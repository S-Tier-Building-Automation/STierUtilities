//! Observability Pack supervisor — manages the optional Telegraf + InfluxDB +
//! Grafana stack that backs the `timeseries` capability.
//!
//! The base app stays small: these binaries are NOT bundled. They are downloaded
//! on demand into the app data dir and supervised as child processes, all bound
//! to 127.0.0.1. This module owns:
//!   - generating each service's config (pure, unit-tested),
//!   - picking free localhost ports,
//!   - building the official download URLs per OS/arch (pure, unit-tested),
//!   - writing line protocol to InfluxDB over HTTP (request builder + status
//!     parser are pure/unit-tested; the socket send is integration),
//!   - and the process lifecycle (start/stop/status).
//!
//! Portable: pure helpers compile everywhere; process spawning uses std only.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::timeseries::{to_line_protocol_batch, FieldValue, Point};

/// Connection + layout config for a running (or to-be-run) pack. Sent from the
/// frontend transport on each write; also drives config-file generation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackConfig {
    pub influx_port: u16,
    pub grafana_port: u16,
    pub telegraf_listener_port: u16,
    pub org: String,
    pub bucket: String,
    pub token: String,
}

impl Default for PackConfig {
    fn default() -> Self {
        PackConfig {
            influx_port: 8086,
            grafana_port: 3000,
            telegraf_listener_port: 8186,
            org: "stier".into(),
            bucket: "utilities".into(),
            token: String::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// Free-port selection
// ---------------------------------------------------------------------------

/// Pick `n` distinct free localhost ports by binding to :0 and reading them back.
/// Each port is free at the moment of return (a classic TOCTOU, acceptable here
/// since we immediately hand them to the children we're about to spawn). Returns
/// an error if fewer than `n` ports could be reserved, so callers fail with a
/// clear message instead of silently falling back to maybe-busy defaults.
pub fn find_free_ports(n: usize) -> Result<Vec<u16>, String> {
    // Hold the listeners until we've collected all ports so the OS doesn't hand
    // back the same port twice, then drop them all.
    let mut listeners = Vec::new();
    let mut ports = Vec::new();
    for _ in 0..n {
        let l = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|e| format!("could not reserve a free localhost port: {e}"))?;
        let addr = l
            .local_addr()
            .map_err(|e| format!("could not read a reserved localhost port: {e}"))?;
        ports.push(addr.port());
        listeners.push(l);
    }
    Ok(ports)
}

// ---------------------------------------------------------------------------
// Download asset URL construction (pure)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DownloadAsset {
    pub url: String,
    /// "zip" or "tar.gz" — how to unpack it.
    pub archive: String,
}

/// Build the official download URL for a pack component. `os` is one of
/// "windows" | "darwin" | "linux"; `arch` is "amd64" | "arm64".
pub fn download_asset(
    component: &str,
    version: &str,
    os: &str,
    arch: &str,
) -> Result<DownloadAsset, String> {
    let (archive, _) = match os {
        "windows" => ("zip", "windows"),
        _ => ("tar.gz", os),
    };
    let url = match component {
        // InfluxData's Windows asset drops the arch token and uses a hyphen
        // (influxdb2-<ver>-windows.zip); linux/darwin use the _os_arch form.
        "influxdb" if os == "windows" => {
            format!("https://dl.influxdata.com/influxdb/releases/influxdb2-{version}-windows.zip")
        }
        "influxdb" => format!(
            "https://dl.influxdata.com/influxdb/releases/influxdb2-{version}_{os}_{arch}.{archive}"
        ),
        "telegraf" => format!(
            "https://dl.influxdata.com/telegraf/releases/telegraf-{version}_{os}_{arch}.{archive}"
        ),
        "grafana" => {
            // Grafana uses "windows-amd64.zip" / "linux-amd64.tar.gz" naming.
            format!("https://dl.grafana.com/oss/release/grafana-{version}.{os}-{arch}.{archive}")
        }
        other => return Err(format!("unknown component: {other}")),
    };
    Ok(DownloadAsset {
        url,
        archive: archive.to_string(),
    })
}

/// Map Rust's compile-time target to the (os, arch) tokens used by the download URLs.
pub fn current_os_arch() -> (&'static str, &'static str) {
    let os = if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "amd64"
    };
    (os, arch)
}

// ---------------------------------------------------------------------------
// Config-file generation (pure)
// ---------------------------------------------------------------------------

/// Telegraf config: an InfluxDB v2 output, a line-protocol listener input (so the
/// app can push via HTTP), plus a couple of host metrics inputs.
pub fn telegraf_conf(cfg: &PackConfig) -> String {
    format!(
        r#"# Generated by S-Tier Utilities — Observability Pack
[agent]
  interval = "10s"
  flush_interval = "2s"
  omit_hostname = false

[[outputs.influxdb_v2]]
  urls = ["http://127.0.0.1:{influx}"]
  token = "{token}"
  organization = "{org}"
  bucket = "{bucket}"

# Local ingest endpoint: tools POST InfluxDB line protocol here.
[[inputs.influxdb_v2_listener]]
  service_address = "127.0.0.1:{listener}"
  token = "{token}"

[[inputs.mem]]
[[inputs.cpu]]
  percpu = false
  totalcpu = true
"#,
        influx = cfg.influx_port,
        listener = cfg.telegraf_listener_port,
        token = cfg.token,
        org = cfg.org,
        bucket = cfg.bucket,
    )
}

/// Grafana main config: localhost-only, anonymous Viewer (for embedding), and —
/// critically — data/logs/plugins + provisioning kept OUTSIDE grafana-home so
/// updates don't wipe user state, and so our provisioned datasource/dashboards
/// (written under config_dir) are actually loaded.
pub fn grafana_ini(cfg: &PackConfig, paths: &PackPaths) -> String {
    // Forward slashes avoid any INI backslash-escaping ambiguity on Windows.
    let slash = |p: PathBuf| p.to_string_lossy().replace('\\', "/");
    let data = slash(paths.grafana_data_dir());
    let provisioning = slash(paths.config_dir().join("provisioning"));
    format!(
        r#"# Generated by S-Tier Utilities — Observability Pack
[paths]
data = {data}
logs = {data}/log
plugins = {data}/plugins
provisioning = {provisioning}

[server]
http_addr = 127.0.0.1
http_port = {port}

[auth.anonymous]
enabled = true
org_name = Main Org.
org_role = Viewer

[security]
allow_embedding = true
"#,
        data = data,
        provisioning = provisioning,
        port = cfg.grafana_port,
    )
}

/// Grafana datasource provisioning: points at the local InfluxDB with the app token.
pub fn grafana_datasource_yaml(cfg: &PackConfig) -> String {
    format!(
        r#"apiVersion: 1
datasources:
  - name: InfluxDB
    uid: influxdb
    type: influxdb
    access: proxy
    url: http://127.0.0.1:{influx}
    isDefault: true
    jsonData:
      version: Flux
      organization: {org}
      defaultBucket: {bucket}
    secureJsonData:
      token: {token}
"#,
        influx = cfg.influx_port,
        org = cfg.org,
        bucket = cfg.bucket,
        token = cfg.token,
    )
}

/// Grafana dashboard provider: loads every dashboard JSON dropped into `dashboards_dir`.
pub fn grafana_dashboard_provider_yaml(dashboards_dir: &str) -> String {
    format!(
        r#"apiVersion: 1
providers:
  - name: stier-utilities
    type: file
    disableDeletion: false
    updateIntervalSeconds: 30
    options:
      path: {dir}
      foldersFromFilesStructure: true
"#,
        dir = dashboards_dir,
    )
}

/// The argv InfluxDB v2 (`influxd`) is launched with for a localhost, app-local instance.
pub fn influxd_args(cfg: &PackConfig, data_dir: &Path) -> Vec<String> {
    vec![
        "--http-bind-address".into(),
        format!("127.0.0.1:{}", cfg.influx_port),
        "--bolt-path".into(),
        data_dir.join("influxd.bolt").to_string_lossy().into_owned(),
        "--engine-path".into(),
        data_dir.join("engine").to_string_lossy().into_owned(),
        "--reporting-disabled".into(),
    ]
}

// ---------------------------------------------------------------------------
// Pack paths & status
// ---------------------------------------------------------------------------

/// Resolved on-disk layout for the pack under the app data dir.
pub struct PackPaths {
    pub root: PathBuf,
}

impl PackPaths {
    pub fn new(app_data_dir: &Path) -> Self {
        PackPaths {
            root: app_data_dir.join("observability"),
        }
    }
    pub fn bin_dir(&self) -> PathBuf {
        self.root.join("bin")
    }
    pub fn data_dir(&self) -> PathBuf {
        self.root.join("data")
    }
    pub fn config_dir(&self) -> PathBuf {
        self.root.join("config")
    }
    pub fn dashboards_dir(&self) -> PathBuf {
        self.root.join("config").join("dashboards")
    }
    /// Grafana's persistent state (grafana.db, logs, plugins) — kept OUTSIDE
    /// grafana-home so a Grafana version update (which replaces grafana-home)
    /// never wipes user dashboards/settings.
    pub fn grafana_data_dir(&self) -> PathBuf {
        self.root.join("grafana-data")
    }
    /// Path to a component binary (adds .exe on Windows).
    pub fn binary(&self, name: &str) -> PathBuf {
        let exe = if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.to_string()
        };
        self.bin_dir().join(exe)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackStatus {
    pub installed: bool,
    pub influx_present: bool,
    pub grafana_present: bool,
    pub telegraf_present: bool,
}

/// Inspect which component binaries are present on disk.
pub fn pack_status(paths: &PackPaths) -> PackStatus {
    let influx = paths.binary("influxd").exists();
    let grafana = paths.binary("grafana-server").exists() || paths.binary("grafana").exists();
    let telegraf = paths.binary("telegraf").exists();
    PackStatus {
        installed: influx && grafana && telegraf,
        influx_present: influx,
        grafana_present: grafana,
        telegraf_present: telegraf,
    }
}

// ---------------------------------------------------------------------------
// Line-protocol HTTP write (request builder + status parser are pure)
// ---------------------------------------------------------------------------

/// Minimal percent-encoding for query-string values (org/bucket are simple
/// identifiers, but be safe).
fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn build_write_request_to_port(cfg: &PackConfig, port: u16, body: &str) -> String {
    let path = format!(
        "/api/v2/write?org={}&bucket={}&precision=ns",
        percent_encode(&cfg.org),
        percent_encode(&cfg.bucket),
    );
    format!(
        "POST {path} HTTP/1.1\r\n\
         Host: 127.0.0.1:{port}\r\n\
         Authorization: Token {token}\r\n\
         Content-Type: text/plain; charset=utf-8\r\n\
         Content-Length: {len}\r\n\
         Connection: close\r\n\
         \r\n\
         {body}",
        port = port,
        token = cfg.token,
        len = body.len(),
        body = body,
    )
}

/// Build the raw HTTP/1.1 request text for an InfluxDB v2 line-protocol write.
pub fn build_write_request(cfg: &PackConfig, body: &str) -> String {
    build_write_request_to_port(cfg, cfg.influx_port, body)
}

fn build_telegraf_write_request(cfg: &PackConfig, body: &str) -> String {
    build_write_request_to_port(cfg, cfg.telegraf_listener_port, body)
}

/// Minimal JSON string escaping for the onboarding body.
fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// Build the HTTP/1.1 request for InfluxDB v2 initial onboarding (`/api/v2/setup`).
/// Sets the operator token to the app's pre-generated token so all later writes
/// (and Grafana's datasource) authenticate. `password` must be >= 8 chars.
pub fn build_setup_request(cfg: &PackConfig, username: &str, password: &str) -> String {
    let body = format!(
        r#"{{"username":"{u}","password":"{p}","org":"{o}","bucket":"{b}","token":"{t}"}}"#,
        u = json_escape(username),
        p = json_escape(password),
        o = json_escape(&cfg.org),
        b = json_escape(&cfg.bucket),
        t = json_escape(&cfg.token),
    );
    format!(
        "POST /api/v2/setup HTTP/1.1\r\n\
         Host: 127.0.0.1:{port}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {len}\r\n\
         Connection: close\r\n\
         \r\n\
         {body}",
        port = cfg.influx_port,
        len = body.len(),
        body = body,
    )
}

/// Build an authenticated GET used as a token-liveness probe (`/api/v2/buckets`).
pub fn build_buckets_request(cfg: &PackConfig) -> String {
    format!(
        "GET /api/v2/buckets?limit=1 HTTP/1.1\r\n\
         Host: 127.0.0.1:{port}\r\n\
         Authorization: Token {token}\r\n\
         Connection: close\r\n\
         \r\n",
        port = cfg.influx_port,
        token = cfg.token,
    )
}

pub fn build_query_request(cfg: &PackConfig, flux: &str) -> String {
    let path = format!("/api/v2/query?org={}", percent_encode(&cfg.org));
    let body = format!(r#"{{"query":"{}"}}"#, json_escape(flux));
    format!(
        "POST {path} HTTP/1.1\r\n\
         Host: 127.0.0.1:{port}\r\n\
         Authorization: Token {token}\r\n\
         Accept: application/csv\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {len}\r\n\
         Connection: close\r\n\
         \r\n\
         {body}",
        port = cfg.influx_port,
        token = cfg.token,
        len = body.len(),
        body = body,
    )
}

/// Parse the numeric status code out of an HTTP response's status line.
pub fn parse_http_status(response: &str) -> Option<u16> {
    let first = response.lines().next()?;
    let mut parts = first.split_whitespace();
    let _http = parts.next()?; // "HTTP/1.1"
    parts.next()?.parse::<u16>().ok()
}

/// Cap on how much of an HTTP response we buffer. The setup/write/health
/// responses are tiny; a Flux `/api/v2/query` could return a large CSV, so we
/// bound the read rather than pulling an unbounded amount into memory.
const MAX_HTTP_RESPONSE_BYTES: u64 = 8 * 1024 * 1024;

/// Send a pre-built request to 127.0.0.1:port and return (status, body). Integration
/// path — requires a listening InfluxDB. Times out quickly so the UI never hangs.
fn http_send(port: u16, request: &str) -> Result<(u16, String), String> {
    let mut stream =
        TcpStream::connect(("127.0.0.1", port)).map_err(|e| format!("connect failed: {e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;
    stream
        .write_all(request.as_bytes())
        .map_err(|e| format!("write failed: {e}"))?;
    // Every request we build sends `Connection: close`, so the server closes the
    // socket after the body and this read terminates at EOF. The `take` cap keeps
    // a large or runaway response from ballooning memory.
    let mut response = String::new();
    stream
        .take(MAX_HTTP_RESPONSE_BYTES)
        .read_to_string(&mut response)
        .map_err(|e| format!("read failed: {e}"))?;
    let status = parse_http_status(&response).ok_or("malformed HTTP response")?;
    Ok((status, response))
}

// ---------------------------------------------------------------------------
// Point DTO (from the frontend) -> typed Point
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct PointDto {
    pub measurement: String,
    #[serde(default)]
    pub tags: HashMap<String, String>,
    pub fields: HashMap<String, serde_json::Value>,
    /// Epoch milliseconds (JS Date.now()); converted to ns for the line.
    pub ts: Option<f64>,
}

fn field_from_json(v: &serde_json::Value) -> Option<FieldValue> {
    match v {
        serde_json::Value::Bool(b) => Some(FieldValue::Bool(*b)),
        serde_json::Value::String(s) => Some(FieldValue::Str(s.clone())),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                // Preserve integers as floats by default to avoid field-type conflicts
                // when a value is sometimes whole and sometimes fractional.
                Some(FieldValue::Float(i as f64))
            } else {
                n.as_f64().map(FieldValue::Float)
            }
        }
        _ => None,
    }
}

fn dto_to_point(dto: PointDto) -> Point {
    let tags = dto.tags.into_iter().collect::<Vec<_>>();
    let fields = dto
        .fields
        .iter()
        .filter_map(|(k, v)| field_from_json(v).map(|fv| (k.clone(), fv)))
        .collect::<Vec<_>>();
    let timestamp_ns = dto.ts.map(|ms| (ms * 1_000_000.0) as i64);
    Point {
        measurement: dto.measurement,
        tags,
        fields,
        timestamp_ns,
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Pick free localhost ports for the three services in one shot.
#[tauri::command]
pub fn observability_pick_ports() -> Result<PackConfig, String> {
    // `find_free_ports` guarantees exactly three ports on success.
    let ports = find_free_ports(3)?;
    Ok(PackConfig {
        influx_port: ports[0],
        grafana_port: ports[1],
        telegraf_listener_port: ports[2],
        ..PackConfig::default()
    })
}

/// Report which pack binaries are installed under the app data dir.
#[cfg(windows)]
#[tauri::command]
pub fn observability_status(app: tauri::AppHandle) -> Result<PackStatus, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?;
    Ok(pack_status(&PackPaths::new(&dir)))
}

/// Generate and write the pack's config files (Telegraf/Grafana/InfluxDB datasource
/// + dashboard provider) into the app data dir. Safe to call repeatedly.
#[cfg(windows)]
#[tauri::command]
pub fn observability_write_configs(
    app: tauri::AppHandle,
    config: PackConfig,
) -> Result<String, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?;
    let paths = PackPaths::new(&dir);
    write_pack_configs(&paths, &config)?;
    Ok(paths.config_dir().to_string_lossy().into_owned())
}

/// Write all generated config files to disk. Pure-ish (filesystem only) so it's
/// reused by the command and exercisable directly.
pub fn write_pack_configs(paths: &PackPaths, cfg: &PackConfig) -> Result<(), String> {
    std::fs::create_dir_all(paths.config_dir()).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(paths.dashboards_dir()).map_err(|e| e.to_string())?;
    let provisioning = paths.config_dir().join("provisioning").join("datasources");
    std::fs::create_dir_all(&provisioning).map_err(|e| e.to_string())?;
    let dash_prov = paths.config_dir().join("provisioning").join("dashboards");
    std::fs::create_dir_all(&dash_prov).map_err(|e| e.to_string())?;
    // Grafana also probes these provisioning dirs on startup; we don't ship any
    // plugin/alerting provisioning, but pre-creating them empty avoids the noisy
    // "cannot find the file specified" errors Grafana logs when they're missing.
    for sub in ["plugins", "alerting"] {
        std::fs::create_dir_all(paths.config_dir().join("provisioning").join(sub))
            .map_err(|e| e.to_string())?;
    }
    // Grafana's persistent state dir (survives version updates).
    std::fs::create_dir_all(paths.grafana_data_dir()).map_err(|e| e.to_string())?;
    // The external-plugins dir (grafana.ini `plugins = {data}/plugins`). We bundle
    // no plugins, but Grafana opens this path at startup to scan for them (including
    // the image renderer); if it's missing it logs `failed to open plugins path`
    // ("Failed to get renderer plugin sources"). Creating it empty silences that —
    // image rendering isn't used here (panels are embedded as live iframes).
    std::fs::create_dir_all(paths.grafana_data_dir().join("plugins")).map_err(|e| e.to_string())?;

    std::fs::write(paths.config_dir().join("telegraf.conf"), telegraf_conf(cfg))
        .map_err(|e| e.to_string())?;
    std::fs::write(
        paths.config_dir().join("grafana.ini"),
        grafana_ini(cfg, paths),
    )
    .map_err(|e| e.to_string())?;
    std::fs::write(
        provisioning.join("influxdb.yaml"),
        grafana_datasource_yaml(cfg),
    )
    .map_err(|e| e.to_string())?;
    std::fs::write(
        dash_prov.join("stier.yaml"),
        grafana_dashboard_provider_yaml(&paths.dashboards_dir().to_string_lossy()),
    )
    .map_err(|e| e.to_string())?;
    provision_dashboards(paths)?;
    Ok(())
}

/// The dashboards-as-code shipped with first-party tools. Compiled into the
/// binary so they're always available; written into the Grafana-provisioned
/// dashboards dir on every config write so upgrades refresh them. (Third-party
/// tools' dashboards would be copied from their bundle by the loader.)
const BUNDLED_DASHBOARDS: &[(&str, &str)] = &[
    (
        "netscan-hosts.json",
        include_str!("../../src/tools/dashboards/netscan-hosts.json"),
    ),
    (
        "bacnet-points.json",
        include_str!("../../src/tools/dashboards/bacnet-points.json"),
    ),
    (
        "device-health.json",
        include_str!("../../src/tools/dashboards/device-health.json"),
    ),
    (
        "building-workspace.json",
        include_str!("../../src/tools/dashboards/building-workspace.json"),
    ),
];

/// Write the bundled dashboard JSONs into the Grafana dashboards dir.
pub fn provision_dashboards(paths: &PackPaths) -> Result<(), String> {
    std::fs::create_dir_all(paths.dashboards_dir()).map_err(|e| e.to_string())?;
    for (name, json) in BUNDLED_DASHBOARDS {
        std::fs::write(paths.dashboards_dir().join(name), json).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Encode points to line protocol and POST them to the local InfluxDB. Returns the
/// number of points written. This is the backend behind the `timeseries` service's
/// InfluxDB transport (Phase 3); when the pack isn't running, the connect fails and
/// the frontend service keeps buffering.
#[tauri::command]
pub async fn timeseries_write(config: PackConfig, points: Vec<PointDto>) -> Result<usize, String> {
    // Blocking HTTP off the main thread (called on the flush interval).
    tauri::async_runtime::spawn_blocking(move || -> Result<usize, String> {
        let pts: Vec<Point> = points.into_iter().map(dto_to_point).collect();
        let total = pts.len();
        let (body, skipped) = to_line_protocol_batch(&pts);
        if body.is_empty() {
            return Ok(0);
        }
        let request = build_write_request(&config, &body);
        let (status, resp) = http_send(config.influx_port, &request)?;
        if (200..300).contains(&status) {
            // Report points actually encoded + sent, not the input count — the
            // encoder drops points it can't represent, so the input count would
            // overstate what landed in InfluxDB.
            Ok(total.saturating_sub(skipped))
        } else {
            Err(format!(
                "InfluxDB write returned HTTP {status}: {}",
                resp.lines().next().unwrap_or("")
            ))
        }
    })
    .await
    .map_err(|e| format!("write task panicked: {e}"))?
}

// ---------------------------------------------------------------------------
// Process supervision (integration — requires the downloaded binaries)
// ---------------------------------------------------------------------------

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use once_cell::sync::Lazy;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Default pinned versions for the on-demand download. Bumped deliberately.
pub const INFLUXDB_VERSION: &str = "2.7.5";
pub const TELEGRAF_VERSION: &str = "1.30.0";
pub const GRAFANA_VERSION: &str = "11.1.0";

#[derive(Default)]
struct Supervisor {
    influx: Option<Child>,
    grafana: Option<Child>,
    telegraf: Option<Child>,
}

static SUPERVISOR: Lazy<Mutex<Supervisor>> = Lazy::new(|| Mutex::new(Supervisor::default()));

/// Spawn a pack binary from the app config dir. Backend-only — paths are validated
/// before launch, so this does not go through the webview shell capability scope.
fn spawn_component(
    paths: &PackPaths,
    bin: &str,
    args: &[String],
) -> Result<Child, String> {
    let exe = paths.binary(bin);
    if !exe.exists() {
        return Err(format!(
            "{bin} is not installed (expected at {})",
            exe.display()
        ));
    }
    let mut cmd = Command::new(&exe);
    cmd.args(args)
        .current_dir(&paths.root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn()
        .map_err(|e| format!("failed to start {bin}: {e}"))
}

/// Whether a localhost TCP port currently accepts connections (a liveness proxy).
pub fn port_open(port: u16) -> bool {
    TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(400),
    )
    .is_ok()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackHealth {
    /// InfluxDB's port accepts connections (liveness).
    pub influx_up: bool,
    /// InfluxDB is onboarded AND the token authenticates (true readiness for writes).
    pub influx_ready: bool,
    /// Grafana's port accepts connections.
    pub grafana_up: bool,
    /// End-to-end metric ingest/query smoke test results.
    pub smoke: PackSmokeHealth,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackSmokeHealth {
    pub attempted: bool,
    pub direct_write: bool,
    pub direct_query: bool,
    pub telegraf_write: bool,
    pub telegraf_query: bool,
    pub error: Option<String>,
}

impl PackSmokeHealth {
    fn skipped(reason: &str) -> Self {
        PackSmokeHealth {
            attempted: false,
            direct_write: false,
            direct_query: false,
            telegraf_write: false,
            telegraf_query: false,
            error: Some(reason.to_string()),
        }
    }
}

/// True when the end-to-end health smoke (direct + Telegraf write/query) succeeded.
pub fn smoke_passed(smoke: &PackSmokeHealth) -> bool {
    smoke.attempted
        && smoke.direct_write
        && smoke.direct_query
        && smoke.telegraf_write
        && smoke.telegraf_query
}

/// Full Observability Pack bring-up for release validation: install (if needed),
/// write configs, start services, onboard InfluxDB, then run the health smoke test.
#[cfg(windows)]
pub async fn run_smoke_test(app: tauri::AppHandle) -> Result<PackHealth, String> {
    use crate::secrets;
    use tauri::Manager;

    async fn async_sleep(d: Duration) {
        let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await;
    }

    observability_install(app.clone()).await?;

    let mut config = match observability_load_config(app.clone())? {
        Some(config) => config,
        None => observability_pick_ports()?,
    };
    if config.token.is_empty() {
        let dir = app
            .path()
            .app_config_dir()
            .map_err(|e| format!("could not resolve app data dir: {e}"))?;
        config.token = secrets::get_or_create_token(&dir.join("secrets.json"))?;
    }
    observability_save_config(app.clone(), config.clone())?;
    observability_write_configs(app.clone(), config.clone())?;
    observability_start(app.clone(), config.clone()).await?;

    let mut influx_up = false;
    for _ in 0..60 {
        if port_open(config.influx_port) {
            influx_up = true;
            break;
        }
        async_sleep(Duration::from_secs(1)).await;
    }
    if !influx_up {
        return Err("InfluxDB did not become reachable within 60s".into());
    }

    observability_onboard(config.clone()).await?;

    for _ in 0..30 {
        let health = observability_health(config.clone()).await;
        if health.influx_ready && health.smoke.attempted {
            return Ok(health);
        }
        async_sleep(Duration::from_secs(2)).await;
    }

    Ok(observability_health(config).await)
}

fn smoke_run_id(prefix: &str) -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    format!("{prefix}_{millis}")
}

fn query_smoke_point(cfg: &PackConfig, measurement: &str, run: &str) -> Result<bool, String> {
    let flux = format!(
        r#"from(bucket: "{}") |> range(start: -30m) |> filter(fn: (r) => r._measurement == "{}" and r.source == "health" and r.run == "{}") |> last()"#,
        cfg.bucket, measurement, run
    );
    let (status, resp) = http_send(cfg.influx_port, &build_query_request(cfg, &flux))?;
    if !(200..300).contains(&status) {
        return Err(format!(
            "query returned HTTP {status}: {}",
            resp.lines().next().unwrap_or("")
        ));
    }
    Ok(resp.contains(measurement) && resp.contains(run))
}

fn run_pack_smoke(cfg: &PackConfig) -> PackSmokeHealth {
    let direct_run = smoke_run_id("direct");
    let direct_body = format!("stier_health_smoke,source=health,run={direct_run} value=1");
    let mut smoke = PackSmokeHealth {
        attempted: true,
        direct_write: false,
        direct_query: false,
        telegraf_write: false,
        telegraf_query: false,
        error: None,
    };

    match http_send(cfg.influx_port, &build_write_request(cfg, &direct_body)) {
        Ok((s, _resp)) if (200..300).contains(&s) => {
            smoke.direct_write = true;
            match query_smoke_point(cfg, "stier_health_smoke", &direct_run) {
                Ok(found) => smoke.direct_query = found,
                Err(e) => smoke.error = Some(e),
            }
        }
        Ok((s, resp)) => {
            smoke.error = Some(format!(
                "direct write returned HTTP {s}: {}",
                resp.lines().next().unwrap_or("")
            ));
            return smoke;
        }
        Err(e) => {
            smoke.error = Some(e);
            return smoke;
        }
    }

    if !port_open(cfg.telegraf_listener_port) {
        smoke
            .error
            .get_or_insert_with(|| "Telegraf listener is down".to_string());
        return smoke;
    }

    let telegraf_run = smoke_run_id("telegraf");
    let telegraf_body =
        format!("stier_health_smoke_telegraf,source=health,run={telegraf_run} value=1");
    match http_send(
        cfg.telegraf_listener_port,
        &build_telegraf_write_request(cfg, &telegraf_body),
    ) {
        Ok((s, _resp)) if (200..300).contains(&s) => {
            smoke.telegraf_write = true;
            for _ in 0..20 {
                match query_smoke_point(cfg, "stier_health_smoke_telegraf", &telegraf_run) {
                    Ok(true) => {
                        smoke.telegraf_query = true;
                        break;
                    }
                    Ok(false) => std::thread::sleep(Duration::from_millis(500)),
                    Err(e) => {
                        smoke.error = Some(e);
                        break;
                    }
                }
            }
            if smoke.telegraf_write && !smoke.telegraf_query && smoke.error.is_none() {
                smoke.error = Some(
                    "Telegraf write accepted but query did not return the point yet".to_string(),
                );
            }
        }
        Ok((s, resp)) => {
            smoke.error = Some(format!(
                "Telegraf write returned HTTP {s}: {}",
                resp.lines().next().unwrap_or("")
            ));
        }
        Err(e) => smoke.error = Some(e),
    }

    smoke
}

/// Probe pack health. `influx_up`/`grafana_up` are TCP liveness; `influx_ready`
/// additionally confirms the token authenticates an API call, so the UI doesn't
/// report "connected" against an un-onboarded InfluxDB.
#[tauri::command]
pub async fn observability_health(config: PackConfig) -> PackHealth {
    // Off the main thread: the authed buckets probe can block on a slow port.
    tauri::async_runtime::spawn_blocking(move || {
        let influx_up = port_open(config.influx_port);
        let influx_ready = influx_up
            && !config.token.is_empty()
            && matches!(
                http_send(config.influx_port, &build_buckets_request(&config)),
                Ok((s, _)) if (200..300).contains(&s)
            );
        let smoke = if influx_ready {
            run_pack_smoke(&config)
        } else {
            PackSmokeHealth::skipped("InfluxDB is not ready")
        };
        PackHealth {
            influx_up,
            influx_ready,
            grafana_up: port_open(config.grafana_port),
            smoke,
        }
    })
    .await
    .unwrap_or(PackHealth {
        influx_up: false,
        influx_ready: false,
        grafana_up: false,
        smoke: PackSmokeHealth::skipped("Health check failed"),
    })
}

/// One-time InfluxDB v2 onboarding (`/api/v2/setup`): makes the app's pre-generated
/// token the operator token so writes + Grafana authenticate. Idempotent — HTTP 422
/// ("already set up") is treated as success. Requires influxd to be up.
#[tauri::command]
pub async fn observability_onboard(config: PackConfig) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<bool, String> {
        if config.token.is_empty() {
            return Err("no InfluxDB token configured".into());
        }
        // username/password are required by setup; the operator token is what we use.
        // The password is bcrypt-hashed by InfluxDB, which rejects inputs over 72
        // bytes — so derive a short password from the token (the token field below
        // still sets the full operator token). Take chars, not bytes, so a token
        // with a multi-byte char at the 32-byte boundary can't panic the slice.
        let password: String = config.token.chars().take(32).collect();
        let request = build_setup_request(&config, "stier", &password);
        let (status, resp) = http_send(config.influx_port, &request)?;
        match status {
            s if (200..300).contains(&s) => Ok(true),
            422 => Ok(true), // already onboarded
            s => Err(format!(
                "InfluxDB setup returned HTTP {s}: {}",
                resp.lines().next().unwrap_or("")
            )),
        }
    })
    .await
    .map_err(|e| format!("onboard task panicked: {e}"))?
}

/// The download URLs for all three components at this OS/arch.
#[cfg(test)]
pub fn observability_download_urls() -> Result<Vec<DownloadAsset>, String> {
    let (os, arch) = current_os_arch();
    Ok(vec![
        download_asset("influxdb", INFLUXDB_VERSION, os, arch)?,
        download_asset("telegraf", TELEGRAF_VERSION, os, arch)?,
        download_asset("grafana", GRAFANA_VERSION, os, arch)?,
    ])
}

/// Start the three pack services (writing fresh configs first). Best-effort:
/// returns an error naming any component that isn't installed/failed to launch.
#[cfg(windows)]
#[tauri::command]
pub async fn observability_start(app: tauri::AppHandle, config: PackConfig) -> Result<(), String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?;
    let paths = PackPaths::new(&dir);
    write_pack_configs(&paths, &config)?;
    std::fs::create_dir_all(paths.data_dir()).map_err(|e| e.to_string())?;

    let mut sup = SUPERVISOR.lock().map_err(|_| "supervisor lock poisoned")?;

    if sup.influx.is_none() && !port_open(config.influx_port) {
        sup.influx = Some(spawn_component(
            &paths,
            "influxd",
            &influxd_args(&config, &paths.data_dir()),
        )?);
    }
    if sup.telegraf.is_none() && !port_open(config.telegraf_listener_port) {
        let conf = paths
            .config_dir()
            .join("telegraf.conf")
            .to_string_lossy()
            .into_owned();
        sup.telegraf = Some(spawn_component(
            &paths,
            "telegraf",
            &["--config".into(), conf],
        )?);
    }
    if sup.grafana.is_none() && !port_open(config.grafana_port) {
        let ini = paths
            .config_dir()
            .join("grafana.ini")
            .to_string_lossy()
            .into_owned();
        let home = paths
            .root
            .join("grafana-home")
            .to_string_lossy()
            .into_owned();
        sup.grafana = Some(spawn_component(
            &paths,
            "grafana",
            &[
                "server".into(),
                "--config".into(),
                ini,
                "--homepath".into(),
                home,
            ],
        )?);
    }
    Ok(())
}

/// Drain + reap all supervised pack children.
/// an install/update that may need to replace a running binary.
fn stop_services() {
    if let Ok(mut sup) = SUPERVISOR.lock() {
        for mut c in [sup.influx.take(), sup.telegraf.take(), sup.grafana.take()]
            .into_iter()
            .flatten()
        {
            let _ = c.kill();
        }
    }
}

/// Stop any running pack services.
#[tauri::command]
pub fn observability_stop() -> Result<(), String> {
    stop_services();
    Ok(())
}

// ---------------------------------------------------------------------------
// Pack component versions (so updates can be detected and applied)
// ---------------------------------------------------------------------------

/// (component, pinned version, exe-base-name) for the three pack services.
fn pinned_components() -> [(&'static str, &'static str, &'static str); 3] {
    [
        ("influxdb", INFLUXDB_VERSION, "influxd"),
        ("telegraf", TELEGRAF_VERSION, "telegraf"),
        ("grafana", GRAFANA_VERSION, "grafana"),
    ]
}

fn versions_path(paths: &PackPaths) -> PathBuf {
    paths.bin_dir().join("versions.json")
}

/// Component -> installed version, recorded at install time next to the binaries.
fn load_versions(paths: &PackPaths) -> HashMap<String, String> {
    std::fs::read_to_string(versions_path(paths))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_versions(paths: &PackPaths, versions: &HashMap<String, String>) -> Result<(), String> {
    std::fs::create_dir_all(paths.bin_dir()).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(versions).map_err(|e| e.to_string())?;
    std::fs::write(versions_path(paths), json).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentStatus {
    pub name: String,
    pub present: bool,
    pub installed_version: String,
    pub pinned_version: String,
    pub needs_update: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackVersionStatus {
    /// All three components are present and at the pinned version.
    pub installed: bool,
    /// A present component is at an older version than pinned.
    pub updates_available: bool,
    pub components: Vec<ComponentStatus>,
}

/// Compare installed (bin/versions.json + binary presence) vs pinned versions.
fn compute_pack_status(paths: &PackPaths) -> PackVersionStatus {
    let versions = load_versions(paths);
    let mut components = Vec::new();
    let mut all_ready = true;
    let mut updates = false;
    for (name, pinned, exe) in pinned_components() {
        let present = paths.binary(exe).exists();
        let installed = versions.get(name).cloned().unwrap_or_default();
        // A present binary with no recorded version (installed before version
        // tracking) is assumed current, so we don't spuriously re-download it.
        let needs_update = !present || (!installed.is_empty() && installed != pinned);
        if needs_update {
            all_ready = false;
        }
        if present && !installed.is_empty() && installed != pinned {
            updates = true;
        }
        components.push(ComponentStatus {
            name: name.to_string(),
            present,
            installed_version: installed,
            pinned_version: pinned.to_string(),
            needs_update,
        });
    }
    PackVersionStatus {
        installed: all_ready,
        updates_available: updates,
        components,
    }
}

/// Whether a component is installed and current and (for grafana) has its home
/// dir, so the installer can skip it. A present binary with no recorded version
/// (pre-tracking install) is assumed current.
fn is_up_to_date(
    paths: &PackPaths,
    component: &str,
    version: &str,
    exe: &str,
    versions: &HashMap<String, String>,
) -> bool {
    if !paths.binary(exe).exists() {
        return false;
    }
    if !versions
        .get(component)
        .map(|v| v == version)
        .unwrap_or(true)
    {
        return false;
    }
    // grafana also needs its home dir, or it can't start despite the exe being present.
    if component == "grafana" && !paths.root.join("grafana-home").exists() {
        return false;
    }
    true
}

/// Report installed vs pinned versions for each pack component (drives the
/// "update available" UI). Pinned versions ship with the app, so an app update
/// that bumps them surfaces here and is applied by the next install/update.
#[cfg(windows)]
#[tauri::command]
pub fn observability_pack_status(app: tauri::AppHandle) -> Result<PackVersionStatus, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?;
    Ok(compute_pack_status(&PackPaths::new(&dir)))
}

// ---------------------------------------------------------------------------
// Install (download + extract). Windows-native via curl.exe + Expand-Archive,
// so no new crates are pulled in. The tree-search helpers are pure/unit-tested;
// the network + extraction are integration (need a real download).
// ---------------------------------------------------------------------------

/// Recursively find a file (case-insensitive) under `root`. Used to locate the
/// component exe inside an extracted archive's (versioned) directory tree.
pub fn find_in_tree(root: &Path, filename: &str) -> Option<PathBuf> {
    let mut subdirs = Vec::new();
    for entry in std::fs::read_dir(root).ok()?.flatten() {
        let p = entry.path();
        if p.is_dir() {
            subdirs.push(p);
        } else if p
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.eq_ignore_ascii_case(filename))
            .unwrap_or(false)
        {
            return Some(p);
        }
    }
    for d in subdirs {
        if let Some(found) = find_in_tree(&d, filename) {
            return Some(found);
        }
    }
    None
}

/// Recursively copy a directory tree (used to lay down Grafana's home dir).
pub fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Pinned SHA-256 for a downloaded archive. These are the authoritative vendor
/// checksums for the Windows amd64 assets at the versions in `pinned_components`
/// (the installer only runs on Windows — see `install_blocking`). Pinning here
/// establishes trust at build time, so a compromised/MITM'd mirror can't slip in
/// a different binary. Update these in lockstep with INFLUXDB/TELEGRAF/GRAFANA
/// _VERSION. An unknown component returns None, which the installer treats as a
/// hard error (fail closed) rather than running an unverified binary.
fn pinned_sha256(component: &str) -> Option<&'static str> {
    match component {
        // influxdb2-2.7.5-windows.zip
        "influxdb" => Some("93fc7c675bf7830c7b6a1108ae149ec45852eb6c771765583d4a5825c7cfaeac"),
        // telegraf-1.30.0_windows_amd64.zip
        "telegraf" => Some("5fee5b7ec9f47bf85b14f6146b028352dc54041b4854befaed3d8bd50eed7efe"),
        // grafana-11.1.0.windows-amd64.zip (vendor-published .sha256)
        "grafana" => Some("a55788ca49554cf0a0c7f0b017bdfc108cc6007e0898ac80cbddf72317cab9b8"),
        _ => None,
    }
}

/// Replace `dst` with `src`. If `dst` is a running (locked) binary, rename it
/// aside — Windows allows renaming a running exe — and copy the new one into
/// place, taking effect on the next start.
#[cfg(windows)]
fn replace_binary(src: &Path, dst: &Path) -> Result<(), String> {
    if dst.exists() && std::fs::remove_file(dst).is_err() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let aside = dst.with_file_name(format!(
            "{}.old-{}-{}",
            dst.file_name().and_then(|n| n.to_str()).unwrap_or("bin"),
            std::process::id(),
            nanos,
        ));
        std::fs::rename(dst, &aside).map_err(|e| {
            format!(
                "cannot replace {} (a previous instance may be running — restart the app): {e}",
                dst.display()
            )
        })?;
    }
    std::fs::copy(src, dst).map_err(|e| format!("copy to {} failed: {e}", dst.display()))?;
    Ok(())
}

/// Best-effort removal of leftover ".old-*" binaries from a prior in-place update.
#[cfg(windows)]
fn cleanup_old_binaries(paths: &PackPaths) {
    if let Ok(entries) = std::fs::read_dir(paths.bin_dir()) {
        for e in entries.flatten() {
            if e.file_name().to_string_lossy().contains(".old-") {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
}

#[cfg(windows)]
fn run_tool(program: &str, args: &[&str]) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let out = Command::new(program)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("failed to run {program}: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "{program} failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

/// Parse one curl progress-meter line into (percent, totalSize, received, rate, eta).
/// Columns: %Total Total %Recv Recv %Xferd Xferd Dload Upload TimeTotal TimeSpent TimeLeft CurSpeed
fn parse_curl_meter(line: &str) -> Option<(f64, String, String, String, String)> {
    let t: Vec<&str> = line.split_whitespace().collect();
    if t.len() < 12 {
        return None;
    }
    let percent = t[0].parse::<f64>().ok()?;
    Some((
        percent,
        t[1].to_string(),
        t[3].to_string(),
        t[11].to_string(),
        t[10].to_string(),
    ))
}

/// Download `url` to `out` with curl, streaming live progress (percent, bytes,
/// rate, ETA) to the frontend via `observability://install` "download" events.
#[cfg(windows)]
fn curl_download_with_progress(
    app: &tauri::AppHandle,
    component: &str,
    index: usize,
    total: usize,
    url: &str,
    out: &Path,
) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use tauri::Emitter;

    let mut child = Command::new("curl.exe")
        // No --silent: curl writes its progress meter to stderr, which we parse.
        .args([
            "-L",
            "--fail",
            "--show-error",
            "-o",
            &out.to_string_lossy(),
            url,
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("failed to run curl: {e}"))?;

    let mut err_tail: Vec<String> = Vec::new();
    if let Some(mut stderr) = child.stderr.take() {
        let mut acc = String::new();
        let mut chunk = [0u8; 4096];
        loop {
            let n = match stderr.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => n,
                Err(_) => break,
            };
            acc.push_str(&String::from_utf8_lossy(&chunk[..n]));
            // curl rewrites the meter line with '\r'; split on both '\r' and '\n'.
            while let Some(pos) = acc.find(['\r', '\n']) {
                let seg: String = acc.drain(..=pos).collect();
                let seg = seg.trim();
                if seg.is_empty() {
                    continue;
                }
                if let Some((percent, size, received, rate, eta)) = parse_curl_meter(seg) {
                    let _ = app.emit(
                        "observability://install",
                        serde_json::json!({
                            "component": component, "step": "download", "index": index, "total": total,
                            "percent": percent, "size": size, "received": received, "rate": rate, "eta": eta,
                        }),
                    );
                } else if !seg.starts_with('%') && !seg.contains("Dload") {
                    // keep non-meter lines (e.g. curl errors) for diagnostics
                    err_tail.push(seg.to_string());
                    if err_tail.len() > 6 {
                        err_tail.remove(0);
                    }
                }
            }
        }
    }

    let status = child.wait().map_err(|e| format!("curl wait failed: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "download of {component} failed (curl exit {}){}",
            status.code().unwrap_or(-1),
            if err_tail.is_empty() {
                String::new()
            } else {
                format!(": {}", err_tail.join(" "))
            },
        ))
    }
}

#[cfg(windows)]
fn extract_archive(archive: &Path, dest: &Path) -> Result<(), String> {
    // Use Windows' built-in bsdtar (tar.exe), NOT PowerShell 5.1 Expand-Archive:
    // Expand-Archive silently fails on Grafana's deep (>260-char MAX_PATH) entries
    // — it leaves an empty directory but still exits 0. tar.exe is long-path-aware
    // and ~15x faster.
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    run_tool(
        "tar.exe",
        &[
            "-xf",
            &archive.to_string_lossy(),
            "-C",
            &dest.to_string_lossy(),
        ],
    )
}

#[cfg(windows)]
fn verify_sha256(path: &Path, expected: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let script = format!(
        "(Get-FileHash -Algorithm SHA256 -LiteralPath '{}').Hash",
        path.display().to_string().replace('\'', "''"),
    );
    let out = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| e.to_string())?;
    let got = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if got.eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err(format!("sha256 mismatch: expected {expected}, got {got}"))
    }
}

/// Download + extract the three pack binaries into `bin/` (and Grafana's home).
/// Streams `observability://install` progress events. Returns the resulting status.
#[cfg(windows)]
#[tauri::command]
pub async fn observability_install(app: tauri::AppHandle) -> Result<PackStatus, String> {
    // Run the ~400 MB download + extract off the main thread so the UI never freezes.
    tauri::async_runtime::spawn_blocking(move || install_blocking(app))
        .await
        .map_err(|e| format!("install task panicked: {e}"))?
}

#[cfg(windows)]
fn install_blocking(app: tauri::AppHandle) -> Result<PackStatus, String> {
    use tauri::{Emitter, Manager};
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?;
    let paths = PackPaths::new(&dir);
    std::fs::create_dir_all(paths.bin_dir()).map_err(|e| e.to_string())?;
    let dl = paths.root.join("download");
    std::fs::create_dir_all(&dl).map_err(|e| e.to_string())?;

    let (os, arch) = current_os_arch();
    let components = pinned_components();
    let total = components.len();
    let mut versions = load_versions(&paths);

    // Decide per component up front so we only stop running services when at least
    // one binary actually needs replacing (avoids needless restarts of healthy,
    // up-to-date services).
    let plan: Vec<bool> = components
        .iter()
        .map(|(c, v, e)| is_up_to_date(&paths, c, v, e, &versions))
        .collect();
    if plan.iter().any(|ok| !ok) {
        stop_services();
        cleanup_old_binaries(&paths);
    }

    for (i, (component, version, exe)) in components.iter().enumerate() {
        let emit = |step: &str| {
            let _ = app.emit(
                "observability://install",
                serde_json::json!({ "component": component, "step": step, "index": i, "total": total }),
            );
        };

        if plan[i] {
            // Present + current. Backfill the version record if it was missing
            // (pre-tracking install) so future updates are detected.
            if !versions.contains_key(*component) {
                versions.insert((*component).to_string(), (*version).to_string());
                let _ = save_versions(&paths, &versions);
            }
            emit("already-installed");
            continue;
        }

        emit("download");
        let asset = download_asset(component, version, os, arch)?;
        let archive_path = dl.join(format!("{component}.{}", asset.archive));
        curl_download_with_progress(&app, component, i, total, &asset.url, &archive_path)?;

        emit("verify");
        let expected = pinned_sha256(component).ok_or_else(|| {
            format!("refusing to install {component} {version}: no pinned SHA-256 to verify the download against")
        })?;
        verify_sha256(&archive_path, expected)?;

        emit("extract");
        let extract_dir = dl.join(component);
        let _ = std::fs::remove_dir_all(&extract_dir);
        extract_archive(&archive_path, &extract_dir)?;

        emit("install");
        let exe_file = format!("{exe}.exe");
        let found = find_in_tree(&extract_dir, &exe_file)
            .ok_or_else(|| format!("{exe_file} not found in extracted {component} archive"))?;
        replace_binary(&found, &paths.binary(exe))?;

        // Grafana needs its full home (bin/ + public/ + conf/) for `--homepath`.
        // Persistent state lives in grafana-data (see grafana_ini), so replacing
        // grafana-home does not lose dashboards/settings.
        if *component == "grafana" {
            let home_src = found
                .parent()
                .and_then(|p| p.parent())
                .ok_or("unexpected grafana archive layout")?;
            let home_dst = paths.root.join("grafana-home");
            if home_dst.exists() {
                std::fs::remove_dir_all(&home_dst).map_err(|e| {
                    format!("cannot replace grafana-home (a previous Grafana may be running — restart the app): {e}")
                })?;
            }
            copy_dir_all(home_src, &home_dst)
                .map_err(|e| format!("grafana-home copy failed: {e}"))?;
        }

        // Record the installed version so future runs can detect updates (fail
        // loudly if it can't persist, so disk and the record don't diverge).
        versions.insert((*component).to_string(), (*version).to_string());
        save_versions(&paths, &versions)
            .map_err(|e| format!("recording installed version failed: {e}"))?;
        emit("done");
    }

    let _ = std::fs::remove_dir_all(&dl);
    Ok(pack_status(&paths))
}

// ---------------------------------------------------------------------------
// Pack config persistence (so ports/token survive restarts)
// ---------------------------------------------------------------------------

#[cfg(windows)]
fn pack_config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("observability")
        .join("pack-config.json"))
}

/// Load the persisted pack config (ports + token + org/bucket), or None.
#[cfg(windows)]
#[tauri::command]
pub fn observability_load_config(app: tauri::AppHandle) -> Result<Option<PackConfig>, String> {
    let path = pack_config_path(&app)?;
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(serde_json::from_str(&s).ok()),
        Err(_) => Ok(None),
    }
}

/// Persist the pack config so a restart reuses the same ports + data dir.
#[cfg(windows)]
#[tauri::command]
pub fn observability_save_config(app: tauri::AppHandle, config: PackConfig) -> Result<(), String> {
    let path = pack_config_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> PackConfig {
        PackConfig {
            influx_port: 8086,
            grafana_port: 3000,
            telegraf_listener_port: 8186,
            org: "stier".into(),
            bucket: "utilities".into(),
            token: "secret-token".into(),
        }
    }

    #[test]
    fn smoke_passed_requires_all_four_checks() {
        assert!(smoke_passed(&PackSmokeHealth {
            attempted: true,
            direct_write: true,
            direct_query: true,
            telegraf_write: true,
            telegraf_query: true,
            error: None,
        }));
        assert!(!smoke_passed(&PackSmokeHealth {
            attempted: true,
            direct_write: true,
            direct_query: true,
            telegraf_write: false,
            telegraf_query: false,
            error: None,
        }));
    }

    #[test]
    fn port_open_detects_a_listener() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(
            port_open(port),
            "a bound listener's port should read as open"
        );
    }

    #[test]
    fn download_urls_cover_all_three_components() {
        let urls = observability_download_urls().unwrap();
        assert_eq!(urls.len(), 3);
        assert!(urls.iter().any(|a| a.url.contains("influxdb2-")));
        assert!(urls.iter().any(|a| a.url.contains("telegraf-")));
        assert!(urls.iter().any(|a| a.url.contains("grafana-")));
    }

    #[test]
    fn find_free_ports_returns_distinct_ports() {
        let ports = find_free_ports(3).unwrap();
        assert_eq!(ports.len(), 3);
        assert_ne!(ports[0], ports[1]);
        assert_ne!(ports[1], ports[2]);
        assert_ne!(ports[0], ports[2]);
    }

    #[test]
    fn download_urls_per_component_and_os() {
        let win = download_asset("influxdb", "2.7.5", "windows", "amd64").unwrap();
        assert_eq!(win.archive, "zip");
        // InfluxData's Windows asset uses the hyphen/no-arch form; the _windows_amd64 form 404s.
        assert!(
            win.url.ends_with("influxdb2-2.7.5-windows.zip"),
            "got {}",
            win.url
        );
        let lin_influx = download_asset("influxdb", "2.7.5", "linux", "amd64").unwrap();
        assert!(
            lin_influx
                .url
                .ends_with("influxdb2-2.7.5_linux_amd64.tar.gz"),
            "got {}",
            lin_influx.url
        );

        let lin = download_asset("telegraf", "1.30.0", "linux", "amd64").unwrap();
        assert_eq!(lin.archive, "tar.gz");
        assert!(lin.url.contains("telegraf-1.30.0_linux_amd64.tar.gz"));

        let graf = download_asset("grafana", "11.0.0", "windows", "amd64").unwrap();
        assert!(graf.url.contains("grafana-11.0.0.windows-amd64.zip"));

        assert!(download_asset("nope", "1", "linux", "amd64").is_err());
    }

    #[test]
    fn telegraf_conf_wires_output_and_listener() {
        let c = telegraf_conf(&cfg());
        assert!(c.contains("urls = [\"http://127.0.0.1:8086\"]"));
        assert!(c.contains("token = \"secret-token\""));
        assert!(c.contains("bucket = \"utilities\""));
        assert!(c.contains("service_address = \"127.0.0.1:8186\""));
        assert!(c.contains("flush_interval = \"2s\""));
    }

    #[test]
    fn grafana_ini_is_localhost_embeddable_and_persists_data_outside_home() {
        let paths = PackPaths::new(Path::new("/app"));
        let c = grafana_ini(&cfg(), &paths);
        assert!(c.contains("http_addr = 127.0.0.1"));
        assert!(c.contains("http_port = 3000"));
        assert!(c.contains("allow_embedding = true"));
        assert!(c.contains("org_role = Viewer"));
        // data + provisioning live OUTSIDE grafana-home (so updates don't wipe them
        // and our provisioned datasource/dashboards are actually loaded).
        assert!(c.contains("[paths]"));
        assert!(c.contains("data = /app/observability/grafana-data"));
        assert!(c.contains("provisioning = /app/observability/config/provisioning"));
        assert!(
            !c.contains("grafana-home"),
            "data/provisioning must not be under grafana-home"
        );
    }

    #[test]
    fn is_up_to_date_checks_version_and_grafana_home() {
        let dir = std::env::temp_dir().join(format!("stier_obs_utd_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let paths = PackPaths::new(&dir);
        std::fs::create_dir_all(paths.bin_dir()).unwrap();
        let mut v = std::collections::HashMap::new();

        // influxd present + matching version (no home requirement) -> up to date.
        std::fs::write(paths.binary("influxd"), b"x").unwrap();
        v.insert("influxdb".to_string(), "2.7.5".to_string());
        assert!(is_up_to_date(&paths, "influxdb", "2.7.5", "influxd", &v));
        // version mismatch -> not up to date.
        assert!(!is_up_to_date(&paths, "influxdb", "2.7.6", "influxd", &v));

        // grafana present + matching version but NO grafana-home -> not up to date.
        std::fs::write(paths.binary("grafana"), b"x").unwrap();
        v.insert("grafana".to_string(), "11.1.0".to_string());
        assert!(!is_up_to_date(&paths, "grafana", "11.1.0", "grafana", &v));
        // create grafana-home -> up to date.
        std::fs::create_dir_all(paths.root.join("grafana-home")).unwrap();
        assert!(is_up_to_date(&paths, "grafana", "11.1.0", "grafana", &v));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn grafana_datasource_points_at_influx() {
        let c = grafana_datasource_yaml(&cfg());
        assert!(c.contains("url: http://127.0.0.1:8086"));
        assert!(c.contains("organization: stier"));
        assert!(c.contains("token: secret-token"));
    }

    #[test]
    fn influxd_args_bind_localhost() {
        let args = influxd_args(&cfg(), Path::new("/data"));
        assert!(args.contains(&"--http-bind-address".to_string()));
        assert!(args.iter().any(|a| a == "127.0.0.1:8086"));
        assert!(args.iter().any(|a| a.contains("influxd.bolt")));
    }

    #[test]
    fn write_request_has_auth_and_content_length() {
        let body = "m,device=1 v=2.0";
        let req = build_write_request(&cfg(), body);
        assert!(
            req.starts_with("POST /api/v2/write?org=stier&bucket=utilities&precision=ns HTTP/1.1")
        );
        assert!(req.contains("Authorization: Token secret-token"));
        assert!(req.contains(&format!("Content-Length: {}", body.len())));
        assert!(req.ends_with(body));
    }

    #[test]
    fn parse_status_reads_code() {
        assert_eq!(
            parse_http_status("HTTP/1.1 204 No Content\r\n\r\n"),
            Some(204)
        );
        assert_eq!(
            parse_http_status("HTTP/1.1 401 Unauthorized\r\n"),
            Some(401)
        );
        assert_eq!(parse_http_status("garbage"), None);
    }

    #[test]
    fn percent_encode_escapes_specials() {
        assert_eq!(percent_encode("a b/c"), "a%20b%2Fc");
        assert_eq!(percent_encode("simple_org.1"), "simple_org.1");
    }

    #[test]
    fn pack_paths_layout() {
        let paths = PackPaths::new(Path::new("/app"));
        assert!(
            paths.bin_dir().ends_with("observability/bin")
                || paths.bin_dir().ends_with("observability\\bin")
        );
        let influx = paths.binary("influxd");
        if cfg!(windows) {
            assert!(influx.to_string_lossy().ends_with("influxd.exe"));
        } else {
            assert!(influx.to_string_lossy().ends_with("influxd"));
        }
    }

    #[test]
    fn dto_converts_fields_and_timestamp() {
        let dto = PointDto {
            measurement: "m".into(),
            tags: HashMap::from([("d".into(), "1".into())]),
            fields: HashMap::from([
                ("v".into(), serde_json::json!(72.5)),
                ("n".into(), serde_json::json!(3)),
                ("ok".into(), serde_json::json!(true)),
                ("s".into(), serde_json::json!("hi")),
            ]),
            ts: Some(1000.0),
        };
        let p = dto_to_point(dto);
        assert_eq!(p.measurement, "m");
        assert_eq!(p.timestamp_ns, Some(1_000_000_000)); // 1000 ms -> ns
        assert_eq!(p.tags, vec![("d".to_string(), "1".to_string())]);
        assert_eq!(p.fields.len(), 4);
        // integer json becomes a float field to keep types stable
        assert!(p
            .fields
            .iter()
            .any(|(k, v)| k == "n" && *v == FieldValue::Float(3.0)));
    }

    #[test]
    fn json_escape_handles_quotes_and_backslashes() {
        assert_eq!(json_escape(r#"a"b\c"#), r#"a\"b\\c"#);
        assert_eq!(json_escape("plain"), "plain");
    }

    #[test]
    fn setup_request_carries_org_bucket_token() {
        let req = build_setup_request(&cfg(), "stier", "secret-token");
        assert!(req.starts_with("POST /api/v2/setup HTTP/1.1"));
        assert!(req.contains("Content-Type: application/json"));
        assert!(req.contains(r#""org":"stier""#));
        assert!(req.contains(r#""bucket":"utilities""#));
        assert!(req.contains(r#""token":"secret-token""#));
        // Content-Length must equal the JSON body length.
        let body = req.split("\r\n\r\n").nth(1).unwrap();
        assert!(req.contains(&format!("Content-Length: {}", body.len())));
    }

    #[test]
    fn buckets_request_is_authenticated_get() {
        let req = build_buckets_request(&cfg());
        assert!(req.starts_with("GET /api/v2/buckets?limit=1 HTTP/1.1"));
        assert!(req.contains("Authorization: Token secret-token"));
    }

    #[test]
    fn query_request_posts_flux_json() {
        let req = build_query_request(
            &cfg(),
            r#"from(bucket: "utilities") |> range(start: -5m)"#,
        );
        assert!(req.starts_with("POST /api/v2/query?org=stier HTTP/1.1"));
        assert!(req.contains("Accept: application/csv"));
        assert!(req.contains("Content-Type: application/json"));
        assert!(req.contains(
            r#""query":"from(bucket: \"utilities\") |> range(start: -5m)""#
        ));
    }

    #[test]
    fn datasource_yaml_has_uid_for_dashboard_refs() {
        assert!(grafana_datasource_yaml(&cfg()).contains("uid: influxdb"));
    }

    #[test]
    fn provision_dashboards_writes_bundled_json() {
        let dir = std::env::temp_dir().join(format!("stier_obs_dash_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let paths = PackPaths::new(&dir);
        provision_dashboards(&paths).unwrap();
        let netscan = paths.dashboards_dir().join("netscan-hosts.json");
        let bacnet = paths.dashboards_dir().join("bacnet-points.json");
        let workspace = paths.dashboards_dir().join("building-workspace.json");
        let device_health = paths.dashboards_dir().join("device-health.json");
        assert!(netscan.exists() && bacnet.exists() && workspace.exists() && device_health.exists());
        assert!(std::fs::read_to_string(&bacnet)
            .unwrap()
            .contains("bacnet_point"));
        assert!(std::fs::read_to_string(&device_health)
            .unwrap()
            .contains("bacnet_device"));
        assert!(std::fs::read_to_string(&workspace)
            .unwrap()
            .contains("building-workspace"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn find_in_tree_locates_nested_exe_case_insensitively() {
        let root = std::env::temp_dir().join(format!("stier_obs_tree_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let nested = root.join("grafana-v11.1.0").join("bin");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("grafana.exe"), b"x").unwrap();
        let found = find_in_tree(&root, "GRAFANA.EXE").expect("should find nested exe");
        assert!(found.ends_with("grafana.exe"));
        // its home is the dir two levels up (the dir containing bin/)
        assert_eq!(
            found.parent().unwrap().parent().unwrap(),
            root.join("grafana-v11.1.0")
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn pinned_components_are_the_three_services() {
        let c = pinned_components();
        assert_eq!(c.len(), 3);
        assert!(c.iter().any(|(n, _, e)| *n == "grafana" && *e == "grafana"));
        assert!(c
            .iter()
            .any(|(n, _, e)| *n == "influxdb" && *e == "influxd"));
    }

    #[test]
    fn every_pinned_component_has_a_valid_sha256() {
        // The installer hard-fails when a component has no pinned hash, so all
        // three must be present and well-formed (64 lowercase hex chars).
        for (component, _, _) in pinned_components() {
            let hash = pinned_sha256(component)
                .unwrap_or_else(|| panic!("no pinned sha256 for {component}"));
            assert_eq!(hash.len(), 64, "{component} hash wrong length");
            assert!(
                hash.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
                "{component} hash not lowercase hex"
            );
        }
        assert!(pinned_sha256("unknown-component").is_none());
    }

    #[test]
    fn versions_roundtrip_and_status_detects_update() {
        let dir = std::env::temp_dir().join(format!("stier_obs_ver_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let paths = PackPaths::new(&dir);
        std::fs::create_dir_all(paths.bin_dir()).unwrap();

        // Nothing installed yet -> everything needs update, not "installed".
        let s0 = compute_pack_status(&paths);
        assert!(!s0.installed);
        assert!(!s0.updates_available); // nothing present, so no *upgrade* available
        assert!(s0.components.iter().all(|c| c.needs_update));

        // Fake all three binaries present + record matching versions -> installed, no updates.
        for (_, ver, exe) in pinned_components() {
            std::fs::write(paths.binary(exe), b"x").unwrap();
            let _ = ver;
        }
        let mut v = std::collections::HashMap::new();
        for (name, ver, _) in pinned_components() {
            v.insert(name.to_string(), ver.to_string());
        }
        save_versions(&paths, &v).unwrap();
        let s1 = compute_pack_status(&paths);
        assert!(s1.installed);
        assert!(!s1.updates_available);

        // Mark grafana as an older version -> update available + needs_update for it only.
        v.insert("grafana".to_string(), "0.0.1".to_string());
        save_versions(&paths, &v).unwrap();
        let s2 = compute_pack_status(&paths);
        assert!(!s2.installed);
        assert!(s2.updates_available);
        let graf = s2.components.iter().find(|c| c.name == "grafana").unwrap();
        assert!(graf.needs_update && graf.present && graf.installed_version == "0.0.1");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn present_binary_without_recorded_version_is_not_flagged_for_update() {
        let dir = std::env::temp_dir().join(format!("stier_obs_migrate_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let paths = PackPaths::new(&dir);
        std::fs::create_dir_all(paths.bin_dir()).unwrap();
        for (_, _, exe) in pinned_components() {
            std::fs::write(paths.binary(exe), b"x").unwrap();
        }
        // No versions.json (pre-tracking install): assumed current, no spurious update.
        let s = compute_pack_status(&paths);
        assert!(s.installed);
        assert!(!s.updates_available);
        assert!(s.components.iter().all(|c| !c.needs_update));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn replace_binary_swaps_and_creates() {
        let dir = std::env::temp_dir().join(format!("stier_obs_repl_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("new.exe");
        let dst = dir.join("target.exe");
        std::fs::write(&src, b"NEW").unwrap();
        // create fresh
        replace_binary(&src, &dst).unwrap();
        assert_eq!(std::fs::read(&dst).unwrap(), b"NEW");
        // replace existing
        std::fs::write(&src, b"NEWER").unwrap();
        replace_binary(&src, &dst).unwrap();
        assert_eq!(std::fs::read(&dst).unwrap(), b"NEWER");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parse_curl_meter_extracts_progress_fields() {
        let line = " 10  172M   10 17.6M    0     0  5.8M      0  0:00:29  0:00:03  0:00:26 5.8M";
        let (percent, size, received, rate, eta) = parse_curl_meter(line).unwrap();
        assert_eq!(percent, 10.0);
        assert_eq!(size, "172M");
        assert_eq!(received, "17.6M");
        assert_eq!(rate, "5.8M");
        assert_eq!(eta, "0:00:26");
        // header / partial lines are ignored
        assert!(parse_curl_meter("% Total    % Received % Xferd  Average Speed").is_none());
        assert!(parse_curl_meter("curl: (22) The requested URL returned error: 404").is_none());
    }

    #[test]
    fn copy_dir_all_copies_tree() {
        let base = std::env::temp_dir().join(format!("stier_obs_copy_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let src = base.join("src");
        std::fs::create_dir_all(src.join("sub")).unwrap();
        std::fs::write(src.join("a.txt"), b"a").unwrap();
        std::fs::write(src.join("sub").join("b.txt"), b"b").unwrap();
        let dst = base.join("dst");
        copy_dir_all(&src, &dst).unwrap();
        assert!(dst.join("a.txt").exists() && dst.join("sub").join("b.txt").exists());
        let _ = std::fs::remove_dir_all(&base);
    }
}
