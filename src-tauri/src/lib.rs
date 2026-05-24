#[cfg(windows)]
mod clipboardtyper;
#[cfg(windows)]
mod heicmov;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init());

    #[cfg(windows)]
    let builder = builder.invoke_handler(tauri::generate_handler![
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
    ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
