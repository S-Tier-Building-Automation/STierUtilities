//! Network Manager (read-only slice).
//!
//! Lists Windows network adapters, reads their live IPv4 + DNS state, persists
//! reusable network profiles, and reports "drift" — whether Windows currently
//! matches a saved profile. This is a faithful port of the read/compare/persist
//! layer of the standalone C# `NetworkManager` WPF app.
//!
//! NOT in this slice: **applying** a profile. Apply mutates IPv4/DNS settings via
//! `netsh` / `Set-DnsClientServerAddress`, which require administrator rights. The
//! hub runs un-elevated, so apply needs a dedicated elevation mechanism (a bundled
//! `requireAdministrator` helper) that lands in a follow-up. Everything here is
//! read-only and needs no elevation.
//!
//! Reads shell out to the same Windows tooling the C# used, but via locale- and
//! layout-independent structured PowerShell (projecting enums to strings, forcing
//! arrays, and detecting manual-vs-automatic DNS from the registry rather than the
//! English `netsh` text). Every PowerShell call is launched with `CREATE_NO_WINDOW`
//! to avoid console flashes.

#![cfg(windows)]

use std::net::Ipv4Addr;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

/// Suppresses the transient console window Windows would otherwise show for each
/// `powershell.exe` invocation.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ---------------------------------------------------------------------------
// Enums (shared with the frontend; serialize as lowercase strings)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Ipv4Mode {
    Dhcp,
    Static,
}

impl Default for Ipv4Mode {
    fn default() -> Self {
        Self::Dhcp
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DnsMode {
    Automatic,
    Manual,
    NoChange,
}

impl Default for DnsMode {
    fn default() -> Self {
        Self::NoChange
    }
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/// The one persisted entity: a saved network configuration the user can apply to
/// an adapter. `id` and `last_applied_at` are managed by the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkProfile {
    #[serde(default)]
    pub id: String,
    #[serde(default = "default_name")]
    pub name: String,
    #[serde(default)]
    pub adapter_name: String,
    #[serde(default)]
    pub ipv4_mode: Ipv4Mode,
    #[serde(default)]
    pub ip_address: String,
    #[serde(default = "default_mask")]
    pub subnet_mask: String,
    #[serde(default)]
    pub gateway: String,
    #[serde(default)]
    pub dns_mode: DnsMode,
    #[serde(default)]
    pub primary_dns: String,
    #[serde(default)]
    pub secondary_dns: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub last_applied_at: Option<String>,
}

fn default_name() -> String {
    "New profile".into()
}

fn default_mask() -> String {
    "255.255.255.0".into()
}

/// Read-only snapshot of a live adapter, used to populate pickers.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkAdapterInfo {
    pub name: String,
    pub description: String,
    pub status: String,
    pub mac_address: String,
    pub link_speed: String,
}

/// Read-only snapshot of an adapter's current IPv4 + DNS configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterNetworkState {
    pub adapter_name: String,
    pub adapter_status: String,
    pub ipv4_mode: Ipv4Mode,
    pub ip_address: String,
    pub subnet_mask: String,
    pub gateway: String,
    pub dns_mode: DnsMode,
    pub dns_servers: Vec<String>,
}

/// Result of comparing a profile against an adapter's live state.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileMatchResult {
    pub is_match: bool,
    pub status: String,
    pub detail: String,
}

// ---------------------------------------------------------------------------
// PowerShell shapes (internal; deserialized from the read scripts)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct PsAdapter {
    #[serde(rename = "Name")]
    name: String,
    #[serde(rename = "InterfaceDescription")]
    description: String,
    #[serde(rename = "Status")]
    status: String,
    #[serde(rename = "MacAddress")]
    mac_address: Option<String>,
    #[serde(rename = "LinkSpeed")]
    link_speed: Option<String>,
}

#[derive(Deserialize)]
struct PsState {
    #[serde(rename = "adapterName")]
    adapter_name: String,
    #[serde(rename = "adapterStatus")]
    adapter_status: String,
    #[serde(rename = "ipv4Mode")]
    ipv4_mode: Ipv4Mode,
    #[serde(rename = "ipAddress")]
    ip_address: String,
    #[serde(rename = "prefixLength")]
    prefix_length: u8,
    #[serde(rename = "gateway")]
    gateway: String,
    #[serde(rename = "dnsMode")]
    dns_mode: DnsMode,
    #[serde(rename = "dnsServers")]
    dns_servers: Vec<String>,
}

// ---------------------------------------------------------------------------
// Shell helpers
// ---------------------------------------------------------------------------

fn run_powershell(script: &str) -> Result<String, String> {
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("failed to launch PowerShell: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "PowerShell exited with status {:?}: {}",
            output.status.code(),
            stderr.trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Escapes a value for embedding inside a PowerShell single-quoted string.
fn ps_single_quote(value: &str) -> String {
    value.replace('\'', "''")
}

/// `ConvertTo-Json` emits a bare object for a single item; accept both shapes.
fn parse_adapter_list(json: &str) -> Result<Vec<PsAdapter>, String> {
    if let Ok(list) = serde_json::from_str::<Vec<PsAdapter>>(json) {
        return Ok(list);
    }
    let single: PsAdapter =
        serde_json::from_str(json).map_err(|e| format!("failed to parse adapters: {e}"))?;
    Ok(vec![single])
}

// ---------------------------------------------------------------------------
// Pure logic (no OS calls) — ported 1:1 from the C# service
// ---------------------------------------------------------------------------

fn same_ip(a: &str, b: &str) -> bool {
    matches!(
        (a.trim().parse::<Ipv4Addr>(), b.trim().parse::<Ipv4Addr>()),
        (Ok(x), Ok(y)) if x == y
    )
}

fn same_optional_ip(a: &str, b: &str) -> bool {
    if a.trim().is_empty() && b.trim().is_empty() {
        return true;
    }
    same_ip(a, b)
}

fn display_value(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        "none".into()
    } else {
        trimmed.into()
    }
}

fn ipv4_label(mode: Ipv4Mode) -> &'static str {
    match mode {
        Ipv4Mode::Dhcp => "DHCP",
        Ipv4Mode::Static => "Static",
    }
}

fn dns_label(mode: DnsMode) -> &'static str {
    match mode {
        DnsMode::Automatic => "Automatic",
        DnsMode::Manual => "Manual",
        DnsMode::NoChange => "No change",
    }
}

/// Converts a CIDR prefix length to a dotted IPv4 subnet mask (24 -> 255.255.255.0).
fn prefix_to_mask(prefix: u8) -> String {
    let p = prefix.min(32);
    let bits: u32 = if p == 0 {
        0
    } else {
        u32::MAX << (32 - p as u32)
    };
    Ipv4Addr::from(bits).to_string()
}

/// IPv4-only dedup, preserving order (mirrors the C# `NormalizeDnsServers`).
fn normalize_dns(servers: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for server in servers {
        let trimmed = server.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(addr) = trimmed.parse::<Ipv4Addr>() {
            let normalized = addr.to_string();
            if !out.iter().any(|existing| same_ip(existing, &normalized)) {
                out.push(normalized);
            }
        }
    }
    out
}

fn expected_dns(profile: &NetworkProfile) -> Vec<String> {
    normalize_dns(&[profile.primary_dns.clone(), profile.secondary_dns.clone()])
}

fn ensure_ipv4(value: &str, field: &str) -> Result<(), String> {
    if value.trim().parse::<Ipv4Addr>().is_ok() {
        Ok(())
    } else {
        Err(format!("{field} must be a valid IPv4 address."))
    }
}

/// A valid IPv4 subnet mask is contiguous high bits (a run of 1s then 0s), so a
/// generic dotted-quad check (which accepts e.g. 255.0.255.0) is not enough —
/// netsh would reject those at apply time.
fn ensure_subnet_mask(value: &str) -> Result<(), String> {
    let addr: Ipv4Addr = value
        .trim()
        .parse()
        .map_err(|_| "Subnet mask must be a valid IPv4 subnet mask.".to_string())?;
    let bits = u32::from(addr);
    if bits == 0 || (bits | (bits - 1)) != u32::MAX {
        return Err("Subnet mask must be a valid IPv4 subnet mask.".into());
    }
    Ok(())
}

/// Windows adapter aliases can contain spaces/parens/hyphens, but never control
/// characters (newlines etc.). Rejecting those keeps crafted names out of the
/// netsh/PowerShell argv and is a cheap belt alongside argv-level quoting.
fn is_valid_adapter_name(name: &str) -> bool {
    !name.trim().is_empty() && !name.chars().any(|c| c.is_control())
}

fn validate_profile(profile: &NetworkProfile) -> Result<(), String> {
    if profile.name.trim().is_empty() {
        return Err("Profile name is required.".into());
    }
    if !is_valid_adapter_name(&profile.adapter_name) {
        return Err("Choose a valid network adapter for this profile.".into());
    }
    if profile.ipv4_mode == Ipv4Mode::Static {
        ensure_ipv4(&profile.ip_address, "Static IP address")?;
        ensure_subnet_mask(&profile.subnet_mask)?;
        if !profile.gateway.trim().is_empty() {
            ensure_ipv4(&profile.gateway, "Gateway")?;
        }
    }
    if profile.dns_mode == DnsMode::Manual {
        ensure_ipv4(&profile.primary_dns, "Primary DNS")?;
        if !profile.secondary_dns.trim().is_empty() {
            ensure_ipv4(&profile.secondary_dns, "Secondary DNS")?;
        }
    }
    Ok(())
}

fn compare_profile_to_state(
    profile: &NetworkProfile,
    state: &AdapterNetworkState,
) -> ProfileMatchResult {
    let not_active = |detail: String| ProfileMatchResult {
        is_match: false,
        status: "Not active".into(),
        detail,
    };
    let active = |detail: String| ProfileMatchResult {
        is_match: true,
        status: "Active".into(),
        detail,
    };

    if !profile.adapter_name.eq_ignore_ascii_case(&state.adapter_name) {
        return not_active(format!(
            "Profile targets {}, not {}.",
            profile.adapter_name, state.adapter_name
        ));
    }

    if profile.ipv4_mode != state.ipv4_mode {
        return not_active(format!(
            "IPv4 is {}; profile expects {}.",
            ipv4_label(state.ipv4_mode),
            ipv4_label(profile.ipv4_mode)
        ));
    }

    if profile.ipv4_mode == Ipv4Mode::Static {
        if !same_ip(&profile.ip_address, &state.ip_address) {
            return not_active(format!(
                "IP is {}; profile expects {}.",
                display_value(&state.ip_address),
                profile.ip_address
            ));
        }
        if !same_ip(&profile.subnet_mask, &state.subnet_mask) {
            return not_active(format!(
                "Subnet is {}; profile expects {}.",
                display_value(&state.subnet_mask),
                profile.subnet_mask
            ));
        }
        if !same_optional_ip(&profile.gateway, &state.gateway) {
            return not_active(format!(
                "Gateway is {}; profile expects {}.",
                display_value(&state.gateway),
                display_value(&profile.gateway)
            ));
        }
    }

    if profile.dns_mode == DnsMode::NoChange {
        return active("Windows matches this profile; DNS is ignored.".into());
    }

    if profile.dns_mode != state.dns_mode {
        return not_active(format!(
            "DNS is {}; profile expects {}.",
            dns_label(state.dns_mode),
            dns_label(profile.dns_mode)
        ));
    }

    if profile.dns_mode == DnsMode::Manual {
        let expected = expected_dns(profile);
        let actual = normalize_dns(&state.dns_servers);

        if !expected.is_empty() && !actual.is_empty() && !same_ip(&expected[0], &actual[0]) {
            return not_active(format!(
                "Primary DNS is {}; profile expects {}.",
                display_value(&actual[0]),
                expected[0]
            ));
        }
        if expected.len() > actual.len() {
            let label = if expected.len() > 1 {
                "Alternate DNS"
            } else {
                "Primary DNS"
            };
            return not_active(format!("{label} is none; profile expects {}.", expected[actual.len()]));
        }
        if actual.len() > expected.len() {
            let label = if actual.len() > 1 { "alternate DNS" } else { "DNS" };
            return not_active(format!("Windows has extra {label} {}.", actual[expected.len()]));
        }
        for index in 1..expected.len() {
            if !same_ip(&expected[index], &actual[index]) {
                return not_active(format!(
                    "Alternate DNS is {}; profile expects {}.",
                    display_value(&actual[index]),
                    expected[index]
                ));
            }
        }
    }

    active("Windows currently matches this profile.".into())
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

fn profiles_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("could not resolve app config dir: {e}"))?
        .join("networkmanager");
    Ok(dir.join("profiles.json"))
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn networkmanager_list_adapters() -> Result<Vec<NetworkAdapterInfo>, String> {
    let script = "@(Get-NetAdapter | Sort-Object Name | Select-Object Name,InterfaceDescription,Status,MacAddress,LinkSpeed) | ConvertTo-Json -Depth 3";
    let stdout = run_powershell(script)?;
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let adapters = parse_adapter_list(trimmed)?;
    Ok(adapters
        .into_iter()
        .map(|a| NetworkAdapterInfo {
            name: a.name,
            description: a.description,
            status: a.status,
            mac_address: a.mac_address.unwrap_or_default(),
            link_speed: a.link_speed.unwrap_or_default(),
        })
        .collect())
}

#[tauri::command]
pub fn networkmanager_read_state(name: String) -> Result<AdapterNetworkState, String> {
    let alias = ps_single_quote(&name);
    let script = format!(
        r#"$ErrorActionPreference='SilentlyContinue'
$alias='{alias}'
$ad    = Get-NetAdapter -InterfaceAlias $alias
if (-not $ad) {{ [Console]::Error.WriteLine("Adapter '$alias' not found"); exit 2 }}
$ipif  = Get-NetIPInterface -InterfaceAlias $alias -AddressFamily IPv4
$ipadr = Get-NetIPAddress -InterfaceAlias $alias -AddressFamily IPv4 | Where-Object {{ $_.PrefixOrigin -ne 'WellKnown' }} | Sort-Object @{{e={{$_.PrefixOrigin -eq 'Manual'}}}} -Descending | Select-Object -First 1
$cfg   = Get-NetIPConfiguration -InterfaceAlias $alias
$gw    = ($cfg.IPv4DefaultGateway | Select-Object -First 1).NextHop
$dns   = @((Get-DnsClientServerAddress -InterfaceAlias $alias -AddressFamily IPv4).ServerAddresses)
$guid  = $ad.InterfaceGuid
$ns    = (Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces\$guid" -ErrorAction SilentlyContinue).NameServer
[pscustomobject]@{{
  adapterName   = $alias
  adapterStatus = [string]$ad.Status
  ipv4Mode      = if ([string]$ipif.Dhcp -eq 'Enabled') {{ 'dhcp' }} else {{ 'static' }}
  ipAddress     = [string]$ipadr.IPAddress
  prefixLength  = [int]$ipadr.PrefixLength
  gateway       = [string]$gw
  dnsMode       = if (-not [string]::IsNullOrWhiteSpace($ns)) {{ 'manual' }} else {{ 'automatic' }}
  dnsServers    = $dns
}} | ConvertTo-Json -Compress"#
    );
    let stdout = run_powershell(&script)?;
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Err(format!("adapter '{name}' not found or returned no state"));
    }
    let ps: PsState =
        serde_json::from_str(trimmed).map_err(|e| format!("failed to parse adapter state: {e}"))?;

    let subnet_mask = if ps.ip_address.trim().is_empty() {
        String::new()
    } else {
        prefix_to_mask(ps.prefix_length)
    };

    Ok(AdapterNetworkState {
        adapter_name: ps.adapter_name,
        adapter_status: ps.adapter_status,
        ipv4_mode: ps.ipv4_mode,
        ip_address: ps.ip_address,
        subnet_mask,
        gateway: ps.gateway,
        dns_mode: ps.dns_mode,
        dns_servers: normalize_dns(&ps.dns_servers),
    })
}

#[tauri::command]
pub fn networkmanager_capture_profile(name: String) -> Result<NetworkProfile, String> {
    let state = networkmanager_read_state(name.clone())?;
    let primary = state.dns_servers.first().cloned().unwrap_or_default();
    let secondary = state.dns_servers.get(1).cloned().unwrap_or_default();
    Ok(NetworkProfile {
        // The frontend assigns the id and dedupes the name before adding.
        id: String::new(),
        name: format!("{name} current"),
        adapter_name: state.adapter_name,
        ipv4_mode: state.ipv4_mode,
        ip_address: state.ip_address,
        subnet_mask: if state.subnet_mask.is_empty() {
            default_mask()
        } else {
            state.subnet_mask
        },
        gateway: state.gateway,
        dns_mode: state.dns_mode,
        primary_dns: primary,
        secondary_dns: secondary,
        notes: String::new(),
        last_applied_at: None,
    })
}

#[tauri::command]
pub fn networkmanager_compare(
    profile: NetworkProfile,
    state: AdapterNetworkState,
) -> ProfileMatchResult {
    compare_profile_to_state(&profile, &state)
}

#[tauri::command]
pub fn networkmanager_validate(profile: NetworkProfile) -> Result<(), String> {
    validate_profile(&profile)
}

#[tauri::command]
pub fn networkmanager_load_profiles(app: AppHandle) -> Result<Vec<NetworkProfile>, String> {
    let path = profiles_path(&app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = std::fs::read_to_string(&path).map_err(|e| format!("could not read profiles: {e}"))?;
    if data.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&data).map_err(|e| format!("could not parse profiles: {e}"))
}

#[tauri::command]
pub fn networkmanager_save_profiles(
    app: AppHandle,
    profiles: Vec<NetworkProfile>,
) -> Result<(), String> {
    let path = profiles_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("could not create profile dir: {e}"))?;
    }
    let json =
        serde_json::to_string_pretty(&profiles).map_err(|e| format!("could not serialize profiles: {e}"))?;
    // Write to a sibling temp file and atomically replace the destination, so a
    // crash or power loss mid-write can't truncate profiles.json and wipe every
    // saved profile (the frontend auto-saves on edits). On Windows std::fs::rename
    // replaces an existing file (MOVEFILE_REPLACE_EXISTING).
    let tmp = path.with_file_name(format!(
        "{}.tmp",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("profiles.json")
    ));
    std::fs::write(&tmp, json.as_bytes()).map_err(|e| format!("could not write profiles: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("could not replace profiles file: {e}")
    })
}

#[tauri::command]
pub fn networkmanager_profiles_path(app: AppHandle) -> Result<String, String> {
    Ok(profiles_path(&app)?.to_string_lossy().to_string())
}

#[tauri::command]
pub fn networkmanager_open_profiles_dir(app: AppHandle) -> Result<(), String> {
    let path = profiles_path(&app)?;
    let dir = path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| path.clone());
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create profile dir: {e}"))?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| format!("could not open folder: {e}"))
}

// ---------------------------------------------------------------------------
// Apply (elevated) — changing IPv4/DNS requires administrator rights.
//
// The hub runs un-elevated (asInvoker). To apply, it re-launches THIS executable
// elevated via ShellExecuteEx "runas" (one UAC prompt) with a `--nm-apply-elevated`
// flag; that flag is handled in `run()` before any window/Tauri init, so the
// elevated instance just runs the apply and exits. Because it's the same
// GUI-subsystem exe (release builds), nothing flashes, and the exit code comes
// back reliably via GetExitCodeProcess. The plan is passed as a base64 argument
// (no plan file), and the only on-disk artifact is the write-only results file the
// elevated worker writes for the parent to read (output can't cross the boundary).
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApplyPlan {
    adapter_name: String,
    ipv4_mode: Ipv4Mode,
    ip_address: String,
    subnet_mask: String,
    gateway: String,
    dns_mode: DnsMode,
    dns_servers: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ApplyStep {
    pub step: String,
    pub ok: bool,
    pub detail: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOutcome {
    pub ok: bool,
    pub steps: Vec<ApplyStep>,
}

/// Runs a command with no console window and returns (success, trimmed combined output).
fn run_capture(exe: &str, args: &[String]) -> Result<(bool, String), String> {
    let out = Command::new(exe)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("failed to run {exe}: {e}"))?;
    let mut text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let err = String::from_utf8_lossy(&out.stderr);
    let err = err.trim();
    if !err.is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(err);
    }
    Ok((out.status.success(), text))
}

fn ipv4_mode_word(mode: Ipv4Mode) -> &'static str {
    match mode {
        Ipv4Mode::Dhcp => "dhcp",
        Ipv4Mode::Static => "static",
    }
}

/// Re-validates the decoded plan inside the elevated worker. The parent already
/// validates, but this code runs with administrator rights, so it does not trust
/// input crossing the privilege boundary: every value embedded into a netsh/PS
/// command is re-checked here.
fn validate_plan(plan: &ApplyPlan) -> Result<(), String> {
    if !is_valid_adapter_name(&plan.adapter_name) {
        return Err("invalid adapter name".into());
    }
    if plan.ipv4_mode == Ipv4Mode::Static {
        ensure_ipv4(&plan.ip_address, "Static IP address")?;
        ensure_subnet_mask(&plan.subnet_mask)?;
        if !plan.gateway.trim().is_empty() {
            ensure_ipv4(&plan.gateway, "Gateway")?;
        }
    }
    if plan.dns_mode == DnsMode::Manual {
        for server in &plan.dns_servers {
            ensure_ipv4(server, "DNS server")?;
        }
    }
    Ok(())
}

/// True only for an absolute path under the user's profile whose file name matches
/// the expected `apply-result-*.json`. The elevated worker refuses to write anywhere
/// else, so a tampered result-path argument can't turn an admin-level write loose
/// on an arbitrary location.
fn result_path_is_safe(result_path: &str) -> bool {
    if result_path.contains("..") {
        return false;
    }
    let path = Path::new(result_path);
    if !path.is_absolute() {
        return false;
    }
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    if home.is_empty() || !path.starts_with(&home) {
        return false;
    }
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.starts_with("apply-result-") && n.ends_with(".json"))
        .unwrap_or(false)
}

/// The apply steps, run inside the elevated re-launch of this exe: IPv4 via netsh,
/// then (unless NoChange) DNS via Set-DnsClientServerAddress — independently, since
/// netsh can return non-zero while still applying. Every child gets CREATE_NO_WINDOW,
/// and the elevated host is the same GUI-subsystem exe, so nothing flashes.
fn elevated_apply_steps(plan_b64: &str) -> Vec<ApplyStep> {
    let mut steps = Vec::new();

    let plan: ApplyPlan = match base64_decode(plan_b64)
        .ok_or_else(|| "could not decode apply plan".to_string())
        .and_then(|b| serde_json::from_slice(&b).map_err(|e| format!("could not parse apply plan: {e}")))
    {
        Ok(p) => p,
        Err(e) => {
            steps.push(ApplyStep { step: "Apply".into(), ok: false, detail: e });
            return steps;
        }
    };

    if let Err(e) = validate_plan(&plan) {
        steps.push(ApplyStep { step: "Apply".into(), ok: false, detail: e });
        return steps;
    }

    // ---- IPv4 (netsh) ----
    let mut args: Vec<String> = vec![
        "interface".into(),
        "ipv4".into(),
        "set".into(),
        "address".into(),
        format!("name={}", plan.adapter_name),
    ];
    match plan.ipv4_mode {
        Ipv4Mode::Dhcp => args.push("source=dhcp".into()),
        Ipv4Mode::Static => {
            let gw = if plan.gateway.trim().is_empty() {
                "none".to_string()
            } else {
                plan.gateway.trim().to_string()
            };
            args.push("source=static".into());
            args.push(format!("address={}", plan.ip_address.trim()));
            args.push(format!("mask={}", plan.subnet_mask.trim()));
            args.push(format!("gateway={gw}"));
        }
    }
    match run_capture("netsh.exe", &args) {
        Ok((ok, out)) => {
            let detail = if out.is_empty() {
                format!("IPv4 set to {}", ipv4_mode_word(plan.ipv4_mode))
            } else {
                out
            };
            steps.push(ApplyStep { step: "IPv4".into(), ok, detail });
        }
        Err(e) => steps.push(ApplyStep { step: "IPv4".into(), ok: false, detail: e }),
    }

    // ---- DNS (independent of the IPv4 result) ----
    if plan.dns_mode != DnsMode::NoChange {
        let alias = ps_single_quote(&plan.adapter_name);
        let (command, success_detail) = match plan.dns_mode {
            DnsMode::Automatic => (
                format!("Set-DnsClientServerAddress -InterfaceAlias '{alias}' -ResetServerAddresses -ErrorAction Stop"),
                "DNS reset to automatic".to_string(),
            ),
            DnsMode::Manual => {
                let servers = plan
                    .dns_servers
                    .iter()
                    .map(|s| format!("'{}'", ps_single_quote(s)))
                    .collect::<Vec<_>>()
                    .join(",");
                (
                    format!("Set-DnsClientServerAddress -InterfaceAlias '{alias}' -ServerAddresses @({servers}) -ErrorAction Stop"),
                    format!("DNS set to {}", plan.dns_servers.join(", ")),
                )
            }
            DnsMode::NoChange => unreachable!(),
        };
        let ps_args = vec![
            "-NoProfile".into(),
            "-ExecutionPolicy".into(),
            "Bypass".into(),
            "-Command".into(),
            command,
        ];
        match run_capture("powershell.exe", &ps_args) {
            Ok((true, _)) => steps.push(ApplyStep { step: "DNS".into(), ok: true, detail: success_detail }),
            Ok((false, out)) => steps.push(ApplyStep {
                step: "DNS".into(),
                ok: false,
                detail: if out.is_empty() { "DNS step failed".into() } else { out },
            }),
            Err(e) => steps.push(ApplyStep { step: "DNS".into(), ok: false, detail: e }),
        }
    }

    steps
}

/// Entry point for the elevated re-launch (dispatched from `run()` before Tauri
/// starts). Runs the apply and writes the results file the un-elevated parent reads
/// back, then returns the process exit code.
pub fn run_elevated_worker(plan_b64: &str, result_path: &str) -> i32 {
    // Defense in depth: never let an admin-level write escape to an arbitrary path.
    if !result_path_is_safe(result_path) {
        return 2;
    }
    let steps = elevated_apply_steps(plan_b64);
    let json = serde_json::to_string(&steps).unwrap_or_else(|_| "[]".to_string());
    // Write + flush to disk so the file is complete before the parent (which waits
    // on this process to exit) reads it back.
    if let Ok(mut file) = std::fs::File::create(result_path) {
        use std::io::Write;
        let _ = file.write_all(json.as_bytes());
        let _ = file.sync_all();
    }
    if !steps.is_empty() && steps.iter().all(|s| s.ok) {
        0
    } else {
        1
    }
}

/// Standard base64 (no line breaks). Avoids pulling in a crate just for this.
fn base64_encode(input: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[((n >> 18) & 63) as usize] as char);
        out.push(ALPHABET[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// Standard base64 decode (ignores padding and whitespace). Returns None on invalid input.
fn base64_decode(input: &str) -> Option<Vec<u8>> {
    fn val(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a' + 26) as u32),
            b'0'..=b'9' => Some((c - b'0' + 52) as u32),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    let mut buf = 0u32;
    let mut bits = 0u32;
    for &c in input.as_bytes() {
        if c == b'=' || c.is_ascii_whitespace() {
            continue;
        }
        buf = (buf << 6) | val(c)?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Some(out)
}

/// PowerShell's `ConvertTo-Json` renders collections inconsistently across
/// versions — a bare array, a single bare object, or a `{"value":[...],"Count":N}`
/// wrapper. Accept all three so the results file always parses.
fn parse_apply_steps(raw: &str) -> Vec<ApplyStep> {
    let s = raw.trim_start_matches('\u{feff}').trim();
    if s.is_empty() {
        return Vec::new();
    }
    if let Ok(v) = serde_json::from_str::<Vec<ApplyStep>>(s) {
        return v;
    }
    #[derive(Deserialize)]
    struct Wrapper {
        value: Vec<ApplyStep>,
    }
    if let Ok(w) = serde_json::from_str::<Wrapper>(s) {
        return w.value;
    }
    if let Ok(one) = serde_json::from_str::<ApplyStep>(s) {
        return vec![one];
    }
    Vec::new()
}

fn unique_stamp() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{}-{}", std::process::id(), nanos)
}

/// Re-launches THIS executable elevated (one UAC prompt) via ShellExecuteEx "runas"
/// to run the apply worker, waits for it, and returns its exit code. Returns a
/// distinct error when the user declines the UAC prompt. The plan travels as a
/// base64 argument (alphanumeric + `/+=`, no quotes/spaces) and the flag is handled
/// in `run()` before Tauri starts.
fn launch_elevated_self(plan_b64: &str, result_path: &Path) -> Result<i32, String> {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::Foundation::ERROR_CANCELLED;
    use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject, INFINITE};
    use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
    use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

    let exe = std::env::current_exe().map_err(|e| format!("could not resolve current exe: {e}"))?;
    let params = format!(
        "--nm-apply-elevated {} \"{}\"",
        plan_b64,
        result_path.to_string_lossy().replace('"', "")
    );

    let exe_w = HSTRING::from(exe.to_string_lossy().as_ref());
    let verb_w = HSTRING::from("runas");
    let params_w = HSTRING::from(params.as_str());

    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        lpVerb: PCWSTR(verb_w.as_ptr()),
        lpFile: PCWSTR(exe_w.as_ptr()),
        lpParameters: PCWSTR(params_w.as_ptr()),
        nShow: SW_HIDE.0,
        ..Default::default()
    };

    unsafe {
        if let Err(e) = ShellExecuteExW(&mut info) {
            if e.code() == ERROR_CANCELLED.to_hresult() {
                return Err("Elevation was cancelled — the profile was not applied.".into());
            }
            return Err(format!("Could not request administrator elevation: {e}"));
        }
        if info.hProcess.is_invalid() {
            return Err("The elevated apply process did not start.".into());
        }
        // Blocks until the elevated worker exits. apply_blocking always runs on a
        // spawn_blocking worker thread, never the UI thread. No early return between
        // here and CloseHandle, so the handle can't leak.
        WaitForSingleObject(info.hProcess, INFINITE);
        let mut code: u32 = 1;
        let _ = GetExitCodeProcess(info.hProcess, &mut code);
        let _ = windows::Win32::Foundation::CloseHandle(info.hProcess);
        Ok(code as i32)
    }
}

fn apply_blocking(app: &AppHandle, profile: &NetworkProfile) -> Result<ApplyOutcome, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("could not resolve cache dir: {e}"))?
        .join("networkmanager");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create work dir: {e}"))?;

    let stamp = unique_stamp();
    // The only on-disk artifact is the results file the elevated worker writes
    // back (a write-only output channel — stdout can't cross the elevation
    // boundary). The plan travels as a base64 argv to the elevated re-launch; the
    // result path is argv[3], validated by the worker before it writes.
    let result_path = dir.join(format!("apply-result-{stamp}.json"));

    let plan = ApplyPlan {
        adapter_name: profile.adapter_name.clone(),
        ipv4_mode: profile.ipv4_mode,
        ip_address: profile.ip_address.trim().to_string(),
        subnet_mask: profile.subnet_mask.trim().to_string(),
        gateway: profile.gateway.trim().to_string(),
        dns_mode: profile.dns_mode,
        dns_servers: expected_dns(profile),
    };
    let plan_json = serde_json::to_string(&plan).map_err(|e| format!("could not serialize plan: {e}"))?;
    let plan_b64 = base64_encode(plan_json.as_bytes());

    let run = launch_elevated_self(&plan_b64, &result_path);

    // Read results regardless of exit code (best effort).
    let steps: Vec<ApplyStep> = std::fs::read_to_string(&result_path)
        .ok()
        .map(|s| parse_apply_steps(&s))
        .unwrap_or_default();

    let _ = std::fs::remove_file(&result_path);

    match run {
        Err(e) => Err(e),
        Ok(code) => {
            if steps.is_empty() {
                return Err(format!(
                    "Apply finished (exit {code}) but reported no results — the elevated step may not have run."
                ));
            }
            let ok = code == 0 && steps.iter().all(|s| s.ok);
            Ok(ApplyOutcome { ok, steps })
        }
    }
}

#[tauri::command]
pub async fn networkmanager_apply_profile(
    app: AppHandle,
    profile: NetworkProfile,
) -> Result<ApplyOutcome, String> {
    validate_profile(&profile)?;
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || apply_blocking(&app2, &profile))
        .await
        .map_err(|e| format!("apply task panicked: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_steps_bare_array() {
        let steps = parse_apply_steps(r#"[{"step":"IPv4","ok":true,"detail":"ok"}]"#);
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].step, "IPv4");
        assert!(steps[0].ok);
    }

    #[test]
    fn parse_steps_powershell_value_count_wrapper() {
        // Windows PowerShell 5.1 `,$arr | ConvertTo-Json` shape.
        let steps = parse_apply_steps(
            r#"{"value":[{"step":"IPv4","ok":false,"detail":"x"},{"step":"DNS","ok":true,"detail":"y"}],"Count":2}"#,
        );
        assert_eq!(steps.len(), 2);
        assert!(!steps[0].ok);
        assert!(steps[1].ok);
    }

    #[test]
    fn parse_steps_single_object_and_bom() {
        let steps = parse_apply_steps("\u{feff}{\"step\":\"Apply\",\"ok\":false,\"detail\":\"boom\"}");
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].step, "Apply");
        assert!(!steps[0].ok);
    }

    #[test]
    fn parse_steps_empty_or_garbage() {
        assert!(parse_apply_steps("").is_empty());
        assert!(parse_apply_steps("not json").is_empty());
        assert!(parse_apply_steps("[]").is_empty());
    }

    #[test]
    fn prefix_to_mask_known_values() {
        assert_eq!(prefix_to_mask(24), "255.255.255.0");
        assert_eq!(prefix_to_mask(21), "255.255.248.0");
        assert_eq!(prefix_to_mask(22), "255.255.252.0");
        assert_eq!(prefix_to_mask(0), "0.0.0.0");
        assert_eq!(prefix_to_mask(32), "255.255.255.255");
    }

    #[test]
    fn base64_rfc4648_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn base64_round_trips() {
        for s in ["", "f", "fo", "foo", "foobar", "{\"a\":1,\"b\":\"x y/z+=\"}"] {
            assert_eq!(base64_decode(&base64_encode(s.as_bytes())).unwrap(), s.as_bytes());
        }
        assert!(base64_decode("not base64 ***").is_none());
    }

    #[test]
    fn adapter_name_validation() {
        assert!(is_valid_adapter_name("Ethernet 2"));
        assert!(is_valid_adapter_name("Bluetooth Network Connection"));
        assert!(!is_valid_adapter_name(""));
        assert!(!is_valid_adapter_name("   "));
        assert!(!is_valid_adapter_name("bad\nname"));
        assert!(!is_valid_adapter_name("a\tb"));
    }

    fn sample_plan() -> ApplyPlan {
        ApplyPlan {
            adapter_name: "Ethernet 2".into(),
            ipv4_mode: Ipv4Mode::Static,
            ip_address: "192.168.1.10".into(),
            subnet_mask: "255.255.255.0".into(),
            gateway: String::new(),
            dns_mode: DnsMode::NoChange,
            dns_servers: vec![],
        }
    }

    #[test]
    fn plan_validation() {
        assert!(validate_plan(&sample_plan()).is_ok());

        let mut bad_mask = sample_plan();
        bad_mask.subnet_mask = "255.0.255.0".into();
        assert!(validate_plan(&bad_mask).is_err());

        let mut bad_name = sample_plan();
        bad_name.adapter_name = "bad\nname".into();
        assert!(validate_plan(&bad_name).is_err());

        let mut manual = sample_plan();
        manual.dns_mode = DnsMode::Manual;
        manual.dns_servers = vec!["8.8.8.8".into(), "8.8.4.4".into()];
        assert!(validate_plan(&manual).is_ok());
        manual.dns_servers = vec!["not-an-ip".into()];
        assert!(validate_plan(&manual).is_err());
    }

    #[test]
    fn result_path_safety() {
        let home = std::env::var("USERPROFILE").unwrap_or_default();
        assert!(!home.is_empty(), "USERPROFILE must be set on the test host");
        let good = format!(
            "{home}\\AppData\\Local\\com.stierbuildings.utilities\\networkmanager\\apply-result-12-34.json"
        );
        assert!(result_path_is_safe(&good));
        assert!(!result_path_is_safe("C:\\Windows\\System32\\apply-result-x.json")); // outside profile
        assert!(!result_path_is_safe(&format!("{home}\\..\\evil\\apply-result-x.json"))); // traversal
        assert!(!result_path_is_safe(&format!("{home}\\networkmanager\\evil.txt"))); // wrong name
        assert!(!result_path_is_safe("apply-result-x.json")); // relative
    }

    #[test]
    fn subnet_mask_validation() {
        for ok in ["255.255.255.0", "255.255.252.0", "255.0.0.0", "255.255.255.255"] {
            assert!(ensure_subnet_mask(ok).is_ok(), "{ok} should be valid");
        }
        for bad in ["255.0.255.0", "0.0.0.0", "255.255.255.1", "not-an-ip", "256.0.0.0"] {
            assert!(ensure_subnet_mask(bad).is_err(), "{bad} should be invalid");
        }
    }
}
