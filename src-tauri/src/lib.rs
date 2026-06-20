// BACnet/IP is plain UDP — portable, so not Windows-gated like the others.
mod bacnet;
mod bacnet_codec;

// Platform observability: InfluxDB line-protocol encoding (portable, pure) and
// the Observability Pack supervisor (config gen, ports, line-protocol writes).
mod observability;
mod timeseries;

#[cfg(windows)]
mod auth;
#[cfg(windows)]
mod clipboardtyper;
#[cfg(windows)]
mod heicmov;
#[cfg(windows)]
mod mcp;
#[cfg(windows)]
mod netscan;
#[cfg(windows)]
mod networkmanager;
#[cfg(windows)]
mod secrets;
#[cfg(windows)]
mod startup;

/// Open the app's data/config directory — where tool settings and saved
/// profiles live (e.g. clipboardtyper.json, networkmanager/profiles.json) — in
/// the system file manager. Backed by the same opener plugin the other
/// folder-open commands use.
#[cfg(windows)]
#[tauri::command]
fn app_open_data_dir(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    use tauri_plugin_opener::OpenerExt;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create app data dir: {e}"))?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| format!("could not open folder: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Self-elevation: when this exe is re-launched elevated by the Network Manager
    // apply flow, handle the apply and exit BEFORE any window/Tauri initialization.
    #[cfg(windows)]
    {
        let args: Vec<String> = std::env::args().collect();
        if args.len() >= 4 && args[1] == "--nm-apply-elevated" {
            let code = networkmanager::run_elevated_worker(&args[2], &args[3]);
            std::process::exit(code);
        }
    }

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init());

    // Dev-only MCP Bridge: lets the Tauri MCP server drive the webview/IPC.
    // Debug builds only, bound to localhost so it isn't reachable off-box.
    #[cfg(debug_assertions)]
    let builder = builder.plugin(
        tauri_plugin_mcp_bridge::Builder::new()
            .bind_address("127.0.0.1")
            .build(),
    );

    #[cfg(windows)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        app_open_data_dir,
        auth::auth_get_state,
        auth::auth_create_local_session,
        auth::auth_sign_out,
        auth::auth_switch_org,
        auth::auth_create_org,
        auth::auth_load_user_state,
        auth::auth_save_user_state,
        auth::auth_export_snapshot,
        auth::auth_set_sync_folder,
        auth::auth_clear_sync_folder,
        auth::auth_sync_now,
        clipboardtyper::clipboardtyper_start,
        clipboardtyper::clipboardtyper_stop,
        clipboardtyper::clipboardtyper_set_armed,
        clipboardtyper::clipboardtyper_set_settings,
        clipboardtyper::clipboardtyper_get_state,
        heicmov::heicmov_probe,
        heicmov::heicmov_make_preview,
        heicmov::heicmov_convert,
        heicmov::heicmov_open_path,
        secrets::secrets_influx_token,
        networkmanager::networkmanager_list_adapters,
        networkmanager::networkmanager_read_state,
        networkmanager::networkmanager_capture_profile,
        networkmanager::networkmanager_compare,
        networkmanager::networkmanager_load_profiles,
        networkmanager::networkmanager_save_profiles,
        networkmanager::networkmanager_open_profiles_dir,
        networkmanager::networkmanager_apply_profile,
        netscan::netscan_scan,
        netscan::netscan_ping,
        observability::observability_pick_ports,
        observability::observability_status,
        observability::observability_pack_status,
        observability::observability_write_configs,
        observability::observability_health,
        observability::observability_install,
        observability::observability_start,
        observability::observability_stop,
        observability::observability_onboard,
        observability::observability_load_config,
        observability::observability_save_config,
        observability::timeseries_write,
        startup::app_startup_status,
        mcp::mcp_start,
        mcp::mcp_call,
        mcp::mcp_stop,
        bacnet::bacnet_discover,
        bacnet::bacnet_cancel_discovery,
        bacnet::bacnet_diagnostics,
        bacnet::bacnet_read_objects,
        bacnet::bacnet_read_properties,
        bacnet::bacnet_write_property,
        bacnet::bacnet_read_trend,
        bacnet::bacnet_subscribe_cov,
        bacnet::bacnet_unsubscribe_cov,
        bacnet::bacnet_register_foreign_device,
        bacnet::bacnet_unregister_foreign_device,
        bacnet::bacnet_foreign_device_status,
        bacnet::bacnet_get_alarms,
        bacnet::bacnet_acknowledge_alarm,
    ]);

    #[cfg(windows)]
    let builder = builder.setup(|app| {
        let smoke_mode = std::env::args().any(|a| a == "--observability-smoke");
        if smoke_mode {
            use tauri::Manager;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let outcome = observability::run_smoke_test(handle.clone()).await;
                let (health, ok, message) = match outcome {
                    Ok(health) => {
                        let ok = observability::smoke_passed(&health.smoke);
                        let message = if ok {
                            "Observability smoke test passed".to_string()
                        } else {
                            format!(
                                "Observability smoke test failed: {:?}",
                                health.smoke.error
                            )
                        };
                        (Some(health), ok, message)
                    }
                    Err(err) => (None, false, format!("Observability smoke test error: {err}")),
                };
                let mut report = serde_json::json!({
                    "ok": ok,
                    "message": message,
                });
                if let Some(health) = health {
                    if let Ok(value) = serde_json::to_value(health) {
                        report["health"] = value;
                    }
                }
                if let Ok(dir) = handle.path().app_config_dir() {
                    let _ = std::fs::create_dir_all(&dir);
                    let path = dir.join("observability-smoke-result.json");
                    if let Ok(json) = serde_json::to_string_pretty(&report) {
                        let _ = std::fs::write(&path, json);
                    }
                    eprintln!("[observability-smoke] wrote {}", path.display());
                }
                eprintln!("[observability-smoke] {message}");
                let _ = observability::observability_stop();
                std::process::exit(if ok { 0 } else { 1 });
            });
            return Ok(());
        }
        startup::start_startup_warmup(app.handle().clone());
        Ok(())
    });

    // Build, then run with an event loop so we can stop any spawned Observability
    // Pack services on exit — otherwise influxd/grafana/telegraf would be orphaned
    // and InfluxDB's bolt lock would block the next launch.
    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");
    app.run(|_app_handle, event| {
        if let tauri::RunEvent::ExitRequested { .. } = event {
            let _ = observability::observability_stop();
            #[cfg(windows)]
            mcp::stop_all();
        }
    });
}
