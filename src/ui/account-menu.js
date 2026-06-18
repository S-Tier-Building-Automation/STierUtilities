// App-header account popover — profile, settings, updates, sign out.

import { el, openExternal } from "./dom.js";

/**
 * @param {object} deps
 * @param {typeof import("../platform/tauri.js").invoke} deps.invoke
 * @param {string} deps.appVersion
 * @param {string} deps.repoUrl
 * @param {(view: string) => void} deps.setView
 * @param {() => object|null} deps.getAuthState
 * @param {() => object|null} deps.getActiveUser
 * @param {() => object|null} deps.getActiveOrg
 * @param {() => void|Promise<void>} deps.authSignOut
 * @param {(opts?: { manual?: boolean, silent?: boolean }) => void|Promise<void>} deps.checkForUpdates
 */
export function createAccountMenu({
  invoke, appVersion, repoUrl, setView, getAuthState, getActiveUser, getActiveOrg, authSignOut, checkForUpdates,
}) {

function accountMenuEl() { return document.getElementById("account-menu"); }
function accountMenuBtnEl() { return document.getElementById("header-account-menu"); }

async function openAppDataDir() {
  try {
    await invoke("app_open_data_dir");
  } catch (err) {
    console.warn("openAppDataDir failed:", err);
    alert(`Could not open the app data folder:\n${err}`);
  }
}

function menuButton(label, { icon = "", detail = "", cls = "", onclick } = {}) {
  return el("button", { class: `menu-row ${cls}`.trim(), role: "menuitem", onclick },
    el("span", { class: "menu-row-icon" }, icon),
    el("span", { class: "menu-row-label" }, label),
    detail && el("span", { class: "menu-row-detail" }, detail),
  );
}

function buildAccountMenu() {
  const progressBar = el("div", { class: "progress-bar", id: "update-progress" },
    el("div", { class: "progress-fill", id: "update-progress-fill" }));
  progressBar.style.display = "none";
  const authState = getAuthState();
  const user = getActiveUser();
  const org = getActiveOrg();
  const signedIn = Boolean(authState && authState.session);
  const syncLabel = authState?.syncFolder
    ? (authState.lastSyncedAt ? `Synced ${new Date(authState.lastSyncedAt * 1000).toLocaleString()}` : "Sync folder connected")
    : "Local profile";
  return el("div", { class: "header-menu account-menu", id: "account-menu", role: "menu", hidden: true },
    el("div", { class: "menu-account" },
      el("div", { class: "menu-account-icon" }, signedIn ? "◎" : "○"),
      el("div", { class: "menu-account-copy" },
        el("div", { class: "menu-account-primary" }, signedIn ? (user?.email || user?.name || "Local account") : "No profile connected"),
        el("div", { class: "menu-account-secondary" }, signedIn ? (org?.name || "Personal account") : "Create or connect a local profile"),
      ),
    ),
    el("div", { class: "menu-separator" }),
    menuButton("Profile & sync", {
      icon: "◎",
      detail: syncLabel,
      onclick: () => { closeAccountMenu(); setView("account"); },
    }),
    menuButton("Settings", {
      icon: "⚙",
      detail: "Preferences",
      onclick: () => { closeAccountMenu(); setView("settings"); },
    }),
    menuButton("Services & Capabilities", {
      icon: "◇",
      detail: "Developer API",
      onclick: () => { closeAccountMenu(); setView("services"); },
    }),
    el("div", { class: "menu-separator" }),
    menuButton("Open app data folder", {
      icon: "📁",
      onclick: () => { closeAccountMenu(); openAppDataDir(); },
    }),
    el("div", { class: "menu-separator" }),
    el("div", { class: "menu-app-update" },
      el("span", { class: "menu-app-version", id: "update-status" }, `S-Tier Utilities Ver. ${appVersion}`),
      el("button", {
        class: "menu-inline-btn",
        type: "button",
        onclick: () => { checkForUpdates({ manual: true }); },
      }, "Check for update"),
    ),
    progressBar,
    menuButton("GitHub repository", {
      icon: "↗",
      onclick: () => { closeAccountMenu(); openExternal(repoUrl); },
    }),
    signedIn && menuButton("Sign out", {
      icon: "↩",
      cls: "menu-row-danger",
      onclick: () => { closeAccountMenu(); authSignOut(); },
    }),
  );
}

function onAccountMenuOutside(e) {
  const m = accountMenuEl();
  if (!m || m.hidden) return;
  if (m.contains(e.target) || accountMenuBtnEl()?.contains(e.target)) return;
  closeAccountMenu();
}

function onAccountMenuKey(e) { if (e.key === "Escape") closeAccountMenu(); }

function openAccountMenu() {
  const old = accountMenuEl();
  if (old) old.replaceWith(buildAccountMenu());
  const m = accountMenuEl();
  if (!m) return;
  m.hidden = false;
  accountMenuBtnEl()?.setAttribute("aria-expanded", "true");
  setTimeout(() => {
    document.addEventListener("click", onAccountMenuOutside, true);
    document.addEventListener("keydown", onAccountMenuKey);
  }, 0);
}

function closeAccountMenu() {
  const m = accountMenuEl();
  if (!m || m.hidden) return;
  m.hidden = true;
  accountMenuBtnEl()?.setAttribute("aria-expanded", "false");
  document.removeEventListener("click", onAccountMenuOutside, true);
  document.removeEventListener("keydown", onAccountMenuKey);
}

function toggleAccountMenu() {
  const m = accountMenuEl();
  if (m && m.hidden) openAccountMenu();
  else closeAccountMenu();
}

function mount() {
  document.querySelector(".app-header")?.appendChild(buildAccountMenu());
  document.getElementById("header-account-menu")?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleAccountMenu();
  });
}

return { buildAccountMenu, mount, toggleAccountMenu, openAccountMenu, closeAccountMenu };
}
