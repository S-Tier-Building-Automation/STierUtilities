// Custom titlebar window controls (decorations disabled in tauri.conf.json).

import { getCurrentWindow } from "../platform/tauri.js";

const MAX_ICON =
  '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1"/></svg>';
const RESTORE_ICON =
  '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1"/><path d="M2.5 2.5V0.5H9.5V7.5H7.5" fill="none" stroke="currentColor" stroke-width="1"/></svg>';

export function initWindowControls() {
  const appWindow = getCurrentWindow();

  async function syncMaxButton() {
    try {
      const maxed = await appWindow.isMaximized();
      const btn = document.getElementById("win-max");
      if (!btn) return;
      btn.innerHTML = maxed ? RESTORE_ICON : MAX_ICON;
      btn.title = maxed ? "Restore" : "Maximize";
      btn.setAttribute("aria-label", btn.title);
    } catch (_) {}
  }

  document.getElementById("win-min")?.addEventListener("click", () => appWindow.minimize());
  document.getElementById("win-max")?.addEventListener("click", async () => {
    await appWindow.toggleMaximize();
    syncMaxButton();
  });
  document.getElementById("win-close")?.addEventListener("click", () => appWindow.close());
  appWindow.onResized(() => syncMaxButton());
  syncMaxButton();
}
