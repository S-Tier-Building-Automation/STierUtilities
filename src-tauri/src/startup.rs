#![cfg(windows)]

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::networkmanager::{self, AdapterNetworkState, NetworkAdapterInfo};
use crate::observability::{self, PackConfig, PackHealth, PackVersionStatus};
use crate::secrets;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupNetworkSnapshot {
    pub adapters: Vec<NetworkAdapterInfo>,
    pub state_by_adapter: HashMap<String, AdapterNetworkState>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupObservabilityStatus {
    pub attempted: bool,
    pub started: bool,
    pub skipped: bool,
    pub reason: String,
    pub config: Option<PackConfig>,
    pub pack_status: Option<PackVersionStatus>,
    pub health: Option<PackHealth>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupWarmupStatus {
    pub running: bool,
    pub started_at: String,
    pub completed_at: String,
    pub network: Option<StartupNetworkSnapshot>,
    pub observability: Option<StartupObservabilityStatus>,
    pub errors: Vec<String>,
}

static STARTUP_STATUS: Lazy<Mutex<StartupWarmupStatus>> =
    Lazy::new(|| Mutex::new(StartupWarmupStatus::default()));

fn now_ms_string() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

fn update_status(app: &AppHandle, f: impl FnOnce(&mut StartupWarmupStatus)) {
    let snapshot = {
        let mut status = STARTUP_STATUS.lock().unwrap();
        f(&mut status);
        status.clone()
    };
    let _ = app.emit("app://startup-warmup", snapshot);
}

fn warm_network() -> Result<StartupNetworkSnapshot, String> {
    let adapters = networkmanager::networkmanager_list_adapters()?;
    let mut state_by_adapter = HashMap::new();
    for adapter in &adapters {
        if adapter.status == "Not Present" {
            continue;
        }
        match networkmanager::networkmanager_read_state(adapter.name.clone()) {
            Ok(state) => {
                state_by_adapter.insert(adapter.name.clone(), state);
            }
            Err(err) => {
                eprintln!("[startup] could not read adapter {}: {err}", adapter.name);
            }
        }
    }
    Ok(StartupNetworkSnapshot {
        adapters,
        state_by_adapter,
    })
}

fn config_with_token(app: &AppHandle) -> Result<PackConfig, String> {
    let mut config = match observability::observability_load_config(app.clone())? {
        Some(config) => config,
        None => observability::observability_pick_ports()?,
    };
    if config.token.is_empty() {
        let dir = app
            .path()
            .app_config_dir()
            .map_err(|e| format!("could not resolve app data dir: {e}"))?;
        config.token = secrets::get_or_create_token(&dir.join("secrets.json"))?;
    }
    observability::observability_save_config(app.clone(), config.clone())?;
    Ok(config)
}

async fn warm_observability(app: AppHandle) -> StartupObservabilityStatus {
    let pack_status = match observability::observability_pack_status(app.clone()) {
        Ok(status) => status,
        Err(err) => {
            return StartupObservabilityStatus {
                attempted: false,
                started: false,
                skipped: true,
                reason: err,
                config: None,
                pack_status: None,
                health: None,
            };
        }
    };

    let all_present = pack_status.components.iter().all(|c| c.present);
    if !all_present {
        return StartupObservabilityStatus {
            attempted: false,
            started: false,
            skipped: true,
            reason: "Observability Pack is not installed yet".into(),
            config: None,
            pack_status: Some(pack_status),
            health: None,
        };
    }

    let config = match config_with_token(&app) {
        Ok(config) => config,
        Err(err) => {
            return StartupObservabilityStatus {
                attempted: true,
                started: false,
                skipped: false,
                reason: err,
                config: None,
                pack_status: Some(pack_status),
                health: None,
            };
        }
    };

    let mut started = false;
    let mut reason = String::new();
    match observability::observability_start(app.clone(), config.clone()).await {
        Ok(()) => {
            started = true;
            // Wait (up to ~10s) for InfluxDB's port to come up. `port_open` and the
            // sleep are both blocking, so run the whole poll on the blocking pool
            // instead of stalling a tokio worker thread with a synchronous sleep.
            let influx_port = config.influx_port;
            let _ = tauri::async_runtime::spawn_blocking(move || {
                for _ in 0..20 {
                    if observability::port_open(influx_port) {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(500));
                }
            })
            .await;
            if let Err(err) = observability::observability_onboard(config.clone()).await {
                reason = format!("Pack started, but InfluxDB onboarding failed: {err}");
            }
        }
        Err(err) => {
            reason = err;
        }
    }

    let health = if started {
        Some(observability::observability_health(config.clone()).await)
    } else {
        None
    };
    if reason.is_empty() {
        reason = if started {
            "Pack started from native startup warmup".into()
        } else {
            "Pack did not start".into()
        };
    }

    StartupObservabilityStatus {
        attempted: true,
        started,
        skipped: false,
        reason,
        config: Some(config),
        pack_status: Some(pack_status),
        health,
    }
}

pub fn start_startup_warmup(app: AppHandle) {
    update_status(&app, |status| {
        *status = StartupWarmupStatus {
            running: true,
            started_at: now_ms_string(),
            completed_at: String::new(),
            network: None,
            observability: None,
            errors: Vec::new(),
        };
    });

    tauri::async_runtime::spawn(async move {
        let network_task = tauri::async_runtime::spawn_blocking(warm_network);
        let observability_task = tauri::async_runtime::spawn(warm_observability(app.clone()));
        let network_result = network_task.await;
        let observability_result = observability_task.await;
        update_status(&app, |status| {
            match network_result {
                Ok(Ok(network)) => status.network = Some(network),
                Ok(Err(err)) => status.errors.push(format!("Network warmup failed: {err}")),
                Err(err) => status
                    .errors
                    .push(format!("Network warmup task failed: {err}")),
            }
            let observability = match observability_result {
                Ok(observability) => observability,
                Err(err) => StartupObservabilityStatus {
                    attempted: true,
                    started: false,
                    skipped: false,
                    reason: format!("Observability warmup task failed: {err}"),
                    config: None,
                    pack_status: None,
                    health: None,
                },
            };
            if !observability.reason.is_empty() && !observability.started && !observability.skipped {
                status
                    .errors
                    .push(format!("Observability warmup failed: {}", observability.reason));
            }
            status.observability = Some(observability);
            status.running = false;
            status.completed_at = now_ms_string();
        });
        let _ = app.emit("app://startup-warmup-ready", true);
    });
}

#[tauri::command]
pub fn app_startup_status() -> StartupWarmupStatus {
    STARTUP_STATUS.lock().unwrap().clone()
}
