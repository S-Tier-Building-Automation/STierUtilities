use std::collections::HashMap;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;

use once_cell::sync::Lazy;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

static RUNNING: Lazy<Mutex<HashMap<String, Child>>> = Lazy::new(|| Mutex::new(HashMap::new()));

#[derive(Serialize, Clone)]
struct ToolExitedEvent {
    tool_id: String,
    code: Option<i32>,
}

#[tauri::command]
fn launch_clipboardtyper(app: AppHandle) -> Result<u32, String> {
    let tool_id = "clipboardtyper".to_string();

    {
        let map = RUNNING.lock().map_err(|e| e.to_string())?;
        if map.contains_key(&tool_id) {
            return Err("ClipboardTyper is already running.".into());
        }
    }

    let resource_path = app
        .path()
        .resolve(
            "resources/clipboardtyper/clipboard_typer.py",
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|e| format!("could not resolve script resource: {e}"))?;

    if !resource_path.exists() {
        return Err(format!(
            "bundled script not found at {}",
            resource_path.display()
        ));
    }

    let mut cmd = Command::new("python");
    cmd.arg(resource_path);

    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NEW_CONSOLE);
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("failed to launch python: {e}. Is Python on PATH?"))?;
    let pid = child.id();

    {
        let mut map = RUNNING.lock().map_err(|e| e.to_string())?;
        map.insert(tool_id.clone(), child);
    }

    spawn_exit_watcher(app, tool_id);

    Ok(pid)
}

#[tauri::command]
fn stop_tool(tool_id: String) -> Result<(), String> {
    let mut map = RUNNING.lock().map_err(|e| e.to_string())?;
    if let Some(mut child) = map.remove(&tool_id) {
        child
            .kill()
            .map_err(|e| format!("failed to stop {tool_id}: {e}"))?;
        let _ = child.wait();
        Ok(())
    } else {
        Err(format!("{tool_id} is not running."))
    }
}

#[tauri::command]
fn tool_running(tool_id: String) -> bool {
    let map = match RUNNING.lock() {
        Ok(m) => m,
        Err(_) => return false,
    };
    map.contains_key(&tool_id)
}

#[tauri::command]
fn check_python() -> Result<String, String> {
    let output = Command::new("python")
        .arg("--version")
        .output()
        .map_err(|e| format!("python not found on PATH: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "python returned non-zero exit: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let ver = if stdout.is_empty() {
        String::from_utf8_lossy(&output.stderr).trim().to_string()
    } else {
        stdout
    };
    Ok(ver)
}

#[tauri::command]
fn install_clipboardtyper_deps(app: AppHandle) -> Result<String, String> {
    let req_path = app
        .path()
        .resolve(
            "resources/clipboardtyper/requirements.txt",
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|e| e.to_string())?;
    if !req_path.exists() {
        return Err(format!("requirements.txt missing at {}", req_path.display()));
    }
    let output = Command::new("python")
        .args(["-m", "pip", "install", "--user", "-r"])
        .arg(&req_path)
        .output()
        .map_err(|e| format!("failed to run pip: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "pip exited with status {}\nstderr:\n{}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn spawn_exit_watcher(app: AppHandle, tool_id: String) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(300));
        let exit_code: Option<Option<i32>> = {
            let mut map = match RUNNING.lock() {
                Ok(m) => m,
                Err(_) => return,
            };
            match map.get_mut(&tool_id) {
                Some(child) => match child.try_wait() {
                    Ok(Some(status)) => {
                        let _ = map.remove(&tool_id);
                        Some(status.code())
                    }
                    Ok(None) => None,
                    Err(_) => {
                        let _ = map.remove(&tool_id);
                        Some(None)
                    }
                },
                // Entry gone (likely stopped via `stop_tool`); watcher's job is done.
                None => return,
            }
        };
        if let Some(code) = exit_code {
            let _ = app.emit(
                "tool-exited",
                ToolExitedEvent {
                    tool_id: tool_id.clone(),
                    code,
                },
            );
            return;
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            launch_clipboardtyper,
            stop_tool,
            tool_running,
            check_python,
            install_clipboardtyper_deps
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
