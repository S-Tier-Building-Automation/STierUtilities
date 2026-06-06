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
use std::path::PathBuf;
use std::process::Command;

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

fn validate_profile(profile: &NetworkProfile) -> Result<(), String> {
    if profile.name.trim().is_empty() {
        return Err("Profile name is required.".into());
    }
    if profile.adapter_name.trim().is_empty() {
        return Err("Choose a network adapter for this profile.".into());
    }
    if profile.ipv4_mode == Ipv4Mode::Static {
        ensure_ipv4(&profile.ip_address, "Static IP address")?;
        ensure_ipv4(&profile.subnet_mask, "Subnet mask")?;
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
    std::fs::write(&path, json).map_err(|e| format!("could not write profiles: {e}"))
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
