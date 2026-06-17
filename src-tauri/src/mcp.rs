//! MCP (Model Context Protocol) stdio client — lets third-party tools plug into
//! the platform as out-of-process MCP servers (manifest `kind: "mcp"`).
//!
//! Transport: newline-delimited JSON-RPC 2.0 over the child's stdin/stdout (the
//! MCP stdio transport). A dedicated reader thread per server routes responses to
//! the waiting request by id. The message framing/classification is pure and
//! unit-tested; spawning + the handshake are integration (need a real server).
//!
//! Windows-gated (spawns processes with CREATE_NO_WINDOW), consistent with the
//! rest of the app.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::windows::process::CommandExt;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use once_cell::sync::Lazy;
use serde::Serialize;
use serde_json::{json, Value};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const PROTOCOL_VERSION: &str = "2024-11-05";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

/// Interpreters / script hosts that must never be launched as an MCP "server".
/// A real MCP server is a dedicated executable; these are general-purpose script
/// runners (classic LOLBins) that would turn "spawn this program" into "run
/// arbitrary inline script", defeating the frontend's command-disclosing consent.
/// Defense-in-depth: the frontend already shows and confirms the exact command,
/// but the backend refuses these regardless of how the manifest reached it.
const BLOCKED_MCP_COMMANDS: &[&str] = &[
    "cmd", "powershell", "pwsh", "wscript", "cscript", "mshta", "rundll32", "regsvr32", "regsvcs",
    "installutil", "msbuild", "msiexec", "bitsadmin", "certutil", "conhost",
];

/// Reject empty commands and known script-host interpreters before spawning.
/// Matches on the bare program name (directory + extension stripped), case-insensitively.
fn validate_mcp_command(command: &str) -> Result<(), String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("MCP command is empty".into());
    }
    let base = std::path::Path::new(trimmed)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(trimmed)
        .to_ascii_lowercase();
    if BLOCKED_MCP_COMMANDS.contains(&base.as_str()) {
        return Err(format!(
            "refusing to launch MCP server via '{base}': script-host interpreters are not allowed as MCP commands"
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Pure message framing (unit-tested)
// ---------------------------------------------------------------------------

/// A newline-terminated JSON-RPC 2.0 request line.
pub fn build_request(id: i64, method: &str, params: &Value) -> String {
    let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    format!("{}\n", serde_json::to_string(&msg).unwrap_or_default())
}

/// A newline-terminated JSON-RPC 2.0 notification line (no id, no response).
pub fn build_notification(method: &str, params: &Value) -> String {
    let msg = json!({ "jsonrpc": "2.0", "method": method, "params": params });
    format!("{}\n", serde_json::to_string(&msg).unwrap_or_default())
}

#[derive(Debug, PartialEq)]
pub enum McpMessage {
    Response { id: i64 },
    Notification { method: String },
    Other,
}

/// Classify an incoming JSON-RPC message so the reader can route it.
pub fn classify_message(v: &Value) -> McpMessage {
    if let Some(id) = v.get("id").and_then(|x| x.as_i64()) {
        McpMessage::Response { id }
    } else if let Some(m) = v.get("method").and_then(|x| x.as_str()) {
        McpMessage::Notification {
            method: m.to_string(),
        }
    } else {
        McpMessage::Other
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

/// Parse the `tools` array out of a `tools/list` result.
pub fn parse_tools(result: &Value) -> Vec<ToolInfo> {
    result
        .get("tools")
        .and_then(|t| t.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|t| {
                    let name = t.get("name").and_then(|n| n.as_str())?.to_string();
                    Some(ToolInfo {
                        name,
                        description: t
                            .get("description")
                            .and_then(|d| d.as_str())
                            .unwrap_or("")
                            .to_string(),
                        input_schema: t.get("inputSchema").cloned().unwrap_or(Value::Null),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub tool_count: usize,
    pub tools: Vec<ToolInfo>,
}

// ---------------------------------------------------------------------------
// Running-server registry (integration)
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct ServerHandle {
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<Mutex<HashMap<i64, mpsc::Sender<Value>>>>,
    next_id: Arc<AtomicI64>,
    child: Arc<Mutex<Child>>,
    tools: Vec<ToolInfo>,
}

static SERVERS: Lazy<Mutex<HashMap<String, ServerHandle>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn spawn_reader(stdout: ChildStdout, pending: Arc<Mutex<HashMap<i64, mpsc::Sender<Value>>>>) {
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(val) = serde_json::from_str::<Value>(&line) {
                if let McpMessage::Response { id } = classify_message(&val) {
                    if let Some(tx) = pending.lock().unwrap().remove(&id) {
                        let _ = tx.send(val);
                    }
                }
                // notifications / log lines are ignored
            }
        }
        // stdout closed (server exited): drop every waiting sender so in-flight
        // requests fail fast instead of blocking the full timeout.
        if let Ok(mut p) = pending.lock() {
            p.clear();
        }
    });
}

/// Send a request and block until its response (or timeout). Does NOT hold the
/// SERVERS lock — the caller clones the handle out first.
fn request(handle: &ServerHandle, method: &str, params: Value) -> Result<Value, String> {
    let id = handle.next_id.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = mpsc::channel();
    handle.pending.lock().unwrap().insert(id, tx);

    // Ensure the pending entry is removed on EVERY exit path (write/flush error,
    // timeout) — otherwise a slow/dead server leaks one entry per call.
    struct PendingGuard<'a> {
        pending: &'a Arc<Mutex<HashMap<i64, mpsc::Sender<Value>>>>,
        id: i64,
    }
    impl Drop for PendingGuard<'_> {
        fn drop(&mut self) {
            if let Ok(mut p) = self.pending.lock() {
                p.remove(&self.id);
            }
        }
    }
    let _guard = PendingGuard {
        pending: &handle.pending,
        id,
    };

    let line = build_request(id, method, &params);
    {
        let mut stdin = handle.stdin.lock().unwrap();
        stdin
            .write_all(line.as_bytes())
            .map_err(|e| format!("write failed: {e}"))?;
        stdin.flush().map_err(|e| e.to_string())?;
    }

    let resp = rx
        .recv_timeout(REQUEST_TIMEOUT)
        .map_err(|_| format!("timeout waiting for '{method}' response"))?;
    if let Some(err) = resp.get("error") {
        return Err(format!("MCP error from '{method}': {err}"));
    }
    Ok(resp.get("result").cloned().unwrap_or(Value::Null))
}

fn notify(handle: &ServerHandle, method: &str, params: Value) -> Result<(), String> {
    let line = build_notification(method, &params);
    let mut stdin = handle.stdin.lock().unwrap();
    stdin
        .write_all(line.as_bytes())
        .map_err(|e| format!("write failed: {e}"))?;
    stdin.flush().map_err(|e| e.to_string())
}

/// Kill a child and reap it (kill alone leaves a zombie until wait()).
fn kill_and_reap(handle: &ServerHandle) {
    let mut child = handle.child.lock().unwrap();
    let _ = child.kill();
    let _ = child.wait();
}

/// True if the child process has already exited.
fn child_exited(handle: &ServerHandle) -> bool {
    matches!(handle.child.lock().unwrap().try_wait(), Ok(Some(_)))
}

/// Append the tail of captured stderr to an error so a failed handshake is diagnosable.
fn with_stderr(err: String, buf: &Arc<Mutex<Vec<String>>>) -> String {
    let lines = buf.lock().unwrap();
    if lines.is_empty() {
        return err;
    }
    let tail: Vec<&str> = lines
        .iter()
        .rev()
        .take(8)
        .rev()
        .map(|s| s.as_str())
        .collect();
    format!("{err}\nserver stderr:\n{}", tail.join("\n"))
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Start (or return) an MCP server: spawn the process, run the JSON-RPC
/// handshake (initialize -> initialized -> tools/list), and remember it by id.
#[tauri::command]
pub async fn mcp_start(
    id: String,
    command: String,
    args: Vec<String>,
    env: Option<HashMap<String, String>>,
) -> Result<ServerInfo, String> {
    // The spawn + handshake (initialize/tools/list) can block for seconds — run
    // it off the main thread so the UI stays responsive.
    tauri::async_runtime::spawn_blocking(move || mcp_start_blocking(id, command, args, env))
        .await
        .map_err(|e| format!("mcp start task panicked: {e}"))?
}

fn mcp_start_blocking(
    id: String,
    command: String,
    args: Vec<String>,
    env: Option<HashMap<String, String>>,
) -> Result<ServerInfo, String> {
    if let Some(h) = SERVERS.lock().unwrap().get(&id) {
        return Ok(ServerInfo {
            tool_count: h.tools.len(),
            tools: h.tools.clone(),
        });
    }

    validate_mcp_command(&command)?;

    let mut cmd = Command::new(&command);
    cmd.args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW);
    if let Some(env) = env {
        for (k, v) in env {
            cmd.env(k, v);
        }
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to start MCP server '{id}': {e}"))?;
    let stdin = child.stdin.take().ok_or("MCP server has no stdin")?;
    let stdout = child.stdout.take().ok_or("MCP server has no stdout")?;

    // Capture the tail of stderr (drained on its own thread so the pipe never
    // blocks the child) for diagnosing a failed handshake.
    let stderr_buf = Arc::new(Mutex::new(Vec::<String>::new()));
    if let Some(stderr) = child.stderr.take() {
        let buf = Arc::clone(&stderr_buf);
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let mut b = buf.lock().unwrap();
                b.push(line);
                let len = b.len();
                if len > 50 {
                    b.drain(0..len - 50);
                }
            }
        });
    }

    let pending = Arc::new(Mutex::new(HashMap::new()));
    spawn_reader(stdout, Arc::clone(&pending));

    let mut handle = ServerHandle {
        stdin: Arc::new(Mutex::new(stdin)),
        pending,
        next_id: Arc::new(AtomicI64::new(1)),
        child: Arc::new(Mutex::new(child)),
        tools: Vec::new(),
    };

    // JSON-RPC handshake.
    let init = json!({
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {},
        "clientInfo": { "name": "s-tier-utilities", "version": "0.5.4" },
    });
    if let Err(e) = request(&handle, "initialize", init) {
        kill_and_reap(&handle);
        return Err(with_stderr(e, &stderr_buf));
    }
    let _ = notify(&handle, "notifications/initialized", json!({}));
    let tools = match request(&handle, "tools/list", json!({})) {
        Ok(res) => parse_tools(&res),
        Err(e) => {
            kill_and_reap(&handle);
            return Err(with_stderr(e, &stderr_buf));
        }
    };
    handle.tools = tools.clone();

    SERVERS.lock().unwrap().insert(id, handle);
    Ok(ServerInfo {
        tool_count: tools.len(),
        tools,
    })
}

/// Call a tool on a running MCP server.
#[tauri::command]
pub async fn mcp_call(id: String, name: String, arguments: Option<Value>) -> Result<Value, String> {
    // tools/call blocks until the server responds (up to the request timeout) —
    // keep it off the main thread.
    tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        let handle = {
            let servers = SERVERS.lock().unwrap();
            servers
                .get(&id)
                .cloned()
                .ok_or_else(|| format!("MCP server '{id}' is not running"))?
        };
        // Fail fast (and deregister) if the server process has died, instead of
        // blocking the full request timeout on a dead pipe.
        if child_exited(&handle) {
            SERVERS.lock().unwrap().remove(&id);
            return Err(format!("MCP server '{id}' has exited"));
        }
        let params = json!({ "name": name, "arguments": arguments.unwrap_or(json!({})) });
        request(&handle, "tools/call", params)
    })
    .await
    .map_err(|e| format!("mcp call task panicked: {e}"))?
}

/// Stop and remove a running MCP server.
#[tauri::command]
pub fn mcp_stop(id: String) -> Result<(), String> {
    if let Some(handle) = SERVERS.lock().unwrap().remove(&id) {
        let _ = handle.child.lock().unwrap().kill();
        let _ = handle.child.lock().unwrap().wait();
    }
    Ok(())
}

/// Stop every running MCP server (called on app exit).
pub fn stop_all() {
    let mut servers = SERVERS.lock().unwrap();
    for (_, handle) in servers.drain() {
        let _ = handle.child.lock().unwrap().kill();
        let _ = handle.child.lock().unwrap().wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_request_is_newline_terminated_jsonrpc() {
        let line = build_request(7, "tools/call", &json!({ "name": "x" }));
        assert!(line.ends_with('\n'));
        let v: Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(v["jsonrpc"], "2.0");
        assert_eq!(v["id"], 7);
        assert_eq!(v["method"], "tools/call");
        assert_eq!(v["params"]["name"], "x");
    }

    #[test]
    fn validate_mcp_command_blocks_script_hosts_and_empties() {
        assert!(validate_mcp_command("stier-niagara-mcp").is_ok());
        assert!(validate_mcp_command(r"C:\plugins\my-mcp.exe").is_ok());
        assert!(validate_mcp_command("").is_err());
        assert!(validate_mcp_command("   ").is_err());
        // Blocked regardless of path, case, or extension.
        assert!(validate_mcp_command("powershell").is_err());
        assert!(validate_mcp_command("PowerShell.exe").is_err());
        assert!(validate_mcp_command(r"C:\Windows\System32\cmd.exe").is_err());
        assert!(validate_mcp_command("mshta").is_err());
    }

    #[test]
    fn build_notification_has_no_id() {
        let line = build_notification("notifications/initialized", &json!({}));
        let v: Value = serde_json::from_str(line.trim()).unwrap();
        assert!(v.get("id").is_none());
        assert_eq!(v["method"], "notifications/initialized");
    }

    #[test]
    fn classify_distinguishes_responses_notifications_and_other() {
        assert_eq!(
            classify_message(&json!({ "id": 3, "result": {} })),
            McpMessage::Response { id: 3 }
        );
        assert_eq!(
            classify_message(&json!({ "method": "notifications/message" })),
            McpMessage::Notification {
                method: "notifications/message".into()
            },
        );
        assert_eq!(
            classify_message(&json!({ "jsonrpc": "2.0" })),
            McpMessage::Other
        );
    }

    #[test]
    fn parse_tools_reads_name_description_schema() {
        let result = json!({
            "tools": [
                { "name": "list_stations", "description": "List stations", "inputSchema": { "type": "object" } },
                { "name": "no_desc" },
            ]
        });
        let tools = parse_tools(&result);
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0].name, "list_stations");
        assert_eq!(tools[0].description, "List stations");
        assert_eq!(tools[0].input_schema["type"], "object");
        assert_eq!(tools[1].description, ""); // missing description -> empty
    }

    #[test]
    fn parse_tools_handles_missing_array() {
        assert!(parse_tools(&json!({})).is_empty());
    }
}
