// BACnet/IP is plain UDP — portable, so not Windows-gated like the others.
mod bacnet;
mod bacnet_codec;

#[cfg(windows)]
mod clipboardtyper;
#[cfg(windows)]
mod heicmov;
#[cfg(windows)]
mod netscan;
#[cfg(windows)]
mod networkmanager;

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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init());

    #[cfg(windows)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        app_open_data_dir,
        clipboardtyper::clipboardtyper_start,
        clipboardtyper::clipboardtyper_stop,
        clipboardtyper::clipboardtyper_set_armed,
        clipboardtyper::clipboardtyper_set_settings,
        clipboardtyper::clipboardtyper_get_state,
        heicmov::heicmov_pick_files,
        heicmov::heicmov_pick_output_dir,
        heicmov::heicmov_probe,
        heicmov::heicmov_make_preview,
        heicmov::heicmov_convert,
        heicmov::heicmov_open_path,
        networkmanager::networkmanager_list_adapters,
        networkmanager::networkmanager_read_state,
        networkmanager::networkmanager_capture_profile,
        networkmanager::networkmanager_compare,
        networkmanager::networkmanager_validate,
        networkmanager::networkmanager_load_profiles,
        networkmanager::networkmanager_save_profiles,
        networkmanager::networkmanager_profiles_path,
        networkmanager::networkmanager_open_profiles_dir,
        networkmanager::networkmanager_apply_profile,
        netscan::netscan_scan,
        bacnet::bacnet_discover,
        bacnet::bacnet_read_objects,
        bacnet::bacnet_read_properties,
        bacnet::bacnet_write_property,
        bacnet::bacnet_read_trend,
        bacnet::bacnet_subscribe_cov,
        bacnet::bacnet_unsubscribe_cov,
    ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
