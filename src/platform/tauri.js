// Central Tauri v2 bindings. Prefer importing from here instead of reaching for
// window.__TAURI__ directly — keeps plugin usage consistent as we migrate.

const tauri = window.__TAURI__;

export const invoke = tauri.core.invoke;
export const convertFileSrc = tauri.core.convertFileSrc;
export const listen = tauri.event.listen;
export const opener = tauri.opener;
export const updater = tauri.updater;
export const tauriProcess = tauri.process;
export const getCurrentWindow = () => tauri.window.getCurrentWindow();

/** @type {typeof import("@tauri-apps/plugin-dialog").open} */
export const openDialog = tauri.dialog.open;
