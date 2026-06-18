// Native file/folder pickers via tauri-plugin-dialog.

import { openDialog } from "../platform/tauri.js";
import { filterMediaPaths, HEICMOV_EXTENSIONS } from "./media-paths.js";

/** Multi-select file picker for HEIC/HEIF/MOV. Returns normalized paths or []. */
export async function pickHeicMovFiles() {
  const selected = await openDialog({
    multiple: true,
    filters: [{ name: "HEIC, HEIF & MOV", extensions: HEICMOV_EXTENSIONS }],
  });
  if (selected == null) return [];
  const paths = Array.isArray(selected) ? selected : [selected];
  return filterMediaPaths(paths);
}

/** Folder picker. Returns a path string or null when cancelled. */
export async function pickFolder() {
  const selected = await openDialog({ directory: true, multiple: false });
  return selected ?? null;
}
