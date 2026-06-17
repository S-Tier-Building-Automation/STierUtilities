//! Network scanner — an Angry-IP-Scanner-style sweep of the local subnet.
//!
//! Given a base IPv4 address + prefix length, this fans an ICMP echo sweep across
//! the subnet's host range on a bounded thread pool, then enriches each responder
//! with its MAC address (ARP) and reverse-DNS hostname. Results stream to the
//! frontend as Tauri events so rows appear live, and the full set is also returned
//! from the command for callers that don't listen.
//!
//! All of this works **un-elevated**:
//! - Liveness + round-trip time via `IcmpSendEcho` (IP Helper API — no raw sockets).
//! - MAC via `SendARP` (IP Helper; local-subnet only, and catches firewalled hosts
//!   that drop ICMP but still answer ARP).
//! - Hostname via best-effort PowerShell reverse-DNS, resolved in parallel chunks
//!   and streamed to the frontend as each chunk completes.
//!
//! Every PowerShell call is launched with `CREATE_NO_WINDOW` (consistent with the
//! Network Manager module) so no console flashes.

#![cfg(windows)]

use std::net::Ipv4Addr;
use std::os::windows::process::CommandExt;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use windows::Win32::Foundation::HANDLE;
use windows::Win32::NetworkManagement::IpHelper::{
    IcmpCloseHandle, IcmpCreateFile, IcmpSendEcho, SendARP, ICMP_ECHO_REPLY,
};

/// Suppresses the transient console window for the reverse-DNS PowerShell call.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// ICMP `IP_SUCCESS` status code — a reply with any other status (e.g.
/// destination unreachable) is not a live host.
const IP_SUCCESS: u32 = 0;

/// Per-host ICMP timeout. Short enough to keep a worst-case all-dead sweep fast,
/// long enough for a sleepy LAN host to answer.
const PING_TIMEOUT_MS: u32 = 600;

/// Upper bound on hosts in a single sweep. A /19 is 8190 hosts; anything larger is
/// almost certainly a misconfiguration and would make the sweep crawl.
const MAX_HOSTS: usize = 8192;

/// Max concurrent ICMP workers. Each owns its own ICMP handle, so there's no shared
/// state on the hot path beyond the work queue and counters.
const MAX_WORKERS: usize = 128;

/// Number of IPs reverse-resolved per PowerShell process. Small enough that a chunk
/// of unresolvable hosts returns quickly (so names stream in steadily), large enough
/// to amortize PowerShell's process-startup cost across the chunk.
const DNS_CHUNK: usize = 24;

/// Max concurrent reverse-DNS PowerShell processes.
const MAX_DNS_WORKERS: usize = 8;

// ---------------------------------------------------------------------------
// Models (shared with the frontend)
// ---------------------------------------------------------------------------

/// One discovered host. `hostname` is filled by the reverse-DNS enrichment pass and
/// is empty in the initial `netscan:host` stream events.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanHost {
    pub ip: String,
    pub rtt_ms: u32,
    pub mac: String,
    pub hostname: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ScanProgress {
    scanned: usize,
    total: usize,
    found: usize,
}

/// Returned from the command; also the payload of the final `netscan:done` event.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub total: usize,
    pub hosts: Vec<ScanHost>,
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/// The in_addr (network-byte-order) value `IcmpSendEcho`/`SendARP` expect for an
/// IPv4 address. On Windows (always little-endian) that is the raw octet bytes read
/// back as a native u32.
fn in_addr(addr: Ipv4Addr) -> u32 {
    u32::from_ne_bytes(addr.octets())
}

/// Computes the inclusive host range (network+1 ..= broadcast-1) for `ip/prefix`.
/// Returns an error for prefixes that don't enclose a scannable host range or that
/// would exceed `MAX_HOSTS`.
fn host_range(ip: Ipv4Addr, prefix: u8) -> Result<(u32, u32), String> {
    if !(16..=30).contains(&prefix) {
        return Err("Prefix length must be between /16 and /30 to scan.".into());
    }
    let mask: u32 = u32::MAX << (32 - prefix as u32);
    let base = u32::from(ip);
    let network = base & mask;
    let broadcast = network | !mask;
    let first = network + 1;
    let last = broadcast - 1;
    let count = (last - first + 1) as usize;
    if count > MAX_HOSTS {
        return Err(format!(
            "Subnet /{prefix} has {count} hosts — too large to scan (max {MAX_HOSTS})."
        ));
    }
    Ok((first, last))
}

// ---------------------------------------------------------------------------
// Native probes
// ---------------------------------------------------------------------------

/// ICMP-echoes a single host. Returns its round-trip time on a successful reply.
/// `handle` is an ICMP handle owned by the calling worker thread.
fn ping_one(handle: HANDLE, target: Ipv4Addr) -> Option<u32> {
    let dest = in_addr(target);
    let send_data = [0x61u8; 32];

    // IcmpSendEcho writes [ICMP_ECHO_REPLY][8 reserved][echoed data] contiguously.
    // Back the buffer with u64s so it's 8-byte aligned for the struct read.
    let reply_size = std::mem::size_of::<ICMP_ECHO_REPLY>() + 8 + send_data.len();
    let words = reply_size.div_ceil(8);
    let mut buf: Vec<u64> = vec![0u64; words];
    let buf_ptr = buf.as_mut_ptr() as *mut std::ffi::c_void;

    let replies = unsafe {
        IcmpSendEcho(
            handle,
            dest,
            send_data.as_ptr() as *const std::ffi::c_void,
            send_data.len() as u16,
            None,
            buf_ptr,
            reply_size as u32,
            PING_TIMEOUT_MS,
        )
    };
    // Only read the reply struct once IcmpSendEcho confirms at least one reply was
    // written; on the failure path (0 replies) the buffer holds nothing meaningful.
    // Also guard that the buffer is large enough to back an ICMP_ECHO_REPLY before
    // reinterpreting it (it always is — see reply_size above — but never read past
    // the allocation if that ever changes).
    if replies < 1 || reply_size < std::mem::size_of::<ICMP_ECHO_REPLY>() {
        return None;
    }
    // Safe: the buffer is large enough and aligned; IcmpSendEcho reported >=1 reply.
    let reply = unsafe { &*(buf.as_ptr() as *const ICMP_ECHO_REPLY) };
    if reply.Status != IP_SUCCESS {
        return None;
    }
    Some(reply.RoundTripTime)
}

/// Resolves a host's MAC via ARP. Local-subnet only and un-elevated; returns a
/// dashed-hex string ("AA-BB-CC-DD-EE-FF") or `None` if ARP couldn't resolve it.
fn arp_mac(target: Ipv4Addr) -> Option<String> {
    let dest = in_addr(target);
    let mut mac = [0u8; 8];
    let mut len: u32 = mac.len() as u32;
    // SendARP returns NO_ERROR (0) on success.
    let res = unsafe { SendARP(dest, 0, mac.as_mut_ptr() as *mut std::ffi::c_void, &mut len) };
    if res != 0 || len == 0 {
        return None;
    }
    let n = (len as usize).min(mac.len());
    Some(
        mac[..n]
            .iter()
            .map(|b| format!("{b:02X}"))
            .collect::<Vec<_>>()
            .join("-"),
    )
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

/// Runs the blocking ICMP sweep across `[first, last]`, streaming `netscan:host`
/// and `netscan:progress` events, and returns every responder found.
fn sweep_blocking(app: AppHandle, first: u32, last: u32) -> Vec<ScanHost> {
    let total = (last - first + 1) as usize;

    // Pre-fill a channel with every target and close the sending side; workers drain
    // it via a shared receiver until empty (recv() then returns Err, ending the loop).
    let (tx, rx) = mpsc::channel::<u32>();
    for t in first..=last {
        let _ = tx.send(t);
    }
    drop(tx);
    let rx = Arc::new(Mutex::new(rx));

    let found = Arc::new(Mutex::new(Vec::<ScanHost>::new()));
    let scanned = Arc::new(AtomicUsize::new(0));
    let found_count = Arc::new(AtomicUsize::new(0));

    let worker_count = MAX_WORKERS.min(total).max(1);
    let mut handles = Vec::with_capacity(worker_count);

    for _ in 0..worker_count {
        let rx = Arc::clone(&rx);
        let found = Arc::clone(&found);
        let scanned = Arc::clone(&scanned);
        let found_count = Arc::clone(&found_count);
        let app = app.clone();

        handles.push(thread::spawn(move || {
            // Each worker owns its own ICMP handle (HANDLE isn't Send, so it can't be
            // shared across threads anyway).
            let handle = match unsafe { IcmpCreateFile() } {
                Ok(h) => h,
                Err(_) => return,
            };

            loop {
                let next = {
                    let guard = rx.lock().unwrap_or_else(|e| e.into_inner());
                    guard.recv()
                };
                let target_u = match next {
                    Ok(v) => v,
                    Err(_) => break,
                };
                let target = Ipv4Addr::from(target_u);

                if let Some(rtt) = ping_one(handle, target) {
                    let host = ScanHost {
                        ip: target.to_string(),
                        rtt_ms: rtt,
                        mac: arp_mac(target).unwrap_or_default(),
                        hostname: String::new(),
                    };
                    found_count.fetch_add(1, Ordering::Relaxed);
                    let _ = app.emit("netscan:host", &host);
                    found.lock().unwrap_or_else(|e| e.into_inner()).push(host);
                }

                let done = scanned.fetch_add(1, Ordering::Relaxed) + 1;
                // Emit progress periodically (and on the final probe) to keep the bar
                // moving without flooding the event channel.
                if done.is_multiple_of(16) || done == total {
                    let _ = app.emit(
                        "netscan:progress",
                        ScanProgress {
                            scanned: done,
                            total,
                            found: found_count.load(Ordering::Relaxed),
                        },
                    );
                }
            }

            let _ = unsafe { IcmpCloseHandle(handle) };
        }));
    }

    for h in handles {
        let _ = h.join();
    }

    let mut hosts = Arc::try_unwrap(found)
        .map(|m| m.into_inner().unwrap_or_default())
        .unwrap_or_default();
    // Stable numeric order by IP so the returned set isn't in race-dependent order.
    hosts.sort_by_key(|h| h.ip.parse::<Ipv4Addr>().map(u32::from).unwrap_or(0));
    hosts
}

// ---------------------------------------------------------------------------
// Reverse-DNS enrichment (best-effort)
// ---------------------------------------------------------------------------

/// Payload of the `netscan:hostnames` event — reverse-DNS results that arrive after
/// the sweep is already done, so the table fills in names without blocking.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct HostName {
    ip: String,
    hostname: String,
}

#[derive(Deserialize)]
struct PtrEntry {
    ip: String,
    host: String,
}

fn parse_ptr_list(json: &str) -> Vec<PtrEntry> {
    let s = json.trim_start_matches('\u{feff}').trim();
    if s.is_empty() {
        return Vec::new();
    }
    if let Ok(list) = serde_json::from_str::<Vec<PtrEntry>>(s) {
        return list;
    }
    if let Ok(one) = serde_json::from_str::<PtrEntry>(s) {
        return vec![one];
    }
    Vec::new()
}

/// Reverse-resolves one chunk of IPs in a single PowerShell process. `-QuickTimeout`
/// makes non-resolving hosts fail fast (a no-PTR LAN host would otherwise stall the
/// resolver for seconds each). There is deliberately no `-DnsOnly`, so the system
/// resolver may also satisfy the lookup via LLMNR/NetBIOS — not just DNS. Returns the
/// (ip, hostname) pairs that resolved to a real name; any failure yields an empty list.
fn resolve_chunk(ips: &[String]) -> Vec<HostName> {
    if ips.is_empty() {
        return Vec::new();
    }
    // IPs are already validated (they came from successful pings), but quote-escape
    // defensively anyway since they're embedded into the script.
    let list = ips
        .iter()
        .map(|ip| format!("'{}'", ip.replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(",");
    let script = format!(
        r#"$ErrorActionPreference='SilentlyContinue'
$ips=@({list})
$out=foreach($ip in $ips){{
  $h=''
  try{{
    $r=Resolve-DnsName -Name $ip -Type PTR -QuickTimeout -ErrorAction Stop
    $h=($r | Where-Object {{ $_.NameHost }} | Select-Object -First 1).NameHost
  }}catch{{ $h='' }}
  [pscustomobject]@{{ ip=$ip; host=[string]$h }}
}}
@($out) | ConvertTo-Json -Compress"#
    );

    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    let mut names = Vec::new();
    if let Ok(out) = output {
        if out.status.success() {
            let stdout = String::from_utf8_lossy(&out.stdout);
            for entry in parse_ptr_list(&stdout) {
                let host = entry.host.trim().trim_end_matches('.');
                // Drop entries where reverse DNS just echoed the IP back.
                if !host.is_empty() && host != entry.ip {
                    names.push(HostName {
                        ip: entry.ip,
                        hostname: host.to_string(),
                    });
                }
            }
        }
    }
    names
}

/// Reverse-resolves every responder in parallel chunks, emitting a `netscan:hostnames`
/// event the moment each chunk resolves so names stream into the table instead of
/// landing in one lump at the end. Bounded to `MAX_DNS_WORKERS` concurrent PowerShell
/// processes. Best-effort: unresolved hosts simply stay blank.
fn resolve_hostnames_streaming(app: &AppHandle, ips: Vec<String>) {
    let chunks: Vec<Vec<String>> = ips.chunks(DNS_CHUNK).map(|c| c.to_vec()).collect();
    let n_chunks = chunks.len();
    if n_chunks == 0 {
        return;
    }

    // Feed chunks through a shared queue; bounded workers drain it concurrently.
    let (tx, rx) = mpsc::channel::<Vec<String>>();
    for c in chunks {
        let _ = tx.send(c);
    }
    drop(tx);
    let rx = Arc::new(Mutex::new(rx));

    let worker_count = MAX_DNS_WORKERS.min(n_chunks).max(1);
    let mut handles = Vec::with_capacity(worker_count);
    for _ in 0..worker_count {
        let rx = Arc::clone(&rx);
        let app = app.clone();
        handles.push(thread::spawn(move || loop {
            let next = {
                let guard = rx.lock().unwrap_or_else(|e| e.into_inner());
                guard.recv()
            };
            let chunk = match next {
                Ok(c) => c,
                Err(_) => break,
            };
            let names = resolve_chunk(&chunk);
            if !names.is_empty() {
                let _ = app.emit("netscan:hostnames", &names);
            }
        }));
    }
    for h in handles {
        let _ = h.join();
    }
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/// Sweeps `ip/prefix` and returns every live host. Streams `netscan:host` and
/// `netscan:progress` during the sweep, emits `netscan:done` the moment the sweep
/// finishes, then resolves reverse-DNS hostnames in a **detached** background task
/// that streams `netscan:hostnames` events as each chunk of names resolves. Hostname
/// resolution deliberately does NOT block the command's return — on a large subnet it
/// can take a while, and the host/MAC/RTT results are already complete and usable
/// without it.
#[tauri::command]
pub async fn netscan_scan(app: AppHandle, ip: String, prefix: u8) -> Result<ScanResult, String> {
    let base: Ipv4Addr = ip
        .trim()
        .parse()
        .map_err(|_| "Scan base must be a valid IPv4 address.".to_string())?;
    let (first, last) = host_range(base, prefix)?;
    let total = (last - first + 1) as usize;

    let app_for_sweep = app.clone();
    let hosts =
        tauri::async_runtime::spawn_blocking(move || sweep_blocking(app_for_sweep, first, last))
            .await
            .map_err(|e| format!("scan task panicked: {e}"))?;

    let result = ScanResult {
        total,
        hosts: hosts.clone(),
    };
    let _ = app.emit("netscan:done", &result);

    // Detached, best-effort hostname enrichment — fills in the `hostname` column
    // after the fact via streamed events, so the sweep result is never held up and
    // names appear incrementally as each chunk resolves.
    if !hosts.is_empty() {
        let app_for_dns = app.clone();
        let ips: Vec<String> = hosts.iter().map(|h| h.ip.clone()).collect();
        tauri::async_runtime::spawn(async move {
            let _ = tauri::async_runtime::spawn_blocking(move || {
                resolve_hostnames_streaming(&app_for_dns, ips);
            })
            .await;
        });
    }

    Ok(result)
}

/// ICMP-echoes a single host once, creating and closing its own ICMP handle.
/// Returns the round-trip time in ms on a successful reply, or `None`.
fn ping_host(target: Ipv4Addr) -> Option<u32> {
    let handle = match unsafe { IcmpCreateFile() } {
        Ok(h) => h,
        Err(_) => return None,
    };
    let rtt = ping_one(handle, target);
    let _ = unsafe { IcmpCloseHandle(handle) };
    rtt
}

/// Single-host reachability probe exposed as the `netscan` capability's
/// `isReachable`. Lets other tools (e.g. the BACnet service) cheaply check whether a
/// device IP answers ICMP before trying to talk to it. Returns the round-trip
/// time in milliseconds, or `null` if the host did not reply. Runs on the blocking
/// pool since `IcmpSendEcho` blocks up to `PING_TIMEOUT_MS`.
#[tauri::command]
pub async fn netscan_ping(ip: String) -> Result<Option<u32>, String> {
    let target: Ipv4Addr = ip
        .trim()
        .parse()
        .map_err(|_| "Ping target must be a valid IPv4 address.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || ping_host(target))
        .await
        .map_err(|e| format!("ping task panicked: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_addr_is_network_order() {
        // 1.2.3.4 -> in_addr bytes [1,2,3,4] -> native u32 on LE = 0x04030201.
        assert_eq!(in_addr(Ipv4Addr::new(1, 2, 3, 4)), 0x0403_0201);
    }

    #[test]
    fn host_range_slash_24() {
        let (first, last) = host_range(Ipv4Addr::new(192, 168, 1, 26), 24).unwrap();
        assert_eq!(Ipv4Addr::from(first), Ipv4Addr::new(192, 168, 1, 1));
        assert_eq!(Ipv4Addr::from(last), Ipv4Addr::new(192, 168, 1, 254));
    }

    #[test]
    fn host_range_slash_21() {
        // 192.168.1.26/21 -> network 192.168.0.0, broadcast 192.168.7.255.
        let (first, last) = host_range(Ipv4Addr::new(192, 168, 1, 26), 21).unwrap();
        assert_eq!(Ipv4Addr::from(first), Ipv4Addr::new(192, 168, 0, 1));
        assert_eq!(Ipv4Addr::from(last), Ipv4Addr::new(192, 168, 7, 254));
        assert_eq!((last - first + 1) as usize, 2046);
    }

    #[test]
    fn host_range_rejects_out_of_bounds_prefix() {
        assert!(host_range(Ipv4Addr::new(10, 0, 0, 1), 15).is_err());
        assert!(host_range(Ipv4Addr::new(10, 0, 0, 1), 31).is_err());
    }

    #[test]
    fn host_range_rejects_too_large() {
        // /16 = 65534 hosts > MAX_HOSTS.
        assert!(host_range(Ipv4Addr::new(10, 0, 0, 1), 16).is_err());
    }

    #[test]
    fn resolve_chunk_empty_is_noop() {
        // No IPs -> no PowerShell spawn, empty result.
        assert!(resolve_chunk(&[]).is_empty());
    }

    /// Live check that the new resolution path (no `-DnsOnly`) returns a real name
    /// for an IP that has a PTR record. Ignored by default — it spawns PowerShell and
    /// needs network. Run with: `cargo test -- --ignored resolve_chunk_resolves_known_ptr`.
    #[test]
    #[ignore]
    fn resolve_chunk_resolves_known_ptr() {
        let names = resolve_chunk(&["8.8.8.8".to_string()]);
        assert_eq!(names.len(), 1, "expected one resolved name");
        assert!(
            names[0].hostname.contains("dns.google"),
            "unexpected hostname: {}",
            names[0].hostname
        );
    }

    #[test]
    fn parse_ptr_handles_single_and_array_and_garbage() {
        assert_eq!(parse_ptr_list("").len(), 0);
        assert_eq!(parse_ptr_list("not json").len(), 0);
        let one = parse_ptr_list(r#"{"ip":"1.2.3.4","host":"a.local"}"#);
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].host, "a.local");
        let many = parse_ptr_list(r#"[{"ip":"1.2.3.4","host":"a"},{"ip":"1.2.3.5","host":"b"}]"#);
        assert_eq!(many.len(), 2);
    }
}
