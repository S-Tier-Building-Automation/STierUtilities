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
use std::time::Duration;

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
/// since we immediately hand them to the children we're about to spawn).
pub fn find_free_ports(n: usize) -> Vec<u16> {
    // Hold the listeners until we've collected all ports so the OS doesn't hand
    // back the same port twice, then drop them all.
    let mut listeners = Vec::new();
    let mut ports = Vec::new();
    for _ in 0..n {
        if let Ok(l) = TcpListener::bind(("127.0.0.1", 0)) {
            if let Ok(addr) = l.local_addr() {
                ports.push(addr.port());
                listeners.push(l);
            }
        }
    }
    ports
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
pub fn download_asset(component: &str, version: &str, os: &str, arch: &str) -> Result<DownloadAsset, String> {
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
    let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "amd64" };
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
  flush_interval = "10s"
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

/// Grafana main config: localhost-only, anonymous Viewer (for embedding), embedding allowed.
pub fn grafana_ini(cfg: &PackConfig) -> String {
    format!(
        r#"# Generated by S-Tier Utilities — Observability Pack
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
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Build the raw HTTP/1.1 request text for an InfluxDB v2 line-protocol write.
pub fn build_write_request(cfg: &PackConfig, body: &str) -> String {
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
        port = cfg.influx_port,
        token = cfg.token,
        len = body.len(),
        body = body,
    )
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

/// Parse the numeric status code out of an HTTP response's status line.
pub fn parse_http_status(response: &str) -> Option<u16> {
    let first = response.lines().next()?;
    let mut parts = first.split_whitespace();
    let _http = parts.next()?; // "HTTP/1.1"
    parts.next()?.parse::<u16>().ok()
}

/// Send a pre-built request to 127.0.0.1:port and return (status, body). Integration
/// path — requires a listening InfluxDB. Times out quickly so the UI never hangs.
fn http_send(port: u16, request: &str) -> Result<(u16, String), String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).map_err(|e| format!("connect failed: {e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;
    stream
        .write_all(request.as_bytes())
        .map_err(|e| format!("write failed: {e}"))?;
    let mut response = String::new();
    stream
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
pub fn observability_pick_ports() -> PackConfig {
    let ports = find_free_ports(3);
    let mut cfg = PackConfig::default();
    if ports.len() == 3 {
        cfg.influx_port = ports[0];
        cfg.grafana_port = ports[1];
        cfg.telegraf_listener_port = ports[2];
    }
    cfg
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
pub fn observability_write_configs(app: tauri::AppHandle, config: PackConfig) -> Result<String, String> {
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

    std::fs::write(paths.config_dir().join("telegraf.conf"), telegraf_conf(cfg)).map_err(|e| e.to_string())?;
    std::fs::write(paths.config_dir().join("grafana.ini"), grafana_ini(cfg)).map_err(|e| e.to_string())?;
    std::fs::write(provisioning.join("influxdb.yaml"), grafana_datasource_yaml(cfg)).map_err(|e| e.to_string())?;
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
    ("netscan-hosts.json", include_str!("../../src/tools/dashboards/netscan-hosts.json")),
    ("bacnet-points.json", include_str!("../../src/tools/dashboards/bacnet-points.json")),
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
        let count = pts.len();
        let (body, _skipped) = to_line_protocol_batch(&pts);
        if body.is_empty() {
            return Ok(0);
        }
        let request = build_write_request(&config, &body);
        let (status, resp) = http_send(config.influx_port, &request)?;
        if (200..300).contains(&status) {
            Ok(count)
        } else {
            Err(format!("InfluxDB write returned HTTP {status}: {}", resp.lines().next().unwrap_or("")))
        }
    })
    .await
    .map_err(|e| format!("write task panicked: {e}"))?
}

// ---------------------------------------------------------------------------
// Process supervision (integration — requires the downloaded binaries)
// ---------------------------------------------------------------------------

use std::process::{Child, Command};
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

fn spawn_component(paths: &PackPaths, bin: &str, args: &[String]) -> Result<Child, String> {
    let exe = paths.binary(bin);
    if !exe.exists() {
        return Err(format!("{bin} is not installed (expected at {})", exe.display()));
    }
    let mut cmd = Command::new(&exe);
    cmd.args(args).current_dir(&paths.root);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn().map_err(|e| format!("failed to start {bin}: {e}"))
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
        PackHealth {
            influx_up,
            influx_ready,
            grafana_up: port_open(config.grafana_port),
        }
    })
    .await
    .unwrap_or(PackHealth { influx_up: false, influx_ready: false, grafana_up: false })
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
        let request = build_setup_request(&config, "stier", &config.token);
        let (status, resp) = http_send(config.influx_port, &request)?;
        match status {
            s if (200..300).contains(&s) => Ok(true),
            422 => Ok(true), // already onboarded
            s => Err(format!("InfluxDB setup returned HTTP {s}: {}", resp.lines().next().unwrap_or(""))),
        }
    })
    .await
    .map_err(|e| format!("onboard task panicked: {e}"))?
}

/// The download URLs for all three components at this OS/arch.
#[tauri::command]
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
    tauri::async_runtime::spawn_blocking(move || start_blocking(app, config))
        .await
        .map_err(|e| format!("start task panicked: {e}"))?
}

#[cfg(windows)]
fn start_blocking(app: tauri::AppHandle, config: PackConfig) -> Result<(), String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?;
    let paths = PackPaths::new(&dir);
    write_pack_configs(&paths, &config)?;
    std::fs::create_dir_all(paths.data_dir()).map_err(|e| e.to_string())?;

    let mut sup = SUPERVISOR.lock().map_err(|_| "supervisor lock poisoned")?;

    if sup.influx.is_none() {
        sup.influx = Some(spawn_component(&paths, "influxd", &influxd_args(&config, &paths.data_dir()))?);
    }
    if sup.telegraf.is_none() {
        let conf = paths.config_dir().join("telegraf.conf").to_string_lossy().into_owned();
        sup.telegraf = Some(spawn_component(&paths, "telegraf", &["--config".into(), conf])?);
    }
    if sup.grafana.is_none() {
        // grafana 10+: `grafana server --config <ini> --homepath <install dir>`.
        let ini = paths.config_dir().join("grafana.ini").to_string_lossy().into_owned();
        let home = paths.root.join("grafana-home").to_string_lossy().into_owned();
        sup.grafana = Some(spawn_component(
            &paths,
            "grafana",
            &["server".into(), "--config".into(), ini, "--homepath".into(), home],
        )?);
    }
    Ok(())
}

/// Stop any running pack services.
#[tauri::command]
pub fn observability_stop() -> Result<(), String> {
    let mut sup = SUPERVISOR.lock().map_err(|_| "supervisor lock poisoned")?;
    for child in [sup.influx.take(), sup.telegraf.take(), sup.grafana.take()] {
        if let Some(mut c) = child {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
    Ok(())
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

/// Pinned SHA-256 for a downloaded archive. Returns None until real hashes are
/// pinned for a release — install logs a warning and proceeds when absent.
/// TODO(release): pin these and make absence a hard error.
fn pinned_sha256(_component: &str) -> Option<&'static str> {
    None
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
        Err(format!("{program} failed: {}", String::from_utf8_lossy(&out.stderr).trim()))
    }
}

#[cfg(windows)]
fn curl_download(url: &str, out: &Path) -> Result<(), String> {
    run_tool(
        "curl.exe",
        &["-L", "--fail", "--silent", "--show-error", "-o", &out.to_string_lossy(), url],
    )
}

#[cfg(windows)]
fn extract_archive(archive: &Path, dest: &Path) -> Result<(), String> {
    // Use Windows' built-in bsdtar (tar.exe), NOT PowerShell 5.1 Expand-Archive:
    // Expand-Archive silently fails on Grafana's deep (>260-char MAX_PATH) entries
    // — it leaves an empty directory but still exits 0. tar.exe is long-path-aware
    // and ~15x faster.
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    run_tool("tar.exe", &["-xf", &archive.to_string_lossy(), "-C", &dest.to_string_lossy()])
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
    // (component, version, exe-base-name)
    let components = [
        ("influxdb", INFLUXDB_VERSION, "influxd"),
        ("telegraf", TELEGRAF_VERSION, "telegraf"),
        ("grafana", GRAFANA_VERSION, "grafana"),
    ];
    let total = components.len();

    for (i, (component, version, exe)) in components.iter().enumerate() {
        let emit = |step: &str| {
            let _ = app.emit(
                "observability://install",
                serde_json::json!({ "component": component, "step": step, "index": i, "total": total }),
            );
        };

        // Skip a component that's already installed (makes a retry after a partial
        // failure only fetch what's missing).
        if paths.binary(exe).exists() {
            emit("already-installed");
            continue;
        }

        emit("download");
        let asset = download_asset(component, version, os, arch)?;
        let archive_path = dl.join(format!("{component}.{}", asset.archive));
        curl_download(&asset.url, &archive_path)?;

        if let Some(expected) = pinned_sha256(component) {
            emit("verify");
            verify_sha256(&archive_path, expected)?;
        }

        emit("extract");
        let extract_dir = dl.join(component);
        let _ = std::fs::remove_dir_all(&extract_dir);
        extract_archive(&archive_path, &extract_dir)?;

        emit("install");
        let exe_file = format!("{exe}.exe");
        let found = find_in_tree(&extract_dir, &exe_file)
            .ok_or_else(|| format!("{exe_file} not found in extracted {component} archive"))?;
        std::fs::copy(&found, paths.binary(exe)).map_err(|e| e.to_string())?;

        // Grafana needs its full home (bin/ + public/ + conf/) for `--homepath`.
        if *component == "grafana" {
            let home_src = found
                .parent()
                .and_then(|p| p.parent())
                .ok_or("unexpected grafana archive layout")?;
            let home_dst = paths.root.join("grafana-home");
            let _ = std::fs::remove_dir_all(&home_dst);
            copy_dir_all(home_src, &home_dst).map_err(|e| e.to_string())?;
        }
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
    fn port_open_detects_a_listener() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(port_open(port), "a bound listener's port should read as open");
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
        let ports = find_free_ports(3);
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
        assert!(win.url.ends_with("influxdb2-2.7.5-windows.zip"), "got {}", win.url);
        let lin_influx = download_asset("influxdb", "2.7.5", "linux", "amd64").unwrap();
        assert!(lin_influx.url.ends_with("influxdb2-2.7.5_linux_amd64.tar.gz"), "got {}", lin_influx.url);

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
    }

    #[test]
    fn grafana_ini_is_localhost_and_embeddable() {
        let c = grafana_ini(&cfg());
        assert!(c.contains("http_addr = 127.0.0.1"));
        assert!(c.contains("http_port = 3000"));
        assert!(c.contains("allow_embedding = true"));
        assert!(c.contains("org_role = Viewer"));
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
        assert!(req.starts_with("POST /api/v2/write?org=stier&bucket=utilities&precision=ns HTTP/1.1"));
        assert!(req.contains("Authorization: Token secret-token"));
        assert!(req.contains(&format!("Content-Length: {}", body.len())));
        assert!(req.ends_with(body));
    }

    #[test]
    fn parse_status_reads_code() {
        assert_eq!(parse_http_status("HTTP/1.1 204 No Content\r\n\r\n"), Some(204));
        assert_eq!(parse_http_status("HTTP/1.1 401 Unauthorized\r\n"), Some(401));
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
        assert!(paths.bin_dir().ends_with("observability/bin") || paths.bin_dir().ends_with("observability\\bin"));
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
        assert!(p.fields.iter().any(|(k, v)| k == "n" && *v == FieldValue::Float(3.0)));
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
        assert!(netscan.exists() && bacnet.exists());
        assert!(std::fs::read_to_string(&bacnet).unwrap().contains("bacnet_point"));
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
        assert_eq!(found.parent().unwrap().parent().unwrap(), root.join("grafana-v11.1.0"));
        let _ = std::fs::remove_dir_all(&root);
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
