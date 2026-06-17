import { TOOL_MANIFESTS } from "./tools/manifests.js";
import { createKernel } from "./platform/host.js";
import { buildFactories } from "./tools/capabilities.js";
import { buildServiceCatalog } from "./platform/service-catalog.js";
import { createTimeseries } from "./platform/services/timeseries.js";
import { createScheduler } from "./platform/services/scheduler.js";
import { createPackController } from "./platform/services/pack-controller.js";
import { validateManifest } from "./platform/manifest.js";
import { grantsFromInstall, approveInstall } from "./platform/mcp-loader.js";
import { buildMcpFactories } from "./platform/services/mcp-client.js";
import {
  bwClassifyDiscovery,
  bwDeviceInboxCandidates,
  bwDeviceKey,
  bwFindModeledDeviceForBacnet,
  bwImportPlanItems,
  bwModelObjectsBatch,
  bwModelQueuedDevices,
  bwPlanDeviceObjects,
  bwQueueInboxDevices,
  bwRemoveQueuedDevices,
  commissioningValueMatches,
  exportCommissioningCsv,
  exportCommissioningMarkdown,
  generateBuildingDashboard,
  historianPointFromEntity,
  interpretStatusFlags,
  parsePriorityArray,
  pointEntityFromBacnet,
  runCommissioning,
  suggestEquipmentName,
} from "./tools/building-workspace.js";
import { createUserStateInventoryStorage } from "./tools/inventory.js";

const { invoke, convertFileSrc } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const opener = window.__TAURI__.opener;
const updater = window.__TAURI__.updater;
const tauriProcess = window.__TAURI__.process;

const APP_VERSION = "0.5.4";

// ============================================================================
// Tool catalog — derived from manifests (the single source of truth) plus the
// per-tool UI renderers. The platform kernel boots from the same manifests, so
// "registering a tool" means adding a manifest, not editing this list.
// ============================================================================

// Renderers keyed by manifest id. The referenced functions are hoisted
// declarations defined later in this file.
const TOOL_RENDERERS = {
  clipboardtyper: { renderStatusPill: ctStatusPill, renderPage: renderClipboardTyperPage },
  heicmov: { renderStatusPill: hmStatusPill, renderPage: renderHeicMovPage },
  networkmanager: { renderStatusPill: nmStatusPill, renderPage: renderNetworkManagerPage },
  bacnet: { renderStatusPill: bacStatusPill, renderPage: renderBacnetPage },
  observability: { renderStatusPill: obsStatusPill, renderPage: renderObservabilityPage },
  "bacnet-historian": { renderStatusPill: histStatusPill, renderPage: renderHistorianPage },
  "building-workspace": { renderStatusPill: bwStatusPill, renderPage: renderBuildingWorkspacePage },
};

// Map a manifest to a catalog entry. First-party tools use their dedicated
// renderer; installed kind:"mcp" tools get a generic MCP page.
function manifestToTool(m) {
  let renderers = TOOL_RENDERERS[m.id];
  if (!renderers && m.kind === "mcp") {
    renderers = { renderStatusPill: () => mcpStatusPill(m), renderPage: () => renderMcpToolPage(m) };
  }
  renderers = renderers || {};
  return {
    id: m.id,
    name: m.name,
    emoji: (m.ui && m.ui.emoji) || "🧩",
    tagline: (m.ui && m.ui.tagline) || "",
    description: (m.ui && m.ui.description) || "",
    repo: m.ui && m.ui.repo,
    manifest: m,
    ...renderers,
  };
}

// The full manifest set = first-party + installed third-party (mcp) tools, and
// the catalog derived from it. Both are rebuilt (rebuildCatalog) once user state
// is loaded and after any install/remove. The kernel boots from ALL_MANIFESTS.
let ALL_MANIFESTS = [...TOOL_MANIFESTS];
// The nav-facing catalog excludes headless services (e.g. bacnet-core): they
// provide capabilities and boot in the kernel — which reads ALL_MANIFESTS — but
// have no page, so they must not show up as empty, unclickable tiles. A tool is
// catalog-visible iff manifestToTool gave it a renderPage (apps + mcp tools).
let TOOLS = ALL_MANIFESTS.map(manifestToTool).filter((t) => t.renderPage);

function rebuildCatalog() {
  const installed = (userState.installedTools || []).filter((m) => validateManifest(m).valid);
  ALL_MANIFESTS = [...TOOL_MANIFESTS, ...installed];
  TOOLS = ALL_MANIFESTS.map(manifestToTool).filter((t) => t.renderPage);
}

function toolById(id) { return TOOLS.find((t) => t.id === id); }

// The platform kernel. Booted once in bootstrap(); tool pages reach shared
// capabilities through platformHost(toolId) once it's up.
let platform = null;
// The shared timeseries service instance (passed into the kernel factories so
// every tool writes to the same buffer/ring), the scheduler, and the
// Observability Pack controller.
let telemetry = null;
let scheduler = null;
let pack = null;
// Handle for the periodic pack.flush() interval, cleared on pagehide.
let packFlushTimer = null;

/** Scoped host for a tool's page, or null if the kernel isn't booted. */
function platformHost(toolId) {
  try { return platform ? platform.hostFor(toolId) : null; }
  catch (_) { return null; }
}

// ============================================================================
// Persistent UI state
// ============================================================================

const STORAGE_KEY = "microtools.user_state.v2";

let authState = null;
let authUserStateSaveTimer = null;
let authFolderSyncTimer = null;
let authSyncBusy = false;
let authSyncMessage = "";
const authDraft = {
  name: "",
  email: "",
  orgName: "",
  newOrgName: "",
};

const userState = loadUserState();
rebuildCatalog(); // fold installed third-party (mcp) tools into the catalog

function normalizeUserState(stored = {}) {
  const persistedAt = Number(stored._persistedAt);
  return {
    _persistedAt: Number.isFinite(persistedAt) ? persistedAt : 0,
    favorites: stored.favorites || {},
    hidden: stored.hidden || {},
    showHidden: Boolean(stored.showHidden),
    libraryView: stored.libraryView === "list" ? "list" : "grid",
    nmRailWidth: Number.isFinite(stored.nmRailWidth) ? stored.nmRailWidth : 240,
    view: typeof stored.view === "string" ? stored.view : "library",
    sidebarCollapsed: Boolean(stored.sidebarCollapsed),
    activityToolFilter: typeof stored.activityToolFilter === "string" ? stored.activityToolFilter : "all",
    activityKindFilter: typeof stored.activityKindFilter === "string" ? stored.activityKindFilter : "all",
    historian: stored.historian || null,
    buildingWorkspace: stored.buildingWorkspace || null,
    inventory: stored.inventory || null,
    inventoryLegacyMigrated: Boolean(stored.inventoryLegacyMigrated),
    networkManager: stored.networkManager || null,
    installedTools: Array.isArray(stored.installedTools) ? stored.installedTools : [],
    installedGrants: stored.installedGrants || {},
  };
}

function loadUserState() {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch (_) {
    stored = {};
  }
  return normalizeUserState(stored);
}

function saveUserState() {
  userState._persistedAt = Date.now();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(userState));
  queueAuthUserStateSave();
}

function createAppInventoryStorage() {
  return createUserStateInventoryStorage({
    getState: () => userState,
    setInventory: (inventory, meta = {}) => {
      userState.inventory = inventory;
      if (meta.legacyMigrated) userState.inventoryLegacyMigrated = true;
      saveUserState();
    },
  });
}

function queueAuthUserStateSave() {
  if (!authState || !authState.session) return;
  clearTimeout(authUserStateSaveTimer);
  authUserStateSaveTimer = setTimeout(() => {
    invoke("auth_save_user_state", { userId: null, orgId: null, state: userState })
      .then(() => queueAuthFolderSync())
      .catch((err) => console.warn("[auth] could not persist user state:", err));
  }, 200);
}

function queueAuthFolderSync() {
  if (!authState || !authState.session || !authState.syncFolder) return;
  clearTimeout(authFolderSyncTimer);
  authFolderSyncTimer = setTimeout(() => {
    invoke("auth_sync_now")
      .then((result) => {
        if (result && result.state) authState = result.state;
      })
      .catch((err) => console.warn("[auth] background sync failed:", err));
  }, 1800);
}

function flushUserStatePersistence() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(userState));
  if (authUserStateSaveTimer) {
    clearTimeout(authUserStateSaveTimer);
    authUserStateSaveTimer = null;
  }
  if (authState && authState.session) {
    invoke("auth_save_user_state", { userId: null, orgId: null, state: userState })
      .catch((err) => console.warn("[auth] final state save failed:", err));
  }
}

function activeAuthUser() {
  if (!authState || !authState.session) return null;
  return (authState.users || []).find((u) => u.id === authState.session.userId) || null;
}

function activeAuthOrg() {
  if (!authState || !authState.session) return null;
  return (authState.orgs || []).find((o) => o.id === authState.session.orgId) || null;
}

function hasMeaningfulSavedState(value) {
  return value && typeof value === "object" && Object.keys(value).length > 0;
}

async function authBootstrapUserState() {
  try {
    authState = await invoke("auth_get_state");
    if (authState && authState.syncFolder) {
      try {
        const result = await invoke("auth_sync_now");
        if (result && result.state) {
          authState = result.state;
          authSyncMessage = result.message || "";
        }
      } catch (err) {
        authSyncMessage = `Startup sync failed: ${err}`;
        console.warn("[auth] startup sync failed:", err);
      }
    }
    if (!authState || !authState.session) return;
    await authLoadActiveUserState({ migrateIfEmpty: true });
  } catch (err) {
    console.warn("[auth] native state unavailable; using browser-local preferences:", err);
  }
}

async function authLoadActiveUserState({ migrateIfEmpty = true, preferNative = false } = {}) {
  if (!authState || !authState.session) return;
  const saved = await invoke("auth_load_user_state", { userId: null, orgId: null });
  if (hasMeaningfulSavedState(saved)) {
    const nativeState = normalizeUserState(saved);
    if (!preferNative && (userState._persistedAt || 0) > (nativeState._persistedAt || 0)) {
      await invoke("auth_save_user_state", { userId: null, orgId: null, state: userState });
      queueAuthFolderSync();
    } else {
      Object.assign(userState, nativeState);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(userState));
    }
    rebuildCatalog();
    applyScopedUserState();
  } else if (migrateIfEmpty) {
    await invoke("auth_save_user_state", { userId: null, orgId: null, state: userState });
    applyScopedUserState();
  } else {
    Object.assign(userState, normalizeUserState({}));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(userState));
    applyScopedUserState();
  }
}

async function authCreateLocalAccount() {
  const name = authDraft.name.trim();
  const email = authDraft.email.trim();
  const orgName = authDraft.orgName.trim();
  try {
    authState = await invoke("auth_create_local_session", {
      name,
      email,
      orgName,
    });
    await invoke("auth_save_user_state", { userId: null, orgId: null, state: userState });
    queueAuthFolderSync();
    renderAll();
  } catch (err) {
    alert(`Could not create local account: ${err}`);
  }
}

async function authSwitchOrg(orgId) {
  if (!orgId || !authState || authState.session?.orgId === orgId) return;
  try {
    await invoke("auth_save_user_state", { userId: null, orgId: null, state: userState });
    authState = await invoke("auth_switch_org", { orgId });
    await authLoadActiveUserState({ migrateIfEmpty: false, preferNative: true });
    renderAll();
  } catch (err) {
    alert(`Could not switch organization: ${err}`);
  }
}

async function authCreateOrg() {
  const orgName = authDraft.newOrgName.trim();
  if (!orgName) return;
  try {
    await invoke("auth_save_user_state", { userId: null, orgId: null, state: userState });
    authState = await invoke("auth_create_org", { orgName });
    authDraft.newOrgName = "";
    await invoke("auth_save_user_state", { userId: null, orgId: null, state: userState });
    queueAuthFolderSync();
    renderAll();
  } catch (err) {
    alert(`Could not create organization: ${err}`);
  }
}

async function authSignOut() {
  try {
    authState = await invoke("auth_sign_out");
    renderAll();
  } catch (err) {
    alert(`Could not sign out: ${err}`);
  }
}

async function authExportSnapshot() {
  try {
    const snapshot = await invoke("auth_export_snapshot");
    const text = JSON.stringify(snapshot, null, 2);
    await navigator.clipboard.writeText(text);
    alert("Account snapshot copied to clipboard.");
  } catch (err) {
    alert(`Could not export account snapshot: ${err}`);
  }
}

async function authPickSyncFolder() {
  try {
    authSyncBusy = true;
    authSyncMessage = "Opening folder picker...";
    renderAll();
    const picked = await invoke("auth_pick_sync_folder");
    if (!picked) {
      authSyncBusy = false;
      authSyncMessage = "";
      renderAll();
      return;
    }
    authState = picked;
    await authSyncNow({ quiet: true });
  } catch (err) {
    authSyncBusy = false;
    alert(`Could not connect sync folder: ${err}`);
    renderAll();
  }
}

async function authClearSyncFolder() {
  try {
    authState = await invoke("auth_clear_sync_folder");
    authSyncMessage = "";
    renderAll();
  } catch (err) {
    alert(`Could not clear sync folder: ${err}`);
  }
}

async function authSyncNow({ quiet = false } = {}) {
  try {
    if (!quiet) {
      authSyncBusy = true;
      authSyncMessage = "Syncing...";
      renderAll();
    }
    if (authState && authState.session) {
      await invoke("auth_save_user_state", { userId: null, orgId: null, state: userState });
    }
    const result = await invoke("auth_sync_now");
    authState = result.state;
    authSyncMessage = result.message || "Sync complete.";
    await authLoadActiveUserState({ migrateIfEmpty: true, preferNative: true });
  } catch (err) {
    authSyncMessage = `Sync failed: ${err}`;
    if (!quiet) alert(authSyncMessage);
  } finally {
    authSyncBusy = false;
    renderAll();
  }
}

async function resetPreferences() {
  if (!confirm("Reset all preferences (favorites, hidden tools, view)?")) return;
  localStorage.removeItem(STORAGE_KEY);
  userState.favorites = {};
  userState.hidden = {};
  userState.showHidden = false;
  userState.libraryView = "grid";
  userState.view = "library";
  userState.sidebarCollapsed = false;
  try {
    if (authState && authState.session) {
      await invoke("auth_save_user_state", { userId: null, orgId: null, state: userState });
      queueAuthFolderSync();
    }
  } catch (err) {
    console.warn("[auth] could not reset scoped preferences:", err);
  }
  saveUserState();
  applySidebarCollapsed();
  renderAll();
}

function isFavorite(id) { return Boolean(userState.favorites[id]); }
function isDefaultHidden(id) {
  const manifest = ALL_MANIFESTS.find((m) => m.id === id);
  return Boolean(manifest?.ui?.defaultHidden);
}
function isHidden(id) {
  if (Object.prototype.hasOwnProperty.call(userState.hidden, id)) return Boolean(userState.hidden[id]);
  return isDefaultHidden(id);
}

function setFavorite(id, on) {
  if (on) userState.favorites[id] = true;
  else delete userState.favorites[id];
  saveUserState();
  renderAll();
}

function setHidden(id, on) {
  if (on) {
    userState.hidden[id] = true;
    // If currently on the plugin page, bounce to library so we don't show
    // a "page for a hidden tool" state.
    if (currentPluginId() === id) userState.view = "library";
  } else {
    if (isDefaultHidden(id)) userState.hidden[id] = false;
    else delete userState.hidden[id];
  }
  saveUserState();
  renderAll();
}

function setShowHidden(on) {
  userState.showHidden = on;
  saveUserState();
  renderLibrary();
}

function setLibraryView(view) {
  userState.libraryView = view === "list" ? "list" : "grid";
  saveUserState();
  renderLibrary();
}

function setView(view) {
  bwStopLivePoll(); // tear down any live poll when leaving the current view
  userState.view = view;
  saveUserState();
  renderAll();
}

function applySidebarCollapsed() {
  const app = document.querySelector(".app");
  if (app) app.classList.toggle("sidebar-collapsed", userState.sidebarCollapsed);
  const toggle = document.getElementById("sidebar-toggle");
  if (toggle) {
    toggle.setAttribute("aria-expanded", String(!userState.sidebarCollapsed));
    toggle.title = userState.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar";
  }
}

function setSidebarCollapsed(on) {
  userState.sidebarCollapsed = on;
  saveUserState();
  applySidebarCollapsed();
}

function currentView() {
  if (userState.view === "library" || userState.view === "settings" || userState.view === "services" || userState.view === "activity" || userState.view === "account") {
    return userState.view;
  }
  if (typeof userState.view === "string" && userState.view.startsWith("plugin:")) {
    return userState.view;
  }
  return "library";
}

function currentPluginId() {
  const v = currentView();
  return v.startsWith("plugin:") ? v.slice("plugin:".length) : null;
}

function pluginView(id) { return `plugin:${id}`; }

function applyScopedUserState() {
  rebuildCatalog();
  bwRestoreState();
  applySidebarCollapsed();
  inventoryInstance()?.reload?.();
  histRestore({ replace: true });
}

// ============================================================================
// Live tool state (ClipboardTyper)
// ============================================================================

let ct = {
  running: false,
  armed: false,
  settings: { type_delay_ms: 60, modifier_hold_ms: 40, start_delay_ms: 40, trailing_tab: false, newline_as_tab: false, column_major: false, rules: [] },
};
// Deep-copy so editing pending rules doesn't mutate the last-applied state.
function ctClonePending(settings) {
  return { ...settings, rules: (settings.rules || []).map((r) => ({ ...r })) };
}
let ctPending = ctClonePending(ct.settings);

// ============================================================================
// Centralized activity log
// ============================================================================

const pluginLogs = new Map(); // toolId -> array (newest first), max 100

function logTo(toolId, msg, kind = "info") {
  let arr = pluginLogs.get(toolId);
  if (!arr) {
    arr = [];
    pluginLogs.set(toolId, arr);
  }
  arr.unshift({ time: new Date(), msg, kind });
  while (arr.length > 100) arr.pop();
  if (currentView() === "activity") renderActivityPage();
}

function activityToolLabel(toolId) {
  const tool = toolById(toolId) || ALL_MANIFESTS.map(manifestToTool).find((t) => t.id === toolId);
  return tool ? `${tool.emoji || ""} ${tool.name}`.trim() : toolId;
}

function activityEntries() {
  return [...pluginLogs.entries()]
    .flatMap(([toolId, entries]) => entries.map((entry) => ({ ...entry, toolId, toolLabel: activityToolLabel(toolId) })))
    .sort((a, b) => b.time - a.time);
}

function filteredActivityEntries() {
  const toolFilter = userState.activityToolFilter || "all";
  const kindFilter = userState.activityKindFilter || "all";
  return activityEntries().filter((entry) =>
    (toolFilter === "all" || entry.toolId === toolFilter) &&
    (kindFilter === "all" || entry.kind === kindFilter));
}

function renderActivityLogEntry(entry) {
  return el("li", { class: `log-${entry.kind} activity-log-row` },
    el("span", { class: "log-time" }, entry.time.toLocaleTimeString()),
    el("span", { class: "activity-source" }, entry.toolLabel),
    el("span", { class: `activity-kind activity-kind-${entry.kind}` }, entry.kind),
    el("span", { class: "log-msg" }, entry.msg),
  );
}

// ============================================================================
// DOM helpers
// ============================================================================

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

async function openExternal(url) {
  try {
    await opener.openUrl(url);
  } catch (err) {
    console.warn("openExternal failed:", err);
  }
}

// ============================================================================
// App header (sidebar toggle + account menu)
// ============================================================================

const REPO_URL = "https://github.com/S-Tier-Building-Automation/STierUtilities";

async function openAppDataDir() {
  try {
    await invoke("app_open_data_dir");
  } catch (err) {
    console.warn("openAppDataDir failed:", err);
    alert(`Could not open the app data folder:\n${err}`);
  }
}

// --- Account popover ---

function accountMenuEl() { return document.getElementById("account-menu"); }
function accountMenuBtnEl() { return document.getElementById("header-account-menu"); }

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
  const user = activeAuthUser();
  const org = activeAuthOrg();
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
      el("span", { class: "menu-app-version", id: "update-status" }, `S-Tier Utilities Ver. ${APP_VERSION}`),
      el("button", {
        class: "menu-inline-btn",
        type: "button",
        onclick: () => { checkForUpdates({ manual: true }); },
      }, "Check for update"),
    ),
    progressBar,
    menuButton("GitHub repository", {
      icon: "↗",
      onclick: () => { closeAccountMenu(); openExternal(REPO_URL); },
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
  // Defer so the click that opened the menu doesn't immediately close it.
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

// --- Generic modal (used for the per-tool "About" pop-out) ---
// One modal at a time: a backdrop overlay + centered card. Closes on the × button,
// a click on the backdrop (but not the card), or Escape.

let activeModal = null;

function closeModal() {
  if (!activeModal) return;
  document.removeEventListener("keydown", activeModal.onKey);
  activeModal.overlay.remove();
  activeModal = null;
}

function openModal({ title, body = [] } = {}) {
  closeModal(); // never stack
  const closeBtn = el("button", {
    class: "modal-close", title: "Close", "aria-label": "Close", onclick: closeModal,
  }, "×");
  const card = el("div",
    { class: "modal-card", role: "dialog", "aria-modal": "true", "aria-label": title || "Dialog" },
    el("div", { class: "modal-head" },
      el("h3", { class: "modal-title" }, title || ""),
      closeBtn,
    ),
    el("div", { class: "modal-body" }, ...(Array.isArray(body) ? body : [body])),
  );
  const overlay = el("div", {
    class: "modal-overlay",
    onclick: (e) => { if (e.target === e.currentTarget) closeModal(); },
  }, card);
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); closeModal(); } };
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
  activeModal = { overlay, onKey };
  closeBtn.focus(); // land keyboard focus inside the dialog
}

// A modal yes/no confirmation. Resolves true if the user confirms, false on
// cancel/dismiss. Used to gate consequential writes (e.g. acknowledging alarms).
function confirmAction({ title = "Confirm", message = "", confirmLabel = "Confirm", danger = false } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; closeModal(); resolve(v); } };
    const confirmBtn = el("button", {
      class: danger ? "btn btn-danger" : "btn btn-primary",
      onclick: () => done(true),
    }, confirmLabel);
    const cancelBtn = el("button", { class: "btn btn-ghost", onclick: () => done(false) }, "Cancel");
    const body = el("div", { class: "confirm-body" },
      el("p", {}, message),
      el("div", { class: "confirm-actions" }, cancelBtn, confirmBtn),
    );
    openModal({ title, body: [body] });
    // openModal focuses its close button; move focus to the safe default.
    cancelBtn.focus();
  });
}

// --- Toast notifications ---
// Non-modal, transient feedback (write succeeded, poll failed, import done). Themed
// with the --ok/--warn/--error tokens. Stacks in a fixed container; click to dismiss.
let toastContainer = null;
function toast(message, kind = "ok", timeoutMs = 4000) {
  if (typeof document === "undefined") return null;
  if (!toastContainer || !document.body.contains(toastContainer)) {
    toastContainer = el("div", { class: "toast-stack", "aria-live": "polite" });
    document.body.appendChild(toastContainer);
  }
  const node = el("div", { class: `toast toast-${kind}`, role: "status" }, String(message));
  const remove = () => {
    node.remove();
    if (toastContainer && !toastContainer.childElementCount) { toastContainer.remove(); toastContainer = null; }
  };
  node.addEventListener("click", remove);
  toastContainer.appendChild(node);
  setTimeout(remove, Math.max(1000, timeoutMs));
  return node;
}

// ============================================================================
// ClipboardTyper-specific bits (status pill + page)
// ============================================================================

function ctStatusPill() {
  if (!ct.running) return { label: "Idle", cls: "pill-idle" };
  if (ct.armed) return { label: "Armed", cls: "pill-running" };
  return { label: "Standby", cls: "pill-muted" };
}

function ctSlider(key, label, min, max, step, suffix) {
  const valueEl = el("span", { class: "slider-value" }, `${ctPending[key]} ${suffix}`);
  const input = el("input", {
    type: "range",
    min: String(min),
    max: String(max),
    step: String(step),
    value: String(ctPending[key]),
    oninput: (e) => {
      ctPending[key] = Number(e.target.value);
      valueEl.textContent = `${ctPending[key]} ${suffix}`;
      ctPushSettings();
    },
  });
  return el("div", { class: "slider-row" },
    el("label", {}, label),
    input,
    valueEl,
  );
}

let ctPushTimer = null;
function ctPushSettings() {
  if (ctPushTimer) clearTimeout(ctPushTimer);
  ctPushTimer = setTimeout(async () => {
    try {
      await invoke("clipboardtyper_set_settings", { settings: { ...ctPending } });
    } catch (err) {
      logTo("clipboardtyper", `Failed to update settings: ${err}`, "error");
    }
  }, 100);
}

async function ctToggleEnabled() {
  try {
    if (ct.running) {
      await invoke("clipboardtyper_stop");
      logTo("clipboardtyper", "Disabled. Middle-click is back to normal.", "warn");
    } else {
      await invoke("clipboardtyper_start");
      logTo("clipboardtyper", "Enabled. Middle-click anywhere to type your clipboard.", "ok");
    }
  } catch (err) {
    logTo("clipboardtyper", `${err}`, "error");
  }
}

async function ctSetArmed(armed) {
  try {
    await invoke("clipboardtyper_set_armed", { armed });
    logTo("clipboardtyper", armed ? "Armed." : "Disarmed (hook still installed).", "info");
  } catch (err) {
    logTo("clipboardtyper", `Failed to set armed: ${err}`, "error");
  }
}

function ctSetTrailingTab(value) {
  ctPending.trailing_tab = value;
  ctPushSettings();
  logTo(
    "clipboardtyper",
    value ? "Trailing Tab on: a Tab is sent after the last cell." : "Trailing Tab off.",
    "info",
  );
  renderAll();
}

function ctSetNewlineAsTab(value) {
  ctPending.newline_as_tab = value;
  ctPushSettings();
  logTo(
    "clipboardtyper",
    value
      ? "New line → Tab on: line breaks advance with Tab (good for copied columns)."
      : "New line → Tab off: line breaks press Enter.",
    "info",
  );
  renderAll();
}

function ctSetColumnMajor(value) {
  ctPending.column_major = value;
  ctPushSettings();
  logTo(
    "clipboardtyper",
    value
      ? "Column order on: a copied block types each column top-to-bottom (Tab-separated)."
      : "Column order off: types in Excel's left-to-right, row-by-row order.",
    "info",
  );
  renderAll();
}

function ctAddRule() {
  ctPending.rules = [...(ctPending.rules || []), { match: "", output: "" }];
  ctPushSettings();
  renderAll();
}

function ctRemoveRule(index) {
  ctPending.rules = (ctPending.rules || []).filter((_, i) => i !== index);
  ctPushSettings();
  renderAll();
}

// Live-edit of a rule field. No renderAll here — that would recreate the input
// and steal focus mid-keystroke; the state echo is also suppressed (see listener).
function ctUpdateRule(index, field, value) {
  if (!ctPending.rules || !ctPending.rules[index]) return;
  ctPending.rules[index][field] = value;
  ctPushSettings();
}

function renderClipboardTyperPage(tool) {
  const status = ctStatusPill();

  const enableBtn = el("button", {
    class: ct.running ? "btn btn-danger" : "btn btn-primary",
    onclick: ctToggleEnabled,
  }, ct.running ? "Disable" : "Enable");

  const armToggle = el("label",
    {
      class: `toggle ${ct.armed ? "toggle-on" : ""} ${!ct.running ? "toggle-disabled" : ""}`,
    },
    el("input", {
      type: "checkbox",
      checked: ct.armed ? "checked" : undefined,
      disabled: !ct.running ? "disabled" : undefined,
      onchange: (e) => ctSetArmed(e.target.checked),
    }),
    el("span", { class: "toggle-track" }, el("span", { class: "toggle-knob" })),
    el("span", { class: "toggle-label" }, "Armed"),
  );

  return el("div", { class: "plugin-controls" },
    el("section", { class: "plugin-section" },
      el("div", { class: "action-row" }, enableBtn, armToggle),
      el("p", { class: "muted small" },
        ct.running
          ? (ct.armed
              ? "Middle-click anywhere - clipboard text will be sent to the focused local window."
              : "Hook installed but disarmed. Toggle Armed to react to middle-clicks.")
          : "Click Enable to install the mouse hook.",
      ),
    ),

    el("section", { class: "plugin-section" },
      el("h3", {}, "Behavior"),
      el("label",
        { class: `toggle ${ctPending.trailing_tab ? "toggle-on" : ""}` },
        el("input", {
          type: "checkbox",
          checked: ctPending.trailing_tab ? "checked" : undefined,
          onchange: (e) => ctSetTrailingTab(e.target.checked),
        }),
        el("span", { class: "toggle-track" }, el("span", { class: "toggle-knob" })),
        el("span", { class: "toggle-label" }, "Trailing Tab"),
      ),
      el("p", { class: "muted small" },
        "Press Tab once more after the last cell, so you can type a copied Excel ",
        "row and land on the next field (or next row) without advancing manually.",
      ),
      el("label",
        { class: `toggle ${ctPending.newline_as_tab ? "toggle-on" : ""}` },
        el("input", {
          type: "checkbox",
          checked: ctPending.newline_as_tab ? "checked" : undefined,
          onchange: (e) => ctSetNewlineAsTab(e.target.checked),
        }),
        el("span", { class: "toggle-track" }, el("span", { class: "toggle-knob" })),
        el("span", { class: "toggle-label" }, "New line → Tab"),
      ),
      el("p", { class: "muted small" },
        "Treat line breaks as a Tab instead of Enter. A column copied from Excel is ",
        "new-line separated (no tabs), so turn this on to advance field-to-field.",
      ),
      el("label",
        { class: `toggle ${ctPending.column_major ? "toggle-on" : ""}` },
        el("input", {
          type: "checkbox",
          checked: ctPending.column_major ? "checked" : undefined,
          onchange: (e) => ctSetColumnMajor(e.target.checked),
        }),
        el("span", { class: "toggle-track" }, el("span", { class: "toggle-knob" })),
        el("span", { class: "toggle-label" }, "Column order (top → bottom)"),
      ),
      el("p", { class: "muted small" },
        "When you copy a block of several columns, type each column top-to-bottom ",
        "instead of Excel's left-to-right, row-by-row order. Values are Tab-separated, ",
        "so this covers the \"New line → Tab\" case on its own.",
      ),
    ),

    el("section", { class: "plugin-section" },
      el("h3", {}, "Cell Rules"),
      el("p", { class: "muted small rule-tokens" },
        "When a cell matches (case-insensitive), send the output instead of typing it. ",
        "Output can mix text with key tokens: ",
        el("code", {}, "{space}"), " ", el("code", {}, "{tab}"), " ", el("code", {}, "{enter}"), " ",
        el("code", {}, "{esc}"), " ", el("code", {}, "{up}"), " ", el("code", {}, "{down}"), " ",
        el("code", {}, "{left}"), " ", el("code", {}, "{right}"), " ", el("code", {}, "{bksp}"), " ",
        el("code", {}, "{del}"), ". Leave the output blank to skip the cell (just advance).",
      ),
      ...(ctPending.rules || []).map((rule, i) =>
        el("div", { class: "rule-row" },
          el("input", {
            type: "text",
            class: "rule-input rule-match",
            placeholder: "when cell is…",
            value: rule.match ?? "",
            oninput: (e) => ctUpdateRule(i, "match", e.target.value),
          }),
          el("span", { class: "rule-arrow" }, "→"),
          el("input", {
            type: "text",
            class: "rule-input rule-output",
            placeholder: "send instead (e.g. {space})",
            value: rule.output ?? "",
            oninput: (e) => ctUpdateRule(i, "output", e.target.value),
          }),
          el("button", { class: "btn btn-ghost rule-remove", title: "Remove rule", onclick: () => ctRemoveRule(i) }, "✕"),
        ),
      ),
      el("button", { class: "btn btn-ghost", onclick: ctAddRule }, "+ Add rule"),
    ),

    el("section", { class: "plugin-section" },
      el("h3", {}, "Timing"),
      ctSlider("type_delay_ms", "Type delay", 0, 200, 5, "ms"),
      ctSlider("modifier_hold_ms", "Modifier hold", 0, 200, 5, "ms"),
      ctSlider("start_delay_ms", "Start delay", 0, 500, 10, "ms"),
      el("p", { class: "muted small" },
        "Modifier hold can help when a remote tool forwards injected input but ",
        "drops shifted characters. If DeskIn receives nothing at all, it is likely ",
        "blocking injected input before timing matters.",
      ),
    ),
  );
}


// ============================================================================
// HEIC & MOV (status pill + page)
// ============================================================================

let hm = {
  files: [],
  selectedPath: null,
  outputDir: null,
  imageFormat: "jpeg",
  overwrite: false,
  busy: false,
  busyLabel: "",
  progress: null,
  previewSrc: null,
  previewMime: null,
};

function hmStatusPill() {
  if (hm.busy) {
    const label = hm.progress
      ? `${hm.busyLabel} ${hm.progress.done}/${hm.progress.total}`
      : hm.busyLabel || "Working";
    return { label, cls: "pill-running" };
  }
  if (hm.files.length === 0) return { label: "No files", cls: "pill-idle" };
  return { label: `${hm.files.length} file${hm.files.length === 1 ? "" : "s"}`, cls: "pill-muted" };
}

function hmSelectedFile() {
  return hm.files.find((f) => f.path === hm.selectedPath) || null;
}

function hmFormatFileMeta(file) {
  const parts = [];
  if (file.width && file.height) parts.push(`${file.width}×${file.height}`);
  if (file.duration_sec != null) {
    const s = Math.round(file.duration_sec);
    const m = Math.floor(s / 60);
    const r = s % 60;
    parts.push(m > 0 ? `${m}:${String(r).padStart(2, "0")}` : `${s}s`);
  }
  parts.push(file.kind === "video" ? "video" : "image");
  return parts.join(" · ");
}

async function hmRefreshPreview() {
  const file = hmSelectedFile();
  hm.previewSrc = null;
  hm.previewMime = null;
  if (!file) {
    renderAll();
    return;
  }
  hm.busy = true;
  hm.busyLabel = "Previewing";
  renderAll();
  try {
    const preview = await invoke("heicmov_make_preview", { path: file.path });
    hm.previewSrc = convertFileSrc(preview.preview_path);
    hm.previewMime = preview.mime;
    logTo("heicmov", `Preview ready: ${file.path.split(/[/\\]/).pop()}`, "ok");
  } catch (err) {
    logTo("heicmov", `Preview failed: ${err}`, "error");
  } finally {
    hm.busy = false;
    hm.busyLabel = "";
    renderAll();
  }
}

async function hmPickFiles() {
  try {
    const paths = await invoke("heicmov_pick_files");
    if (!paths || paths.length === 0) return;
    hm.busy = true;
    hm.busyLabel = "Loading";
    hm.progress = { done: 0, total: paths.length };
    renderAll();

    const files = [];
    for (const path of paths) {
      try {
        const probe = await invoke("heicmov_probe", { path });
        files.push(probe);
        logTo("heicmov", `Added ${path.split(/[/\\]/).pop()}`, "info");
      } catch (err) {
        logTo("heicmov", `Skipped ${path}: ${err}`, "error");
      }
      hm.progress.done += 1;
      renderAll();
    }

    hm.files = files;
    if (files.length > 0) {
      const stillSelected = files.some((f) => f.path === hm.selectedPath);
      hm.selectedPath = stillSelected ? hm.selectedPath : files[0].path;
      await hmRefreshPreview();
    } else {
      hm.selectedPath = null;
    }
  } catch (err) {
    logTo("heicmov", `Could not pick files: ${err}`, "error");
  } finally {
    hm.busy = false;
    hm.busyLabel = "";
    hm.progress = null;
    renderAll();
  }
}

async function hmPickOutputDir() {
  try {
    const dir = await invoke("heicmov_pick_output_dir");
    if (dir) {
      hm.outputDir = dir;
      logTo("heicmov", `Output folder: ${dir}`, "info");
      renderAll();
    }
  } catch (err) {
    logTo("heicmov", `Could not pick folder: ${err}`, "error");
  }
}

async function hmConvert() {
  if (hm.files.length === 0) return;
  hm.busy = true;
  hm.busyLabel = "Converting";
  hm.progress = { done: 0, total: hm.files.length };
  renderAll();
  try {
    const batch = await invoke("heicmov_convert", {
      paths: hm.files.map((f) => f.path),
      outputDir: hm.outputDir,
      imageFormat: hm.imageFormat,
      overwrite: hm.overwrite,
    });
    let okCount = 0;
    for (const r of batch.results) {
      const name = r.input.split(/[/\\]/).pop();
      if (r.ok) {
        okCount += 1;
        logTo("heicmov", `Converted ${name} → ${r.output.split(/[/\\]/).pop()}`, "ok");
      } else {
        logTo("heicmov", `${name}: ${r.error || "failed"}`, "error");
      }
      hm.progress.done += 1;
      renderAll();
    }
    logTo("heicmov", `Done — ${okCount}/${batch.results.length} succeeded.`, okCount ? "ok" : "warn");
  } catch (err) {
    logTo("heicmov", `Convert failed: ${err}`, "error");
  } finally {
    hm.busy = false;
    hm.busyLabel = "";
    hm.progress = null;
    renderAll();
  }
}

async function hmOpenOutputFolder() {
  const dir = hm.outputDir
    || (hm.files[0] ? hm.files[0].path.replace(/[/\\][^/\\]+$/, "") : null);
  if (!dir) return;
  try {
    await invoke("heicmov_open_path", { path: dir });
  } catch (err) {
    logTo("heicmov", `Could not open folder: ${err}`, "error");
  }
}

function hmSelectFile(path) {
  if (hm.selectedPath === path) return;
  hm.selectedPath = path;
  hmRefreshPreview();
}

function hmRemoveFile(path) {
  hm.files = hm.files.filter((f) => f.path !== path);
  if (hm.selectedPath === path) {
    hm.selectedPath = hm.files[0]?.path || null;
    hm.previewSrc = null;
    hm.previewMime = null;
    if (hm.selectedPath) hmRefreshPreview();
    else renderAll();
    return;
  }
  renderAll();
}

function hmClearFiles() {
  hm.files = [];
  hm.selectedPath = null;
  hm.previewSrc = null;
  hm.previewMime = null;
  renderAll();
}

function renderHeicMovPage() {
  const pickBtn = el("button", {
    class: "btn btn-primary",
    disabled: hm.busy ? "disabled" : undefined,
    onclick: hmPickFiles,
  }, "Choose files…");

  const clearBtn = el("button", {
    class: "btn-ghost",
    disabled: hm.busy || hm.files.length === 0 ? "disabled" : undefined,
    onclick: hmClearFiles,
  }, "Clear list");

  const fileList = el("ul", { class: "hm-file-list" });
  if (hm.files.length === 0) {
    fileList.appendChild(el("li", { class: "hm-file-empty muted small" },
      "No files yet. Choose HEIC, HEIF, or MOV files to preview and convert.",
    ));
  } else {
    for (const file of hm.files) {
      const active = file.path === hm.selectedPath;
      fileList.appendChild(el("li", {
        class: `hm-file-row ${active ? "hm-file-active" : ""}`,
        onclick: () => hmSelectFile(file.path),
      },
        el("span", { class: "hm-file-name" }, file.path.split(/[/\\]/).pop()),
        el("span", { class: "hm-file-meta muted small" }, hmFormatFileMeta(file)),
        el("button", {
          class: "btn-ghost hm-file-remove",
          title: "Remove",
          onclick: (e) => { e.stopPropagation(); hmRemoveFile(file.path); },
        }, "×"),
      ));
    }
  }

  let previewNode;
  if (hm.previewSrc && hm.previewMime?.startsWith("video/")) {
    previewNode = el("video", {
      class: "hm-preview-media",
      src: hm.previewSrc,
      controls: "controls",
    });
  } else if (hm.previewSrc) {
    previewNode = el("img", {
      class: "hm-preview-media",
      src: hm.previewSrc,
      alt: "Preview",
    });
  } else {
    previewNode = el("p", { class: "hm-preview-empty muted small" },
      hm.busy ? "Generating preview…" : "Select a file to preview.",
    );
  }

  const outputLabel = hm.outputDir
    ? hm.outputDir
    : "Same folder as each source file";

  const convertBtn = el("button", {
    class: "btn btn-primary",
    disabled: hm.busy || hm.files.length === 0 ? "disabled" : undefined,
    onclick: hmConvert,
  }, hm.busy && hm.busyLabel === "Converting" ? "Converting…" : "Convert all");

  const openFolderBtn = el("button", {
    class: "btn-ghost",
    disabled: hm.files.length === 0 && !hm.outputDir ? "disabled" : undefined,
    onclick: hmOpenOutputFolder,
  }, "Open output folder");

  return el("div", { class: "plugin-controls" },
    el("section", { class: "plugin-section" },
      el("h3", {}, "Files"),
      el("div", { class: "action-row" }, pickBtn, clearBtn),
      fileList,
    ),

    el("section", { class: "plugin-section" },
      el("h3", {}, "Preview"),
      el("div", { class: "hm-preview-frame" }, previewNode),
    ),

    el("section", { class: "plugin-section" },
      el("h3", {}, "Convert"),
      el("p", { class: "muted small" },
        "Images → JPEG or PNG. Videos → MP4 (H.264 + AAC).",
      ),
      el("div", { class: "hm-convert-options" },
        el("label", { class: "hm-option" }, "Image format",
          el("select", {
            disabled: hm.busy ? "disabled" : undefined,
            onchange: (e) => { hm.imageFormat = e.target.value; },
          },
            el("option", { value: "jpeg", selected: hm.imageFormat === "jpeg" ? "selected" : undefined }, "JPEG"),
            el("option", { value: "png", selected: hm.imageFormat === "png" ? "selected" : undefined }, "PNG"),
          ),
        ),
        el("label", { class: "checkbox-row hm-option" },
          el("input", {
            type: "checkbox",
            checked: hm.overwrite ? "checked" : undefined,
            disabled: hm.busy ? "disabled" : undefined,
            onchange: (e) => { hm.overwrite = e.target.checked; },
          }),
          el("span", {}, "Overwrite existing outputs"),
        ),
      ),
      el("p", { class: "muted small hm-output-line" },
        "Output: ",
        el("span", { class: "hm-output-path" }, outputLabel),
        el("button", {
          class: "btn-ghost hm-pick-dir",
          disabled: hm.busy ? "disabled" : undefined,
          onclick: hmPickOutputDir,
        }, hm.outputDir ? "Change folder…" : "Choose folder…"),
        hm.outputDir ? el("button", {
          class: "btn-ghost",
          disabled: hm.busy ? "disabled" : undefined,
          onclick: () => { hm.outputDir = null; renderAll(); },
        }, "Use source folders") : null,
      ),
      el("div", { class: "action-row" }, convertBtn, openFolderBtn),
    ),
  );
}


// ============================================================================
// Network Manager (status pill + page)
// ============================================================================

const nmCachedSnapshot = userState.networkManager?.adapterSnapshot || null;
const nmCachedAdapters = Array.isArray(nmCachedSnapshot?.adapters) ? nmCachedSnapshot.adapters : [];
const nmCachedStateByAdapter = nmCachedSnapshot?.stateByAdapter && typeof nmCachedSnapshot.stateByAdapter === "object"
  ? nmCachedSnapshot.stateByAdapter
  : {};
const nmCachedSelectedAdapter = typeof userState.networkManager?.selectedAdapter === "string" ? userState.networkManager.selectedAdapter : "";

let nm = {
  adapters: nmCachedAdapters, // NetworkAdapterInfo[]
  profiles: [],            // NetworkProfile[]
  selectedId: nmCachedSelectedAdapter ? null : (typeof userState.networkManager?.selectedProfileId === "string" ? userState.networkManager.selectedProfileId : null), // selected profile id (mutually exclusive with selectedAdapter)
  selectedAdapter: nmCachedSelectedAdapter || null, // selected adapter name, when inspecting a live NIC
  stateByAdapter: nmCachedStateByAdapter, // adapterName -> AdapterNetworkState
  matchById: {},           // profileId -> ProfileMatchResult
  busy: false,
  busyLabel: "",
  loaded: nmCachedAdapters.length > 0, // adapters/state read at least once or hydrated from cache
  adapterSnapshotStale: nmCachedAdapters.length > 0,
  adapterSnapshotAt: typeof nmCachedSnapshot?.readAt === "string" ? nmCachedSnapshot.readAt : "",
  autoRefreshAttempted: false,
  tab: userState.networkManager?.tab === "scan" ? "scan" : "configure", // "configure" (merged adapters+profiles) | "scan"
  scan: {
    adapterName: typeof userState.networkManager?.scanAdapterName === "string" ? userState.networkManager.scanAdapterName : "", // adapter whose subnet we sweep
    scanning: false,
    scanned: 0,
    total: 0,
    hosts: [],             // ScanHost[]: { ip, rttMs, mac, hostname }
    filter: "",            // free-text filter over ip/hostname/mac
    sortKey: "ip",         // "ip" | "hostname" | "mac" | "rtt"
    sortDir: "asc",        // "asc" | "desc"
    done: false,
    error: "",
    listenersReady: false,
  },
};

function nmNewId() {
  return (crypto?.randomUUID?.()) || `p${Date.now()}${Math.random().toString(16).slice(2)}`;
}

function nmBlankProfile() {
  return {
    id: nmNewId(),
    name: "New profile",
    adapterName: "",
    ipv4Mode: "dhcp",
    ipAddress: "",
    subnetMask: "255.255.255.0",
    gateway: "",
    dnsMode: "nochange",
    primaryDns: "",
    secondaryDns: "",
    notes: "",
    lastAppliedAt: null,
  };
}

function nmStatusPill() {
  if (nm.busy) return { label: nm.busyLabel || "Working", cls: "pill-running" };
  const n = nm.profiles.length;
  if (n === 0) return { label: "No profiles", cls: "pill-idle" };
  const active = nm.profiles.filter((p) => nm.matchById[p.id]?.isMatch).length;
  return active > 0
    ? { label: `${active}/${n} active`, cls: "pill-running" }
    : { label: `${n} profile${n === 1 ? "" : "s"}`, cls: "pill-muted" };
}

function nmSelected() { return nm.profiles.find((p) => p.id === nm.selectedId) || null; }

function nmMatch(p) {
  return nm.matchById[p.id] || { isMatch: false, status: "Needs refresh", detail: "Refresh adapters to evaluate." };
}

function nmUniqueName(base) {
  const taken = new Set(nm.profiles.map((p) => p.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  let i = 2;
  while (taken.has(`${base} ${i}`.toLowerCase())) i += 1;
  return `${base} ${i}`;
}

function nmIpv4Summary(s) {
  if (!s) return "Unavailable";
  if (s.ipv4Mode === "dhcp") return s.ipAddress ? `DHCP (${s.ipAddress})` : "DHCP";
  return s.ipAddress ? `${s.ipAddress} / ${s.subnetMask || "?"}` : "none";
}

function nmDnsSummary(s) {
  if (!s) return "Unavailable";
  const list = (s.dnsServers || []).join(", ");
  if (s.dnsMode === "manual") return list || "none";
  return list ? `Automatic (${list})` : "Automatic";
}

// ---- data flow ----

let nmSaveTimer = null;
function nmSaveSoon() {
  if (nmSaveTimer) clearTimeout(nmSaveTimer);
  nmSaveTimer = setTimeout(nmSaveNow, 250);
}
async function nmSaveNow() {
  try {
    await invoke("networkmanager_save_profiles", { profiles: nm.profiles });
  } catch (err) {
    logTo("networkmanager", `Could not save profiles: ${err}`, "error");
  }
}

function nmSaveUiState() {
  userState.networkManager = {
    ...(userState.networkManager || {}),
    selectedAdapter: nm.selectedAdapter || "",
    selectedProfileId: nm.selectedId || "",
    tab: nm.tab,
    scanAdapterName: nm.scan.adapterName || "",
    adapterSnapshot: userState.networkManager?.adapterSnapshot || null,
  };
  saveUserState();
}

function nmSaveAdapterSnapshot() {
  const readAt = new Date().toISOString();
  nm.adapterSnapshotAt = readAt;
  userState.networkManager = {
    ...(userState.networkManager || {}),
    selectedAdapter: nm.selectedAdapter || "",
    selectedProfileId: nm.selectedId || "",
    tab: nm.tab,
    scanAdapterName: nm.scan.adapterName || "",
    adapterSnapshot: {
      readAt,
      adapters: nm.adapters,
      stateByAdapter: nm.stateByAdapter,
    },
  };
  saveUserState();
}

async function nmLoadProfiles() {
  try {
    nm.profiles = await invoke("networkmanager_load_profiles");
    if (nm.selectedId && !nm.profiles.some((p) => p.id === nm.selectedId)) nm.selectedId = null;
    if (nm.profiles.length && !nm.selectedId && !nm.selectedAdapter) nm.selectedId = nm.profiles[0].id;
    nmSaveUiState();
  } catch (err) {
    logTo("networkmanager", `Could not load profiles: ${err}`, "error");
  }
}

async function nmRecomputeMatch(p) {
  const state = nm.stateByAdapter[p.adapterName];
  if (!state) {
    nm.matchById[p.id] = {
      isMatch: false,
      status: p.adapterName ? "No adapter" : "Needs setup",
      detail: p.adapterName
        ? `No live snapshot for ${p.adapterName}. Refresh adapters.`
        : "Pick a target adapter for this profile.",
    };
    return;
  }
  try {
    nm.matchById[p.id] = await invoke("networkmanager_compare", { profile: p, state });
  } catch (err) {
    nm.matchById[p.id] = { isMatch: false, status: "Error", detail: String(err) };
  }
}

async function nmRecomputeAll() { await Promise.all(nm.profiles.map(nmRecomputeMatch)); }

async function nmApplyStartupSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.adapters)) return false;
  nm.adapters = snapshot.adapters;
  nm.stateByAdapter = snapshot.stateByAdapter && typeof snapshot.stateByAdapter === "object"
    ? snapshot.stateByAdapter
    : {};
  nm.loaded = true;
  nm.adapterSnapshotStale = false;
  nm.autoRefreshAttempted = true;
  await nmRecomputeAll();
  nmSaveAdapterSnapshot();
  logTo("networkmanager", `Loaded ${nm.adapters.length} adapter${nm.adapters.length === 1 ? "" : "s"} from native startup warmup.`, "ok");
  return true;
}

async function nmRefresh({ automatic = false } = {}) {
  nm.autoRefreshAttempted = true;
  nm.busy = true;
  nm.busyLabel = nm.loaded ? "Refreshing adapters" : "Reading adapters";
  renderAll();
  try {
    nm.adapters = await invoke("networkmanager_list_adapters");
    nm.stateByAdapter = {};
    // Read adapter states concurrently — each shells out to PowerShell (~0.5-1.5s),
    // so a sequential loop would freeze the UI for several seconds on multi-NIC boxes.
    await Promise.all(
      nm.adapters
        .filter((a) => a.status !== "Not Present")
        .map(async (a) => {
          try {
            nm.stateByAdapter[a.name] = await invoke("networkmanager_read_state", { name: a.name });
          } catch (err) {
            logTo("networkmanager", `Could not read ${a.name}: ${err}`, "warn");
          }
        }),
    );
    await nmRecomputeAll();
    nm.loaded = true;
    nm.adapterSnapshotStale = false;
    nmSaveAdapterSnapshot();
    logTo("networkmanager", `Read ${nm.adapters.length} adapter${nm.adapters.length === 1 ? "" : "s"}.`, "ok");
  } catch (err) {
    if (!automatic || !nm.loaded) logTo("networkmanager", `Refresh failed: ${err}`, "error");
    else logTo("networkmanager", `Background adapter refresh failed: ${err}`, "warn");
  } finally {
    nm.busy = false;
    nm.busyLabel = "";
    renderAll();
  }
}

function nmEnsureLoaded() {
  if (!nm.loaded && !nm.busy) nmRefresh();
  else if (nm.adapterSnapshotStale && !nm.busy && !nm.autoRefreshAttempted) nmRefresh({ automatic: true });
}

function nmDefaultAdapter() {
  const sel = nmSelected();
  if (sel?.adapterName) return sel.adapterName;
  const up = nm.adapters.find((a) => a.status === "Up");
  return up?.name || nm.adapters[0]?.name || "";
}

async function nmNew() {
  const p = nmBlankProfile();
  p.name = nmUniqueName("New profile");
  p.adapterName = nmDefaultAdapter();
  nm.profiles.push(p);
  nm.selectedId = p.id;
  nm.selectedAdapter = null;
  await nmRecomputeMatch(p);
  nmSaveSoon();
  nmSaveUiState();
  logTo("networkmanager", `Created "${p.name}".`, "info");
  renderAll();
}

async function nmDuplicate() {
  const sel = nmSelected();
  if (!sel) return;
  const p = { ...sel, id: nmNewId(), name: nmUniqueName(`${sel.name} copy`), lastAppliedAt: null };
  nm.profiles.push(p);
  nm.selectedId = p.id;
  nm.selectedAdapter = null;
  await nmRecomputeMatch(p);
  nmSaveSoon();
  nmSaveUiState();
  renderAll();
}

function nmDelete() {
  const sel = nmSelected();
  if (!sel) return;
  if (!confirm(`Delete profile "${sel.name}"?`)) return;
  const idx = nm.profiles.findIndex((p) => p.id === sel.id);
  nm.profiles = nm.profiles.filter((p) => p.id !== sel.id);
  delete nm.matchById[sel.id];
  const next = nm.profiles[idx] || nm.profiles[idx - 1] || null;
  nm.selectedId = next?.id || null;
  nmSaveSoon();
  nmSaveUiState();
  logTo("networkmanager", `Deleted "${sel.name}".`, "warn");
  renderAll();
}

function nmSelect(id) {
  if (nm.selectedId === id && !nm.selectedAdapter) return;
  nm.selectedId = id;
  nm.selectedAdapter = null;
  nmSaveUiState();
  renderAll();
}

// Select a live adapter (shows its detail in the config panel). Mutually
// exclusive with a profile selection.
function nmSelectAdapter(name) {
  if (nm.selectedAdapter === name) return;
  nm.selectedAdapter = name;
  nm.selectedId = null;
  nmSaveUiState();
  renderAll();
}

let nmFieldTimer = null;
function nmSetText(key, value) {
  const sel = nmSelected();
  if (!sel) return;
  sel[key] = value;
  nmSaveSoon();
  if (nmFieldTimer) clearTimeout(nmFieldTimer);
  nmFieldTimer = setTimeout(async () => {
    await nmRecomputeMatch(sel);
    nmRefreshLiveBits();
  }, 250);
}

// Update only the drift banner + profile list in place, so editing a text field
// never steals focus from the input being typed into.
function nmRefreshLiveBits() {
  if (currentPluginId() !== "networkmanager") return;
  const sel = nmSelected();
  const rail = document.getElementById("nm-config-rail");
  if (rail) rail.replaceChildren(...nmConfigRailContent());
  const drift = document.getElementById("nm-drift");
  if (drift && sel) drift.replaceWith(nmDriftBanner(sel));
  const title = document.getElementById("nm-editor-title");
  if (title && sel) title.textContent = sel.name || "(unnamed)";
}

async function nmSetChoice(key, value) {
  const sel = nmSelected();
  if (!sel) return;
  sel[key] = value;
  nmSaveSoon();
  await nmRecomputeMatch(sel);
  renderAll();
}

async function nmCaptureAdapter(adapterName) {
  if (!adapterName) {
    logTo("networkmanager", "No adapter available to capture.", "warn");
    return;
  }
  nm.busy = true;
  nm.busyLabel = "Capturing";
  renderAll();
  try {
    const p = await invoke("networkmanager_capture_profile", { name: adapterName });
    p.id = nmNewId();
    p.name = nmUniqueName(p.name);
    nm.profiles.push(p);
    nm.selectedId = p.id;
    nm.selectedAdapter = null;   // show the new profile's editor in the config panel
    await nmRecomputeMatch(p);
    nmSaveNow();
    logTo("networkmanager", `Captured "${p.name}" from ${adapterName}.`, "ok");
  } catch (err) {
    logTo("networkmanager", `Capture failed: ${err}`, "error");
  } finally {
    nm.busy = false;
    nm.busyLabel = "";
    renderAll();
  }
}

async function nmOpenDir() {
  try {
    await invoke("networkmanager_open_profiles_dir");
  } catch (err) {
    logTo("networkmanager", `Could not open folder: ${err}`, "error");
  }
}

async function nmApply() {
  const sel = nmSelected();
  if (!sel || nm.busy) return;
  if (!sel.adapterName) {
    logTo("networkmanager", "Pick a target adapter before applying.", "warn");
    return;
  }
  // Snapshot the profile before any await. The user can still edit fields while
  // UAC / apply / re-read is in flight, so we must verify against exactly what we
  // sent — not against a profile that changed underneath us.
  const applied = { ...sel };

  const proceed = confirm(
    `Apply "${applied.name}" to ${applied.adapterName}?\n\n` +
    `This changes Windows IPv4/DNS settings and will prompt for administrator approval.`,
  );
  if (!proceed) return;

  nm.busy = true;
  nm.busyLabel = "Applying";
  renderAll();
  let attempted = false;
  let hadStepIssue = false;
  try {
    const outcome = await invoke("networkmanager_apply_profile", { profile: applied });
    attempted = true;
    hadStepIssue = !outcome.ok;
    for (const s of outcome.steps) {
      logTo("networkmanager", `${s.step}: ${s.detail}`, s.ok ? "ok" : "error");
    }
  } catch (err) {
    logTo("networkmanager", `${err}`, "error");
  } finally {
    // The authoritative "did it work?" signal is the re-read state, NOT the step
    // exit codes — netsh can apply a change and still return non-zero. So always
    // re-read and judge success by whether Windows matches the applied snapshot.
    if (attempted && applied.adapterName) {
      nm.busyLabel = "Verifying";
      renderAll();
      await new Promise((r) => setTimeout(r, 1000));
      let state = null;
      try {
        state = await invoke("networkmanager_read_state", { name: applied.adapterName });
        nm.stateByAdapter[applied.adapterName] = state;
      } catch (err) {
        logTo("networkmanager", `Could not re-read ${applied.adapterName}: ${err}`, "warn");
      }
      let matched = false;
      let detail = "No live snapshot.";
      if (state) {
        try {
          const m = await invoke("networkmanager_compare", { profile: applied, state });
          matched = m.isMatch;
          detail = m.detail;
        } catch (err) {
          detail = String(err);
        }
      }
      if (matched) {
        const live = nm.profiles.find((p) => p.id === applied.id);
        if (live) {
          live.lastAppliedAt = new Date().toISOString();
          nmSaveNow();
        }
        logTo("networkmanager", `Applied "${applied.name}" — Windows now matches.`, "ok");
      } else {
        logTo(
          "networkmanager",
          `Applied, but Windows doesn't match yet: ${detail}`,
          hadStepIssue ? "error" : "warn",
        );
      }
      // Keep the on-screen drift for the currently-selected profile in sync.
      const cur = nmSelected();
      if (cur) await nmRecomputeMatch(cur);
    }
    nm.busy = false;
    nm.busyLabel = "";
    renderAll();
  }
}

// ---- render ----

// Active / Drift / Idle status for a profile, derived from its live-match result:
// Active = currently applied; Drift = its target adapter is present but live config
// differs; Idle = no present target adapter.
function nmProfileStatus(p) {
  if (nmMatch(p).isMatch) return { dot: "nm-dot-active", label: "Active", cls: "nm-nic-active" };
  const present = nm.adapters.some((a) => a.name === p.adapterName && a.status !== "Not Present");
  return present
    ? { dot: "nm-dot-drift", label: "Drift", cls: "nm-state-drift" }
    : { dot: "nm-dot-idle", label: "Idle", cls: "muted" };
}

// A profile row in the grouped config rail (the adapter it targets is implied by
// its group, so the row only carries name + status).
function nmRailProfileRow(p) {
  const active = !nm.selectedAdapter && p.id === nm.selectedId;
  const s = nmProfileStatus(p);
  return el("div", {
    class: `nm-rail-profile ${active ? "selected" : ""}`,
    role: "button",
    tabindex: "0",
    title: p.name || "(unnamed)",
    "aria-pressed": active ? "true" : "false",
    onclick: () => nmSelect(p.id),
    onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); nmSelect(p.id); } },
  },
    el("span", { class: `nm-rail-dot ${s.dot}`, "aria-hidden": "true" }),
    el("span", { class: "nm-rail-pname" }, p.name || "(unnamed)"),
    el("span", { class: `nm-rail-pstate small ${s.cls}` }, s.label),
  );
}

function nmDriftBanner(p) {
  const m = nmMatch(p);
  const state = nm.stateByAdapter[p.adapterName];
  const snapshot = state
    ? `${state.adapterName}: IPv4 ${nmIpv4Summary(state)} · gateway ${state.gateway || "none"} · DNS ${nmDnsSummary(state)}`
    : "No live snapshot yet — use Refresh adapters.";
  return el("div", { id: "nm-drift", class: `nm-drift ${m.isMatch ? "nm-drift-active" : ""}` },
    el("div", { class: "nm-drift-status" }, m.isMatch ? "✓ Active" : (m.status || "Not active")),
    m.detail ? el("div", { class: "muted small" }, m.detail) : null,
    el("div", { class: "muted small nm-drift-snapshot" }, snapshot),
  );
}

function nmTextField(label, key, opts = {}) {
  const sel = nmSelected();
  const input = el("input", {
    class: "nm-input",
    type: "text",
    placeholder: opts.placeholder || "",
    disabled: opts.disabled ? "disabled" : undefined,
    oninput: (e) => nmSetText(key, e.target.value),
  });
  input.value = sel[key] || "";
  return el("label", { class: `nm-field ${opts.disabled ? "nm-field-dim" : ""}` },
    el("span", { class: "nm-field-label" }, label),
    input,
  );
}

function nmSeg(label, key, options) {
  const sel = nmSelected();
  return el("div", { class: "nm-seg-row" },
    el("span", { class: "nm-field-label" }, label),
    el("div", { class: "nm-seg" },
      ...options.map((opt) => el("button", {
        class: `nm-seg-btn ${sel[key] === opt.value ? "nm-seg-on" : ""}`,
        onclick: () => nmSetChoice(key, opt.value),
      }, opt.label)),
    ),
  );
}

function nmEditorContent(sel) {
  const usesStatic = sel.ipv4Mode === "static";
  const usesManual = sel.dnsMode === "manual";

  const adapterSelect = el("select", {
    class: "nm-input",
    onchange: (e) => nmSetChoice("adapterName", e.target.value),
  },
    el("option", { value: "" }, "— choose adapter —"),
    ...nm.adapters.map((a) => el("option", {
      value: a.name,
      selected: a.name === sel.adapterName ? "selected" : undefined,
    }, a.description ? `${a.name} — ${a.description}` : a.name)),
    (sel.adapterName && !nm.adapters.some((a) => a.name === sel.adapterName))
      ? el("option", { value: sel.adapterName, selected: "selected" }, `${sel.adapterName} (not found)`)
      : null,
  );

  const notes = el("textarea", {
    class: "nm-input nm-textarea",
    oninput: (e) => nmSetText("notes", e.target.value),
  });
  notes.value = sel.notes || "";

  const header = el("div", { class: "nm-editor-head" },
    el("h3", { id: "nm-editor-title", class: "nm-editor-title" }, sel.name || "(unnamed)"),
    el("div", { class: "nm-editor-actions" },
      el("button", {
        class: "btn btn-primary nm-apply-btn",
        disabled: nm.busy || !sel.adapterName ? "disabled" : undefined,
        title: "Apply this profile to Windows (prompts for admin)",
        onclick: nmApply,
      }, "Apply"),
      el("button", { class: "btn-ghost", disabled: nm.busy ? "disabled" : undefined, onclick: nmDuplicate }, "Duplicate"),
      el("button", { class: "btn-ghost nm-danger", disabled: nm.busy ? "disabled" : undefined, onclick: nmDelete }, "Delete"),
    ),
  );

  return [
    header,
    el("section", { class: "plugin-section" },
      el("h3", {}, "Profile"),
      el("div", { class: "nm-grid-2" },
        nmTextField("Name", "name"),
        el("label", { class: "nm-field" },
          el("span", { class: "nm-field-label" }, "Target adapter"),
          adapterSelect,
        ),
      ),
      nmDriftBanner(sel),
      el("label", { class: "nm-field" },
        el("span", { class: "nm-field-label" }, "Notes"),
        notes,
      ),
    ),
    el("section", { class: "plugin-section" },
      el("h3", {}, "IPv4"),
      nmSeg("Mode", "ipv4Mode", [
        { value: "dhcp", label: "DHCP" },
        { value: "static", label: "Static" },
      ]),
      el("div", { class: "nm-grid-2" },
        nmTextField("IP address", "ipAddress", { disabled: !usesStatic, placeholder: "192.168.1.50" }),
        nmTextField("Subnet mask", "subnetMask", { disabled: !usesStatic, placeholder: "255.255.255.0" }),
      ),
      nmTextField("Gateway", "gateway", { disabled: !usesStatic, placeholder: "192.168.1.1 (optional)" }),
    ),
    el("section", { class: "plugin-section" },
      el("h3", {}, "DNS"),
      nmSeg("Mode", "dnsMode", [
        { value: "automatic", label: "Automatic" },
        { value: "manual", label: "Manual" },
        { value: "nochange", label: "No change" },
      ]),
      el("div", { class: "nm-grid-2" },
        nmTextField("Primary DNS", "primaryDns", { disabled: !usesManual, placeholder: "8.8.8.8" }),
        nmTextField("Alternate DNS", "secondaryDns", { disabled: !usesManual, placeholder: "8.8.4.4 (optional)" }),
      ),
    ),
    el("p", { class: "muted small nm-readonly-note" },
      "Apply changes Windows IPv4/DNS for the target adapter and prompts for administrator approval. · ",
      el("a", { href: "#", onclick: (e) => { e.preventDefault(); nmOpenDir(); } }, "open profiles folder"),
    ),
  ];
}

// ---- scan (Angry-IP-Scanner-style subnet sweep) ----

// Dotted IPv4 mask -> CIDR prefix length (count of contiguous high bits).
function nmMaskToPrefix(mask) {
  const parts = String(mask || "").split(".").map((n) => parseInt(n, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  let bits = 0;
  for (const oct of parts) bits += (oct >>> 0).toString(2).split("").filter((b) => b === "1").length;
  return bits;
}

// Resolve the subnet we'd sweep for an adapter, from its live state. Returns
// { ip, prefix, network, label } or null when the adapter has no usable IPv4.
function nmScanSubnetFor(adapterName) {
  const st = nm.stateByAdapter[adapterName];
  if (!st || !st.ipAddress) return null;
  const prefix = nmMaskToPrefix(st.subnetMask);
  if (prefix == null || prefix < 16 || prefix > 30) return null;
  const ipParts = st.ipAddress.split(".").map((n) => parseInt(n, 10));
  if (ipParts.length !== 4 || ipParts.some((n) => Number.isNaN(n))) return null;
  const ipNum = ((ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3]) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const net = (ipNum & mask) >>> 0;
  const network = [(net >>> 24) & 255, (net >>> 16) & 255, (net >>> 8) & 255, net & 255].join(".");
  const hostCount = Math.max(0, Math.pow(2, 32 - prefix) - 2);
  return { ip: st.ipAddress, prefix, network, hostCount, label: `${network}/${prefix} · ${hostCount} hosts` };
}

// Pick a sensible default adapter to scan: the current scan target if still valid,
// else the selected profile's adapter, else the first "Up" adapter with an IPv4.
function nmScanDefaultAdapter() {
  if (nm.scan.adapterName && nmScanSubnetFor(nm.scan.adapterName)) return nm.scan.adapterName;
  const sel = nmSelected();
  if (sel?.adapterName && nmScanSubnetFor(sel.adapterName)) return sel.adapterName;
  const up = nm.adapters.find((a) => a.status === "Up" && nmScanSubnetFor(a.name));
  if (up) return up.name;
  const any = nm.adapters.find((a) => nmScanSubnetFor(a.name));
  return any?.name || "";
}

function nmScanInitListeners() {
  if (nm.scan.listenersReady) return;
  nm.scan.listenersReady = true;
  listen("netscan:host", (e) => {
    const h = e.payload;
    if (!nm.scan.hosts.some((x) => x.ip === h.ip)) nm.scan.hosts.push(h);
    nmScanRenderLive();
  }).catch((e) => console.warn("listen netscan:host failed:", e));
  listen("netscan:progress", (e) => {
    nm.scan.scanned = e.payload.scanned;
    nm.scan.total = e.payload.total;
    nmScanRenderLive();
  }).catch((e) => console.warn("listen netscan:progress failed:", e));
  listen("netscan:done", (e) => {
    // Merge rather than replace: streamed `netscan:host` rows may already carry
    // hostnames that arrived first; keep them.
    const byIp = new Map(nm.scan.hosts.map((h) => [h.ip, h]));
    nm.scan.hosts = (e.payload.hosts || []).map((h) => ({ ...h, hostname: h.hostname || byIp.get(h.ip)?.hostname || "" }));
    nm.scan.total = e.payload.total;
    nm.scan.done = true;
    nm.scan.scanning = false;
    renderAll();
  }).catch((e) => console.warn("listen netscan:done failed:", e));
  listen("netscan:hostnames", (e) => {
    const map = new Map((e.payload || []).map((x) => [x.ip, x.hostname]));
    for (const h of nm.scan.hosts) { const n = map.get(h.ip); if (n) h.hostname = n; }
    nmScanRenderLive();
  }).catch((e) => console.warn("listen netscan:hostnames failed:", e));
}

async function nmScanStart() {
  if (nm.scan.scanning) return;
  const adapterName = nmScanDefaultAdapter();
  const subnet = adapterName ? nmScanSubnetFor(adapterName) : null;
  if (!subnet) {
    logTo("networkmanager", "No adapter with a scannable IPv4 subnet. Refresh adapters first.", "warn");
    return;
  }
  nm.scan.adapterName = adapterName;
  nm.scan.scanning = true;
  nm.scan.done = false;
  nm.scan.error = "";
  nm.scan.hosts = [];
  nm.scan.scanned = 0;
  nm.scan.total = subnet.hostCount;
  renderAll();
  try {
    // The `netscan:done` event is authoritative for the host list (and merges
    // streamed hostnames); don't overwrite it from the resolved value here.
    const result = await invoke("netscan_scan", { ip: subnet.ip, prefix: subnet.prefix });
    nm.scan.total = result.total;
    logTo("networkmanager", `Scan complete — ${result.hosts.length} host${result.hosts.length === 1 ? "" : "s"} on ${subnet.network}/${subnet.prefix}.`, "ok");
  } catch (err) {
    nm.scan.error = String(err);
    logTo("networkmanager", `Scan failed: ${err}`, "error");
  } finally {
    nm.scan.scanning = false;
    nm.scan.done = true;
    renderAll();
  }
}

// Patch the live bits (progress + results) in place so streamed events don't
// rebuild the whole page (which would steal focus / flicker the adapter picker).
function nmScanRenderLive() {
  if (currentPluginId() !== "networkmanager" || nm.tab !== "scan") return;
  const prog = document.getElementById("nm-scan-progress");
  if (prog) prog.replaceWith(nmScanProgress());
  nmScanApplyFilter();
}

// Hosts narrowed by the free-text filter (case-insensitive substring over
// IP, hostname, and MAC). Empty filter returns every host.
function nmScanFilteredHosts() {
  const q = nm.scan.filter.trim().toLowerCase();
  if (!q) return nm.scan.hosts;
  return nm.scan.hosts.filter((h) =>
    (h.ip || "").toLowerCase().includes(q) ||
    (h.hostname || "").toLowerCase().includes(q) ||
    (h.mac || "").toLowerCase().includes(q));
}

// Dotted IPv4 -> sortable 32-bit number; -1 for anything unparseable so
// malformed addresses sort to the top in ascending order.
function nmIpToNum(ip) {
  const p = String(ip || "").split(".").map((n) => parseInt(n, 10));
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return -1;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

// Sort a host list by the active column/direction. IP and RTT compare
// numerically; hostname/MAC compare case-insensitively with blanks pinned
// last (regardless of direction). IP is the stable tiebreaker throughout.
function nmScanSortedHosts(hosts) {
  const { sortKey, sortDir } = nm.scan;
  const dir = sortDir === "desc" ? -1 : 1;
  const ipCmp = (a, b) => nmIpToNum(a.ip) - nmIpToNum(b.ip);
  return hosts.slice().sort((a, b) => {
    if (sortKey === "ip") return ipCmp(a, b) * dir;
    if (sortKey === "rtt") {
      const cmp = (a.rttMs ?? Infinity) - (b.rttMs ?? Infinity);
      return (cmp || ipCmp(a, b)) * dir;
    }
    // hostname / mac
    const av = (a[sortKey] || "").toLowerCase();
    const bv = (b[sortKey] || "").toLowerCase();
    if (!av && !bv) return ipCmp(a, b);
    if (!av) return 1;   // blanks always last
    if (!bv) return -1;
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return (cmp || ipCmp(a, b)) * dir;
  });
}

// "N hosts" when unfiltered, "shown of total" when a filter is active.
function nmScanFilterCountText() {
  const total = nm.scan.hosts.length;
  if (!nm.scan.filter.trim()) return `${total} host${total === 1 ? "" : "s"}`;
  return `${nmScanFilteredHosts().length} of ${total} shown`;
}

// Re-render just the results body + count in place so typing in the filter
// box never rebuilds the page (which would steal focus from the input).
function nmScanApplyFilter() {
  if (currentPluginId() !== "networkmanager" || nm.tab !== "scan") return;
  const body = document.getElementById("nm-scan-results");
  if (body) body.replaceChildren(...nmScanResultRows());
  const cnt = document.getElementById("nm-scan-filter-count");
  if (cnt) cnt.textContent = nmScanFilterCountText();
}

// Filter row above the results table. The <input> is left untouched by
// nmScanApplyFilter, so it keeps focus + caret while you type.
function nmScanFilterBar() {
  return el("div", { class: "nm-scan-filter" },
    el("input", {
      type: "search",
      class: "nm-input nm-scan-filter-input",
      placeholder: "Filter by IP, hostname, or MAC…",
      "aria-label": "Filter scan results",
      value: nm.scan.filter,
      oninput: (e) => { nm.scan.filter = e.target.value; nmScanApplyFilter(); },
    }),
    el("span", { id: "nm-scan-filter-count", class: "muted small nm-scan-filter-count" },
      nmScanFilterCountText()),
  );
}

function nmScanProgress() {
  const { scanned, total, scanning, hosts } = nm.scan;
  const pct = total > 0 ? Math.min(100, Math.round((scanned / total) * 100)) : 0;
  let idle = "Pick a subnet to scan.";
  if (!scanning && !nm.scan.done) {
    const a = nmScanDefaultAdapter();
    const sub = a ? nmScanSubnetFor(a) : null;
    idle = sub ? `${sub.hostCount} hosts in range (${sub.network}/${sub.prefix})` : "No scannable subnet — refresh adapters.";
  }
  return el("div", { id: "nm-scan-progress", class: "nm-scan-progress" },
    el("div", { class: "nm-scan-bar" }, el("div", { class: "nm-scan-bar-fill", style: `width:${pct}%` })),
    el("div", { class: "muted small" },
      scanning
        ? `Scanning… ${scanned}/${total} probed · ${hosts.length} found`
        : nm.scan.done
          ? `Done · ${hosts.length} host${hosts.length === 1 ? "" : "s"} of ${total} probed`
          : idle),
  );
}

function nmScanResultRows() {
  const hosts = nmScanSortedHosts(nmScanFilteredHosts());
  if (hosts.length === 0) {
    let msg;
    if (nm.scan.hosts.length > 0) msg = "No hosts match the filter.";
    else if (nm.scan.scanning) msg = "Listening for hosts…";
    else msg = "No hosts yet — run a scan.";
    return [el("tr", {}, el("td", { class: "muted small", colspan: "4" }, msg))];
  }
  return hosts.map((h) => el("tr", { class: "nm-scan-row" },
    el("td", { class: "nm-scan-ip" }, h.ip),
    el("td", {}, h.hostname || el("span", { class: "muted" }, "—")),
    el("td", { class: "nm-scan-mac" }, h.mac || el("span", { class: "muted" }, "—")),
    el("td", { class: "nm-scan-rtt" }, h.rttMs != null ? `${h.rttMs} ms` : "—"),
  ));
}

// Click a column to sort by it; click the active column again to flip
// direction. Re-renders the table in place (header arrows + rows) without a
// full page render, so the filter input keeps its focus/caret.
function nmScanSetSort(key) {
  if (nm.scan.sortKey === key) nm.scan.sortDir = nm.scan.sortDir === "asc" ? "desc" : "asc";
  else { nm.scan.sortKey = key; nm.scan.sortDir = "asc"; }
  const tbl = document.getElementById("nm-scan-table");
  if (tbl) tbl.replaceWith(nmScanTableEl());
}

function nmScanHeaderCell(key, label) {
  const active = nm.scan.sortKey === key;
  const arrow = active ? (nm.scan.sortDir === "asc" ? "▲" : "▼") : "";
  return el("th", {
    class: `nm-scan-th${active ? " nm-scan-th-active" : ""}`,
    role: "button",
    tabindex: "0",
    "aria-sort": active ? (nm.scan.sortDir === "asc" ? "ascending" : "descending") : "none",
    onclick: () => nmScanSetSort(key),
    onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); nmScanSetSort(key); } },
  }, label, el("span", { class: "nm-scan-sort-ind" }, arrow));
}

function nmScanTableEl() {
  return el("table", { id: "nm-scan-table", class: "nm-scan-table" },
    el("thead", {}, el("tr", {},
      nmScanHeaderCell("ip", "IP address"),
      nmScanHeaderCell("hostname", "Hostname"),
      nmScanHeaderCell("mac", "MAC"),
      nmScanHeaderCell("rtt", "RTT"),
    )),
    el("tbody", { id: "nm-scan-results" }, ...nmScanResultRows()),
  );
}

function nmScanTab() {
  nmScanInitListeners();
  const adapterName = nmScanDefaultAdapter();
  const subnet = adapterName ? nmScanSubnetFor(adapterName) : null;

  const candidates = nm.adapters.filter((a) => nmScanSubnetFor(a.name));
  const picker = el("select", {
    class: "nm-input",
    disabled: nm.scan.scanning ? "disabled" : undefined,
    onchange: (e) => { nm.scan.adapterName = e.target.value; nmSaveUiState(); renderAll(); },
  },
    ...candidates.map((a) => el("option", {
      value: a.name,
      selected: a.name === adapterName ? "selected" : undefined,
    }, `${a.name} — ${nmScanSubnetFor(a.name).label}`)),
  );

  const scanBtn = el("button", {
    class: "btn btn-primary",
    disabled: nm.scan.scanning || !subnet ? "disabled" : undefined,
    onclick: nmScanStart,
  }, nm.scan.scanning ? "Scanning…" : "Scan subnet");

  const head = el("section", { class: "plugin-section" },
    el("div", { class: "nm-pane-head" },
      el("div", { class: "nm-pane-head-text" },
        el("h3", {}, "Scan local subnet"),
        el("p", { class: "muted small nm-section-sub" },
          "Ping-sweep the adapter's subnet to find live hosts, their MAC, and hostname. Un-elevated."),
      ),
    ),
    candidates.length === 0
      ? el("p", { class: "muted small" }, nm.loaded ? "No adapter has a scannable IPv4 subnet." : "Reading adapters…")
      : el("div", { class: "nm-scan-controls" },
          el("label", { class: "nm-field nm-scan-pick" },
            el("span", { class: "nm-field-label" }, "Subnet"),
            picker,
          ),
          scanBtn,
        ),
    nmScanProgress(),
  );

  const table = nmScanTableEl();

  const showFilter = nm.scan.scanning || nm.scan.done || nm.scan.hosts.length > 0;

  return el("div", { class: "plugin-controls plugin-controls-fill" },
    head,
    el("section", { class: "plugin-section plugin-section-fill" },
      showFilter ? nmScanFilterBar() : null,
      // Static scroll wrapper; refresh swaps the inner <table> in place (no re-nesting).
      el("div", { class: "table-scroll table-scroll-fill" }, table),
    ),
  );
}

function nmTabBar() {
  const tab = (id, label) => el("button", {
    class: `nm-tab ${nm.tab === id ? "nm-tab-active" : ""}`,
    onclick: () => { nm.tab = id; nmSaveUiState(); renderAll(); },
  }, label);
  return el("div", { class: "nm-tabs" },
    tab("configure", "Configure"),
    tab("scan", "Scan"),
  );
}

function nmAdapterCacheNotice() {
  if (!nm.loaded || !nm.adapterSnapshotStale) return null;
  const readAt = nm.adapterSnapshotAt ? new Date(nm.adapterSnapshotAt) : null;
  const stamp = readAt && !Number.isNaN(readAt.getTime()) ? readAt.toLocaleString() : "a previous session";
  return el("div", { class: "nm-cache-notice" },
    el("span", {}, `Showing cached adapter data from ${stamp}.`),
    el("button", {
      class: "btn-ghost",
      disabled: nm.busy ? "disabled" : undefined,
      onclick: () => nmRefresh(),
    }, nm.busy ? "Refreshing..." : "Refresh now"));
}

// ---- resizable rail (the splitter between the rail and the config panel) ----

function nmRailWidthPx() {
  return Math.max(180, Math.min(440, userState.nmRailWidth || 240));
}
function nmSetRailWidth(px, persist) {
  userState.nmRailWidth = Math.max(180, Math.min(440, Math.round(px)));
  const md = document.getElementById("nm-config-md");
  if (md) md.style.gridTemplateColumns = `${userState.nmRailWidth}px 8px minmax(0, 1fr)`;
  const sep = document.getElementById("nm-splitter");
  if (sep) sep.setAttribute("aria-valuenow", String(userState.nmRailWidth));
  if (persist) saveUserState();
}
// Track the drag on window so it survives the pointer leaving the handle.
// Pointer capture + a pointercancel teardown guard against a "stuck" drag if the
// matching pointerup is ever lost (alt-tab, OS cancel).
function nmStartRailDrag(e) {
  e.preventDefault();
  const startX = e.clientX;
  const startW = nmRailWidthPx();
  const handle = e.currentTarget;
  try { handle.setPointerCapture(e.pointerId); } catch (_) { /* not fatal */ }
  document.body.classList.add("nm-resizing");
  const onMove = (ev) => nmSetRailWidth(startW + (ev.clientX - startX), false);
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    document.body.classList.remove("nm-resizing");
    try { handle.releasePointerCapture(e.pointerId); } catch (_) { /* already released */ }
    saveUserState();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}
function nmRailKeyResize(e) {
  if (e.key === "ArrowLeft") { e.preventDefault(); nmSetRailWidth(nmRailWidthPx() - 16, true); }
  else if (e.key === "ArrowRight") { e.preventDefault(); nmSetRailWidth(nmRailWidthPx() + 16, true); }
}

// ---- merged Configure view (adapters + profiles, master/detail) ----

// The grouped rail: each present adapter is a header (selectable → live detail)
// with its saved profiles nested beneath; profiles whose target adapter isn't
// present fall into an "Other" group.
function nmConfigRailContent() {
  const children = [];
  const present = nm.adapters.filter((a) => a.status !== "Not Present");
  const byAdapter = new Map();
  for (const p of nm.profiles) {
    const key = p.adapterName || "";
    if (!byAdapter.has(key)) byAdapter.set(key, []);
    byAdapter.get(key).push(p);
  }
  for (const a of present) {
    children.push(nmRailAdapterHeader(a));
    for (const p of (byAdapter.get(a.name) || [])) children.push(nmRailProfileRow(p));
    byAdapter.delete(a.name);
  }
  const others = [];
  for (const ps of byAdapter.values()) others.push(...ps);
  if (others.length) {
    children.push(el("div", { class: "nm-rail-other-head" }, "Other profiles"));
    for (const p of others) children.push(nmRailProfileRow(p));
  }
  if (!children.length) {
    children.push(el("p", { class: "muted small nm-rail-empty" },
      nm.loaded ? "No adapters or profiles yet." : "Reading adapters…"));
  }
  return children;
}

function nmRailAdapterHeader(a) {
  const st = nm.stateByAdapter[a.name];
  const selected = nm.selectedAdapter === a.name;
  return el("div", { class: `nm-rail-adapter ${selected ? "selected" : ""}` },
    el("div", { class: "nm-rail-adapter-head" },
      // The name is the selectable region; Save is a SIBLING (not a nested button),
      // so keyboard Enter/Space on Save can't trigger the adapter selection.
      el("span", {
        class: "nm-rail-adapter-name",
        role: "button",
        tabindex: "0",
        title: a.description || a.name,
        "aria-pressed": selected ? "true" : "false",
        onclick: () => nmSelectAdapter(a.name),
        onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); nmSelectAdapter(a.name); } },
      }, a.name),
      el("button", {
        class: "btn-ghost nm-rail-save",
        title: "Save this adapter as a profile",
        "aria-label": `Save ${a.name} as a profile`,
        disabled: nm.busy ? "disabled" : undefined,
        onclick: () => nmCaptureAdapter(a.name),
      }, "Save"),
    ),
    el("div", { class: "nm-rail-summary" },
      st ? `IPv4 ${nmIpv4Summary(st)} · gw ${st.gateway || "none"}` : (nm.loaded ? "no live state" : "reading…")),
  );
}

// Config panel when a live adapter (not a profile) is selected.
function nmAdapterDetail(a) {
  const st = nm.stateByAdapter[a.name];
  const matching = nm.profiles.filter((p) => p.adapterName === a.name);
  const profilesList = el("div", { class: "nm-rail-list" });
  if (matching.length) for (const p of matching) profilesList.appendChild(nmRailProfileRow(p));
  else profilesList.appendChild(el("p", { class: "muted small" }, "No profiles yet — save this adapter to make one."));

  return el("div", { class: "nm-editor-pane" },
    el("div", { class: "nm-editor-head" },
      el("h3", { class: "nm-editor-title" }, a.name),
      el("div", { class: "nm-editor-actions" },
        el("button", {
          class: "btn btn-primary",
          disabled: nm.busy ? "disabled" : undefined,
          onclick: () => nmCaptureAdapter(a.name),
        }, "Save as profile"),
      ),
    ),
    el("section", { class: "plugin-section" },
      el("h3", {}, "Live adapter"),
      el("p", { class: "muted small" }, a.description || ""),
      el("div", { class: "muted small" }, `Status: ${a.status}`),
      el("div", { class: "muted small" }, st ? `IPv4 ${nmIpv4Summary(st)}` : "No live snapshot — use Refresh adapters."),
      st ? el("div", { class: "muted small" }, `Gateway ${st.gateway || "none"} · DNS ${nmDnsSummary(st)}`) : null,
    ),
    el("section", { class: "plugin-section" },
      el("h3", {}, "Profiles for this adapter"),
      profilesList,
    ),
  );
}

function nmConfigEmpty() {
  return el("div", { class: "nm-editor-pane nm-editor-empty" },
    el("div", { class: "nm-empty" },
      el("p", { class: "nm-empty-title" }, "Select an adapter or profile"),
      el("p", { class: "muted small" },
        "Pick a NIC on the left to see its live config and save it as a profile, or pick a profile to edit and apply it."),
    ),
  );
}

function nmConfigureTab() {
  const railList = el("div", { id: "nm-config-rail", class: "nm-rail-list" }, ...nmConfigRailContent());
  const rail = el("div", { class: "nm-rail" },
    railList,
    el("button", {
      class: "btn btn-primary nm-new-btn",
      disabled: nm.busy ? "disabled" : undefined,
      onclick: nmNew,
    }, "+ New profile"),
  );

  let panel;
  if (nm.selectedAdapter) {
    const a = nm.adapters.find((x) => x.name === nm.selectedAdapter);
    panel = a ? nmAdapterDetail(a) : nmConfigEmpty();
  } else {
    const sel = nmSelected();
    panel = sel ? el("div", { class: "nm-editor-pane" }, ...nmEditorContent(sel)) : nmConfigEmpty();
  }

  const splitter = el("div", {
    id: "nm-splitter",
    class: "nm-splitter",
    role: "separator",
    tabindex: "0",
    "aria-orientation": "vertical",
    "aria-label": "Resize the configuration panel",
    "aria-valuemin": "180",
    "aria-valuemax": "440",
    "aria-valuenow": String(nmRailWidthPx()),
    title: "Drag to resize · double-click to reset",
    onpointerdown: nmStartRailDrag,
    ondblclick: () => nmSetRailWidth(240, true),
    onkeydown: nmRailKeyResize,
  });

  const md = el("div", { id: "nm-config-md", class: "nm-config-md" }, rail, splitter, panel);
  md.style.gridTemplateColumns = `${nmRailWidthPx()}px 8px minmax(0, 1fr)`;

  return el("div", { class: "plugin-controls plugin-controls-fill" },
    el("div", { class: "nm-config-head" },
      el("button", {
        class: "btn-ghost",
        disabled: nm.busy ? "disabled" : undefined,
        onclick: nmRefresh,
      }, nm.busy ? "Reading…" : "Refresh adapters"),
    ),
    md,
  );
}

function renderNetworkManagerPage() {
  nmEnsureLoaded();
  const body = nm.tab === "scan" ? nmScanTab() : nmConfigureTab();
  return el("div", { class: "plugin-controls plugin-controls-fill nm-root" },
    nmTabBar(),
    nmAdapterCacheNotice(),
    body,
  );
}


// ============================================================================
// Advanced BACnet Inspector (status pill + page)
// ============================================================================

let bac = {
  discovering: false,
  discoveryStartedAt: 0,
  discoveryDurationMs: 5000,
  discoveryTimer: null,
  devices: [],            // BacnetDevice[] from the backend (key, address, instance, …)
  deviceFilter: "",       // free-text over instance/name/address/vendor/model
  deviceSortKey: "instance", // "instance" | "name" | "address" | "vendor" | "model"
  deviceSortDir: "asc",
  selectedDeviceKey: null,
  objects: [],            // BacnetObject[] for the selected device
  objectsLoading: false,
  objectsProgress: null,  // { done, total } during index-by-index walks
  objectFilter: "",
  objectTypeFilter: new Set(), // selected typeName strings; empty = all types
  objectInstanceMin: "",
  objectInstanceMax: "",
  objectSelection: new Set(),  // "type:instance" keys chosen for bulk import
  objectNameTemplate: "",      // optional naming template for bulk import
  objectTypesOpen: false,      // is the type-filter <details> popover open
  selectedObjectKey: null, // "type:instance"
  props: [],              // PropertyEntry[] for the selected object
  propsLoading: false,
  cov: { processId: null, objectKey: null, busy: false, updates: 0, lastAt: null },
  trend: { loading: false, records: [], recordCount: 0, truncated: false, objectKey: null, max: "200" },
  alarms: { loading: false, entries: [], deviceKey: null, error: null, ran: false },
  write: { propertyId: "85", kind: "real", value: "", priority: "", arrayIndex: "" },
  target: "255.255.255.255",
  lowLimit: "",
  highLimit: "",
  // Foreign-device (BBMD) registration: reach broadcast discovery across subnets.
  bbmd: { address: "", ttl: "60", status: null, busy: false },
  listenersReady: false,
  discoveryRan: false,
  lastDiscoveryCount: null,
  driftSummary: null,          // { new, returning, changed, missing } vs the last scan
  deviceStatusByKey: {},       // device key -> "new" | "returning" | "changed"
};

function bacStatusPill() {
  if (bac.discovering) return { label: "Discovering…", cls: "pill-running" };
  const n = bac.devices.length;
  if (n === 0) return { label: "Idle", cls: "pill-idle" };
  return { label: `${n} device${n === 1 ? "" : "s"}`, cls: "pill-muted" };
}

function bacSelectedDevice() {
  return bac.devices.find((d) => d.key === bac.selectedDeviceKey) || null;
}

// The DeviceRef the backend needs to reach a device (router addressing included).
// maxApdu + segmentation let the backend segment an outbound request that won't
// fit the device's APDU (e.g. a large WriteProperty), or reject it up front when
// the device can't receive segments.
function bacDeviceRef(d) {
  return {
    address: d.address,
    network: d.network ?? null,
    mac: d.mac ?? null,
    maxApdu: d.maxApdu ?? null,
    segmentation: d.segmentation ?? null,
  };
}

function bacObjectKey(o) { return `${o.objectType}:${o.instance}`; }

function bacSelectedObject() {
  return bac.objects.find((o) => bacObjectKey(o) === bac.selectedObjectKey) || null;
}

function bacDeviceLabel(d) {
  const route = d.network != null ? ` · net ${d.network}` : "";
  return `${d.name || `device ${d.instance}`} (${d.instance})${route}`;
}

function bacDiscoveryProgressState() {
  if (!bac.discovering || !bac.discoveryStartedAt) return null;
  const elapsed = Math.max(0, Date.now() - bac.discoveryStartedAt);
  const duration = Math.max(500, bac.discoveryDurationMs || 5000);
  const listening = elapsed < duration;
  const pct = listening ? Math.min(92, Math.round((elapsed / duration) * 92)) : 96;
  const remainingMs = Math.max(0, duration - elapsed);
  return {
    pct,
    finalizing: !listening,
    phase: listening ? "Listening for I-Am replies" : "Finalizing device details",
    remainingText: listening ? `~${Math.max(1, Math.ceil(remainingMs / 1000))}s left` : "almost done",
    found: bac.devices.length,
  };
}

function bacDiscoveryProgressEl(id = "bac-discovery-progress") {
  const state = bacDiscoveryProgressState();
  if (!state) return null;
  return el("div", { id, class: "bac-discovery-progress" },
    el("div", { class: "bac-discovery-progress-head" },
      el("span", {}, state.phase),
      el("span", { class: "muted small" }, `${state.found} found · ${state.remainingText}`)),
    el("div", { class: "bac-discovery-bar" },
      el("div", {
        class: `bac-discovery-fill ${state.finalizing ? "bac-discovery-finalizing" : ""}`,
        style: `width:${state.pct}%`,
      })));
}

function bacRenderDiscoveryProgressLive() {
  for (const id of ["bac-discovery-progress", "bw-discovery-progress"]) {
    const node = document.getElementById(id);
    if (!node) continue;
    const next = bacDiscoveryProgressEl(id);
    if (next) node.replaceWith(next);
    else node.remove();
  }
  const count = document.getElementById("bw-device-inbox-count");
  if (count) {
    const queued = Object.values(bw.deviceInbox?.candidates || {}).filter((c) => c?.status === "queued").length;
    count.textContent = bac.discovering ? "Discovering..." : `${bac.devices.length} discovered · ${queued} queued`;
  }
  const bacCount = document.getElementById("bac-device-count");
  if (bacCount) bacCount.textContent = bacDeviceCountText();
}

function bacStartDiscoveryClock(durationMs = 5000) {
  if (bac.discoveryTimer) clearInterval(bac.discoveryTimer);
  bac.discoveryDurationMs = durationMs;
  bac.discoveryStartedAt = Date.now();
  bac.discoveryTimer = setInterval(bacRenderDiscoveryProgressLive, 250);
}

function bacStopDiscoveryClock() {
  if (bac.discoveryTimer) clearInterval(bac.discoveryTimer);
  bac.discoveryTimer = null;
  bacRenderDiscoveryProgressLive();
}

// ---- events ----

function bacEnsureListeners() {
  if (bac.listenersReady) return;
  bac.listenersReady = true;
  listen("bacnet:device", (e) => {
    const d = e.payload;
    if (!bac.devices.some((x) => x.key === d.key)) bac.devices.push(d);
    bacScheduleDevicesRender();
  }).catch((e) => console.warn("listen bacnet:device failed:", e));
  listen("bacnet:device_update", (e) => {
    const d = e.payload;
    const i = bac.devices.findIndex((x) => x.key === d.key);
    if (i >= 0) bac.devices[i] = d;
    else bac.devices.push(d);
    bacScheduleDevicesRender();
  }).catch((e) => console.warn("listen bacnet:device_update failed:", e));
  listen("bacnet:objects_progress", (e) => {
    bac.objectsProgress = e.payload;
    const node = document.getElementById("bac-objects-status");
    if (node) node.textContent = `Walking object-list… ${e.payload.done}/${e.payload.total}`;
  }).catch((e) => console.warn("listen bacnet:objects_progress failed:", e));
  listen("bacnet:object_names", (e) => {
    // Names stream from a detached pass; ignore batches for a device we've
    // already navigated away from.
    if (!e.payload || e.payload.deviceKey !== bac.selectedDeviceKey) return;
    const map = new Map((e.payload.names || []).map((x) => [x.key, x.name]));
    for (const o of bac.objects) {
      const n = map.get(bacObjectKey(o));
      if (n) o.name = n;
    }
    bacApplyObjectFilter();
  }).catch((e) => console.warn("listen bacnet:object_names failed:", e));
  listen("bacnet:cov", (e) => {
    const p = e.payload;
    if (!p) return;
    // Only apply notifications for the subscription we're currently showing.
    if (p.processId !== bac.cov.processId) return;
    if (`${p.objectType}:${p.instance}` !== bac.cov.objectKey) return;
    // Skip while the property grid is mid-rebuild (a re-read cleared bac.props);
    // applying now would bump the counter against rows that aren't there yet.
    if (bac.propsLoading || bac.props.length === 0) return;
    bac.cov.updates += 1;
    bac.cov.lastAt = Date.now();
    bacApplyCovUpdate(p.values || []);
  }).catch((e) => console.warn("listen bacnet:cov failed:", e));
}

// ---- actions ----

// Inter-tool dependency in action: BACnet Inspector borrows Network Manager's
// subnet scanner (the `netscan` capability) to find live hosts to aim discovery
// at — instead of reimplementing an ICMP sweep. Only offered when the kernel
// resolved the optional dependency, so it degrades cleanly if Network Manager
// is unavailable.
async function bacSuggestTargets() {
  const netscan = platformHost("bacnet")?.tryUse("netscan.v1");
  if (!netscan) { logTo("bacnet", "Network scan capability unavailable.", "warn"); return; }
  if (!nm.loaded) { try { await nmRefresh(); } catch (_) {} }
  let subnet = null;
  for (const a of nm.adapters) {
    const s = nmScanSubnetFor(a.name);
    if (s) { subnet = s; break; }
  }
  if (!subnet) { logTo("bacnet", "No adapter with a scannable IPv4 subnet to search.", "warn"); return; }
  logTo("bacnet", `Scanning ${subnet.network}/${subnet.prefix} for live hosts (via Network Manager)…`, "info");
  try {
    const result = await netscan.scan(`${subnet.ip}/${subnet.prefix}`);
    const hosts = result?.hosts || [];
    if (hosts.length === 0) { logTo("bacnet", "No live hosts found on the subnet.", "warn"); return; }
    const preview = hosts.slice(0, 12).map((h) => h.ip).join(", ");
    logTo("bacnet", `Found ${hosts.length} live host${hosts.length === 1 ? "" : "s"}: ${preview}${hosts.length > 12 ? "…" : ""}`, "ok");
  } catch (err) {
    logTo("bacnet", `Host scan failed: ${err}`, "error");
  }
}

// The Inspector consumes the extracted bacnet-core service. If the kernel
// didn't boot, it falls back to direct backend calls so the advanced tool still
// works — the platform must never take the UI down.
function bacnetRead() {
  const cap = platformHost("bacnet")?.tryUse("bacnet.read.v1");
  if (cap) return cap;
  return {
    listDevices: (o = {}) => invoke("bacnet_discover", {
      target: o.target ?? null, lowLimit: o.lowLimit ?? null,
      highLimit: o.highLimit ?? null, durationMs: o.durationMs ?? null,
    }),
    readPoint: (device, objectType, instance) =>
      invoke("bacnet_read_properties", { device, objectType, instance }),
    listObjects: (device, deviceInstance) =>
      invoke("bacnet_read_objects", { device, deviceInstance }),
    writeProperty: ({ device, objectType, instance, property, value, priority = null, arrayIndex = null }) =>
      invoke("bacnet_write_property", { device, objectType, instance, property, value, priority, arrayIndex }),
    readTrend: ({ device, objectType, instance, maxRecords }) =>
      invoke("bacnet_read_trend", { device, objectType, instance, maxRecords }),
    subscribeCov: ({ device, deviceInstance, objectType, instance, confirmed = false }) =>
      invoke("bacnet_subscribe_cov", { device, deviceInstance, objectType, instance, confirmed }),
    unsubscribeCov: ({ device, objectType, instance, processId }) =>
      invoke("bacnet_unsubscribe_cov", { device, objectType, instance, processId }),
    registerForeignDevice: ({ bbmd, ttlSeconds = null }) =>
      invoke("bacnet_register_foreign_device", { bbmd, ttlSeconds }),
    unregisterForeignDevice: () => invoke("bacnet_unregister_foreign_device"),
    foreignDeviceStatus: () => invoke("bacnet_foreign_device_status"),
    getAlarms: (device) => invoke("bacnet_get_alarms", { device }),
    acknowledgeAlarm: ({ device, objectType, instance }) =>
      invoke("bacnet_acknowledge_alarm", { device, objectType, instance }),
  };
}

async function bacDiscover() {
  if (bac.discovering) return;
  bacEnsureListeners();
  if (bac.cov.processId != null) await bacCovStop();
  const durationMs = 5000;
  bac.discovering = true;
  bac.discoveryRan = true;
  bac.lastDiscoveryCount = null;
  bacStartDiscoveryClock(durationMs);
  bac.devices = [];
  bac.selectedDeviceKey = null;
  bac.objects = [];
  bac.selectedObjectKey = null;
  bac.props = [];
  renderAll();
  const low = parseInt(bac.lowLimit, 10);
  const high = parseInt(bac.highLimit, 10);
  try {
    const devices = await bacnetRead().listDevices({
      target: bac.target.trim() || null,
      lowLimit: Number.isFinite(low) ? low : null,
      highLimit: Number.isFinite(high) ? high : null,
      durationMs,
    });
    bac.devices = devices;
    bac.lastDiscoveryCount = devices.length;
    bacRecordDiscoveryDrift(devices);
    logTo("bacnet", `Discovery finished — ${devices.length} device${devices.length === 1 ? "" : "s"}.`, devices.length ? "ok" : "warn");
  } catch (err) {
    bac.lastDiscoveryCount = null;
    logTo("bacnet", `Discovery failed: ${err}`, "error");
  } finally {
    bac.discovering = false;
    bacStopDiscoveryClock();
    renderAll();
  }
}

// Register/unregister with a BBMD as a foreign device, so a subsequent Who-Is is
// distributed across IP subnets (the host needn't be on the BACnet LAN). A
// background keep-alive in the backend holds the registration open.
async function bacToggleForeignDevice() {
  if (bac.bbmd.busy) return;
  const api = bacnetRead();
  bac.bbmd.busy = true;
  renderAll();
  try {
    if (bac.bbmd.status) {
      await api.unregisterForeignDevice();
      bac.bbmd.status = null;
      logTo("bacnet", "Unregistered from BBMD (will expire at TTL).", "info");
    } else {
      const addr = bac.bbmd.address.trim();
      if (!addr) { logTo("bacnet", "Enter the BBMD's IP address to register.", "warn"); return; }
      const ttl = parseInt(bac.bbmd.ttl, 10);
      const status = await api.registerForeignDevice({
        bbmd: addr,
        ttlSeconds: Number.isFinite(ttl) ? ttl : null,
      });
      bac.bbmd.status = status;
      logTo("bacnet", `Registered as foreign device with ${status.bbmd} (TTL ${status.ttlSeconds}s). Broadcasts now route through the BBMD.`, "ok");
    }
  } catch (err) {
    logTo("bacnet", `Foreign-device registration failed: ${err}`, "error");
  } finally {
    bac.bbmd.busy = false;
    renderAll();
  }
}

// Classify a fresh discovery against the persisted baseline (new/returning/changed +
// missing) and store the new baseline for next time. Local-only; never blocks discovery.
function bacRecordDiscoveryDrift(devices) {
  try {
    const prev = Array.isArray(userState.bacnetDiscoveryCache) ? userState.bacnetDiscoveryCache : [];
    const drift = bwClassifyDiscovery(prev, devices);
    bac.driftSummary = drift.summary;
    bac.deviceStatusByKey = Object.fromEntries(drift.devices.map((d) => [d.key, d.status]));
    userState.bacnetDiscoveryCache = devices.map((d) => ({
      key: d.key, instance: d.instance, address: d.address,
      network: d.network ?? null, mac: d.mac ?? null,
      vendorId: d.vendorId ?? null, modelName: d.modelName ?? null, name: d.name ?? null,
    }));
    saveUserState();
  } catch (_) {
    bac.driftSummary = null;
    bac.deviceStatusByKey = {};
  }
}

function bacDriftSummaryEl() {
  const s = bac.driftSummary;
  if (!s) return null;
  const parts = [];
  if (s.new) parts.push(`${s.new} new`);
  if (s.returning) parts.push(`${s.returning} returning`);
  if (s.changed) parts.push(`${s.changed} changed`);
  if (s.missing) parts.push(`${s.missing} missing`);
  if (!parts.length) return null;
  return el("span", {
    class: "muted small bac-drift-summary",
    title: "Compared to the previous discovery on this machine",
  }, `· ${parts.join(" · ")} since last scan`);
}

function bacDeviceStatusBadge(d) {
  const status = bac.deviceStatusByKey[d.key];
  if (!status || status === "returning") return null;
  return el("span", {
    class: `bac-badge bac-badge-${status}`,
    title: status === "new" ? "Not seen in the previous scan" : "Address/vendor/model changed since the previous scan",
  }, status);
}

async function bacSelectDevice(key) {
  if (bac.selectedDeviceKey === key) return;
  if (bac.cov.processId != null) await bacCovStop();
  bac.selectedDeviceKey = key;
  bac.objects = [];
  bac.selectedObjectKey = null;
  bac.props = [];
  bac.objectFilter = "";
  bac.objectTypeFilter.clear();
  bac.objectInstanceMin = "";
  bac.objectInstanceMax = "";
  bac.objectSelection.clear();
  const dev = bacSelectedDevice();
  if (!dev) { renderAll(); return; }
  bac.objectsLoading = true;
  bac.objectsProgress = null;
  renderAll();
  try {
    const objects = await bacnetRead().listObjects(bacDeviceRef(dev), dev.instance);
    // A faster click may have switched devices while this was in flight; don't
    // overwrite the newer selection with stale results.
    if (bac.selectedDeviceKey !== key) return;
    bac.objects = objects;
    logTo("bacnet", `Read ${bac.objects.length} objects from ${bacDeviceLabel(dev)}.`, "ok");
  } catch (err) {
    if (bac.selectedDeviceKey !== key) return;
    logTo("bacnet", `Object list failed for ${bacDeviceLabel(dev)}: ${err}`, "error");
  } finally {
    if (bac.selectedDeviceKey === key) {
      bac.objectsLoading = false;
      bac.objectsProgress = null;
      renderAll();
    }
  }
}

async function bacSelectObject(key) {
  // Drop any live subscription tied to the previously-viewed object.
  if (bac.cov.processId != null && bac.cov.objectKey !== key) await bacCovStop();
  if (bac.trend.objectKey !== key) {
    bac.trend = { loading: false, records: [], recordCount: 0, truncated: false, objectKey: null, max: bac.trend.max };
  }
  bac.selectedObjectKey = key;
  bac.props = [];
  const dev = bacSelectedDevice();
  const obj = bacSelectedObject();
  if (!dev || !obj) { renderAll(); return; }
  bac.propsLoading = true;
  renderAll();
  try {
    const props = await bacnetRead().readPoint(
      bacDeviceRef(dev), obj.objectType, obj.instance,
    );
    // Guard against a newer object selection resolving first.
    if (bac.selectedObjectKey !== key) return;
    bac.props = props;
  } catch (err) {
    if (bac.selectedObjectKey !== key) return;
    logTo("bacnet", `Property read failed for ${obj.typeName}:${obj.instance}: ${err}`, "error");
  } finally {
    if (bac.selectedObjectKey === key) {
      bac.propsLoading = false;
      renderAll();
    }
  }
}

async function bacRefreshProps() {
  const key = bac.selectedObjectKey;
  bac.selectedObjectKey = null; // force re-select to re-read
  await bacSelectObject(key);
}

// ---- COV (live values) ----

function bacCovActive() {
  return bac.cov.processId != null && bac.cov.objectKey === bac.selectedObjectKey;
}

// Tear down any live subscription (fire-and-forget the cancel to the device).
async function bacCovStop() {
  const { processId, objectKey } = bac.cov;
  if (processId == null) return;
  const dev = bacSelectedDevice();
  bac.cov = { processId: null, objectKey: null, busy: false, updates: 0, lastAt: null };
  if (dev && objectKey) {
    const [t, i] = objectKey.split(":").map((n) => parseInt(n, 10));
    try {
      await bacnetRead().unsubscribeCov({ device: bacDeviceRef(dev), objectType: t, instance: i, processId });
    } catch (_) { /* device drops us at lifetime expiry anyway */ }
  }
}

async function bacToggleCov() {
  if (bacCovActive()) {
    await bacCovStop();
    logTo("bacnet", "Stopped COV subscription.", "info");
    renderAll();
    return;
  }
  const dev = bacSelectedDevice();
  const obj = bacSelectedObject();
  if (!dev || !obj) return;
  // Replace any subscription on a previous object.
  if (bac.cov.processId != null) await bacCovStop();
  bac.cov.busy = true;
  renderAll();
  try {
    const processId = await bacnetRead().subscribeCov({
      device: bacDeviceRef(dev),
      deviceInstance: dev.instance,
      objectType: obj.objectType,
      instance: obj.instance,
      confirmed: false,
    });
    bac.cov = { processId, objectKey: bacObjectKey(obj), busy: false, updates: 0, lastAt: null };
    logTo("bacnet", `Subscribed to COV on ${obj.typeName}:${obj.instance} (live values).`, "ok");
  } catch (err) {
    bac.cov.busy = false;
    logTo("bacnet", `COV subscribe failed for ${obj.typeName}:${obj.instance}: ${err}`, "error");
  }
  renderAll();
}

// Patch the property rows a COV notification touched, in place, and flash them.
function bacApplyCovUpdate(values) {
  if (currentPluginId() !== "bacnet") return;
  for (const v of values) {
    const row = bac.props.find((p) => p.id === v.id);
    if (row) { row.display = v.display; row.values = v.values; row.error = v.error; }
  }
  const body = document.getElementById("bac-props-body");
  if (body) body.replaceChildren(...bacPropRows(new Set(values.map((v) => v.id))));
  const badge = document.getElementById("bac-cov-badge");
  if (badge) badge.textContent = `live · ${bac.cov.updates} update${bac.cov.updates === 1 ? "" : "s"}`;
}

// Builds the typed value payload the backend expects ({ kind, ... }).
// Integer kinds use Number.isSafeInteger so a value past 2^53 is rejected
// rather than silently rounded to a different integer before it's written.
function bacBuildWriteValue() {
  const kind = bac.write.kind;
  const raw = bac.write.value.trim();
  // An empty field must never silently become 0 — writing 0 to a live setpoint
  // is dangerous. Only Null (no value) and an intentional empty string are ok.
  if (raw === "" && kind !== "null" && kind !== "characterString") {
    throw new Error("Enter a value to write.");
  }
  const safeInt = (allowNegative) => {
    const v = Number(raw);
    if (!Number.isInteger(v) || (!allowNegative && v < 0)) {
      throw new Error(`"${raw}" is not ${allowNegative ? "an integer" : "a non-negative integer"}`);
    }
    if (!Number.isSafeInteger(v)) {
      throw new Error(`"${raw}" is too large to enter precisely (max ${Number.MAX_SAFE_INTEGER})`);
    }
    return v;
  };
  switch (kind) {
    case "null": return { kind: "null" };
    case "real": {
      const v = Number(raw);
      if (!Number.isFinite(v)) throw new Error(`"${raw}" is not a number`);
      return { kind: "real", value: v };
    }
    case "unsigned": return { kind: "unsigned", value: safeInt(false) };
    case "signed": return { kind: "signed", value: safeInt(true) };
    case "enumerated": return { kind: "enumerated", value: safeInt(false) };
    case "boolean": {
      const t = raw.toLowerCase();
      if (!["true", "false", "1", "0", "active", "inactive"].includes(t)) {
        throw new Error(`"${raw}" is not a boolean (use true/false)`);
      }
      return { kind: "boolean", value: t === "true" || t === "1" || t === "active" };
    }
    case "characterString": return { kind: "characterString", value: bac.write.value };
    default: throw new Error(`unsupported type ${kind}`);
  }
}

async function bacWrite(relinquish = false) {
  const dev = bacSelectedDevice();
  const obj = bacSelectedObject();
  if (!dev || !obj) return;
  const propertyId = parseInt(bac.write.propertyId, 10);
  if (!Number.isInteger(propertyId)) {
    logTo("bacnet", "Pick a property number to write.", "warn");
    return;
  }
  const priority = bac.write.priority === "" ? null : parseInt(bac.write.priority, 10);
  if (relinquish && priority == null) {
    logTo("bacnet", "Relinquish needs a priority (the slot to release).", "warn");
    return;
  }
  const arrayIndex = bac.write.arrayIndex === "" ? null : parseInt(bac.write.arrayIndex, 10);
  let value;
  try {
    value = relinquish ? { kind: "null" } : bacBuildWriteValue();
  } catch (err) {
    logTo("bacnet", `Invalid value: ${err.message}`, "warn");
    return;
  }
  const what = relinquish
    ? `relinquish p${priority}`
    : `write ${JSON.stringify(value)}${priority != null ? ` @ p${priority}` : ""}`;
  try {
    await bacnetRead().writeProperty({
      device: bacDeviceRef(dev),
      objectType: obj.objectType,
      instance: obj.instance,
      property: propertyId,
      value,
      priority,
      arrayIndex,
    });
    logTo("bacnet", `OK — ${what} on ${obj.typeName}:${obj.instance}.`, "ok");
    await bacRefreshProps();
  } catch (err) {
    logTo("bacnet", `Write failed on ${obj.typeName}:${obj.instance}: ${err}`, "error");
  }
}

// ---- live render helpers (in-place, no focus stealing) ----

// Coalesce bursts of device events (hundreds can arrive in one discovery
// window) into at most ~7 table rebuilds per second.
let bacDevicesRenderTimer = null;
function bacScheduleDevicesRender() {
  if (bacDevicesRenderTimer) return;
  bacDevicesRenderTimer = setTimeout(() => {
    bacDevicesRenderTimer = null;
    bacRenderDevicesLive();
  }, 150);
}

function bacRenderDevicesLive() {
  if (currentPluginId() === "building-workspace") {
    bwRenderDeviceInboxLive();
    return;
  }
  if (currentPluginId() !== "bacnet") return;
  const body = document.getElementById("bac-device-rows");
  if (body) body.replaceChildren(...bacDeviceRows());
  const count = document.getElementById("bac-device-count");
  if (count) count.textContent = bacDeviceCountText();
}

// Vendor/model display string, matching the table cells (so filter + export
// see the same text the user sees).
function bacVendorText(d) { return d.vendorName || (d.vendorId ? `vendor ${d.vendorId}` : ""); }
function bacAddressText(d) {
  return d.network != null ? `${d.address} → net ${d.network}/${d.mac || "?"}` : d.address;
}

// Hosts narrowed by the free-text filter (case-insensitive substring over
// instance, name, address, vendor, model). Empty filter returns all devices.
function bacFilteredDevices() {
  const q = bac.deviceFilter.trim().toLowerCase();
  if (!q) return bac.devices;
  return bac.devices.filter((d) =>
    String(d.instance).includes(q) ||
    (d.name || "").toLowerCase().includes(q) ||
    bacAddressText(d).toLowerCase().includes(q) ||
    bacVendorText(d).toLowerCase().includes(q) ||
    (d.modelName || "").toLowerCase().includes(q));
}

// Sort devices by the active column/direction. instance/maxApdu compare
// numerically; text columns compare case-insensitively with blanks pinned
// last; instance is the stable tiebreaker.
function bacSortedDevices(devices) {
  const { deviceSortKey: key, deviceSortDir: dir } = bac;
  const sign = dir === "desc" ? -1 : 1;
  const byInst = (a, b) => (a.instance || 0) - (b.instance || 0);
  const textOf = (d) =>
    key === "name" ? (d.name || "")
    : key === "address" ? bacAddressText(d)
    : key === "vendor" ? bacVendorText(d)
    : key === "model" ? (d.modelName || "")
    : "";
  return devices.slice().sort((a, b) => {
    if (key === "instance") return byInst(a, b) * sign;
    const av = textOf(a).toLowerCase();
    const bv = textOf(b).toLowerCase();
    if (!av && !bv) return byInst(a, b);
    if (!av) return 1;
    if (!bv) return -1;
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return (cmp || byInst(a, b)) * sign;
  });
}

function bacVisibleDevices() { return bacSortedDevices(bacFilteredDevices()); }

function bacDeviceCountText() {
  const total = bac.devices.length;
  if (bac.discovering) return `Listening… ${total} device${total === 1 ? "" : "s"} so far`;
  if (bac.deviceFilter.trim()) return `${bacFilteredDevices().length} of ${total} shown`;
  return `${total} device${total === 1 ? "" : "s"}`;
}

// Re-render just the device rows + count in place (so typing in the filter
// or clicking a sort header never rebuilds the page and steals input focus).
function bacApplyDeviceView() {
  if (currentPluginId() !== "bacnet") return;
  const tbl = document.getElementById("bac-device-table");
  if (tbl) tbl.replaceWith(bacDeviceTableEl());
  const count = document.getElementById("bac-device-count");
  if (count) count.textContent = bacDeviceCountText();
}

function bacSetDeviceSort(key) {
  if (bac.deviceSortKey === key) bac.deviceSortDir = bac.deviceSortDir === "asc" ? "desc" : "asc";
  else { bac.deviceSortKey = key; bac.deviceSortDir = "asc"; }
  bacApplyDeviceView();
}

// CSV of the currently-visible (filtered + sorted) devices.
function bacDevicesToCsv() {
  const rows = bacVisibleDevices();
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ["instance", "name", "address", "network", "mac", "vendorId", "vendorName", "model", "maxApdu", "segmentation"];
  const lines = [header.join(",")];
  for (const d of rows) {
    lines.push([
      d.instance, d.name, d.address, d.network ?? "", d.mac ?? "",
      d.vendorId, d.vendorName, d.modelName, d.maxApdu, d.segmentation,
    ].map(esc).join(","));
  }
  return lines.join("\r\n");
}

async function bacCopyDevices() {
  const csv = bacDevicesToCsv();
  try {
    await navigator.clipboard.writeText(csv);
    logTo("bacnet", `Copied ${bacVisibleDevices().length} devices to clipboard (CSV).`, "ok");
  } catch (err) {
    logTo("bacnet", `Clipboard copy failed: ${err}`, "error");
  }
}

function bacExportDevices() {
  const csv = bacDevicesToCsv();
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: `bacnet-devices-${bacTimestamp()}.csv` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  logTo("bacnet", `Exported ${bacVisibleDevices().length} devices to CSV.`, "ok");
}

function bacTimestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

// Shared object-filter predicate (free text + type set + instance range). Used by the
// Advanced Inspector object browser and the Building Workspace point-import modal so both
// filter identically.
function bacObjectMatches(o, { q = "", types = null, min = "", max = "" } = {}) {
  if (types && types.size && !types.has(o.typeName)) return false;
  const mn = parseInt(min, 10);
  if (Number.isFinite(mn) && Number(o.instance) < mn) return false;
  const mx = parseInt(max, 10);
  if (Number.isFinite(mx) && Number(o.instance) > mx) return false;
  const qq = String(q).trim().toLowerCase();
  if (qq && !(
    String(o.name || "").toLowerCase().includes(qq) ||
    String(o.typeName || "").toLowerCase().includes(qq) ||
    String(o.instance).includes(qq)
  )) return false;
  return true;
}

function bacFilteredObjects() {
  return bac.objects.filter((o) => bacObjectMatches(o, {
    q: bac.objectFilter, types: bac.objectTypeFilter,
    min: bac.objectInstanceMin, max: bac.objectInstanceMax,
  }));
}

function bacApplyObjectFilter() {
  if (currentPluginId() !== "bacnet") return;
  const list = document.getElementById("bac-object-list");
  if (list) list.replaceChildren(...bacObjectRows());
  const count = document.getElementById("bac-object-count");
  if (count) count.textContent = bacObjectCountText();
  const bulkbar = document.getElementById("bac-object-bulkbar");
  if (bulkbar) bulkbar.replaceWith(bacObjectBulkBar());
}

function bacObjectFiltersActive() {
  return Boolean(
    bac.objectFilter.trim() ||
    bac.objectTypeFilter.size ||
    String(bac.objectInstanceMin).trim() ||
    String(bac.objectInstanceMax).trim(),
  );
}

function bacObjectCountText() {
  const total = bac.objects.length;
  if (!bacObjectFiltersActive()) return `${total} object${total === 1 ? "" : "s"}`;
  return `${bacFilteredObjects().length} of ${total} shown`;
}

// ---- render ----

function bacDeviceRows() {
  if (bac.devices.length === 0) {
    const msg = bac.discovering ? "Listening for I-Am replies…" : "No devices yet — run Discover.";
    return [el("tr", {}, el("td", { class: "muted small", colspan: "6" }, msg))];
  }
  const devices = bacVisibleDevices();
  if (devices.length === 0) {
    return [el("tr", {}, el("td", { class: "muted small", colspan: "6" }, "No devices match the filter."))];
  }
  return devices.map((d) => {
    const active = d.key === bac.selectedDeviceKey;
    return el("tr", {
      class: `bac-device-row ${active ? "bac-row-active" : ""}`,
      onclick: () => bacSelectDevice(d.key),
    },
      el("td", { class: "bac-num" }, String(d.instance)),
      el("td", {}, d.name || el("span", { class: "muted" }, "—"), bacDeviceStatusBadge(d)),
      el("td", { class: "bac-mono" }, bacAddressText(d)),
      el("td", {}, bacVendorText(d) || el("span", { class: "muted" }, "—")),
      el("td", {}, d.modelName || el("span", { class: "muted" }, "—")),
      el("td", { class: "bac-num" }, `${d.maxApdu} · ${d.segmentation}`),
    );
  });
}

function bacDeviceHeaderCell(key, label, cls) {
  const active = bac.deviceSortKey === key;
  const arrow = active ? (bac.deviceSortDir === "asc" ? "▲" : "▼") : "";
  return el("th", {
    class: `bac-th${active ? " bac-th-active" : ""}${cls ? " " + cls : ""}`,
    role: "button",
    tabindex: "0",
    "aria-sort": active ? (bac.deviceSortDir === "asc" ? "ascending" : "descending") : "none",
    onclick: () => bacSetDeviceSort(key),
    onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); bacSetDeviceSort(key); } },
  }, label, el("span", { class: "bac-sort-ind" }, arrow));
}

function bacDeviceTableEl() {
  return el("table", { id: "bac-device-table", class: "bac-table" },
    el("thead", {}, el("tr", {},
      bacDeviceHeaderCell("instance", "Instance"),
      bacDeviceHeaderCell("name", "Name"),
      bacDeviceHeaderCell("address", "Address"),
      bacDeviceHeaderCell("vendor", "Vendor"),
      bacDeviceHeaderCell("model", "Model"),
      el("th", {}, "Max APDU · seg"),
    )),
    el("tbody", { id: "bac-device-rows" }, ...bacDeviceRows()),
  );
}

function bacObjectRows() {
  const objects = bacFilteredObjects();
  if (objects.length === 0) {
    let msg;
    if (bac.objects.length > 0) msg = "No objects match the filter.";
    else if (bac.objectsLoading) msg = "Reading object list…";
    else msg = "Select a device to list its objects.";
    return [el("li", { class: "muted small bac-object-empty" }, msg)];
  }
  // Group by object type so a large device reads like Niagara's point folders.
  const sorted = [...objects].sort((a, b) =>
    String(a.typeName).localeCompare(String(b.typeName)) || Number(a.instance) - Number(b.instance));
  const countByType = sorted.reduce((m, o) => m.set(o.typeName, (m.get(o.typeName) || 0) + 1), new Map());
  const rows = [];
  let lastType = null;
  for (const o of sorted) {
    if (o.typeName !== lastType) {
      lastType = o.typeName;
      rows.push(el("li", { class: "bac-object-group", role: "presentation" },
        el("span", {}, lastType),
        el("span", { class: "muted small" }, String(countByType.get(lastType))),
      ));
    }
    const key = bacObjectKey(o);
    const active = key === bac.selectedObjectKey;
    const checked = bac.objectSelection.has(key);
    rows.push(el("li", {
      class: `bac-object-row ${active ? "bac-row-active" : ""}${checked ? " bac-object-checked" : ""}`,
      role: "button",
      tabindex: "0",
      onclick: () => bacSelectObject(key),
      onkeydown: (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); bacSelectObject(key); }
      },
    },
      el("input", {
        type: "checkbox", class: "bac-object-check",
        checked: checked ? "checked" : undefined,
        "aria-label": `Select ${o.typeName}:${o.instance} for import`,
        onclick: (e) => { e.stopPropagation(); bacToggleObjectSelect(key); },
      }),
      el("span", { class: "bac-object-type" }, `${o.typeName}:${o.instance}`),
      el("span", { class: "bac-object-name" }, o.name || ""),
      el("button", {
        class: "btn-ghost bac-object-action",
        title: "Import this object into Building Workspace and historize it",
        onclick: (e) => { e.stopPropagation(); bwHistorizeSelectedObject(o); },
      }, "Historize"),
    ));
  }
  return rows;
}

// ---- object browser: type/instance filters, multi-select, bulk import, export ----

function bacObjectTypeNames() {
  return [...new Set(bac.objects.map((o) => o.typeName))].sort((a, b) => String(a).localeCompare(String(b)));
}

function bacToggleObjectType(typeName) {
  if (bac.objectTypeFilter.has(typeName)) bac.objectTypeFilter.delete(typeName);
  else bac.objectTypeFilter.add(typeName);
  // A row that just became hidden shouldn't stay selected for import.
  for (const key of [...bac.objectSelection]) {
    const obj = bac.objects.find((o) => bacObjectKey(o) === key);
    if (obj && bac.objectTypeFilter.size && !bac.objectTypeFilter.has(obj.typeName)) bac.objectSelection.delete(key);
  }
  renderAll();
}

function bacToggleObjectSelect(key) {
  if (bac.objectSelection.has(key)) bac.objectSelection.delete(key);
  else bac.objectSelection.add(key);
  bacApplyObjectFilter();
}

function bacSelectAllFiltered() {
  for (const o of bacFilteredObjects()) bac.objectSelection.add(bacObjectKey(o));
  bacApplyObjectFilter();
}

function bacClearObjectSelection() {
  bac.objectSelection.clear();
  bacApplyObjectFilter();
}

function bacSelectedObjectsForBulk() {
  return bac.objects.filter((o) => bac.objectSelection.has(bacObjectKey(o)));
}

function bacObjectsToCsv(objects) {
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [["objectType", "typeName", "instance", "name"].join(",")];
  for (const o of objects) lines.push([o.objectType, o.typeName, o.instance, o.name].map(esc).join(","));
  return lines.join("\r\n");
}

function bacExportObjects() {
  const dev = bacSelectedDevice();
  const objects = bacFilteredObjects();
  if (!objects.length) { toast("No objects to export.", "warn"); return; }
  const csv = bacObjectsToCsv(objects);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: `bacnet-objects-${dev ? dev.instance : "device"}-${bacTimestamp()}.csv` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Exported ${objects.length} object${objects.length === 1 ? "" : "s"} to CSV.`, "ok");
}

// Bulk-model the checked objects into the active site/building/floor: group them by
// inferred equipment, create/reuse one equip per group, then upsert all points in a
// single inventory write (inventory.upsertMany). Reuses the same equip/point helpers
// as the single-object Historize path.
function bacBulkImportSelected() {
  const inv = inventoryInstance();
  const dev = bacSelectedDevice();
  const objects = bacSelectedObjectsForBulk();
  if (!inv) { toast("Building model is not ready.", "error"); return; }
  if (!dev || !objects.length) { toast("Select one or more objects first.", "warn"); return; }
  const { site, building, floor } = bwEnsureLocation(inv);
  const plan = bwPlanDeviceObjects({ device: dev, objects, template: bac.objectNameTemplate });
  const equipIdByName = new Map();
  for (const name of plan.equips) {
    let equip = bwEntityByName(inv, { type: "equip", floorId: floor.id }, name)
      || inv.upsertEntity({
        type: "equip", siteId: site.id, buildingId: building.id, floorId: floor.id, parentId: floor.id,
        name, tags: { equip: true },
      });
    equip = inv.applyTemplate(equip.id, bwTemplateForName(name));
    equipIdByName.set(name, equip.id);
  }
  const points = bwModelObjectsBatch({
    siteId: site.id, buildingId: building.id, floorId: floor.id, device: dev, items: plan.items, equipIdByName,
  });
  const saved = inv.upsertMany(points);
  bwSaveState();
  bac.objectSelection.clear();
  logTo("building-workspace", `Imported ${saved.length} point${saved.length === 1 ? "" : "s"} from device ${dev.instance} into ${floor.name}.`, "ok");
  toast(`Imported ${saved.length} point${saved.length === 1 ? "" : "s"} into ${floor.name}. Open Building Workspace to model further.`, "ok");
  renderAll();
}

// Saved object-filter presets (persisted in user state).
function bacObjectPresets() {
  if (!userState.bacnetObjectPresets || typeof userState.bacnetObjectPresets !== "object") userState.bacnetObjectPresets = {};
  return userState.bacnetObjectPresets;
}

function bacSaveObjectPreset() {
  const name = (prompt("Save the current object filter as a preset named:", "") || "").trim();
  if (!name) return;
  bacObjectPresets()[name] = {
    q: bac.objectFilter,
    types: [...bac.objectTypeFilter],
    min: bac.objectInstanceMin,
    max: bac.objectInstanceMax,
  };
  saveUserState();
  toast(`Saved filter preset "${name}".`, "ok");
  renderAll();
}

function bacApplyObjectPreset(name) {
  const preset = bacObjectPresets()[name];
  if (!preset) return;
  bac.objectFilter = preset.q || "";
  bac.objectTypeFilter = new Set(Array.isArray(preset.types) ? preset.types : []);
  bac.objectInstanceMin = preset.min || "";
  bac.objectInstanceMax = preset.max || "";
  renderAll();
}

// The filter toolbar (type chips + instance range + presets + CSV export) above the list.
function bacObjectToolbar() {
  const typeNames = bacObjectTypeNames();
  const presets = Object.keys(bacObjectPresets());
  const typeChips = typeNames.map((t) => {
    const on = bac.objectTypeFilter.has(t);
    return el("button", {
      type: "button",
      class: `bac-type-chip${on ? " bac-type-chip-on" : ""}`,
      "aria-pressed": on ? "true" : "false",
      onclick: () => bacToggleObjectType(t),
    }, t);
  });
  return el("div", { class: "bac-object-toolbar" },
    el("input", {
      type: "search", class: "nm-input bac-object-filter",
      placeholder: "Filter objects…",
      "aria-label": "Filter objects",
      value: bac.objectFilter,
      oninput: (e) => { bac.objectFilter = e.target.value; bacApplyObjectFilter(); },
    }),
    el("div", { class: "bac-object-range" },
      el("span", { class: "muted small" }, "Instance"),
      el("input", {
        type: "number", class: "nm-input bac-range-input", placeholder: "min",
        "aria-label": "Minimum instance", value: bac.objectInstanceMin,
        oninput: (e) => { bac.objectInstanceMin = e.target.value; bacApplyObjectFilter(); },
      }),
      el("span", { class: "muted small" }, "–"),
      el("input", {
        type: "number", class: "nm-input bac-range-input", placeholder: "max",
        "aria-label": "Maximum instance", value: bac.objectInstanceMax,
        oninput: (e) => { bac.objectInstanceMax = e.target.value; bacApplyObjectFilter(); },
      }),
    ),
    typeNames.length
      ? el("details", {
          class: "bac-type-filter",
          open: bac.objectTypesOpen ? "open" : undefined,
          ontoggle: (e) => { bac.objectTypesOpen = e.target.open; },
        },
          el("summary", {}, `Types${bac.objectTypeFilter.size ? ` (${bac.objectTypeFilter.size})` : ""}`),
          el("div", { class: "bac-type-chips" },
            ...typeChips,
            bac.objectTypeFilter.size
              ? el("button", { type: "button", class: "btn-ghost bac-type-clear", onclick: () => { bac.objectTypeFilter.clear(); renderAll(); } }, "Clear types")
              : null,
          ),
        )
      : null,
    el("div", { class: "bac-object-presets" },
      presets.length
        ? el("select", {
            class: "nm-input bac-preset-select", "aria-label": "Apply a saved filter preset",
            onchange: (e) => { if (e.target.value) bacApplyObjectPreset(e.target.value); },
          },
            el("option", { value: "" }, "Presets…"),
            ...presets.map((p) => el("option", { value: p }, p)),
          )
        : null,
      el("button", { type: "button", class: "btn-ghost", title: "Save the current filter as a preset", onclick: bacSaveObjectPreset }, "Save filter"),
      el("button", { type: "button", class: "btn-ghost", title: "Download the filtered object list as CSV", onclick: bacExportObjects }, "Export CSV"),
    ),
  );
}

// The bulk-action bar: shown once a device's objects are loaded so "Select all" and
// the name template are reachable; the import button enables when rows are checked.
function bacObjectBulkBar() {
  const n = bac.objectSelection.size;
  const visible = bacFilteredObjects().length;
  if (!bac.objects.length) return el("div", { id: "bac-object-bulkbar", class: "bac-object-bulkbar" });
  return el("div", { id: "bac-object-bulkbar", class: "bac-object-bulkbar bac-object-bulkbar-on" },
    el("span", { class: "muted small" }, n ? `${n} selected` : ""),
    el("input", {
      type: "text", class: "nm-input bac-name-template",
      placeholder: "Name template, e.g. {equip}-{type}{instance}",
      title: "Optional. Tokens: {equip} {type} {instance} {name}. Blank keeps each object's own name.",
      "aria-label": "Point name template",
      value: bac.objectNameTemplate,
      oninput: (e) => { bac.objectNameTemplate = e.target.value; },
    }),
    el("button", { type: "button", class: "btn-ghost", onclick: bacSelectAllFiltered }, `Select all${visible ? ` (${visible})` : ""}`),
    n ? el("button", { type: "button", class: "btn-ghost", onclick: bacClearObjectSelection }, "Clear") : null,
    el("button", {
      type: "button", class: "btn bac-bulk-import",
      disabled: n ? undefined : "disabled",
      title: "Model the selected objects as points under the active floor",
      onclick: bacBulkImportSelected,
    }, n ? `Import ${n} point${n === 1 ? "" : "s"}` : "Import points"),
  );
}

function bacAdapterTarget(adapterName = bwSelectedNetworkAdapterName()) {
  return adapterName ? bacSweepTargetFor(adapterName) : null;
}

async function bwDiscoverDevices() {
  const target = bacAdapterTarget();
  if (target) bac.target = target.value;
  await bacDiscover();
}

function bacPropRows(flashIds) {
  if (bac.props.length === 0) {
    const msg = bac.propsLoading
      ? "Reading properties…"
      : "Select an object to read its properties.";
    return [el("tr", {}, el("td", { class: "muted small", colspan: "2" }, msg))];
  }
  return bac.props.map((p) => {
    const flash = flashIds && flashIds.has(p.id);
    return el("tr", { class: `${p.error ? "bac-prop-error" : ""}${flash ? " bac-prop-flash" : ""}` },
      el("td", { class: "bac-prop-name", title: `property ${p.id}` }, p.name),
      el("td", { class: "bac-prop-value" }, p.display),
    );
  });
}

// ---- alarms (GetEventInformation / GetAlarmSummary) ----

async function bacReadAlarms() {
  const dev = bacSelectedDevice();
  if (!dev || bac.alarms.loading) return;
  bac.alarms.loading = true;
  bac.alarms.deviceKey = dev.key;
  bac.alarms.error = null;
  renderAll();
  try {
    const entries = await bacnetRead().getAlarms(bacDeviceRef(dev));
    // Ignore if the user switched devices mid-read.
    if (bac.selectedDeviceKey !== dev.key) return;
    bac.alarms.entries = entries;
    bac.alarms.ran = true;
    const active = entries.filter((e) => e.eventState !== "normal").length;
    logTo("bacnet", `Read ${entries.length} alarm record${entries.length === 1 ? "" : "s"} from ${bacDeviceLabel(dev)} (${active} not normal).`, entries.length ? "ok" : "info");
  } catch (err) {
    if (bac.selectedDeviceKey !== dev.key) return;
    bac.alarms.entries = [];
    bac.alarms.error = String(err);
    bac.alarms.ran = true;
    logTo("bacnet", `Alarm read failed for ${bacDeviceLabel(dev)}: ${err}`, "error");
  } finally {
    // Clear loading whenever this read still owns the alarms slot, even if the
    // user switched devices mid-read — otherwise the button stays disabled.
    if (bac.alarms.deviceKey === dev.key) {
      bac.alarms.loading = false;
      renderAll();
    }
  }
}

async function bacAcknowledgeAlarm(alarm) {
  const dev = bacSelectedDevice();
  if (!dev) return;
  const label = `${alarm.typeName}:${alarm.instance}${alarm.name ? ` (${alarm.name})` : ""}`;
  const ok = await confirmAction({
    title: "Acknowledge alarm",
    message: `Acknowledge the "${alarm.eventState}" alarm on ${label} at ${bacDeviceLabel(dev)}? ` +
      `This writes an acknowledgment to the device and is logged.`,
    confirmLabel: "Acknowledge",
  });
  if (!ok) return;
  // Audit trail: record intent and outcome in the activity log.
  logTo("bacnet", `ACK requested — ${label} (${alarm.eventState}) on ${bacDeviceLabel(dev)}.`, "warn");
  try {
    await bacnetRead().acknowledgeAlarm({
      device: bacDeviceRef(dev),
      objectType: alarm.objectType,
      instance: alarm.instance,
    });
    logTo("bacnet", `ACK accepted by device — ${label}.`, "ok");
    toast(`Acknowledged ${label}`, "ok");
    await bacReadAlarms(); // refresh so the ack state reflects reality
  } catch (err) {
    logTo("bacnet", `ACK failed — ${label}: ${err}`, "error");
    toast(`Acknowledge failed: ${err}`, "error");
  }
}

function bacAlarmRows() {
  const fresh = bac.alarms.deviceKey === bac.selectedDeviceKey;
  const entries = fresh ? bac.alarms.entries : [];
  if (!entries.length) return [];
  return entries.map((a) => {
    const stateCls = a.eventState === "normal" ? "" : "bac-alarm-active";
    const action = a.acknowledged
      ? el("span", { class: "muted small" }, "ack'd")
      : el("button", {
          class: "btn-ghost",
          title: "Acknowledge this alarm on the device (writes)",
          onclick: () => bacAcknowledgeAlarm(a),
        }, "Ack");
    return el("tr", { class: stateCls },
      el("td", {}, `${a.typeName}:${a.instance}`),
      el("td", {}, a.name || "—"),
      el("td", {}, a.eventState),
      el("td", {}, a.acknowledged ? "yes" : "no"),
      el("td", {}, a.priority != null ? String(a.priority) : "—"),
      el("td", {}, a.timestamp || "—"),
      el("td", {}, action),
    );
  });
}

function bacAlarmsSection() {
  const dev = bacSelectedDevice();
  if (!dev) return null;
  const fresh = bac.alarms.deviceKey === dev.key;
  const rows = bacAlarmRows();
  let status = "";
  if (bac.alarms.loading && fresh) status = "Reading alarms…";
  else if (fresh && bac.alarms.error) status = `Error: ${bac.alarms.error}`;
  else if (fresh && bac.alarms.ran && rows.length === 0) status = "No active or unacknowledged alarms.";
  return el("section", { class: "plugin-section" },
    el("div", { class: "section-head" },
      el("h3", {}, `Alarms — ${bacDeviceLabel(dev)}`),
      el("button", {
        class: "btn-ghost",
        disabled: bac.alarms.loading ? "disabled" : undefined,
        title: "List active and unacknowledged alarms (GetEventInformation / GetAlarmSummary)",
        onclick: bacReadAlarms,
      }, bac.alarms.loading && fresh ? "…" : "Read alarms"),
    ),
    status ? el("p", { class: "muted small" }, status) : null,
    rows.length
      ? el("div", { class: "table-scroll" },
          el("table", { class: "bac-table" },
            el("thead", {}, el("tr", {},
              el("th", {}, "Object"),
              el("th", {}, "Name"),
              el("th", {}, "State"),
              el("th", {}, "Ack'd"),
              el("th", {}, "Priority"),
              el("th", {}, "Since"),
              el("th", {}, "Action"),
            )),
            el("tbody", {}, ...rows),
          ))
      : null,
  );
}

// ---- trend logs (ReadRange) ----

function bacObjectIsTrendLog(obj) {
  return obj && (obj.objectType === 20 || obj.objectType === 27); // trend-log / trend-log-multiple
}

async function bacReadTrend() {
  const dev = bacSelectedDevice();
  const obj = bacSelectedObject();
  if (!dev || !obj) return;
  const max = Math.max(1, Math.min(2000, parseInt(bac.trend.max, 10) || 200));
  bac.trend.loading = true;
  bac.trend.objectKey = bacObjectKey(obj);
  renderAll();
  try {
    const result = await bacnetRead().readTrend({
      device: bacDeviceRef(dev),
      objectType: obj.objectType,
      instance: obj.instance,
      maxRecords: max,
    });
    // Ignore if the user navigated away mid-read.
    if (bac.selectedObjectKey !== bacObjectKey(obj)) return;
    bac.trend.records = result.records;
    bac.trend.recordCount = result.recordCount;
    bac.trend.truncated = result.truncated;
    logTo("bacnet", `Read ${result.records.length} trend record${result.records.length === 1 ? "" : "s"} from ${obj.typeName}:${obj.instance}.`, "ok");
  } catch (err) {
    if (bac.selectedObjectKey !== bacObjectKey(obj)) return;
    logTo("bacnet", `Trend read failed for ${obj.typeName}:${obj.instance}: ${err}`, "error");
  } finally {
    if (bac.selectedObjectKey === bacObjectKey(obj)) {
      bac.trend.loading = false;
      renderAll();
    }
  }
}

function bacTrendToCsv() {
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = ["timestamp,value,status"];
  for (const r of bac.trend.records) {
    lines.push([r.timestamp, r.value, r.status].map(esc).join(","));
  }
  return lines.join("\r\n");
}

function bacExportTrend() {
  const obj = bacSelectedObject();
  const csv = bacTrendToCsv();
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: `trend-${obj ? `${obj.typeName}-${obj.instance}` : "log"}-${bacTimestamp()}.csv` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  logTo("bacnet", `Exported ${bac.trend.records.length} trend records to CSV.`, "ok");
}

function bacTrendPanel() {
  const recs = bac.trend.records;
  const rows = recs.length === 0
    ? [el("tr", {}, el("td", { class: "muted small", colspan: "3" },
        bac.trend.loading ? "Reading trend log…" : "No records read yet — click Read trend."))]
    : recs.map((r) => el("tr", {},
        el("td", { class: "bac-mono" }, r.timestamp),
        el("td", { class: "bac-prop-value" }, r.value),
        el("td", {}, r.status || el("span", { class: "muted" }, "—")),
      ));

  const maxInput = el("input", {
    type: "text", class: "nm-input bac-trend-max",
    title: "Max records to read",
    value: bac.trend.max,
    oninput: (e) => { bac.trend.max = e.target.value; },
  });

  return el("div", { class: "bac-trend" },
    el("div", { class: "section-head" },
      el("h4", {}, "Trend log"),
      bac.trend.recordCount
        ? el("span", { class: "muted small" }, `${bac.trend.recordCount} records on device${bac.trend.truncated ? ` · showing ${recs.length}` : ""}`)
        : null,
    ),
    el("div", { class: "action-row bac-trend-controls" },
      el("label", { class: "nm-field bac-trend-field" },
        el("span", { class: "nm-field-label" }, "Max records"), maxInput),
      el("button", {
        class: "btn btn-primary",
        disabled: bac.trend.loading ? "disabled" : undefined,
        onclick: bacReadTrend,
      }, bac.trend.loading ? "Reading…" : "Read trend"),
      el("button", {
        class: "btn-ghost",
        disabled: recs.length === 0 ? "disabled" : undefined,
        onclick: bacExportTrend,
      }, "Export CSV"),
    ),
    el("table", { class: "bac-table bac-trend-table" },
      el("thead", {}, el("tr", {},
        el("th", {}, "Timestamp"),
        el("th", {}, "Value"),
        el("th", {}, "Status"),
      )),
      el("tbody", {}, ...rows),
    ),
  );
}

function bacWritePanel() {
  const dev = bacSelectedDevice();
  const obj = bacSelectedObject();
  const disabled = !dev || !obj ? "disabled" : undefined;

  const propInput = el("input", {
    type: "text", class: "nm-input bac-write-prop", disabled,
    title: "Property number (85 = present-value)",
    value: bac.write.propertyId,
    oninput: (e) => { bac.write.propertyId = e.target.value; },
  });
  const kindSelect = el("select", {
    class: "nm-input bac-write-kind", disabled,
    onchange: (e) => { bac.write.kind = e.target.value; },
  },
    ...[
      ["real", "Real"],
      ["unsigned", "Unsigned"],
      ["signed", "Signed"],
      ["enumerated", "Enumerated"],
      ["boolean", "Boolean"],
      ["characterString", "Text"],
      ["null", "Null"],
    ].map(([v, label]) => el("option", {
      value: v,
      selected: bac.write.kind === v ? "selected" : undefined,
    }, label)),
  );
  const valueInput = el("input", {
    type: "text", class: "nm-input bac-write-value", disabled,
    placeholder: "value (e.g. 72.5)",
    value: bac.write.value,
    oninput: (e) => { bac.write.value = e.target.value; },
  });
  const prioritySelect = el("select", {
    class: "nm-input bac-write-priority", disabled,
    title: "Command priority (8 = manual operator)",
    onchange: (e) => { bac.write.priority = e.target.value; },
  },
    el("option", { value: "" }, "no priority"),
    ...Array.from({ length: 16 }, (_, i) => el("option", {
      value: String(i + 1),
      selected: bac.write.priority === String(i + 1) ? "selected" : undefined,
    }, `priority ${i + 1}`)),
  );

  return el("div", { class: "bac-write" },
    el("div", { class: "bac-write-row" },
      el("label", { class: "nm-field bac-write-field" },
        el("span", { class: "nm-field-label" }, "Property #"), propInput),
      el("label", { class: "nm-field bac-write-field" },
        el("span", { class: "nm-field-label" }, "Type"), kindSelect),
      el("label", { class: "nm-field bac-write-field bac-write-grow" },
        el("span", { class: "nm-field-label" }, "Value"), valueInput),
      el("label", { class: "nm-field bac-write-field" },
        el("span", { class: "nm-field-label" }, "Priority"), prioritySelect),
    ),
    el("div", { class: "action-row" },
      el("button", { class: "btn btn-primary", disabled, onclick: () => bacWrite(false) }, "Write"),
      el("button", {
        class: "btn-ghost", disabled,
        title: "Write Null at the selected priority to release the slot",
        onclick: () => bacWrite(true),
      }, "Relinquish"),
      el("button", { class: "btn-ghost", disabled, onclick: bacRefreshProps }, "Refresh"),
    ),
  );
}

// Directed-broadcast address for an adapter (e.g. 192.168.7.255 for a /21),
// derived from the Network Manager's live adapter state. Null when unusable.
function bacDirectedBroadcastFor(adapterName) {
  const st = nm.stateByAdapter[adapterName];
  if (!st || !st.ipAddress) return null;
  const prefix = nmMaskToPrefix(st.subnetMask);
  if (prefix == null || prefix < 8 || prefix > 30) return null;
  const p = st.ipAddress.split(".").map((n) => parseInt(n, 10));
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return null;
  const ip = ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const bcast = (ip | ~mask) >>> 0;
  return [(bcast >>> 24) & 255, (bcast >>> 16) & 255, (bcast >>> 8) & 255, bcast & 255].join(".");
}

// Discovery target(s) for an adapter. For subnets wider than /24 this also
// sweeps every /24 directed broadcast inside the range — flat BAS networks
// often mix masks, and a /24-configured controller ignores the /21 broadcast.
function bacSweepTargetFor(adapterName) {
  const st = nm.stateByAdapter[adapterName];
  if (!st || !st.ipAddress) return null;
  const prefix = nmMaskToPrefix(st.subnetMask);
  if (prefix == null || prefix < 16 || prefix > 30) return null;
  const bcast = bacDirectedBroadcastFor(adapterName);
  if (!bcast) return null;
  if (prefix >= 24) return { value: bcast, label: bcast };
  const p = st.ipAddress.split(".").map((n) => parseInt(n, 10));
  const ip = ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  const net = (ip & mask) >>> 0;
  const count = Math.min(Math.pow(2, 24 - prefix), 32); // cap the sweep at 32 /24s
  const targets = [bcast];
  for (let i = 0; i < count; i++) {
    const sub = (net + i * 256) >>> 0;
    targets.push([(sub >>> 24) & 255, (sub >>> 16) & 255, (sub >>> 8) & 255, 255].join("."));
  }
  const netStr = [(net >>> 24) & 255, (net >>> 16) & 255, (net >>> 8) & 255, net & 255].join(".");
  return { value: targets.join(","), label: `${netStr}/${prefix} sweep` };
}

// One clickable chip per adapter subnet, so multi-NIC machines (VPN, WSL,
// Hyper-V) can aim the Who-Is at the right network in one click.
function bacTargetChips() {
  const chips = [];
  const seen = new Set();
  for (const a of nm.adapters) {
    const t = bacSweepTargetFor(a.name);
    if (!t || seen.has(t.value)) continue;
    seen.add(t.value);
    chips.push(el("button", {
      class: `bac-chip ${bac.target === t.value ? "bac-chip-on" : ""}`,
      title: `Who-Is target(s) for ${a.name}`,
      disabled: bac.discovering ? "disabled" : undefined,
      onclick: () => { bac.target = t.value; renderAll(); },
    }, `${a.name} · ${t.label}`));
  }
  if (chips.length === 0) {
    return el("p", { class: "muted small bac-chip-row" },
      nm.loaded ? "" : "Reading adapters for subnet suggestions…");
  }
  return el("div", { class: "bac-chip-row" }, ...chips);
}

function renderBacnetPage() {
  bacEnsureListeners();
  nmEnsureLoaded(); // adapter state feeds the target suggestions

  const targetInput = el("input", {
    type: "text", class: "nm-input",
    placeholder: "255.255.255.255 or 192.168.1.255 or a device IP",
    disabled: bac.discovering ? "disabled" : undefined,
    value: bac.target,
    oninput: (e) => { bac.target = e.target.value; },
  });
  const lowInput = el("input", {
    type: "text", class: "nm-input bac-range-input", placeholder: "low",
    disabled: bac.discovering ? "disabled" : undefined,
    value: bac.lowLimit,
    oninput: (e) => { bac.lowLimit = e.target.value; },
  });
  const highInput = el("input", {
    type: "text", class: "nm-input bac-range-input", placeholder: "high",
    disabled: bac.discovering ? "disabled" : undefined,
    value: bac.highLimit,
    oninput: (e) => { bac.highLimit = e.target.value; },
  });
  const discoverBtn = el("button", {
    class: "btn btn-primary",
    disabled: bac.discovering ? "disabled" : undefined,
    onclick: bacDiscover,
  }, bac.discovering ? "Discovering…" : "Discover");

  // Offered only when the platform kernel resolved BACnet's optional dependency
  // on the netscan capability (i.e. Network Manager is present).
  const scanBtn = platformHost("bacnet")?.has("netscan.v1")
    ? el("button", {
        class: "btn btn-ghost",
        disabled: bac.discovering ? "disabled" : undefined,
        title: "Use Network Manager's scanner to list live hosts on your subnet",
        onclick: bacSuggestTargets,
      }, "Find live hosts")
    : null;

  const fdrRegistered = !!bac.bbmd.status;
  const bbmdInput = el("input", {
    type: "text", class: "nm-input",
    placeholder: "BBMD IP (e.g. 10.0.5.1)",
    disabled: (fdrRegistered || bac.bbmd.busy) ? "disabled" : undefined,
    value: bac.bbmd.address,
    oninput: (e) => { bac.bbmd.address = e.target.value; },
  });
  const bbmdTtlInput = el("input", {
    type: "text", class: "nm-input bac-range-input", placeholder: "TTL s",
    disabled: (fdrRegistered || bac.bbmd.busy) ? "disabled" : undefined,
    value: bac.bbmd.ttl,
    oninput: (e) => { bac.bbmd.ttl = e.target.value; },
  });
  const bbmdBtn = el("button", {
    class: fdrRegistered ? "btn btn-ghost" : "btn",
    disabled: bac.bbmd.busy ? "disabled" : undefined,
    onclick: bacToggleForeignDevice,
  }, bac.bbmd.busy ? "…" : (fdrRegistered ? "Unregister" : "Register"));

  const discoverSection = el("section", { class: "plugin-section" },
    el("div", { class: "nm-pane-head" },
      el("div", { class: "nm-pane-head-text" },
        el("h3", {}, "Discover devices"),
        el("p", { class: "muted small nm-section-sub" },
          "Broadcasts a Who-Is on UDP 47808. Use a directed broadcast (x.x.x.255) for a ",
          "specific subnet, or a device's IP to probe it directly across subnets."),
      ),
    ),
    el("div", { class: "bac-discover-controls" },
      el("label", { class: "nm-field bac-target-field" },
        el("span", { class: "nm-field-label" }, "Target"), targetInput),
      el("label", { class: "nm-field" },
        el("span", { class: "nm-field-label" }, "Instance range (optional)"),
        el("div", { class: "bac-range-pair" }, lowInput, el("span", { class: "muted" }, "–"), highInput),
      ),
      discoverBtn,
      scanBtn,
    ),
    el("div", { class: "bac-discover-controls bac-fdr-controls" },
      el("label", { class: "nm-field bac-target-field" },
        el("span", { class: "nm-field-label" }, "BBMD (foreign device)"), bbmdInput),
      el("label", { class: "nm-field" },
        el("span", { class: "nm-field-label" }, "TTL"), bbmdTtlInput),
      bbmdBtn,
      fdrRegistered
        ? el("span", { class: "muted small" },
            `Registered with ${bac.bbmd.status.bbmd} — broadcasts route through the BBMD.`)
        : el("span", { class: "muted small" },
            "Optional: reach devices on other IP subnets via a BBMD."),
    ),
    bac.discovering ? bacDiscoveryProgressEl("bac-discovery-progress") : null,
    bacTargetChips(),
  );

  const hasDevices = bac.devices.length > 0;
  const devicesSection = el("section", { class: "plugin-section plugin-section-fill" },
    el("div", { class: "section-head" },
      el("h3", {}, "Devices"),
      el("span", { id: "bac-device-count", class: "muted small" }, bacDeviceCountText()),
      bacDriftSummaryEl(),
    ),
    hasDevices
      ? el("div", { class: "bac-device-toolbar" },
          el("input", {
            type: "search",
            class: "nm-input bac-device-filter",
            placeholder: "Filter by instance, name, address, vendor, model…",
            "aria-label": "Filter devices",
            value: bac.deviceFilter,
            oninput: (e) => { bac.deviceFilter = e.target.value; bacApplyDeviceView(); },
          }),
          el("button", {
            class: "btn-ghost", title: "Copy visible devices as CSV", onclick: bacCopyDevices,
          }, "Copy"),
          el("button", {
            class: "btn-ghost", title: "Download visible devices as a CSV file", onclick: bacExportDevices,
          }, "Export CSV"),
        )
      : null,
    // Static scroll wrapper; bacApplyDeviceView swaps the inner <table> in place (no re-nesting).
    el("div", { class: "table-scroll table-scroll-fill" }, bacDeviceTableEl()),
  );

  const dev = bacSelectedDevice();
  const obj = bacSelectedObject();

  const objectsPane = el("div", { class: "bac-objects-pane" },
    el("div", { class: "section-head" },
      el("h3", {}, dev ? `Objects — ${bacDeviceLabel(dev)}` : "Objects"),
      el("span", { id: "bac-object-count", class: "muted small" }, bacObjectCountText()),
    ),
    bacObjectToolbar(),
    bacObjectBulkBar(),
    el("p", { id: "bac-objects-status", class: "muted small" },
      bac.objectsLoading
        ? (bac.objectsProgress
            ? `Walking object-list… ${bac.objectsProgress.done}/${bac.objectsProgress.total}`
            : "Reading object list…")
        : ""),
    el("ul", { id: "bac-object-list", class: "bac-object-list" }, ...bacObjectRows()),
  );

  const covOn = bacCovActive();
  const covBtn = el("button", {
    class: `btn-ghost bac-cov-btn ${covOn ? "bac-cov-on" : ""}`,
    disabled: !obj || bac.cov.busy ? "disabled" : undefined,
    title: "Subscribe to Change-of-Value notifications for live updates",
    onclick: bacToggleCov,
  }, bac.cov.busy ? "…" : covOn ? "Stop live" : "Subscribe live (COV)");

  const propsPane = el("div", { class: "bac-props-pane" },
    el("div", { class: "section-head" },
      el("h3", {}, obj ? `Properties — ${obj.typeName}:${obj.instance}` : "Properties"),
      el("div", { class: "bac-props-head-right" },
        covOn ? el("span", { id: "bac-cov-badge", class: "pill pill-running bac-cov-badge" },
          `live · ${bac.cov.updates} update${bac.cov.updates === 1 ? "" : "s"}`) : null,
        obj && obj.name ? el("span", { class: "muted small" }, obj.name) : null,
        covBtn,
      ),
    ),
    el("table", { class: "bac-table bac-props-table" },
      el("thead", {}, el("tr", {},
        el("th", {}, "Property"),
        el("th", {}, "Value"),
      )),
      el("tbody", { id: "bac-props-body" }, ...bacPropRows()),
    ),
    bacObjectIsTrendLog(obj) ? bacTrendPanel() : null,
    bacWritePanel(),
  );

  const browseSection = el("section", { class: "plugin-section plugin-section-fill" },
    el("div", { class: "bac-browse" }, objectsPane, propsPane),
  );

  return el("div", { class: "plugin-controls plugin-controls-fill bac-root" },
    discoverSection,
    devicesSection,
    browseSection,
    bacAlarmsSection(),
  );
}

// ============================================================================
// Observability (platform service page)
// ============================================================================

// Pack UI state.
let obsBusy = false;
let obsPhase = "";       // high-level bring-up phase label
let obsProgress = null;  // latest per-component install event (download %, rate, ETA, …)
let obsHealth = null;
let obsHealthChecking = true;
let obsHealthMessage = "Checking health and smoke test on startup…";
let obsPack = null;      // installed-vs-pinned component versions (update detection)
let obsPackLoading = false;

const OBS_COMPONENT_NAMES = { influxdb: "InfluxDB", telegraf: "Telegraf", grafana: "Grafana" };

// Lazily fetch pack version status (installed vs pinned) once per page visit.
function obsEnsurePackStatus() {
  if (obsPack !== null || obsPackLoading || !pack) return;
  obsPackLoading = true;
  pack.packStatus()
    .then((s) => { obsPack = s; obsPackLoading = false; renderAll(); })
    .catch(() => { obsPackLoading = false; });
}

// "InfluxDB 2.7.5 · Telegraf 1.30.0 · Grafana 11.1.0 → 11.2.0" + an update badge.
function obsVersionsLine() {
  if (!obsPack || !obsPack.components) return null;
  const parts = obsPack.components.map((c) => {
    const name = OBS_COMPONENT_NAMES[c.name] || c.name;
    const ver = c.present ? (c.installedVersion || "?") : "not installed";
    const upgrade = c.present && c.needsUpdate ? ` → ${c.pinnedVersion}` : "";
    return `${name} ${ver}${upgrade}`;
  });
  return el("p", { class: "muted small" },
    parts.join(" · "),
    obsPack.updatesAvailable ? el("span", { class: "pill pill-running", style: "margin-left:8px" }, "Update available") : null,
  );
}

const OBS_PHASE_LABELS = {
  status: "Checking what's installed…",
  install: "Downloading & installing components…",
  "write-configs": "Writing configuration…",
  start: "Starting InfluxDB, Telegraf & Grafana…",
  "wait-influx": "Waiting for InfluxDB to come up…",
  onboard: "Initializing InfluxDB…",
  connect: "Connecting telemetry…",
  done: "Done",
};

function renderInstallProgress() {
  const pr = obsProgress;
  const downloading = pr && pr.step === "download" && pr.percent != null;
  const pct = downloading ? Math.max(0, Math.min(100, Math.round(Number(pr.percent)))) : null;
  let detail;
  if (downloading) {
    detail = `Downloading ${pr.component} (${(pr.index ?? 0) + 1}/${pr.total ?? 3}) — ` +
      `${pct}% · ${pr.received}/${pr.size} · ${pr.rate}/s · ETA ${pr.eta}`;
  } else if (pr && pr.step) {
    const verb = { extract: "Extracting", install: "Installing", "already-installed": "Already installed",
      done: "Installed", verify: "Verifying" }[pr.step] || pr.step;
    detail = `${verb} ${pr.component} (${(pr.index ?? 0) + 1}/${pr.total ?? 3})…`;
  } else {
    detail = obsPhase || "Working…";
  }
  const fill = el("div", { class: "progress-fill" });
  fill.style.width = pct != null ? `${pct}%` : "100%";
  if (pct == null) fill.style.opacity = "0.4"; // indeterminate phases
  const bar = el("div", { class: "progress-bar" }, fill);
  bar.style.display = "block";
  return el("section", { class: "plugin-section" },
    el("h3", {}, obsPhase || "Installing…"),
    el("p", { class: "muted small" }, detail),
    bar,
  );
}

function obsStatusPill() {
  if (obsHealthChecking) return { label: "Checking", cls: "pill-muted" };
  if (obsHealth && obsHealth.influxReady && obsSmokeOk(obsHealth.smoke)) return { label: "Live", cls: "pill-running" };
  if (obsHealth && obsHealth.influxReady) return { label: "Partial", cls: "pill-muted" };
  if (obsHealth && obsHealth.influxUp) return { label: "Starting", cls: "pill-muted" };
  const s = telemetry ? telemetry.stats() : null;
  if (s && s.backend && s.degraded) return { label: "Reconnecting", cls: "pill-muted" };
  return { label: "Local", cls: "pill-idle" };
}

function obsSmokeOk(smoke) {
  return !!(smoke && smoke.directWrite && smoke.directQuery && smoke.telegrafWrite && smoke.telegrafQuery);
}

function obsSmokeLabel(smoke) {
  if (!smoke) return "Smoke: unknown";
  if (!smoke.attempted) return `Smoke: skipped${smoke.error ? ` (${smoke.error})` : ""}`;
  if (obsSmokeOk(smoke)) return "Smoke: ok";
  const bits = [
    `Influx write ${smoke.directWrite ? "ok" : "failed"}`,
    `Influx query ${smoke.directQuery ? "ok" : "failed"}`,
    `Telegraf write ${smoke.telegrafWrite ? "ok" : "failed"}`,
    `Telegraf query ${smoke.telegrafQuery ? "ok" : "failed"}`,
  ];
  return `Smoke: partial — ${bits.join(" · ")}${smoke.error ? ` (${smoke.error})` : ""}`;
}

function obsCompactHealthLine() {
  if (obsHealthChecking) return obsHealthMessage || "Checking health…";
  if (!obsHealth) return obsHealthMessage || "Health not checked yet.";
  if (obsHealth.influxReady && obsHealth.grafanaUp && obsSmokeOk(obsHealth.smoke)) {
    return "Live · metrics verified";
  }
  if (obsHealth.influxReady && obsHealth.grafanaUp) {
    return "Partial · metrics smoke needs attention";
  }
  if (obsHealth.influxUp) return "Starting · waiting for readiness";
  return "Offline · buffering locally";
}

async function obsRefreshHealth() {
  if (!pack) return;
  obsHealthChecking = true;
  obsHealthMessage = "Checking health and smoke test…";
  renderAll();
  try {
    obsHealth = await pack.health();
    obsHealthMessage = "";
  } catch (err) {
    obsHealth = null;
    obsHealthMessage = `Health check failed: ${err}`;
  } finally {
    obsHealthChecking = false;
    renderAll();
  }
}

async function obsApplyStartupStatus(status) {
  const obs = status?.observability;
  if (!obs) {
    if (status?.running) {
      obsHealthChecking = true;
      obsHealthMessage = "Checking health and smoke test on startup…";
      return true;
    }
    return false;
  }
  obsHealthChecking = false;
  if (obs.packStatus) obsPack = obs.packStatus;
  if (obs.health) {
    obsHealth = obs.health;
    obsHealthMessage = "";
  }
  if (pack && obs.started && obs.config && obs.health?.influxReady) {
    try {
      await pack.connect(obs.config);
      logTo("observability", "Connected to Observability Pack started during app startup.", "ok");
    } catch (err) {
      logTo("observability", `Pack started, but telemetry attach failed: ${err}`, "warn");
    }
  } else if (obs.skipped && obs.reason && obs.reason !== "Observability Pack is not installed yet") {
    obsHealthMessage = `Startup warmup skipped: ${obs.reason}`;
    logTo("observability", `Startup warmup skipped: ${obs.reason}`, "info");
  } else if (obs.skipped && obs.reason) {
    obsHealthMessage = obs.reason;
  } else if (obs.attempted && !obs.started && obs.reason) {
    obsHealthMessage = `Startup warmup could not start pack: ${obs.reason}`;
    logTo("observability", `Startup warmup could not start pack: ${obs.reason}`, "warn");
  } else if (!obs.health && obs.reason) {
    obsHealthMessage = obs.reason;
  }
  return true;
}

async function obsBringUp() {
  if (!pack || obsBusy) return;
  obsBusy = true; obsPhase = OBS_PHASE_LABELS.status; obsProgress = null; renderAll();
  try {
    logTo("observability", "Bringing up the Observability Pack… (first run downloads ~400 MB)", "info");
    const cfg = await pack.bringUp((s) => {
      obsPhase = OBS_PHASE_LABELS[s] || s;
      if (s !== "install") obsProgress = null; // download detail only during install
      renderAll();
    });
    logTo("observability", `Pack up — InfluxDB :${cfg.influxPort}, Grafana :${cfg.grafanaPort}.`, "ok");
    await obsRefreshHealth();
  } catch (err) {
    logTo("observability", `Bring-up failed: ${err}`, "error");
  } finally {
    // Re-fetch installed versions on success OR failure (a partial update may
    // have changed them), so the version line / Update-available badge is fresh.
    obsPack = null;
    obsBusy = false; obsPhase = ""; obsProgress = null; renderAll();
  }
}

async function obsStop() {
  if (!pack) return;
  try { await pack.stop(); logTo("observability", "Stopped pack services.", "info"); await obsRefreshHealth(); }
  catch (err) { logTo("observability", `Stop failed: ${err}`, "error"); }
}

async function obsWriteConfigs() {
  if (!pack) return;
  try { const dir = await pack.writeConfigs(); logTo("observability", `Wrote pack config files to ${dir}.`, "ok"); }
  catch (err) { logTo("observability", `Could not write configs: ${err}`, "error"); }
}

function renderObservabilityPage() {
  obsEnsurePackStatus();
  const stats = telemetry ? telemetry.stats() : null;
  const recent = telemetry ? telemetry.recent(15) : [];
  const cfg = pack ? pack.getConfig() : null;

  const healthLine = obsHealthChecking
    ? (obsHealthMessage || "Checking health…")
    : obsHealth
      ? `InfluxDB: ${obsHealth.influxReady ? "ready" : obsHealth.influxUp ? "starting" : "down"} · Grafana: ${obsHealth.grafanaUp ? "up" : "down"} · ${obsSmokeLabel(obsHealth.smoke)}`
      : (obsHealthMessage || "Health not checked yet — click Check health.");

  const installLabel = obsBusy ? "Working…"
    : (obsPack && obsPack.updatesAvailable) ? "Update & restart pack"
    : (obsPack && obsPack.installed) ? "Restart pack"
    : "Install & start pack";

  const details = el("details", { class: "obs-details" },
    el("summary", { class: "muted small" }, "Details"),
    el("div", { class: "settings-stack" },
      obsVersionsLine(),
      el("p", { class: "muted small" }, healthLine),
      el("p", { class: "muted small" },
        "Local stack: Telegraf, InfluxDB, and Grafana on 127.0.0.1. Metrics buffer in memory until the pack is live."),
      el("div", { class: "tool-actions" },
        el("button", { class: "btn-ghost", disabled: obsBusy ? "disabled" : undefined, onclick: obsWriteConfigs }, "Write configs"),
      ),
    ),
  );

  const statusCard = el("section", { class: "plugin-section" },
    el("div", { class: "section-head" },
      el("h3", {}, "Observability Pack"),
      el("span", { class: "muted small" }, obsBusy ? (obsPhase || "Working…") : obsCompactHealthLine()),
    ),
    el("div", { class: "tool-actions" },
      el("button", {
        class: "btn btn-primary",
        disabled: obsBusy ? "disabled" : undefined,
        onclick: obsBringUp,
      }, installLabel),
      el("button", { class: "btn-ghost", disabled: obsBusy ? "disabled" : undefined, onclick: obsStop }, "Stop"),
      el("button", { class: "btn-ghost", onclick: obsRefreshHealth }, "Check health"),
      obsHealth && obsHealth.grafanaUp && cfg
        ? el("button", { class: "btn-ghost", onclick: () => openExternal(`http://127.0.0.1:${cfg.grafanaPort}`) }, "Open Grafana")
        : null,
    ),
    details,
  );

  const statRow = (label, val) => el("div", { class: "kv-row" },
    el("span", { class: "muted small" }, label), el("span", {}, String(val)));
  const statsCard = el("section", { class: "plugin-section" },
    el("h3", {}, "Buffer"),
    stats
      ? el("div", { class: "kv-grid" },
          statRow("Recent (ring)", stats.ring),
          statRow("Buffered", stats.buffered),
          statRow("Written", stats.written),
          statRow("Dropped", stats.dropped),
        )
      : el("p", { class: "muted small" }, "Telemetry service not started."),
  );

  const recentCard = el("section", { class: "plugin-section plugin-section-fill" },
    el("div", { class: "section-head" },
      el("h3", {}, "Recent metrics"),
      el("button", { class: "btn-ghost", onclick: () => renderAll() }, "Refresh"),
    ),
    recent.length === 0
      ? el("p", { class: "muted small" }, "No metrics recorded yet. Run a tool (e.g. a network scan) to produce some.")
      : el("ol", { class: "plugin-log scroll-fill" },
          ...recent.slice().reverse().map((p) =>
            el("li", { class: "log-info" },
              el("span", { class: "log-time" }, new Date(p.ts).toLocaleTimeString()),
              el("span", { class: "log-msg" },
                `${p.measurement} ${Object.entries(p.tags).map(([k, v]) => `${k}=${v}`).join(",")} → ${Object.entries(p.fields).map(([k, v]) => `${k}=${v}`).join(", ")}`),
            )),
        ),
  );

  const progressCard = obsBusy ? renderInstallProgress() : null;
  return el("div", { class: "plugin-controls plugin-controls-fill" }, statusCard, progressCard, statsCard, recentCard);
}

// ============================================================================
// BACnet Historian (composed tool page)
// ============================================================================

function historianInstance() {
  return platform ? platform.capability("bacnet.historian.v1") : null;
}

let histIntervalMs = 60000;

function histStatusPill() {
  const hist = historianInstance();
  if (!hist) return { label: "Off", cls: "pill-muted" };
  return hist.isRunning() ? { label: "Logging", cls: "pill-running" } : { label: "Idle", cls: "pill-idle" };
}

// Persist the configured points + run state so unattended logging survives a
// reload/restart (the historian core itself is in-memory only).
function histPersist() {
  const hist = historianInstance();
  if (!hist) return;
  userState.historian = {
    points: hist.points().map((p) => ({
      device: p.device,
      objectType: p.objectType,
      instance: p.instance,
      label: p.label || "",
      site: p.site || "",
      building: p.building || "",
      floor: p.floor || "",
      equip: p.equip || "",
      pointId: p.pointId || "",
    })),
    running: hist.isRunning(),
    intervalMs: histIntervalMs,
  };
  saveUserState();
}

function histSourceRef(point) {
  const device = point?.device || {};
  const deviceInstance = device.deviceInstance ?? device.instance ?? device.id;
  if (deviceInstance == null || point?.objectType == null || point?.instance == null) return "";
  return `bacnet:${Number(deviceInstance)}:${Number(point.objectType)}:${Number(point.instance)}`;
}

function histMetadataChanged(current, next) {
  return ["label", "site", "building", "floor", "equip", "pointId"]
    .some((key) => (current?.[key] || "") !== (next?.[key] || ""));
}

function histSyncFromInventory() {
  const inv = inventoryInstance();
  const hist = historianInstance();
  if (!inv || !hist) return 0;
  let refreshed = 0;
  for (const current of hist.points()) {
    const sourceRef = histSourceRef(current);
    const point = (current.pointId ? inv.getEntity(current.pointId) : null)
      || inv.listEntities({ type: "point", sourceRef })[0];
    if (!point || point.type !== "point") continue;
    try {
      const record = bwHistorianRecordForPoint(inv, point);
      if (!histMetadataChanged(current, record)) continue;
      hist.addPoint(record);
      refreshed++;
    } catch (_) {
      // Keep manual historian records intact.
    }
  }
  return refreshed;
}

function histRestore({ replace = false } = {}) {
  const hist = historianInstance();
  const saved = userState.historian;
  if (!hist) return;
  if (replace) {
    if (hist.isRunning()) hist.stop();
    hist.clearPoints?.();
  }
  if (!saved) return;
  for (const p of saved.points || []) hist.addPoint(p);
  if (saved.intervalMs) histIntervalMs = saved.intervalMs;
  const refreshed = histSyncFromInventory();
  if (refreshed) histPersist();
  if (saved.running && (saved.points || []).length) {
    hist.start(histIntervalMs);
    logTo("bacnet-historian", `Resumed logging ${saved.points.length} point(s).`, "info");
  }
}

function renderHistorianPage() {
  const hist = historianInstance();
  if (!hist) {
    return el("div", { class: "plugin-controls" },
      el("section", { class: "plugin-section" },
        el("p", { class: "muted" }, "Historian unavailable — the platform kernel did not resolve its dependencies.")));
  }
  const synced = histSyncFromInventory();
  if (synced) histPersist();

  // Devices come from the shared BACnet discovery session used by Building Workspace.
  const devices = bac.devices || [];
  let devIdx = devices.length ? "0" : "";
  const objTypeInput = el("input", { type: "number", class: "nm-input bac-range-input", value: "0", title: "Object type (0=AI, 1=AO, 2=AV, …)" });
  const instInput = el("input", { type: "number", class: "nm-input bac-range-input", value: "0" });
  const labelInput = el("input", { type: "text", class: "nm-input", placeholder: "label (optional)" });
  const devSelect = el("select", { class: "nm-input", onchange: (e) => { devIdx = e.target.value; } },
    ...(devices.length
      ? devices.map((d, i) => el("option", { value: String(i) }, bacDeviceLabel(d)))
      : [el("option", { value: "" }, "No devices — discover from Building Workspace first")]));

  const addBtn = el("button", {
    class: "btn",
    disabled: devices.length ? undefined : "disabled",
    onclick: () => {
      const dev = devices[Number(devIdx)];
      if (!dev) return;
      hist.addPoint({
        device: { ...bacDeviceRef(dev), deviceInstance: dev.instance },
        objectType: Number(objTypeInput.value),
        instance: Number(instInput.value),
        label: labelInput.value.trim(),
      });
      logTo("bacnet-historian", `Added device ${dev.instance} point ${objTypeInput.value}:${instInput.value}.`, "ok");
      histPersist();
      renderAll();
    },
  }, "Add point");

  const addCard = el("section", { class: "plugin-section" },
    el("h3", {}, "Add a point"),
    el("p", { class: "muted small" }, "Points are read through the BACnet service from the current discovery session."),
    el("div", { class: "bac-discover-controls" },
      el("label", { class: "nm-field bac-target-field" }, el("span", { class: "nm-field-label" }, "Device"), devSelect),
      el("label", { class: "nm-field" }, el("span", { class: "nm-field-label" }, "Object type"), objTypeInput),
      el("label", { class: "nm-field" }, el("span", { class: "nm-field-label" }, "Instance"), instInput),
      el("label", { class: "nm-field" }, el("span", { class: "nm-field-label" }, "Label"), labelInput),
      addBtn,
    ),
  );

  const intervalInput = el("input", { type: "number", class: "nm-input bac-range-input", value: String(Math.round(histIntervalMs / 1000) || 60), title: "seconds" });
  const running = hist.isRunning();
  const controlCard = el("section", { class: "plugin-section" },
    el("div", { class: "section-head" },
      el("h3", {}, "Logging"),
      el("span", { class: `pill ${running ? "pill-running" : "pill-idle"}` }, running ? "Logging" : "Idle")),
    el("p", { class: "muted small" },
      "Writes present-value to the time-series service. Connect the Observability Pack to chart it in Grafana."),
    el("div", { class: "bac-discover-controls" },
      el("label", { class: "nm-field" }, el("span", { class: "nm-field-label" }, "Interval (s)"), intervalInput),
      el("button", {
        class: "btn btn-primary",
        onclick: () => {
          histIntervalMs = Math.max(5, Number(intervalInput.value) || 60) * 1000;
          hist.start(histIntervalMs);
          logTo("bacnet-historian", "Started logging.", "ok");
          histPersist();
          renderAll();
        },
      }, running ? "Restart" : "Start"),
      running
        ? el("button", { class: "btn-ghost", onclick: () => { hist.stop(); logTo("bacnet-historian", "Stopped logging.", "info"); histPersist(); renderAll(); } }, "Stop")
        : null,
      el("button", {
        class: "btn-ghost",
        onclick: async () => {
          try {
            const r = await hist.pollOnce();
            logTo("bacnet-historian", `Polled — ${r.written} written, ${r.errors} error(s).`, r.errors ? "warn" : "ok");
            renderAll();
          } catch (err) {
            logTo("bacnet-historian", `Poll failed: ${err}`, "error");
          }
        },
      }, "Poll now"),
    ),
  );

  const pts = hist.points();
  const pointsCard = el("section", { class: "plugin-section plugin-section-fill" },
    el("h3", {}, `Points (${pts.length})`),
    pts.length === 0
      ? el("p", { class: "muted small" }, "No points yet — add one above.")
      : el("ol", { class: "plugin-log scroll-fill" },
          ...pts.map((p) =>
            el("li", { class: p.lastError ? "log-error" : "log-info" },
              el("span", { class: "log-msg" },
                `${p.label ? p.label + " · " : ""}dev ${p.device.deviceInstance} ${p.objectType}:${p.instance} → ` +
                `${p.lastError ? "ERR " + p.lastError : (p.lastValue ?? "—")} (${p.reads} reads)`),
              el("button", { class: "btn-ghost", onclick: () => { hist.removePoint(p); histPersist(); renderAll(); } }, "Remove"),
            ))),
  );

  return el("div", { class: "plugin-controls plugin-controls-fill" }, controlCard, addCard, pointsCard);
}

// ============================================================================
// Building Workspace (model → historize → dashboard → commission → report)
// ============================================================================

let bw = bwStateFromUserState();

function bwNormalizeDeviceInboxState(saved = {}) {
  const inbox = saved.deviceInbox && typeof saved.deviceInbox === "object" ? saved.deviceInbox : {};
  const phase = inbox.phase === "modeling" ? "modeling" : "discovery";
  return {
    phase,
    selectedKeys: Array.isArray(inbox.selectedKeys)
      ? inbox.selectedKeys
      : (Array.isArray(saved.deviceInboxSelectedKeys) ? saved.deviceInboxSelectedKeys : []),
    anchorKey: inbox.anchorKey || saved.deviceInboxSelectionAnchorKey || "",
    filter: typeof inbox.filter === "string" ? inbox.filter : (saved.deviceInboxFilter || ""),
    candidates: inbox.candidates && typeof inbox.candidates === "object" && !Array.isArray(inbox.candidates)
      ? inbox.candidates
      : {},
  };
}

function bwStateFromUserState() {
  const saved = userState.buildingWorkspace || {};
  return {
    tab: saved.tab || "model",
    filter: saved.filter || "",
    template: saved.template || "vav",
    selectedSiteId: saved.selectedSiteId || "",
    selectedBuildingId: saved.selectedBuildingId || "",
    selectedFloorId: saved.selectedFloorId || "",
    selectedEntityId: saved.selectedEntityId || "",
    selectedEntityIds: Array.isArray(saved.selectedEntityIds) ? saved.selectedEntityIds : [],
    selectionAnchorId: saved.selectionAnchorId || "",
    collapsedNodeIds: Array.isArray(saved.collapsedNodeIds) ? saved.collapsedNodeIds : [],
    contextMenu: null,
    inboxMenu: null,
    draft: null,
    busy: false,
    lastRunId: saved.lastRunId || null,
    dashboardJson: "",
    floorBatchPattern: "Floor {n}",
    floorBatchStart: "1",
    floorBatchCount: "3",
    deviceInbox: bwNormalizeDeviceInboxState(saved),
    cxMin: "",
    cxMax: "",
    cxNotes: "",
    cxCommand: "",
    cxPriority: "8",
    cxVerify: false,
    cxToggle: false,
  };
}

function bwRestoreState() {
  bw = bwStateFromUserState();
}

function bwSaveState() {
  userState.buildingWorkspace = {
    tab: bw.tab,
    filter: bw.filter,
    template: bw.template,
    selectedSiteId: bw.selectedSiteId,
    selectedBuildingId: bw.selectedBuildingId,
    selectedFloorId: bw.selectedFloorId,
    selectedEntityId: bw.selectedEntityId,
    selectedEntityIds: bw.selectedEntityIds,
    selectionAnchorId: bw.selectionAnchorId,
    collapsedNodeIds: bw.collapsedNodeIds,
    lastRunId: bw.lastRunId,
    deviceInbox: bw.deviceInbox,
  };
  saveUserState();
}

function inventoryInstance() {
  return platform ? platform.capability("inventory.v1") : null;
}

function bwStatusPill() {
  const inv = inventoryInstance();
  if (!inv) return { label: "Off", cls: "pill-muted" };
  const points = inv.listEntities({ type: "point" }).length;
  return points ? { label: `${points} point${points === 1 ? "" : "s"}`, cls: "pill-running" } : { label: "Ready", cls: "pill-idle" };
}

function bwTemplateForName(name) {
  const s = String(name || "").toLowerCase();
  if (s.includes("ahu")) return "ahu";
  if (s.includes("meter") || s.includes("mtr")) return "meter";
  if (s.includes("zone")) return "zone";
  return "vav";
}

function bwNodeCollapsed(id) {
  return bw.collapsedNodeIds.includes(id);
}

function bwSetNodeCollapsed(id, collapsed) {
  const current = new Set(bw.collapsedNodeIds);
  if (collapsed) current.add(id);
  else current.delete(id);
  bw.collapsedNodeIds = [...current];
  bwSaveState();
}

function bwToggleNodeCollapsed(id) {
  bwSetNodeCollapsed(id, !bwNodeCollapsed(id));
  bwRenderModelScope({ tree: true, details: false, header: false });
}

function bwExpandNode(id) {
  if (!id || !bwNodeCollapsed(id)) return;
  bwSetNodeCollapsed(id, false);
}

function bwActiveSite(inv) {
  if (String(bw.selectedSiteId || "").startsWith("__new_")) return null;
  return inv.getEntity(bw.selectedSiteId) || inv.listEntities({ type: "site" })[0] || null;
}

function bwActiveBuilding(inv, siteId) {
  if (String(bw.selectedBuildingId || "").startsWith("__new_")) return null;
  const selected = inv.getEntity(bw.selectedBuildingId);
  if (selected && (!siteId || selected.siteId === siteId)) return selected;
  const buildings = siteId ? inv.listEntities({ type: "building", siteId }) : inv.listEntities({ type: "building" });
  return buildings[0] || null;
}

function bwActiveFloor(inv, buildingId) {
  if (String(bw.selectedFloorId || "").startsWith("__new_")) return null;
  const selected = inv.getEntity(bw.selectedFloorId);
  if (selected && (!buildingId || selected.buildingId === buildingId || selected.parentId === buildingId)) return selected;
  const floors = buildingId ? inv.listEntities({ type: "floor", buildingId }) : inv.listEntities({ type: "floor" });
  return floors[0] || null;
}

function bwEnsureSite(inv) {
  const existing = bwActiveSite(inv);
  if (existing) {
    bw.selectedSiteId = existing.id;
    return existing;
  }
  const site = inv.upsertEntity({
    type: "site",
    name: "Default Site",
    tags: { site: true, haystack: "4" },
  });
  bw.selectedSiteId = site.id;
  return site;
}

function bwEnsureBuilding(inv, site) {
  const existing = bwActiveBuilding(inv, site.id);
  if (existing) {
    bw.selectedBuildingId = existing.id;
    return existing;
  }
  const building = inv.upsertEntity({
    type: "building",
    siteId: site.id,
    parentId: site.id,
    name: "Main Building",
    tags: { building: true },
  });
  bw.selectedBuildingId = building.id;
  return building;
}

function bwEnsureFloor(inv, site, building) {
  const existing = bwActiveFloor(inv, building.id);
  if (existing) {
    bw.selectedFloorId = existing.id;
    return existing;
  }
  const floor = inv.upsertEntity({
    type: "floor",
    siteId: site.id,
    buildingId: building.id,
    parentId: building.id,
    name: "Floor 1",
    tags: { floor: true },
  });
  bw.selectedFloorId = floor.id;
  return floor;
}

function bwEnsureLocation(inv) {
  const site = bwEnsureSite(inv);
  const building = bwEnsureBuilding(inv, site);
  const floor = bwEnsureFloor(inv, site, building);
  bwSaveState();
  return { site, building, floor };
}

function bwPromptName(label, fallback) {
  const value = prompt(label, fallback || "");
  return value == null ? "" : String(value).trim();
}

function bwDefaultName(type) {
  return {
    site: "New Site",
    building: "New Building",
    floor: "New Floor",
    equip: "New Device",
    point: "New Point",
  }[type] || "New Item";
}

function bwFocusDraftName() {
  setTimeout(() => {
    const input = document.querySelector("[data-bw-draft-name='1']");
    if (!input) return;
    input.focus();
    input.select();
  }, 0);
}

function bwStartDraft(type, parentId = "") {
  bw.contextMenu = null;
  bwExpandNode(parentId);
  bw.draft = {
    id: `draft:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    type,
    parentId,
    name: bwDefaultName(type),
  };
  bwRenderModelScope({ tree: true, details: true, header: true });
  bwFocusDraftName();
}

function bwCancelDraft() {
  if (!bw.draft) return;
  bw.draft = null;
  bwRenderModelScope({ tree: true, details: true, header: true });
}

function bwEntityByName(inv, filter, name) {
  const target = String(name || "").trim().toLowerCase();
  return inv.listEntities(filter).find((e) => String(e.name || "").trim().toLowerCase() === target) || null;
}

function bwBacnetDeviceInstance(device) {
  const n = Number(device?.instance ?? device?.deviceInstance);
  return Number.isFinite(n) ? n : null;
}

function bwModeledDeviceForBacnet(inv, device) {
  if (!inv) return null;
  return bwFindModeledDeviceForBacnet(inv.listEntities({ type: "equip" }), device);
}

function bwDeviceEntityFromBacnet({ site, building, floor, device }) {
  const instance = bwBacnetDeviceInstance(device);
  const ref = bacDeviceRef(device);
  return {
    type: "equip",
    siteId: site.id,
    buildingId: building.id,
    floorId: floor.id,
    parentId: floor.id,
    name: device.name || `Device ${instance}`,
    deviceInstance: instance,
    deviceRef: { ...ref, deviceInstance: instance },
    address: device.address || "",
    network: device.network ?? null,
    mac: device.mac ?? null,
    vendorId: device.vendorId ?? null,
    vendorName: device.vendorName || "",
    modelName: device.modelName || "",
    tags: { equip: true, device: true, bacnet: true },
  };
}

function bwFilteredDiscoveredDevices() {
  const q = String(bw.deviceInbox?.filter || "").trim().toLowerCase();
  const devices = bac.devices || [];
  if (!q) return devices;
  return devices.filter((d) =>
    String(d.instance ?? "").includes(q) ||
    (d.name || "").toLowerCase().includes(q) ||
    bacAddressText(d).toLowerCase().includes(q) ||
    bacVendorText(d).toLowerCase().includes(q) ||
    (d.modelName || "").toLowerCase().includes(q));
}

function bwDeviceInboxCandidateList(inv) {
  return bwDeviceInboxCandidates({
    devices: bwFilteredDiscoveredDevices(),
    modeledDevices: inv ? inv.listEntities({ type: "equip" }) : [],
    candidates: bw.deviceInbox?.candidates || {},
  }).filter((c) => c.status !== "ignored");
}

function bwDeviceInboxQueueList(inv) {
  return bwImportPlanItems({
    devices: bac.devices || [],
    modeledDevices: inv ? inv.listEntities({ type: "equip" }) : [],
    candidates: bw.deviceInbox?.candidates || {},
  });
}

function bwInboxSelectionFor(phase) {
  return bw.deviceInbox?.phase === phase ? (bw.deviceInbox.selectedKeys || []) : [];
}

function bwSetInboxSelection(phase, keys, anchorKey = "") {
  bw.deviceInbox.phase = phase;
  bw.deviceInbox.selectedKeys = [...new Set(keys.filter(Boolean))];
  bw.deviceInbox.anchorKey = anchorKey || bw.deviceInbox.selectedKeys.at(-1) || "";
}

function bwSelectInboxCandidate(phase, item, event = null) {
  if (!item || item.selectable === false) return;
  const inv = inventoryInstance();
  const order = (phase === "modeling" ? bwDeviceInboxQueueList(inv) : bwDeviceInboxCandidateList(inv))
    .filter((c) => c.selectable !== false)
    .map((c) => c.key);
  if (!order.includes(item.key)) return;
  const selected = bwInboxSelectionFor(phase);
  if (event?.shiftKey) {
    const anchor = bw.deviceInbox.anchorKey && order.includes(bw.deviceInbox.anchorKey)
      ? bw.deviceInbox.anchorKey
      : (selected.at(-1) || item.key);
    const a = order.indexOf(anchor);
    const b = order.indexOf(item.key);
    bwSetInboxSelection(phase, a >= 0 && b >= 0 ? order.slice(Math.min(a, b), Math.max(a, b) + 1) : [item.key], item.key);
  } else if (event?.ctrlKey || event?.metaKey) {
    const current = new Set(selected);
    if (current.has(item.key)) current.delete(item.key);
    else current.add(item.key);
    bwSetInboxSelection(phase, [...current], item.key);
  } else {
    bwSetInboxSelection(phase, [item.key], item.key);
  }
  bwSaveState();
  bwSyncInboxSelectionUi();
}

function bwOpenInboxMenu(event, phase, item) {
  event.preventDefault();
  event.stopPropagation();
  if (!item || item.selectable === false) return;
  const selected = bwInboxSelectionFor(phase);
  if (bw.deviceInbox.phase !== phase || !selected.includes(item.key)) {
    bwSetInboxSelection(phase, [item.key], item.key);
  }
  bw.inboxMenu = { x: event.clientX, y: event.clientY, phase, key: item.key };
  bwSaveState();
  bwSyncInboxSelectionUi();
  bwRenderInboxMenu();
  bwClampInboxMenu();
}

function bwCloseInboxMenu() {
  if (!bw.inboxMenu) return;
  bw.inboxMenu = null;
  document.querySelector(".bw-inbox-menu")?.remove();
}

function bwClampInboxMenu() {
  setTimeout(() => {
    const menu = document.querySelector(".bw-inbox-menu");
    if (!menu) return;
    const margin = 8;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(margin, Math.min(rect.left, window.innerWidth - rect.width - margin))}px`;
    menu.style.top = `${Math.max(margin, Math.min(rect.top, window.innerHeight - rect.height - margin))}px`;
  }, 0);
}

function bwInboxMenuButton(label, onclick, danger = false) {
  return el("button", {
    class: `bw-menu-item ${danger ? "bw-menu-danger" : ""}`,
    onclick: (e) => {
      e.stopPropagation();
      bw.inboxMenu = null;
      document.querySelector(".bw-inbox-menu")?.remove();
      onclick();
    },
  }, label);
}

function bwInboxContextMenu(inv, floor = null) {
  const menu = bw.inboxMenu;
  if (!menu) return null;
  const selected = bwInboxSelectionFor(menu.phase);
  const selectedCount = selected.length || 1;
  const items = [];
  if (menu.phase === "discovery") {
    items.push(bwInboxMenuButton(`Add ${selectedCount} to Import Plan`, bwQueueSelectedInboxDevices));
    items.push(bwInboxMenuButton(`Ignore ${selectedCount}`, bwIgnoreSelectedInboxDevices, true));
  } else {
    if (floor) items.push(bwInboxMenuButton(selectedCount > 1 ? `Add selected to ${floor.name}` : `Add to ${floor.name}`, () => bwModelQueuedDevicesToFloor(floor.id)));
    items.push(bwInboxMenuButton("Remove from Import Plan", () => bwRemoveQueuedInboxDevices(), true));
  }
  return el("div", {
    class: "bw-context-menu bw-inbox-menu",
    style: `left:${menu.x}px; top:${menu.y}px`,
    onclick: (e) => e.stopPropagation(),
  }, ...items);
}

function bwRenderInboxMenu() {
  document.querySelector(".bw-inbox-menu")?.remove();
  const inv = inventoryInstance();
  if (!inv || !bw.inboxMenu) return;
  const menu = bwInboxContextMenu(inv, bwCurrentFloorForInbox(inv));
  if (menu) document.body.appendChild(menu);
}

function bwEntityContext(inv, entity) {
  if (!entity) return {};
  const equip = entity.type === "equip" ? entity : inv.getEntity(entity.equipId);
  const floor = entity.type === "floor" ? entity : inv.getEntity(entity.floorId || equip?.floorId || equip?.parentId);
  const building = entity.type === "building" ? entity : inv.getEntity(entity.buildingId || floor?.buildingId || floor?.parentId);
  const site = entity.type === "site" ? entity : inv.getEntity(entity.siteId || building?.siteId || building?.parentId);
  return { site, building, floor, equip };
}

function bwTreeEntityOrder(inv) {
  const out = [];
  const pushEquip = (equip) => {
    out.push(equip);
    out.push(...inv.listEntities({ type: "point", equipId: equip.id }));
  };
  for (const site of inv.listEntities({ type: "site" })) {
    out.push(site);
    for (const building of inv.listEntities({ type: "building", siteId: site.id })) {
      out.push(building);
      for (const floor of inv.listEntities({ type: "floor", buildingId: building.id })) {
        out.push(floor);
        for (const equip of inv.listEntities({ type: "equip", floorId: floor.id })) pushEquip(equip);
        out.push(...inv.listEntities({ type: "point", floorId: floor.id }).filter((p) => !p.equipId));
      }
      for (const equip of inv.listEntities({ type: "equip", buildingId: building.id }).filter((e) => !e.floorId)) pushEquip(equip);
      out.push(...inv.listEntities({ type: "point", buildingId: building.id }).filter((p) => !p.floorId && !p.equipId));
    }
    for (const equip of inv.listEntities({ type: "equip", siteId: site.id }).filter((e) => !e.buildingId && !e.floorId)) pushEquip(equip);
    out.push(...inv.listEntities({ type: "point", siteId: site.id }).filter((p) => !p.buildingId && !p.floorId && !p.equipId));
  }
  return out;
}

function bwSetSelection(ids, primaryId = ids.at(-1) || "") {
  const unique = [...new Set(ids.filter(Boolean))];
  bw.selectedEntityIds = unique;
  bw.selectedEntityId = primaryId || unique.at(-1) || "";
}

function bwSelectTreeEntity(entity, event = null) {
  const inv = inventoryInstance();
  if (!inv) return;
  bw.contextMenu = null;
  if (!entity) {
    bwSetSelection([]);
    bw.selectionAnchorId = "";
    bwSaveState();
    bwRenderModelScope({ tree: true, details: true, header: true });
    return;
  }
  if (event?.shiftKey) {
    const order = bwTreeEntityOrder(inv).map((e) => e.id);
    const anchor = bw.selectionAnchorId && order.includes(bw.selectionAnchorId) ? bw.selectionAnchorId : bw.selectedEntityId;
    const a = order.indexOf(anchor);
    const b = order.indexOf(entity.id);
    if (a >= 0 && b >= 0) bwSetSelection(order.slice(Math.min(a, b), Math.max(a, b) + 1), entity.id);
    else bwSetSelection([entity.id], entity.id);
  } else if (event?.ctrlKey || event?.metaKey) {
    const current = new Set(bw.selectedEntityIds);
    if (current.has(entity.id)) current.delete(entity.id);
    else current.add(entity.id);
    bwSetSelection([...current], entity.id);
    bw.selectionAnchorId = entity.id;
  } else {
    bwSetSelection([entity.id], entity.id);
    bw.selectionAnchorId = entity.id;
  }
  const { site, building, floor } = bwEntityContext(inv, entity);
  bw.selectedSiteId = site?.id || "";
  bw.selectedBuildingId = building?.id || "";
  bw.selectedFloorId = floor?.id || "";
  if (entity.type === "site") {
    bw.selectedSiteId = entity.id;
    bw.selectedBuildingId = "";
    bw.selectedFloorId = "";
  } else if (entity.type === "building") {
    bw.selectedBuildingId = entity.id;
    bw.selectedFloorId = "";
  } else if (entity.type === "floor") {
    bw.selectedFloorId = entity.id;
  }
  bwSaveState();
  bwRenderModelScope({ tree: true, details: true, header: true });
}

function bwOpenTreeMenu(event, kind, entityId = "") {
  event.preventDefault();
  event.stopPropagation();
  bw.contextMenu = { x: event.clientX, y: event.clientY, kind, entityId };
  bwRenderTreeMenu();
  bwClampTreeMenu();
}

function bwCloseTreeMenu() {
  if (!bw.contextMenu) return;
  bw.contextMenu = null;
  document.querySelector(".bw-tree-menu")?.remove();
}

function bwClampTreeMenu() {
  setTimeout(() => {
    const menu = document.querySelector(".bw-context-menu");
    if (!menu) return;
    const margin = 8;
    const rect = menu.getBoundingClientRect();
    const left = Math.max(margin, Math.min(rect.left, window.innerWidth - rect.width - margin));
    const top = Math.max(margin, Math.min(rect.top, window.innerHeight - rect.height - margin));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.maxHeight = `${Math.max(140, window.innerHeight - (margin * 2))}px`;
  }, 0);
}

function bwAddSite() {
  bwStartDraft("site");
}

function bwCommitDraft(nameValue) {
  const inv = inventoryInstance();
  const draft = bw.draft;
  if (!inv || !draft) return null;
  const name = String(nameValue || "").trim();
  bw.draft = null;
  if (!name) {
    bwRenderModelScope({ tree: true, details: true, header: true });
    return null;
  }
  let entity = null;
  if (draft.type === "site") {
    entity = inv.upsertEntity({
      type: "site",
      name,
      tags: { site: true, haystack: "4" },
    });
  } else if (draft.type === "building") {
    const site = inv.getEntity(draft.parentId) || bwEnsureSite(inv);
    entity = inv.upsertEntity({
      type: "building",
      siteId: site.id,
      parentId: site.id,
      name,
      tags: { building: true },
    });
  } else if (draft.type === "floor") {
    const building = inv.getEntity(draft.parentId);
    if (!building) {
      bwRenderModelScope({ tree: true, details: true, header: true });
      return null;
    }
    const site = inv.getEntity(building.siteId || building.parentId);
    entity = inv.upsertEntity({
      type: "floor",
      siteId: site?.id || building.siteId,
      buildingId: building.id,
      parentId: building.id,
      name,
      tags: { floor: true },
    });
  } else if (draft.type === "equip") {
    const floor = inv.getEntity(draft.parentId);
    if (!floor) {
      bwRenderModelScope({ tree: true, details: true, header: true });
      return null;
    }
    const building = inv.getEntity(floor.buildingId || floor.parentId);
    entity = inv.upsertEntity({
      type: "equip",
      siteId: floor.siteId || building?.siteId,
      buildingId: building?.id || floor.buildingId,
      floorId: floor.id,
      parentId: floor.id,
      name,
      tags: { equip: true, device: true },
    });
  } else if (draft.type === "point") {
    const parent = inv.getEntity(draft.parentId);
    if (!parent) {
      bwRenderModelScope({ tree: true, details: true, header: true });
      return null;
    }
    const ctx = bwEntityContext(inv, parent);
    const floor = parent.type === "floor" ? parent : ctx.floor;
    const equip = parent.type === "equip" ? parent : ctx.equip;
    entity = inv.upsertEntity({
      type: "point",
      siteId: ctx.site?.id || parent.siteId,
      buildingId: ctx.building?.id || parent.buildingId,
      floorId: floor?.id || parent.floorId,
      equipId: equip?.id || "",
      parentId: equip?.id || floor?.id,
      name,
      tags: { point: true },
    });
  }
  if (!entity) {
    bwRenderModelScope({ tree: true, details: true, header: true });
    return null;
  }
  logTo("building-workspace", `Added ${bwTreeNodeLabel(entity).toLowerCase()} ${entity.name}.`, "ok");
  bwSelectTreeEntity(entity);
  return entity;
}

function bwAddBuilding(siteId) {
  bwStartDraft("building", siteId);
}

function bwAddFloor(buildingId) {
  bwStartDraft("floor", buildingId);
}

function bwBatchFloorName(pattern, n) {
  const p = String(pattern || "").trim() || "Floor {n}";
  return /(\{n\}|#)/.test(p) ? p.replace(/\{n\}|#/g, String(n)) : `${p} ${n}`;
}

function bwBatchFloorNumber(startText, offset) {
  const raw = String(startText || "").trim();
  const n = Number.parseInt(raw, 10) + offset;
  if (!Number.isFinite(n)) return "";
  const width = /^\d+$/.test(raw) && raw.length > 1 && raw.startsWith("0") ? raw.length : 0;
  return width ? String(n).padStart(width, "0") : String(n);
}

function bwFocusBatchFloors() {
  setTimeout(() => {
    const input = document.querySelector("[data-bw-floor-batch-pattern='1']");
    if (!input) return;
    input.focus();
    input.select();
  }, 0);
}

function bwPrepareBatchFloors(building) {
  const inv = inventoryInstance();
  const floors = inv && building ? inv.listEntities({ type: "floor", buildingId: building.id }) : [];
  bw.floorBatchStart = String(floors.length + 1);
  bwSelectTreeEntity(building);
  bwFocusBatchFloors();
}

function bwBatchAddFloors(buildingId) {
  const inv = inventoryInstance();
  const building = inv && inv.getEntity(buildingId);
  if (!inv || !building) return;
  const site = inv.getEntity(building.siteId || building.parentId);
  const startText = String(bw.floorBatchStart || "").trim();
  const start = Number.parseInt(startText, 10);
  const count = Number.parseInt(bw.floorBatchCount, 10);
  if (!Number.isFinite(start) || !Number.isFinite(count) || count < 1) {
    logTo("building-workspace", "Batch floors need a valid start number and count.", "warn");
    bwRenderModelScope({ tree: true, details: true });
    return;
  }
  const total = Math.min(count, 200);
  const created = [];
  const skipped = [];
  for (let i = 0; i < total; i++) {
    const n = bwBatchFloorNumber(startText, i);
    const name = bwBatchFloorName(bw.floorBatchPattern, n);
    if (bwEntityByName(inv, { type: "floor", buildingId: building.id }, name)) {
      skipped.push(name);
      continue;
    }
    created.push(inv.upsertEntity({
      type: "floor",
      siteId: site?.id || building.siteId,
      buildingId: building.id,
      parentId: building.id,
      name,
      tags: { floor: true },
    }));
  }
  if (created.length) {
    const last = created.at(-1);
    bwSetSelection([last.id], last.id);
    bw.selectionAnchorId = last.id;
    bw.selectedSiteId = last.siteId || "";
    bw.selectedBuildingId = building.id;
    bw.selectedFloorId = last.id;
    bwSaveState();
  }
  const skippedMsg = skipped.length ? ` Skipped ${skipped.length} duplicate${skipped.length === 1 ? "" : "s"}.` : "";
  logTo("building-workspace", `Added ${created.length} floor${created.length === 1 ? "" : "s"} to ${building.name}.${skippedMsg}`, created.length ? "ok" : "warn");
  bwRenderModelScope({ tree: true, details: true, header: true });
}

function bwSyncInboxSelectionUi() {
  const selected = new Set(bw.deviceInbox?.selectedKeys || []);
  const phase = bw.deviceInbox?.phase || "discovery";
  document.querySelectorAll("[data-bw-inbox-key]").forEach((row) => {
    const on = row.dataset.bwInboxPhase === phase && selected.has(row.dataset.bwInboxKey);
    row.classList.toggle("bw-inbox-row-selected", on);
    row.setAttribute("aria-selected", on ? "true" : "false");
  });
  const queue = document.getElementById("bw-inbox-queue-selected");
  if (queue) queue.disabled = phase !== "discovery" || selected.size === 0;
  const ignore = document.getElementById("bw-inbox-ignore-selected");
  if (ignore) ignore.disabled = phase !== "discovery" || selected.size === 0;
  const remove = document.getElementById("bw-inbox-remove-queued");
  if (remove) remove.disabled = phase !== "modeling" || selected.size === 0;
  const add = document.getElementById("bw-inbox-model-selected");
  if (add) add.disabled = !add.dataset.floorId || Number(add.dataset.queuedCount || 0) === 0;
}

function bwApplyDeviceInboxFilter() {
  bwSaveState();
  const inv = inventoryInstance();
  const body = document.getElementById("bw-discovered-device-rows");
  if (!inv || !body) return;
  body.replaceChildren(...bwDiscoveredDeviceRows(inv));
  bwSyncInboxSelectionUi();
}

function bwDiscoveryDragAttrs(item, canDrag) {
  if (!canDrag) return {};
  return {
    draggable: "true",
    title: "Drag to Import Plan",
    ondragstart: (e) => bwDragDiscoveryDevices(item, e),
    ondragend: () => { bwInboxDragKeys = []; },
  };
}

function bwQueueSelectedInboxDevices() {
  const inv = inventoryInstance();
  if (!inv) return;
  const selected = bwInboxSelectionFor("discovery");
  const floor = bwCurrentFloorForInbox(inv);
  bw.deviceInbox.candidates = bwQueueInboxDevices({
    candidates: bw.deviceInbox.candidates || {},
    keys: selected,
    devices: bac.devices || [],
    modeledDevices: inv.listEntities({ type: "equip" }),
    targetFloorId: floor?.id || "",
  });
  const queued = selected.filter((key) => bw.deviceInbox.candidates[key]?.status === "queued");
  bwSetInboxSelection("modeling", queued, queued.at(-1) || "");
  logTo("building-workspace", `Queued ${queued.length} device${queued.length === 1 ? "" : "s"} for modeling.`, queued.length ? "ok" : "warn");
  bwSaveState();
  bwRenderInboxScope();
}

let bwInboxDragKeys = [];

function bwDragDiscoveryDevices(item, event) {
  const selected = bwInboxSelectionFor("discovery");
  const keys = bw.deviceInbox.phase === "discovery" && selected.includes(item.key) ? selected : [item.key];
  bwSetInboxSelection("discovery", keys, item.key);
  bw.inboxMenu = null;
  bwInboxDragKeys = keys;
  event.stopPropagation();
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData("application/x-stier-bacnet-device-keys", JSON.stringify(keys));
  event.dataTransfer.setData("text/plain", keys.join(","));
  bwSyncInboxSelectionUi();
}

function bwImportPlanDragOver(event) {
  const types = Array.from(event.dataTransfer.types || []);
  if (!bwInboxDragKeys.length && !types.includes("application/x-stier-bacnet-device-keys") && !types.includes("text/plain")) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  event.currentTarget.classList.add("bw-import-plan-drop");
}

function bwImportPlanDragLeave(event) {
  event.currentTarget.classList.remove("bw-import-plan-drop");
}

function bwImportPlanDrop(event) {
  event.preventDefault();
  event.currentTarget.classList.remove("bw-import-plan-drop");
  const raw = event.dataTransfer.getData("application/x-stier-bacnet-device-keys");
  try {
    const keys = raw ? JSON.parse(raw) : bwInboxDragKeys;
    if (Array.isArray(keys) && keys.length) {
      bwSetInboxSelection("discovery", keys, keys.at(-1));
      bwQueueSelectedInboxDevices();
    }
  } catch (_) {
    // Ignore malformed drag payloads from outside the app.
  } finally {
    bwInboxDragKeys = [];
  }
}

function bwIgnoreSelectedInboxDevices() {
  const selected = bwInboxSelectionFor("discovery");
  if (!selected.length) return;
  const next = { ...(bw.deviceInbox.candidates || {}) };
  for (const key of selected) {
    next[key] = {
      ...(next[key] || {}),
      key,
      status: "ignored",
      discoveredAt: next[key]?.discoveredAt || new Date().toISOString(),
    };
  }
  bw.deviceInbox.candidates = next;
  bwSetInboxSelection("discovery", []);
  bwSaveState();
  bwRenderInboxScope();
}

function bwRemoveQueuedInboxDevices(keys = bwInboxSelectionFor("modeling")) {
  bw.deviceInbox.candidates = bwRemoveQueuedDevices(bw.deviceInbox.candidates || {}, keys);
  bwSetInboxSelection("modeling", []);
  bwSaveState();
  bwRenderInboxScope();
}

function bwClearDeviceDiscovery() {
  bac.devices = [];
  bac.discoveryRan = false;
  bac.lastDiscoveryCount = null;
  bw.deviceInbox.candidates = {};
  bwSetInboxSelection("discovery", []);
  bwSaveState();
  bwRenderInboxScope();
}

function bwModelQueuedDevicesToFloor(floorId, keys = null) {
  const inv = inventoryInstance();
  const floor = inv && inv.getEntity(floorId);
  if (!inv || !floor) return;
  const building = inv.getEntity(floor.buildingId || floor.parentId);
  const site = inv.getEntity(floor.siteId || building?.siteId);
  if (!site || !building) return;
  const selectedKeys = Array.isArray(keys)
    ? keys
    : (bw.deviceInbox.phase === "modeling" ? bwInboxSelectionFor("modeling") : []);
  const modelKeys = selectedKeys.length
    ? selectedKeys
    : Object.values(bw.deviceInbox.candidates || {}).filter((c) => c?.status === "queued").map((c) => c.key);
  const result = bwModelQueuedDevices({
    inventory: inv,
    devices: bac.devices || [],
    candidates: bw.deviceInbox.candidates || {},
    floor,
    site,
    building,
    makeEntity: bwDeviceEntityFromBacnet,
    keys: modelKeys,
  });
  bw.deviceInbox.candidates = result.candidates;
  const imported = result.imported || [];
  if (imported.length) {
    bwSetSelection(imported.map((d) => d.id), imported.at(-1).id);
    bw.selectionAnchorId = imported.at(-1).id;
    bw.selectedSiteId = site.id;
    bw.selectedBuildingId = building.id;
    bw.selectedFloorId = floor.id;
  }
  bwSetInboxSelection("modeling", []);
  bwSaveState();
  logTo("building-workspace",
    `Added ${imported.length} queued device${imported.length === 1 ? "" : "s"} to ${floor.name}.${result.skipped ? ` Skipped ${result.skipped}.` : ""}`,
    imported.length ? "ok" : "warn");
  bwRenderInboxScope();
}

function bwImportDiscoveredDevicesToFloor(floorId, keys = null) {
  const inv = inventoryInstance();
  if (!inv) return;
  const importKeys = Array.isArray(keys) && keys.length ? keys : bwInboxSelectionFor("discovery");
  bw.deviceInbox.candidates = bwQueueInboxDevices({
    candidates: bw.deviceInbox.candidates || {},
    keys: importKeys,
    devices: bac.devices || [],
    modeledDevices: inv.listEntities({ type: "equip" }),
    targetFloorId: floorId,
  });
  bwModelQueuedDevicesToFloor(floorId, importKeys);
}

// State for the Building Workspace "Discover & import points" review modal.
let bwPointImport = null;

async function bwDiscoverDevicePoints(equipId) {
  const inv = inventoryInstance();
  const equip = inv && inv.getEntity(equipId);
  if (!inv || !equip) return;
  const site = inv.getEntity(equip.siteId);
  const building = inv.getEntity(equip.buildingId);
  const floor = inv.getEntity(equip.floorId || equip.parentId);
  const deviceRef = equip.deviceRef || { deviceInstance: equip.deviceInstance };
  const deviceInstance = Number(equip.deviceInstance ?? deviceRef.deviceInstance ?? deviceRef.instance);
  if (!Number.isFinite(deviceInstance)) {
    logTo("building-workspace", `${equip.name} is missing a BACnet device instance.`, "warn");
    return;
  }
  bw.busy = true;
  bwRenderModelScope({ details: true });
  try {
    const bacnet = platform ? platform.capability("bacnet.read.v1") : bacnetRead();
    const objects = (await bacnet.listObjects(deviceRef, deviceInstance)) || [];
    const device = { ...deviceRef, instance: deviceInstance, deviceInstance };
    // Pre-skip objects already modeled as points under this equip.
    const existing = new Set(
      inv.listEntities({ type: "point", equipId: equip.id }).flatMap((p) => p.sourceRefs || []),
    );
    const refOf = (o) => `bacnet:${deviceInstance}:${o.objectType}:${o.instance}`;
    bwPointImport = {
      equip, site, building, floor, device, objects, existing,
      selection: new Set(objects.filter((o) => !existing.has(refOf(o))).map((o) => `${o.objectType}:${o.instance}`)),
      q: "", typeFilter: new Set(), typesOpen: false, min: "", max: "", template: "",
    };
    if (!objects.length) {
      logTo("building-workspace", `No objects returned from ${equip.name}.`, "warn");
    }
    bwOpenPointImportModal();
  } catch (err) {
    logTo("building-workspace", `Point discovery failed for ${equip.name}: ${err}`, "error");
  } finally {
    bw.busy = false;
    bwRenderModelScope({ tree: true, details: true, header: true });
  }
}

function bwPointImportRefOf(o) {
  return `bacnet:${bwPointImport.device.deviceInstance}:${o.objectType}:${o.instance}`;
}

function bwPointImportFiltered() {
  const s = bwPointImport;
  return s.objects.filter((o) => bacObjectMatches(o, { q: s.q, types: s.typeFilter, min: s.min, max: s.max }));
}

function bwOpenPointImportModal() {
  const s = bwPointImport;
  if (!s) return;
  openModal({ title: `Discover & import points — ${s.equip.name}`, body: bwPointImportBody() });
}

function bwPointImportBody() {
  const s = bwPointImport;
  return el("div", { class: "bw-import" },
    el("p", { class: "muted small" },
      `${s.objects.length} object${s.objects.length === 1 ? "" : "s"} on device ${s.device.deviceInstance}. `
      + `Importing into ${s.floor?.name || "this floor"} under ${s.equip.name}. Already-modeled objects start unticked.`),
    bwPointImportToolbar(),
    el("div", { class: "bw-import-listwrap" },
      el("ul", { id: "bw-import-list", class: "bac-object-list" }, ...bwPointImportRows())),
    bwPointImportFooter(),
  );
}

function bwPointImportToolbar() {
  const s = bwPointImport;
  const types = [...new Set(s.objects.map((o) => o.typeName))].sort((a, b) => String(a).localeCompare(String(b)));
  return el("div", { class: "bac-object-toolbar" },
    el("input", {
      type: "search", class: "nm-input bac-object-filter", placeholder: "Filter objects…",
      "aria-label": "Filter objects", value: s.q,
      oninput: (e) => { s.q = e.target.value; bwPointImportRefresh(); },
    }),
    el("div", { class: "bac-object-range" },
      el("span", { class: "muted small" }, "Instance"),
      el("input", { type: "number", class: "nm-input bac-range-input", placeholder: "min", "aria-label": "Minimum instance", value: s.min, oninput: (e) => { s.min = e.target.value; bwPointImportRefresh(); } }),
      el("span", { class: "muted small" }, "–"),
      el("input", { type: "number", class: "nm-input bac-range-input", placeholder: "max", "aria-label": "Maximum instance", value: s.max, oninput: (e) => { s.max = e.target.value; bwPointImportRefresh(); } }),
    ),
    types.length
      ? el("details", {
          class: "bac-type-filter", open: s.typesOpen ? "open" : undefined,
          ontoggle: (e) => { s.typesOpen = e.target.open; },
        },
          el("summary", {}, `Types${s.typeFilter.size ? ` (${s.typeFilter.size})` : ""}`),
          el("div", { class: "bac-type-chips" }, ...types.map((t) => {
            const on = s.typeFilter.has(t);
            return el("button", {
              type: "button", class: `bac-type-chip${on ? " bac-type-chip-on" : ""}`,
              onclick: () => { if (s.typeFilter.has(t)) s.typeFilter.delete(t); else s.typeFilter.add(t); bwOpenPointImportModal(); },
            }, t);
          })),
        )
      : null,
  );
}

function bwPointImportRows() {
  const s = bwPointImport;
  const objects = bwPointImportFiltered();
  if (!objects.length) {
    return [el("li", { class: "muted small bac-object-empty" }, s.objects.length ? "No objects match the filter." : "No objects on this device.")];
  }
  const sorted = [...objects].sort((a, b) =>
    String(a.typeName).localeCompare(String(b.typeName)) || Number(a.instance) - Number(b.instance));
  const countByType = sorted.reduce((m, o) => m.set(o.typeName, (m.get(o.typeName) || 0) + 1), new Map());
  const rows = [];
  let lastType = null;
  for (const o of sorted) {
    if (o.typeName !== lastType) {
      lastType = o.typeName;
      rows.push(el("li", { class: "bac-object-group", role: "presentation" },
        el("span", {}, lastType), el("span", { class: "muted small" }, String(countByType.get(lastType)))));
    }
    const key = `${o.objectType}:${o.instance}`;
    const checked = s.selection.has(key);
    const already = s.existing.has(bwPointImportRefOf(o));
    rows.push(el("li", { class: `bac-object-row bw-import-row${checked ? " bac-object-checked" : ""}` },
      el("input", {
        type: "checkbox", class: "bac-object-check", checked: checked ? "checked" : undefined,
        "aria-label": `Import ${o.typeName}:${o.instance}`,
        onclick: (e) => { if (e.target.checked) s.selection.add(key); else s.selection.delete(key); bwPointImportRefresh(); },
      }),
      el("span", { class: "bac-object-type" }, `${o.typeName}:${o.instance}`),
      el("span", { class: "bac-object-name" }, o.name || "", already ? el("span", { class: "muted small bw-import-already" }, " · modeled") : null),
    ));
  }
  return rows;
}

function bwPointImportFooter() {
  const s = bwPointImport;
  const n = s.selection.size;
  const visible = bwPointImportFiltered();
  return el("div", { id: "bw-import-footer", class: "bw-import-footer" },
    el("input", {
      type: "text", class: "nm-input bac-name-template",
      placeholder: "Name template (optional), e.g. {equip}-{type}{instance}",
      title: "Tokens: {equip} {type} {instance} {name}. Blank keeps each object's own name.",
      "aria-label": "Point name template", value: s.template,
      oninput: (e) => { s.template = e.target.value; },
    }),
    el("button", { type: "button", class: "btn-ghost", onclick: () => { for (const o of visible) s.selection.add(`${o.objectType}:${o.instance}`); bwPointImportRefresh(); } }, `Select all (${visible.length})`),
    el("button", { type: "button", class: "btn-ghost", onclick: () => { s.selection.clear(); bwPointImportRefresh(); } }, "Select none"),
    el("button", {
      type: "button", class: "btn bac-bulk-import", disabled: n ? undefined : "disabled",
      onclick: bwImportSelectedPoints,
    }, n ? `Import ${n} point${n === 1 ? "" : "s"}` : "Import points"),
  );
}

function bwPointImportRefresh() {
  const list = document.getElementById("bw-import-list");
  if (list) list.replaceChildren(...bwPointImportRows());
  const footer = document.getElementById("bw-import-footer");
  if (footer) footer.replaceWith(bwPointImportFooter());
}

function bwImportSelectedPoints() {
  const s = bwPointImport;
  const inv = inventoryInstance();
  if (!s || !inv) return;
  const chosen = s.objects.filter((o) => s.selection.has(`${o.objectType}:${o.instance}`));
  if (!chosen.length) { toast("Select one or more objects first.", "warn"); return; }
  // Every object belongs to this one device → model all points under the selected equip.
  const plan = bwPlanDeviceObjects({ device: s.device, objects: chosen, template: s.template });
  const points = bwModelObjectsBatch({
    siteId: s.equip.siteId, buildingId: s.equip.buildingId,
    floorId: s.equip.floorId || s.equip.parentId, device: s.device, items: plan.items,
  }).map((p) => ({ ...p, equipId: s.equip.id }));
  const saved = inv.upsertMany(points);
  bwSaveState();
  closeModal();
  logTo("building-workspace", `Imported ${saved.length} point${saved.length === 1 ? "" : "s"} into ${s.equip.name}.`, "ok");
  toast(`Imported ${saved.length} point${saved.length === 1 ? "" : "s"} into ${s.equip.name}.`, "ok");
  const refreshed = bwRefreshHistorianForEntity(inv, inv.getEntity(s.equip.id) || s.equip);
  if (refreshed) histPersist();
  bwSelectTreeEntity(inv.getEntity(s.equip.id) || s.equip);
}

function bwAddDevice(floorId) {
  bwStartDraft("equip", floorId);
}

function bwAddPoint(parentId) {
  bwStartDraft("point", parentId);
}

function bwRenameEntity(entityId) {
  const inv = inventoryInstance();
  const entity = inv && inv.getEntity(entityId);
  if (!entity) return;
  const name = bwPromptName(`${entity.type[0].toUpperCase() + entity.type.slice(1)} name`, entity.name);
  if (!name) return;
  const renamed = inv.upsertEntity({ ...entity, name });
  const refreshed = bwRefreshHistorianForEntity(inv, renamed);
  logTo("building-workspace", `Renamed ${entity.type} to ${renamed.name}${refreshed ? ` and refreshed ${refreshed} historian point${refreshed === 1 ? "" : "s"}` : ""}.`, "ok");
  bwSelectTreeEntity(renamed);
}

function bwAffectedPoints(inv, entity) {
  if (!entity) return [];
  if (entity.type === "point") return [entity];
  if (entity.type === "site") return inv.listEntities({ type: "point", siteId: entity.id });
  if (entity.type === "building") return inv.listEntities({ type: "point", buildingId: entity.id });
  if (entity.type === "floor") return inv.listEntities({ type: "point", floorId: entity.id });
  if (entity.type === "equip") return inv.listEntities({ type: "point", equipId: entity.id });
  return [];
}

function bwHistorianKey(point) {
  const device = point.device || {};
  return `${device.deviceInstance ?? device.instance ?? device.id ?? "?"}:${point.objectType}:${point.instance}`;
}

function bwHistorianRecordForPoint(inv, point) {
  const site = inv.getEntity(point.siteId);
  const building = inv.getEntity(point.buildingId);
  const floor = inv.getEntity(point.floorId);
  const equip = inv.getEntity(point.equipId);
  return historianPointFromEntity(point, { site, building, floor, equip });
}

function bwRefreshHistorianForEntity(inv, entity) {
  const hist = historianInstance();
  if (!hist) return 0;
  const tracked = new Set(hist.points().map(bwHistorianKey));
  let refreshed = 0;
  for (const point of bwAffectedPoints(inv, entity)) {
    try {
      const record = bwHistorianRecordForPoint(inv, point);
      if (!tracked.has(bwHistorianKey(record))) continue;
      hist.addPoint(record);
      refreshed++;
    } catch (_) {
      // Manual/unbound points do not have BACnet historian records yet.
    }
  }
  if (refreshed) histPersist();
  return refreshed;
}

function bwDescendantIds(inv, entity) {
  if (!entity) return [];
  const entities = inv.listEntities();
  const directChildren = (parent) => entities.filter((e) =>
    e.parentId === parent.id ||
    (parent.type === "site" && e.siteId === parent.id && e.id !== parent.id) ||
    (parent.type === "building" && e.buildingId === parent.id && e.id !== parent.id) ||
    (parent.type === "floor" && e.floorId === parent.id && e.id !== parent.id) ||
    (parent.type === "equip" && e.equipId === parent.id && e.id !== parent.id));
  const out = [];
  const visit = (parent) => {
    for (const child of directChildren(parent)) {
      if (out.includes(child.id)) continue;
      out.push(child.id);
      visit(child);
    }
  };
  visit(entity);
  return out;
}

function bwRemoveEntityTree(entityId) {
  const inv = inventoryInstance();
  const entity = inv && inv.getEntity(entityId);
  if (!entity) return;
  const ids = [...bwDescendantIds(inv, entity).reverse(), entity.id];
  if (!confirm(`Remove ${entity.name} and ${ids.length - 1} descendant item(s)?`)) return;
  for (const id of ids) inv.removeEntity(id);
  bwSetSelection([]);
  bw.selectionAnchorId = "";
  logTo("building-workspace", `Removed ${entity.name}.`, "warn");
  bwRenderModelScope({ tree: true, details: true, header: true });
}

function bwHistorizeEquipPoints(equipId) {
  const inv = inventoryInstance();
  if (!inv) return;
  const points = inv.listEntities({ type: "point", equipId });
  points.forEach((p) => bwHistorizePoint(p.id));
}

function bwPointsForEntities(inv, entities) {
  const points = new Map();
  const add = (rows) => rows.forEach((p) => points.set(p.id, p));
  for (const entity of entities) {
    if (entity.type === "point") points.set(entity.id, entity);
    else if (entity.type === "equip") add(inv.listEntities({ type: "point", equipId: entity.id }));
    else if (entity.type === "floor") add(inv.listEntities({ type: "point", floorId: entity.id }));
    else if (entity.type === "building") add(inv.listEntities({ type: "point", buildingId: entity.id }));
    else if (entity.type === "site") add(inv.listEntities({ type: "point", siteId: entity.id }));
  }
  return [...points.values()];
}

function bwHistorizeSelectedEntities() {
  const inv = inventoryInstance();
  if (!inv) return;
  const points = bwPointsForEntities(inv, bwSelectedEntities(inv));
  points.forEach((p) => bwHistorizePoint(p.id));
  if (!points.length) {
    logTo("building-workspace", "Selection has no points to historize.", "warn");
    bwRenderModelScope({ details: true });
  }
}

function bwApplyTemplateToSelected(templateId = bw.template) {
  const inv = inventoryInstance();
  if (!inv) return;
  const devices = bwSelectedEntities(inv).filter((e) => e.type === "equip");
  for (const device of devices) inv.applyTemplate(device.id, templateId);
  logTo("building-workspace", devices.length
    ? `Applied ${templateId} template to ${devices.length} device${devices.length === 1 ? "" : "s"}.`
    : "Selection has no devices to template.",
    devices.length ? "ok" : "warn");
  bwRenderModelScope({ tree: true, details: true });
}

function bwRemoveSelectedEntities() {
  const inv = inventoryInstance();
  if (!inv) return;
  const selected = bwSelectedEntities(inv);
  if (!selected.length) return;
  const ids = new Set();
  for (const entity of selected) {
    ids.add(entity.id);
    for (const id of bwDescendantIds(inv, entity)) ids.add(id);
  }
  if (!confirm(`Remove ${selected.length} selected item(s) and ${ids.size - selected.length} descendant item(s)?`)) return;
  for (const id of [...ids].reverse()) inv.removeEntity(id);
  bwSetSelection([]);
  bw.selectionAnchorId = "";
  logTo("building-workspace", `Removed ${ids.size} model item${ids.size === 1 ? "" : "s"}.`, "warn");
  bwRenderModelScope({ tree: true, details: true, header: true });
}

function bwTreeNodeLabel(entity) {
  if (!entity) return "Model";
  if (entity.type === "equip") return entity.tags?.device ? "Device" : "Equipment";
  return entity.type[0].toUpperCase() + entity.type.slice(1);
}

function bwDraftBelongs(type, parentId = "") {
  return bw.draft && bw.draft.type === type && (bw.draft.parentId || "") === (parentId || "");
}

function bwDraftNode(type, depth, parentId = "") {
  const draft = bwDraftBelongs(type, parentId) ? bw.draft : null;
  if (!draft) return null;
  const onCommit = (input) => bwCommitDraft(input.value);
  return el("li", { class: "bw-tree-item" },
    el("div", {
      class: "bw-tree-node bw-tree-node-on bw-tree-draft-node",
      style: `--depth:${depth}`,
      onclick: (e) => e.stopPropagation(),
      oncontextmenu: (e) => e.preventDefault(),
    },
      el("span", { class: "bw-tree-toggle bw-tree-toggle-empty", "aria-hidden": "true" }),
      el("span", { class: `bw-tree-kind bw-tree-kind-${type}` }, bwTreeNodeLabel({ type, tags: type === "equip" ? { device: true } : {} })[0]),
      el("input", {
        class: "bw-tree-name-input",
        value: draft.name,
        "data-bw-draft-name": "1",
        onkeydown: (e) => {
          if (e.key === "Enter") onCommit(e.currentTarget);
          if (e.key === "Escape") bwCancelDraft();
        },
        onblur: (e) => onCommit(e.currentTarget),
      })));
}

function bwTreeNode(inv, entity, depth, children = []) {
  const selected = bw.selectedEntityIds.includes(entity.id) || bw.selectedEntityId === entity.id;
  const primary = bw.selectedEntityId === entity.id;
  const hasChildren = children.length > 0;
  const collapsed = hasChildren && bwNodeCollapsed(entity.id);
  return el("li", { class: "bw-tree-item" },
    el("button", {
      class: `bw-tree-node ${selected ? "bw-tree-node-on" : ""} ${selected && !primary ? "bw-tree-node-multi" : ""}`,
      style: `--depth:${depth}`,
      title: entity.id,
      onclick: (e) => { e.stopPropagation(); bwSelectTreeEntity(entity, e); },
      oncontextmenu: (e) => bwOpenTreeMenu(e, entity.type, entity.id),
    },
      hasChildren
        ? el("span", {
            class: `bw-tree-toggle ${collapsed ? "" : "bw-tree-toggle-open"}`,
            role: "button",
            "aria-label": collapsed ? `Expand ${entity.name || entity.id}` : `Collapse ${entity.name || entity.id}`,
            "aria-expanded": collapsed ? "false" : "true",
            onclick: (e) => { e.stopPropagation(); bwToggleNodeCollapsed(entity.id); },
          }, "›")
        : el("span", { class: "bw-tree-toggle bw-tree-toggle-empty", "aria-hidden": "true" }),
      el("span", { class: `bw-tree-kind bw-tree-kind-${entity.type}` }, bwTreeNodeLabel(entity)[0]),
      el("span", { class: "bw-tree-name" }, entity.name || entity.id),
      entity.type === "point" && !(entity.sourceRefs || []).length ? el("span", { class: "bw-tree-meta" }, "manual") : null),
    hasChildren && !collapsed ? el("ol", { class: "bw-tree-list" }, ...children) : null);
}

function bwTreePanel(inv) {
  const sites = inv.listEntities({ type: "site" });
  const childrenForSite = (site) => {
    const buildings = inv.listEntities({ type: "building", siteId: site.id });
    const legacyEquips = inv.listEntities({ type: "equip", siteId: site.id }).filter((e) => !e.buildingId && !e.floorId);
    const legacyPoints = inv.listEntities({ type: "point", siteId: site.id }).filter((p) => !p.buildingId && !p.floorId && !p.equipId);
    return [
      ...buildings.map((building) => {
        const floors = inv.listEntities({ type: "floor", buildingId: building.id });
        const buildingEquips = inv.listEntities({ type: "equip", buildingId: building.id }).filter((e) => !e.floorId);
        const buildingPoints = inv.listEntities({ type: "point", buildingId: building.id }).filter((p) => !p.floorId && !p.equipId);
        return bwTreeNode(inv, building, 1, [
          ...floors.map((floor) => {
            const equips = inv.listEntities({ type: "equip", floorId: floor.id });
            const directPoints = inv.listEntities({ type: "point", floorId: floor.id }).filter((p) => !p.equipId);
            const floorChildren = [
              ...equips.map((equip) => bwTreeNode(inv, equip, 3, [
                ...inv.listEntities({ type: "point", equipId: equip.id }).map((p) => bwTreeNode(inv, p, 4)),
                bwDraftNode("point", 4, equip.id),
              ].filter(Boolean))),
              ...directPoints.map((p) => bwTreeNode(inv, p, 3)),
              bwDraftNode("equip", 3, floor.id),
            ];
            return bwTreeNode(inv, floor, 2, floorChildren.filter(Boolean));
          }),
          ...buildingEquips.map((equip) => bwTreeNode(inv, equip, 2, [
            ...inv.listEntities({ type: "point", equipId: equip.id }).map((p) => bwTreeNode(inv, p, 3)),
            bwDraftNode("point", 3, equip.id),
          ].filter(Boolean))),
          ...buildingPoints.map((p) => bwTreeNode(inv, p, 2)),
          bwDraftNode("floor", 2, building.id),
        ].filter(Boolean));
      }),
      ...legacyEquips.map((equip) => bwTreeNode(inv, equip, 1, [
        ...inv.listEntities({ type: "point", equipId: equip.id }).map((p) => bwTreeNode(inv, p, 2)),
        bwDraftNode("point", 2, equip.id),
      ].filter(Boolean))),
      ...legacyPoints.map((p) => bwTreeNode(inv, p, 1)),
      bwDraftNode("building", 1, site.id),
    ];
  };
  const siteNodes = [
    ...sites.map((site) => bwTreeNode(inv, site, 0, childrenForSite(site).filter(Boolean))),
    bwDraftNode("site", 0),
  ].filter(Boolean);
  return el("section", {
    id: "bw-model-tree-panel",
    class: "plugin-section bw-tree-section",
    onclick: bwCloseTreeMenu,
    oncontextmenu: (e) => bwOpenTreeMenu(e, "root"),
  },
    el("div", { class: "section-head" },
      el("h3", {}, "Model Tree"),
      el("span", { class: "muted small" }, `${sites.length} site${sites.length === 1 ? "" : "s"}`)),
    el("div", { class: "bw-tree-scroll" },
      el("button", {
        class: `bw-tree-node bw-tree-root ${!bw.selectedEntityId && bw.selectedEntityIds.length === 0 ? "bw-tree-node-on" : ""}`,
        style: "--depth:0",
        onclick: (e) => { e.stopPropagation(); bwSelectTreeEntity(null); },
      oncontextmenu: (e) => bwOpenTreeMenu(e, "root"),
    },
        el("span", { class: "bw-tree-toggle bw-tree-toggle-empty", "aria-hidden": "true" }),
        el("span", { class: "bw-tree-kind" }, "M"),
        el("span", { class: "bw-tree-name" }, "Model")),
      siteNodes.length
        ? el("ol", { class: "bw-tree-list bw-tree-list-root" },
            ...siteNodes)
        : el("p", { class: "muted small" }, "Right-click Model to add a site.")),
    bwTreeContextMenu(inv));
}

function bwMenuButton(label, action, danger = false) {
  return el("button", {
    class: danger ? "bw-menu-item bw-menu-danger" : "bw-menu-item",
    onclick: (e) => {
      e.stopPropagation();
      bw.contextMenu = null;
      document.querySelector(".bw-tree-menu")?.remove();
      action();
    },
  }, label);
}

function bwTreeContextMenu(inv) {
  const menu = bw.contextMenu;
  if (!menu) return null;
  const entity = menu.entityId ? inv.getEntity(menu.entityId) : null;
  const items = [];
  const selected = bwSelectedEntities(inv);
  if (entity && selected.length > 1 && selected.some((e) => e.id === entity.id)) {
    items.push(bwMenuButton("Historize selection", bwHistorizeSelectedEntities));
    items.push(bwMenuButton("Apply template to devices", () => bwApplyTemplateToSelected(bw.template)));
    items.push(bwMenuButton("Clear selection", () => { bwSetSelection([]); bw.selectionAnchorId = ""; bwSaveState(); bwRenderModelScope({ tree: true, details: true, header: true }); }));
    items.push(bwMenuButton("Remove selection", bwRemoveSelectedEntities, true));
    return el("div", {
      class: "bw-context-menu bw-tree-menu",
      style: `left:${menu.x}px; top:${menu.y}px`,
      onclick: (e) => e.stopPropagation(),
    }, ...items);
  }
  if (menu.kind === "root") {
    items.push(bwMenuButton("Add site", bwAddSite));
  } else if (entity?.type === "site") {
    items.push(bwMenuButton("Add building", () => bwAddBuilding(entity.id)));
    items.push(bwMenuButton("Rename site", () => bwRenameEntity(entity.id)));
    items.push(bwMenuButton("Remove site", () => bwRemoveEntityTree(entity.id), true));
  } else if (entity?.type === "building") {
    items.push(bwMenuButton("Add floor", () => bwAddFloor(entity.id)));
    items.push(bwMenuButton("Batch add floors", () => bwPrepareBatchFloors(entity)));
    items.push(bwMenuButton("Rename building", () => bwRenameEntity(entity.id)));
    items.push(bwMenuButton("Remove building", () => bwRemoveEntityTree(entity.id), true));
  } else if (entity?.type === "floor") {
    items.push(bwMenuButton("Add device", () => bwAddDevice(entity.id)));
    items.push(bwMenuButton("Rename floor", () => bwRenameEntity(entity.id)));
    items.push(bwMenuButton("Remove floor", () => bwRemoveEntityTree(entity.id), true));
  } else if (entity?.type === "equip") {
    items.push(bwMenuButton("Add point", () => bwAddPoint(entity.id)));
    items.push(bwMenuButton("Apply template", () => bwApplyTemplate(entity.id, bw.template)));
    items.push(bwMenuButton("Historize points", () => bwHistorizeEquipPoints(entity.id)));
    items.push(bwMenuButton("Rename device", () => bwRenameEntity(entity.id)));
    items.push(bwMenuButton("Remove device", () => bwRemoveEntityTree(entity.id), true));
  } else if (entity?.type === "point") {
    items.push(bwMenuButton("Historize point", () => bwHistorizePoint(entity.id)));
    items.push(bwMenuButton("Rename point", () => bwRenameEntity(entity.id)));
    items.push(bwMenuButton("Remove point", () => bwRemoveEntityTree(entity.id), true));
  }
  return el("div", {
    class: "bw-context-menu bw-tree-menu",
    style: `left:${menu.x}px; top:${menu.y}px`,
    onclick: (e) => e.stopPropagation(),
  }, ...items);
}

function bwRenderTreeMenu() {
  document.querySelector(".bw-tree-menu")?.remove();
  const inv = inventoryInstance();
  if (!inv || !bw.contextMenu) return;
  const menu = bwTreeContextMenu(inv);
  if (menu) document.body.appendChild(menu);
}

function bwPointRows(inv) {
  return inv.listEntities({ type: "point" });
}

function bwSetTab(tab) {
  bw.tab = tab;
  bwSaveState();
  bwRenderWorkspaceScope();
  setTimeout(bwSyncLivePoll, 0); // start/stop live poll for the new tab (after it mounts)
}

function bwTabs() {
  const tabs = [
    ["model", "Model"],
    ["bacnet", "BACnet"],
    ["historian", "Historian"],
    ["dashboard", "Dashboard"],
    ["commissioning", "Commissioning"],
    ["reports", "Reports"],
  ];
  return el("div", { class: "bw-tabs" },
    ...tabs.map(([tab, label]) =>
      el("button", {
        class: `bw-tab ${bw.tab === tab ? "bw-tab-on" : ""}`,
        onclick: () => bwSetTab(tab),
      }, label)));
}

function bwDownload(filename, text, type = "text/plain;charset=utf-8") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function bwHistorizePoint(pointId) {
  const inv = inventoryInstance();
  const hist = historianInstance();
  if (!inv || !hist) return;
  const point = inv.getEntity(pointId);
  if (!point) return;
  const site = inv.getEntity(point.siteId);
  const building = inv.getEntity(point.buildingId);
  const floor = inv.getEntity(point.floorId);
  const equip = inv.getEntity(point.equipId);
  try {
    hist.addPoint(historianPointFromEntity(point, { site, building, floor, equip }));
    histPersist();
    logTo("building-workspace", `Historizing ${point.name}.`, "ok");
    bwRenderTabScope();
  } catch (err) {
    logTo("building-workspace", `Could not historize ${point.name}: ${err}`, "error");
  }
}

function bwHistorizeSelectedObject(obj = bacSelectedObject()) {
  const inv = inventoryInstance();
  const dev = bacSelectedDevice();
  if (!inv || !dev || !obj) return;
  const { site, building, floor } = bwEnsureLocation(inv);
  const equipName = suggestEquipmentName(obj.name || "", `Device ${dev.instance}`);
  let equip = bwEntityByName(inv, { type: "equip", floorId: floor.id }, equipName)
    || inv.upsertEntity({
      type: "equip",
      siteId: site.id,
      buildingId: building.id,
      floorId: floor.id,
      parentId: floor.id,
      name: equipName,
      tags: { equip: true },
    });
  equip = inv.applyTemplate(equip.id, bwTemplateForName(equipName));
  const point = inv.upsertEntity(pointEntityFromBacnet({
    siteId: site.id,
    buildingId: building.id,
    floorId: floor.id,
    equipId: equip.id,
    device: dev,
    object: obj,
    props: bacObjectKey(obj) === bac.selectedObjectKey ? bac.props : [],
  }));
  bwHistorizePoint(point.id);
}

function bwApplyTemplate(entityId, templateId) {
  const inv = inventoryInstance();
  if (!inv) return;
  inv.applyTemplate(entityId, templateId);
  logTo("building-workspace", `Applied ${templateId} template.`, "ok");
  bwRenderModelScope({ tree: true, details: true });
}

function bwSelectedEntity(inv) {
  if (!bw.selectedEntityId) return null;
  const entity = inv.getEntity(bw.selectedEntityId);
  if (!entity) {
    bwSetSelection([]);
    bwSaveState();
    return null;
  }
  return entity;
}

function bwSelectedEntities(inv) {
  const ids = bw.selectedEntityIds.length ? bw.selectedEntityIds : (bw.selectedEntityId ? [bw.selectedEntityId] : []);
  const entities = ids.map((id) => inv.getEntity(id)).filter(Boolean);
  if (entities.length !== ids.length) {
    bwSetSelection(entities.map((e) => e.id), entities.at(-1)?.id || "");
    bwSaveState();
  }
  return entities;
}

function bwScopeCounts(inv, entity = null) {
  const inScope = (e) => {
    if (!entity) return true;
    if (entity.type === "site") return e.siteId === entity.id || e.id === entity.id;
    if (entity.type === "building") return e.buildingId === entity.id || e.parentId === entity.id || e.id === entity.id;
    if (entity.type === "floor") return e.floorId === entity.id || e.parentId === entity.id || e.id === entity.id;
    if (entity.type === "equip") return e.equipId === entity.id || e.parentId === entity.id || e.id === entity.id;
    return e.id === entity.id;
  };
  const rows = inv.listEntities().filter(inScope);
  return {
    sites: rows.filter((e) => e.type === "site").length,
    buildings: rows.filter((e) => e.type === "building").length,
    floors: rows.filter((e) => e.type === "floor").length,
    devices: rows.filter((e) => e.type === "equip").length,
    points: rows.filter((e) => e.type === "point").length,
  };
}

function bwCountTile(label, value) {
  return el("div", { class: "bw-count-tile" },
    el("span", { class: "bw-count-value" }, String(value)),
    el("span", { class: "bw-count-label" }, label));
}

function bwDetailRow(label, value) {
  if (value == null || value === "") return null;
  return el("div", { class: "bw-detail-row" },
    el("span", { class: "bw-detail-label" }, label),
    el("span", { class: "bw-detail-value" }, String(value)));
}

function bwBreadcrumbItems(inv, entity) {
  if (!entity) return [];
  const { site, building, floor, equip } = bwEntityContext(inv, entity);
  const items = [];
  for (const candidate of [site, building, floor, equip]) {
    if (candidate && !items.some((item) => item.id === candidate.id)) items.push(candidate);
  }
  if (!items.some((item) => item.id === entity.id)) items.push(entity);
  return items;
}

function bwBreadcrumb(inv, entity) {
  const items = bwBreadcrumbItems(inv, entity);
  if (!items.length) return null;
  return el("nav", { class: "bw-breadcrumb", "aria-label": "Model path" },
    ...items.flatMap((item, i) => [
      i ? el("span", { class: "bw-breadcrumb-sep" }, ">") : null,
      el("button", {
        class: `bw-breadcrumb-item ${item.id === entity.id ? "bw-breadcrumb-current" : ""}`,
        onclick: (e) => { e.stopPropagation(); bwSelectTreeEntity(item); },
      }, item.name || item.id),
    ]));
}

function bwHeaderBreadcrumb() {
  const inv = inventoryInstance();
  if (!inv) return null;
  const selected = bwSelectedEntities(inv);
  if (selected.length > 1) {
    return el("div", { id: "bw-header-breadcrumb-addon", class: "bw-breadcrumb bw-breadcrumb-summary" }, `${selected.length} selected`);
  }
  const entity = selected.length === 1 ? selected[0] : bwSelectedEntity(inv);
  const crumb = entity ? bwBreadcrumb(inv, entity) : el("div", { class: "bw-breadcrumb bw-breadcrumb-summary" });
  crumb.id = "bw-header-breadcrumb-addon";
  return crumb;
}

function bwCurrentFloorForInbox(inv) {
  const selected = bwSelectedEntity(inv);
  if (!selected) return null;
  if (selected.type === "floor") return selected;
  const { floor } = bwEntityContext(inv, selected);
  return floor || null;
}

function bwSelectedNetworkAdapterName() {
  return nm.selectedAdapter || nmSelected()?.adapterName || nm.scan.adapterName || "";
}

function bwOpenAdapterSelection(adapterName = "") {
  nm.tab = "configure";
  const target = adapterName || bwSelectedNetworkAdapterName() || nmScanDefaultAdapter();
  if (target) {
    nm.selectedAdapter = target;
    nm.selectedId = null;
  }
  setView(pluginView("networkmanager"));
}

function bwDeviceInboxEmptyMessage() {
  if (bac.discovering) return "Listening for I-Am replies...";
  if (bac.discoveryRan && bac.lastDiscoveryCount === 0) {
    const selectedAdapter = bwSelectedNetworkAdapterName();
    const subnet = selectedAdapter ? nmScanSubnetFor(selectedAdapter) : null;
    const target = bacAdapterTarget(selectedAdapter);
    const adapterMessage = !nm.loaded
      ? "Network adapters have not been read yet. Open Network Manager to verify the active BAS/NIC adapter."
      : !selectedAdapter
        ? "No Network Manager adapter is selected. Choose the active BAS/NIC adapter, then run discovery again."
        : !subnet
          ? `${selectedAdapter} is selected, but it does not have a usable IPv4 subnet. Check its IP configuration or choose another adapter.`
          : `${selectedAdapter} is selected (${subnet.label}). Tried ${target?.label || bac.target}. Check VPN/firewall rules, BBMD/foreign-device routing, or try a known device IP with the advanced BACnet Inspector.`;
    return el("div", { class: "bw-empty-action" },
      el("span", {}, `Discovery finished with no BACnet devices found. ${adapterMessage}`),
      el("button", { class: "btn-ghost", onclick: () => bwOpenAdapterSelection(selectedAdapter) }, "Open adapter selection"));
  }
  return "No discovered devices yet. Run discovery to populate the inbox.";
}

function bwRenderDeviceInboxLive() {
  const inv = inventoryInstance();
  const node = document.getElementById("bw-device-inbox");
  if (!inv || !node) return;
  node.replaceWith(bwDeviceInbox(inv, bwCurrentFloorForInbox(inv)));
}

function bwInboxScrollState() {
  return [...document.querySelectorAll("#bw-device-inbox .bw-device-inbox-scroll")]
    .map((node, index) => ({ index, top: node.scrollTop, left: node.scrollLeft }));
}

function bwRestoreInboxScrollState(state) {
  for (const item of state || []) {
    const node = document.querySelectorAll("#bw-device-inbox .bw-device-inbox-scroll")[item.index];
    if (!node) continue;
    node.scrollTop = item.top;
    node.scrollLeft = item.left;
  }
}

function bwPatchDeviceInboxLive() {
  const inv = inventoryInstance();
  const inbox = document.getElementById("bw-device-inbox");
  if (!inv || !inbox) {
    bwRenderDeviceInboxLive();
    return;
  }
  const floor = bwCurrentFloorForInbox(inv);
  const discovered = bwDeviceInboxCandidateList(inv);
  const queued = bwDeviceInboxQueueList(inv);
  const discoverySelected = bwInboxSelectionFor("discovery").length;
  const modelingSelected = bwInboxSelectionFor("modeling").length;
  const scrollState = bwInboxScrollState();

  document.getElementById("bw-discovered-device-rows")?.replaceChildren(...bwDiscoveredDeviceRows(inv));
  document.getElementById("bw-modeling-queue-rows")?.replaceChildren(...bwModelingQueueRows(inv, floor));

  const count = document.getElementById("bw-device-inbox-count");
  if (count) count.textContent = bac.discovering ? "Discovering..." : `${discovered.length} shown · ${queued.length} queued`;
  const ignore = document.getElementById("bw-inbox-ignore-selected");
  if (ignore) ignore.disabled = discoverySelected ? false : true;
  const clear = document.getElementById("bw-inbox-clear");
  if (clear) clear.disabled = bac.devices.length || queued.length ? false : true;
  const model = document.getElementById("bw-inbox-model-selected");
  if (model) {
    model.dataset.floorId = floor?.id || "";
    model.dataset.queuedCount = String(queued.length);
    model.disabled = floor && queued.length ? false : true;
    model.textContent = floor ? (modelingSelected ? `Add selected to ${floor.name}` : `Add queue to ${floor.name}`) : "Select a floor";
  }
  const remove = document.getElementById("bw-inbox-remove-queued");
  if (remove) remove.disabled = modelingSelected ? false : true;
  bwSyncInboxSelectionUi();
  bwRestoreInboxScrollState(scrollState);
  requestAnimationFrame(() => bwRestoreInboxScrollState(scrollState));
}

function bwRenderHeaderAddon() {
  const node = document.getElementById("bw-header-breadcrumb-addon");
  if (!node) return;
  const next = bwHeaderBreadcrumb();
  if (next) node.replaceWith(next);
}

function bwRenderWorkspaceScope() {
  const node = document.getElementById("bw-root");
  if (!node || currentPluginId() !== "building-workspace") {
    renderScoped("page");
    return;
  }
  node.replaceWith(renderBuildingWorkspacePage());
  bwRenderHeaderAddon();
}

function bwRenderTabScope() {
  const inv = inventoryInstance();
  const body = document.getElementById("bw-tab-body");
  if (!inv || !body || currentPluginId() !== "building-workspace") {
    bwRenderWorkspaceScope();
    return;
  }
  body.replaceChildren(bwCurrentTabBody(inv));
  bwRenderHeaderAddon();
}

function bwRenderModelScope({ tree = false, details = false, header = false } = {}) {
  const inv = inventoryInstance();
  if (!inv || currentPluginId() !== "building-workspace") {
    bwStopLivePoll();
    renderScoped("page");
    return;
  }
  if (bw.tab !== "model") {
    bwStopLivePoll();
    bwRenderTabScope();
    return;
  }
  const treeNode = document.getElementById("bw-model-tree-panel");
  const detailsNode = document.getElementById("bw-model-details");
  if (tree && treeNode) treeNode.replaceWith(bwTreePanel(inv));
  if (details && detailsNode) detailsNode.replaceWith(bwModelDetails(inv));
  if (header) bwRenderHeaderAddon();
  if ((tree && !treeNode) || (details && !detailsNode)) bwRenderTabScope();
  bwSyncLivePoll(); // start/stop the live poll to match the current selection
}

function bwRenderInboxScope() {
  if (currentPluginId() !== "building-workspace") {
    renderScoped("page");
    return;
  }
  if (bw.tab === "bacnet") bwPatchDeviceInboxLive();
  else bwRenderTabScope();
  bwRenderHeaderAddon();
}

function bwInboxStatusLabel(inv, item, floor = null) {
  const existing = item.modeledDevice;
  if (item.status === "queued") return "Queued";
  if (item.status === "changed") return "Changed";
  if (item.status === "conflict") return item.conflict || "Conflict";
  if (existing) {
    const existingFloor = inv.getEntity(existing.floorId || existing.parentId);
    return existing.floorId === floor?.id ? "Modeled here" : `Modeled on ${existingFloor?.name || "another floor"}`;
  }
  return "New";
}

function bwInboxStatusClass(status) {
  if (status === "new") return "pill-running";
  if (status === "queued") return "pill-info";
  if (status === "changed") return "pill-warn";
  if (status === "conflict") return "pill-error";
  return "pill-muted";
}

function bwDiscoveredDeviceRows(inv) {
  const items = bwDeviceInboxCandidateList(inv);
  const floor = bwCurrentFloorForInbox(inv);
  const selected = new Set(bwInboxSelectionFor("discovery"));
  const rows = items.map((item) => {
    const device = item.device;
    const canDrag = item.selectable !== false;
    const dragAttrs = bwDiscoveryDragAttrs(item, canDrag);
    return el("tr", {
      class: `bw-inbox-row ${selected.has(item.key) ? "bw-inbox-row-selected" : ""} ${item.selectable === false ? "bw-inbox-row-disabled" : ""}`,
      "data-bw-inbox-key": item.key,
      "data-bw-inbox-phase": "discovery",
      "aria-selected": selected.has(item.key) ? "true" : "false",
      ...dragAttrs,
      onclick: (e) => bwSelectInboxCandidate("discovery", item, e),
      oncontextmenu: (e) => bwOpenInboxMenu(e, "discovery", item),
    },
      el("td", { class: "bac-num", ...dragAttrs }, String(device.instance ?? "")),
      el("td", { ...dragAttrs }, device.name || el("span", { class: "muted" }, "Unnamed")),
      el("td", { class: "bac-mono", ...dragAttrs }, bacAddressText(device)),
      el("td", { ...dragAttrs }, bacVendorText(device) || el("span", { class: "muted" }, "-")),
      el("td", { ...dragAttrs }, device.modelName || el("span", { class: "muted" }, "-")),
      el("td", { ...dragAttrs }, el("span", { class: `pill ${bwInboxStatusClass(item.status)}` }, bwInboxStatusLabel(inv, item, floor))));
  });
  return rows.length ? rows : [el("tr", {}, el("td", { class: "muted small", colspan: "6" }, bwDeviceInboxEmptyMessage()))];
}

function bwModelingQueueRows(inv, floor = null) {
  const items = bwDeviceInboxQueueList(inv);
  const selected = new Set(bwInboxSelectionFor("modeling"));
  const rows = items.map((item) => {
    const device = item.device;
    const targetFloor = inv.getEntity(item.candidate?.targetFloorId || floor?.id);
    const instance = device ? String(device.instance ?? "") : item.key.replace(/^bacnet-device:/, "");
    const match = item.modeledDevice ? bwInboxPathLabel(inv, item.modeledDevice) : (item.conflict || "");
    return el("tr", {
      class: `bw-inbox-row ${selected.has(item.key) ? "bw-inbox-row-selected" : ""}`,
      "data-bw-inbox-key": item.key,
      "data-bw-inbox-phase": "modeling",
      "aria-selected": selected.has(item.key) ? "true" : "false",
      onclick: (e) => bwSelectInboxCandidate("modeling", item, e),
      oncontextmenu: (e) => bwOpenInboxMenu(e, "modeling", item),
    },
      el("td", {}, item.proposedName || device?.name || "Unnamed"),
      el("td", { class: "bac-num" }, instance),
      el("td", { class: "bac-mono" }, device ? bacAddressText(device) : "not in current discovery"),
      el("td", {}, device ? bacVendorText(device) || "-" : "-"),
      el("td", {}, device?.modelName || "-"),
      el("td", {}, targetFloor?.name || "Selected floor"),
      el("td", {}, match || el("span", { class: "muted" }, "-")),
      el("td", {}, item.action === "skip" ? "Skip" : "Add"),
      el("td", {}, el("span", { class: `pill ${bwInboxStatusClass(item.status)}` }, bwInboxStatusLabel(inv, item, floor))));
  });
  return rows.length ? rows : [el("tr", {}, el("td", { class: "muted small", colspan: "9" }, "No queued devices. Highlight discovered rows and queue them for modeling."))];
}

function bwInboxPathLabel(inv, entity) {
  return entity ? bwBreadcrumbItems(inv, entity).map((item) => item.name || item.id).join(" > ") : "";
}

function bwDeviceInbox(inv, floor = null) {
  const discovered = bwDeviceInboxCandidateList(inv);
  const queued = bwDeviceInboxQueueList(inv);
  const discoverySelected = bwInboxSelectionFor("discovery").length;
  const modelingSelected = bwInboxSelectionFor("modeling").length;
  const adapterTarget = bacAdapterTarget();
  const canModel = Boolean(floor && queued.length);
  return el("div", {
    id: "bw-device-inbox",
    class: "bw-device-inbox",
    onclick: () => { if (bw.inboxMenu) bwCloseInboxMenu(); },
  },
    el("div", { class: "bw-inbox-grid" },
    el("div", { class: "bw-inbox-stage bw-inbox-stage-discovery" },
      el("div", { class: "section-head bw-inbox-stage-head" },
        el("h4", {}, "BACnet Device Inbox"),
        el("span", { id: "bw-device-inbox-count", class: "muted small" }, bac.discovering ? "Discovering..." : `${discovered.length} shown · ${queued.length} queued`)),
      adapterTarget
        ? el("p", { class: "muted small bw-inbox-target" }, `Discovery target: ${adapterTarget.label}`)
        : null,
      bac.discovering ? bacDiscoveryProgressEl("bw-discovery-progress") : null,
      el("div", { class: "tool-actions" },
        el("button", {
          class: "btn btn-primary",
          disabled: bac.discovering ? "disabled" : undefined,
          onclick: bwDiscoverDevices,
        }, bac.discovering ? "Discovering..." : "Discover devices"),
        el("button", {
          id: "bw-inbox-ignore-selected",
          class: "btn-ghost",
          disabled: discoverySelected ? undefined : "disabled",
          onclick: bwIgnoreSelectedInboxDevices,
        }, "Ignore"),
        el("button", { id: "bw-inbox-clear", class: "btn-ghost", disabled: bac.devices.length || queued.length ? undefined : "disabled", onclick: bwClearDeviceDiscovery }, "Clear")),
      el("input", {
        class: "nm-input bw-device-filter",
        placeholder: "Filter by instance, name, address, vendor, model",
        value: bw.deviceInbox?.filter || "",
        oninput: (e) => { bw.deviceInbox.filter = e.target.value; bwApplyDeviceInboxFilter(); },
      }),
      el("div", { class: "bw-device-inbox-scroll" },
        el("table", { class: "bac-table bw-device-inbox-table bw-discovery-table" },
          el("thead", {}, el("tr", {},
            el("th", {}, "Instance"),
            el("th", {}, "Name"),
            el("th", {}, "Address"),
            el("th", {}, "Vendor"),
            el("th", {}, "Model"),
            el("th", {}, "Status"))),
          el("tbody", { id: "bw-discovered-device-rows" }, ...bwDiscoveredDeviceRows(inv))))),
    el("div", { class: "bw-inbox-stage bw-inbox-stage-queue" },
      el("div", { class: "section-head bw-inbox-stage-head" },
        el("h4", {}, "Import Plan"),
        el("span", { class: "muted small" }, floor ? `Target: ${floor.name}` : "Select a floor in the Model Tree")),
      el("div", { class: "tool-actions" },
        el("button", {
          id: "bw-inbox-model-selected",
          class: "btn-ghost",
          "data-floor-id": floor?.id || "",
          "data-queued-count": String(queued.length),
          disabled: canModel ? undefined : "disabled",
          onclick: () => bwModelQueuedDevicesToFloor(floor.id),
        }, floor ? (modelingSelected ? `Add selected to ${floor.name}` : `Add queue to ${floor.name}`) : "Select a floor"),
        el("button", {
          id: "bw-inbox-remove-queued",
          class: "btn-ghost",
          disabled: modelingSelected ? undefined : "disabled",
          onclick: () => bwRemoveQueuedInboxDevices(),
        }, "Remove from queue")),
      el("div", {
        class: "bw-device-inbox-scroll bw-queue-scroll bw-import-plan-dropzone",
        ondragover: bwImportPlanDragOver,
        ondragleave: bwImportPlanDragLeave,
        ondrop: bwImportPlanDrop,
      },
        el("table", { class: "bac-table bw-device-inbox-table bw-import-plan-table" },
          el("thead", {}, el("tr", {},
            el("th", {}, "Proposed Equip"),
            el("th", {}, "Instance"),
            el("th", {}, "Address"),
            el("th", {}, "Vendor"),
            el("th", {}, "Model"),
            el("th", {}, "Target"),
            el("th", {}, "Match / Issue"),
            el("th", {}, "Action"),
            el("th", {}, "Status"))),
          el("tbody", { id: "bw-modeling-queue-rows" }, ...bwModelingQueueRows(inv, floor)))))),
    bwInboxContextMenu(inv, floor));
}

function bwRootDetails(inv) {
  const counts = bwScopeCounts(inv);
  return [
    el("div", { class: "bw-count-grid" },
      bwCountTile("Sites", counts.sites),
      bwCountTile("Buildings", counts.buildings),
      bwCountTile("Floors", counts.floors),
      bwCountTile("Devices", counts.devices),
      bwCountTile("Points", counts.points)),
    el("div", { class: "bw-context-summary" },
      el("h4", {}, "Model overview"),
      el("p", { class: "muted small" }, "Select a site, building, floor, device, or point to inspect modeled context. Protocol discovery and imports live in the BACnet tab.")),
  ];
}

function bwSiteDetails(inv, site) {
  const counts = bwScopeCounts(inv, site);
  return [
    el("div", { class: "bw-count-grid" },
      bwCountTile("Buildings", counts.buildings),
      bwCountTile("Floors", counts.floors),
      bwCountTile("Devices", counts.devices),
      bwCountTile("Points", counts.points)),
    el("div", { class: "bw-context-summary" },
      el("h4", {}, "Site context"),
      el("div", { class: "bw-detail-grid" },
        bwDetailRow("Name", site.name),
        bwDetailRow("Tags", Object.keys(site.tags || {}).join(", ")))),
  ];
}

function bwBuildingDetails(inv, building) {
  const counts = bwScopeCounts(inv, building);
  const floors = inv.listEntities({ type: "floor", buildingId: building.id });
  if (!String(bw.floorBatchStart || "").trim()) bw.floorBatchStart = String(floors.length + 1);
  return [
    el("div", { class: "bw-count-grid" },
      bwCountTile("Floors", counts.floors),
      bwCountTile("Devices", counts.devices),
      bwCountTile("Points", counts.points)),
    el("div", { class: "bw-batch-floor-form" },
      el("label", { class: "nm-field" },
        el("span", { class: "nm-field-label" }, "Floor name pattern"),
        el("input", {
          class: "nm-input",
          value: bw.floorBatchPattern,
          "data-bw-floor-batch-pattern": "1",
          placeholder: "Floor {n}",
          oninput: (e) => { bw.floorBatchPattern = e.target.value; },
        })),
      el("label", { class: "nm-field bw-batch-small" },
        el("span", { class: "nm-field-label" }, "Start"),
        el("input", {
          class: "nm-input",
          inputmode: "numeric",
          pattern: "[0-9]*",
          value: bw.floorBatchStart,
          oninput: (e) => { bw.floorBatchStart = e.target.value; },
        })),
      el("label", { class: "nm-field bw-batch-small" },
        el("span", { class: "nm-field-label" }, "Count"),
        el("input", {
          class: "nm-input",
          type: "number",
          min: "1",
          max: "200",
          value: bw.floorBatchCount,
          oninput: (e) => { bw.floorBatchCount = e.target.value; },
        })),
      el("button", { class: "btn-ghost bw-batch-action", onclick: () => bwBatchAddFloors(building.id) }, "Add batch")),
  ];
}

function bwFloorDetails(inv, floor) {
  const counts = bwScopeCounts(inv, floor);
  return [
    el("div", { class: "bw-count-grid" },
      bwCountTile("Devices", counts.devices),
      bwCountTile("Points", counts.points)),
    el("div", { class: "bw-context-summary" },
      el("h4", {}, "Floor context"),
      el("div", { class: "bw-detail-grid" },
        bwDetailRow("Name", floor.name),
        bwDetailRow("Building", inv.getEntity(floor.buildingId || floor.parentId)?.name || ""),
        bwDetailRow("Site", inv.getEntity(floor.siteId)?.name || ""),
        bwDetailRow("Tags", Object.keys(floor.tags || {}).join(", ")))),
  ];
}

function bwDeviceDetails(inv, equip) {
  const templates = inv.listEntities({ type: "template" });
  const points = inv.listEntities({ type: "point", equipId: equip.id });
  return [
    el("div", { class: "bw-count-grid" }, bwCountTile("Points", points.length)),
    el("div", { class: "bw-detail-grid" },
      bwDetailRow("Template", equip.templateId || ""),
      bwDetailRow("Tags", Object.keys(equip.tags || {}).join(", "))),
    el("div", { class: "tool-actions" },
      equip.tags?.bacnet || equip.deviceInstance != null
        ? el("button", { class: "btn-ghost", disabled: bw.busy ? "disabled" : undefined, onclick: () => bwDiscoverDevicePoints(equip.id) }, bw.busy ? "Discovering..." : "Discover points")
        : null,
      el("select", { class: "nm-input bw-template-select", onchange: (e) => { bw.template = e.target.value; bwSaveState(); } },
        ...templates.map((t) => el("option", { value: t.id, selected: bw.template === t.id || bw.template === t.id.replace("template:", "") ? "selected" : undefined }, t.name)))),
    bwDeviceLivePanel(inv, equip),
  ];
}

// ---- Phase 2: live control for a modeled point (present-value, status flags,
// 16-slot priority array, inline write / relinquish / write+verify) ----

// Auto-poll live data for the currently-selected point/device on the Model tab. The
// poll updates only its own display container in place, so write inputs keep focus.
let bwLive = null;          // point poll: { props } | { props:null, error }
let bwDeviceLive = null;    // device poll: { values: Map(pointId -> { value, display } | { error }) }
let bwLivePoll = null;      // { kind: "point" | "device", id }
let bwLiveTimer = null;
let bwLivePaused = false;
let bwLiveBusyWrite = false;
let bwLiveBusyPoll = false;  // guards against overlapping async ticks
const BW_POINT_POLL_MS = 4000;
const BW_DEVICE_POLL_MS = 12000;
const BW_DEVICE_POLL_CAP = 60; // don't hammer a big device every tick

function bwBacnetCap() {
  return platform ? platform.capability("bacnet.read.v1") : bacnetRead();
}

// Build the BACnet object reference straight from the modeled point's own fields.
function bwPointRef(point) {
  const objectType = Number(point.objectType);
  const instance = Number(point.instance);
  if (!Number.isFinite(objectType) || !Number.isFinite(instance)) return null;
  return { device: point.deviceRef || { deviceInstance: point.deviceInstance }, objectType, instance };
}

// Encode a write value by object type: binary -> enumerated 0/1, multistate -> unsigned, else real.
function bwBacnetWriteValue(objectType, raw) {
  const t = Number(objectType);
  if ([3, 4, 5].includes(t)) return { kind: "enumerated", value: Number(raw) ? 1 : 0 };
  if ([13, 14, 19].includes(t)) return { kind: "unsigned", value: Math.max(0, Math.round(Number(raw) || 0)) };
  return { kind: "real", value: Number(raw) };
}

function bwPropEntry(props, id, name) {
  return (props || []).find((p) => p && (p.id === id || p.name === name)) || null;
}

function bwLivePresentValue(props) {
  const e = bwPropEntry(props, 85, "present-value");
  if (!e || e.error || !Array.isArray(e.values) || !e.values.length) return { value: null, display: null };
  return { value: e.values[0]?.value ?? null, display: e.display ?? String(e.values[0]?.value ?? "") };
}

function bwStopLivePoll() {
  if (bwLiveTimer) { clearInterval(bwLiveTimer); bwLiveTimer = null; }
  bwLivePoll = null;
  bwLive = null;
  bwDeviceLive = null;
}

function bwArmLiveTimer(ms) {
  if (bwLiveTimer) { clearInterval(bwLiveTimer); bwLiveTimer = null; }
  if (!bwLivePaused) bwLiveTimer = setInterval(bwLiveTick, ms);
}

// Start/stop the live poll to match the current single selection on the Model tab.
// Idempotent: re-selecting the same entity does not restart the timer or drop data.
function bwSyncLivePoll() {
  const inv = inventoryInstance();
  if (!inv || currentPluginId() !== "building-workspace" || bw.tab !== "model") { bwStopLivePoll(); return; }
  const sel = bwSelectedEntities(inv);
  const entity = sel.length === 1 ? sel[0] : null;
  let target = null;
  if (entity && entity.type === "point" && bwPointRef(entity)) target = { kind: "point", id: entity.id };
  else if (entity && entity.type === "equip" && (entity.deviceInstance != null || entity.deviceRef)) target = { kind: "device", id: entity.id };
  if (!target) { bwStopLivePoll(); return; }
  if (bwLivePoll && bwLivePoll.kind === target.kind && bwLivePoll.id === target.id) return; // already live
  bwStopLivePoll();
  bwLivePoll = target;
  bwLiveTick(); // immediate first read
  bwArmLiveTimer(target.kind === "point" ? BW_POINT_POLL_MS : BW_DEVICE_POLL_MS);
}

function bwToggleLivePause() {
  bwLivePaused = !bwLivePaused;
  if (bwLivePaused) {
    if (bwLiveTimer) { clearInterval(bwLiveTimer); bwLiveTimer = null; }
  } else if (bwLivePoll) {
    bwLiveTick();
    bwArmLiveTimer(bwLivePoll.kind === "point" ? BW_POINT_POLL_MS : BW_DEVICE_POLL_MS);
  }
  const ind = document.getElementById("bw-live-indicator");
  if (ind) ind.replaceWith(bwLiveIndicator());
  const btn = document.getElementById("bw-live-pause");
  if (btn) btn.textContent = bwLivePaused ? "Resume" : "Pause";
}

async function bwLiveTick() {
  // Ticks run sequential async reads that can exceed the poll interval; the busy
  // guard stops setInterval from stacking concurrent polling loops.
  if (bwLiveBusyPoll) return;
  const poll = bwLivePoll;
  if (!poll) return;
  const inv = inventoryInstance();
  // Self-guard: stop if we navigated away or the target is no longer the lone selection.
  if (!inv || currentPluginId() !== "building-workspace" || bw.tab !== "model") { bwStopLivePoll(); return; }
  const entity = inv.getEntity(poll.id);
  if (!entity) { bwStopLivePoll(); return; }
  bwLiveBusyPoll = true;
  try {
    if (poll.kind === "point") {
      const ref = bwPointRef(entity);
      if (!ref) { bwStopLivePoll(); return; }
      try {
        const props = await bwBacnetCap().readPoint(ref.device, ref.objectType, ref.instance);
        if (bwLivePoll !== poll) return; // selection moved mid-read
        bwLive = { props };
      } catch (err) {
        if (bwLivePoll !== poll) return;
        bwLive = { props: null, error: String(err) };
      }
      bwUpdateLiveDisplay(entity);
    } else {
      const points = inv.listEntities({ type: "point", equipId: entity.id }).slice(0, BW_DEVICE_POLL_CAP);
      const values = bwDeviceLive?.values || new Map();
      for (const p of points) {
        if (bwLivePoll !== poll) return; // bail if selection moved
        const ref = bwPointRef(p);
        if (!ref) { values.set(p.id, { error: "no ref" }); continue; }
        try {
          const props = await bwBacnetCap().readPoint(ref.device, ref.objectType, ref.instance);
          if (bwLivePoll !== poll) return; // stale read for a superseded selection
          const pv = bwLivePresentValue(props);
          values.set(p.id, { value: pv.value, display: pv.display });
        } catch (err) {
          if (bwLivePoll !== poll) return;
          values.set(p.id, { error: String(err) });
        }
        bwDeviceLive = { values };
        bwUpdateDeviceLive(entity); // progressive update as each point comes back
      }
    }
  } finally {
    bwLiveBusyPoll = false;
  }
}

function bwLiveIndicator() {
  return bwLivePaused
    ? el("span", { id: "bw-live-indicator", class: "muted small bw-live-ind" }, "paused")
    : el("span", { id: "bw-live-indicator", class: "bw-live-ind" }, el("span", { class: "bw-live-dot", title: "Polling live" }), el("span", { class: "muted small" }, "live"));
}

function bwLiveControls() {
  return el("div", { class: "section-head bw-live-head" },
    el("h4", {}, "Live"),
    el("div", { class: "bw-live-head-right" },
      bwLiveIndicator(),
      el("button", { id: "bw-live-pause", class: "btn-ghost", onclick: bwToggleLivePause }, bwLivePaused ? "Resume" : "Pause"),
    ),
  );
}

function bwUpdateLiveDisplay(point) {
  const node = document.getElementById("bw-live-display");
  if (node) node.replaceChildren(...bwLiveDisplayChildren(point));
  const ind = document.getElementById("bw-live-indicator");
  if (ind) ind.replaceWith(bwLiveIndicator());
}

function bwUpdateDeviceLive(equip) {
  const node = document.getElementById("bw-device-live");
  if (node) node.replaceChildren(...bwDeviceLiveRows(equip));
  const ind = document.getElementById("bw-live-indicator");
  if (ind) ind.replaceWith(bwLiveIndicator());
}

function bwLiveDisplayChildren(point) {
  const live = bwLive;
  if (!live) return [el("p", { class: "muted small" }, "Reading…")];
  if (!live.props) return [el("p", { class: "muted small" }, live.error ? `Read failed: ${live.error}` : "No data.")];
  const pv = bwLivePresentValue(live.props);
  const flagsEntry = bwPropEntry(live.props, 111, "status-flags");
  const flags = flagsEntry ? interpretStatusFlags(flagsEntry.values?.[0]) : null;
  const prioEntry = bwPropEntry(live.props, 87, "priority-array");
  const parsed = prioEntry && Array.isArray(prioEntry.values) && prioEntry.values.length ? parsePriorityArray(prioEntry.values) : null;
  const out = [
    el("div", { class: "bw-live-pv" },
      el("span", { class: "bw-live-pv-val" }, pv.display ?? String(pv.value ?? "—")),
      flags && flags.raised.length
        ? el("span", { class: "bw-live-flags" }, ...flags.raised.map((f) => el("span", { class: `bw-flag bw-flag-${f.replace(/[^a-z]/g, "")}` }, f)))
        : el("span", { class: "muted small" }, "no active alarms"),
    ),
  ];
  if (parsed) out.push(el("div", { class: "bw-prio-wrap" }, el("span", { class: "muted small" }, "Priority array (1 = highest)"), bwPriorityRibbon(point, parsed)));
  return out;
}

function bwDeviceLiveRows(equip) {
  const inv = inventoryInstance();
  if (!inv) return [];
  const points = inv.listEntities({ type: "point", equipId: equip.id });
  if (!points.length) return [el("tr", {}, el("td", { class: "muted small", colspan: "3" }, "No modeled points yet — use Discover points."))];
  const values = bwDeviceLive?.values || new Map();
  const shown = points.slice(0, BW_DEVICE_POLL_CAP);
  const rows = shown.map((p) => {
    const v = values.get(p.id);
    const cell = !v ? el("span", { class: "muted small" }, "…")
      : v.error ? el("span", { class: "bw-live-err", title: v.error }, "err")
      : el("span", { class: "bw-live-val" }, v.display ?? String(v.value ?? "—"));
    return el("tr", { class: "bw-dlive-row", onclick: () => bwSelectTreeEntity(p) },
      el("td", {}, p.name || p.id),
      el("td", { class: "muted small" }, p.objectType != null && p.instance != null ? `${p.objectType}:${p.instance}` : ""),
      el("td", { class: "bw-dlive-val" }, cell));
  });
  if (points.length > shown.length) {
    rows.push(el("tr", {}, el("td", { class: "muted small", colspan: "3" }, `+${points.length - shown.length} more not polled (cap ${BW_DEVICE_POLL_CAP})`)));
  }
  return rows;
}

async function bwWritePoint(point, { value, priority, relinquish = false, verify = false }) {
  const ref = bwPointRef(point);
  if (!ref || bwLiveBusyWrite) return;
  const pr = priority === "" || priority == null ? null : parseInt(priority, 10);
  if (relinquish && pr == null) { toast("Relinquish needs a priority (the slot to release).", "warn"); return; }
  // Guard against blank/invalid input silently coercing to 0 — a real hazard for
  // setpoints and commandable outputs. Only relinquish (null write) is exempt.
  if (!relinquish && (value === "" || value == null || !Number.isFinite(Number(value)))) {
    toast("Enter a numeric value to write.", "warn");
    return;
  }
  const writeVal = relinquish ? { kind: "null" } : bwBacnetWriteValue(ref.objectType, value);
  bwLiveBusyWrite = true;
  try {
    const cap = bwBacnetCap();
    await cap.writeProperty({ device: ref.device, objectType: ref.objectType, instance: ref.instance, property: 85, value: writeVal, priority: pr });
    const label = relinquish ? `Released priority ${pr}` : `Wrote ${value}${pr != null ? ` @ p${pr}` : ""}`;
    logTo("building-workspace", `${label} on ${point.name}.`, "ok");
    if (verify && !relinquish) {
      // Read back and confirm the command actually landed.
      const props = await cap.readPoint(ref.device, ref.objectType, ref.instance);
      bwLive = { props };
      bwUpdateLiveDisplay(point);
      const got = bwLivePresentValue(props).value;
      const ok = commissioningValueMatches(got, writeVal.value);
      toast(
        ok ? `Verified: ${point.name} now reads ${got}` : `Write did NOT land — read back ${got ?? "—"} (stuck output or higher-priority override?)`,
        ok ? "ok" : "error", ok ? 4000 : 7000,
      );
    } else {
      toast(label, "ok");
    }
  } catch (err) {
    toast(`Write failed: ${err}`, "error");
    logTo("building-workspace", `Write failed on ${point.name}: ${err}`, "error");
  } finally {
    bwLiveBusyWrite = false;
    // The next poll refreshes the ribbon; nudge one now so the slot updates immediately.
    if (!bwLivePaused && bwLivePoll && bwLivePoll.kind === "point") bwLiveTick();
  }
}

function bwPriorityRibbon(point, parsed) {
  return el("div", { class: "bw-prio" },
    ...parsed.slots.map((s) => el("div", {
      class: `bw-prio-slot${s.active ? " bw-prio-on" : ""}${parsed.activeLevel === s.level ? " bw-prio-active" : ""}`,
      title: s.active ? `Priority ${s.level} = ${s.value}${parsed.activeLevel === s.level ? " (commanding)" : ""}` : `Priority ${s.level} — empty`,
    },
      el("span", { class: "bw-prio-level" }, String(s.level)),
      el("span", { class: "bw-prio-val" }, s.active ? String(s.value) : "—"),
      s.active ? el("button", { class: "bw-prio-release", title: `Release priority ${s.level}`, onclick: () => bwWritePoint(point, { priority: s.level, relinquish: true }) }, "×") : null,
    )),
  );
}

function bwWriteControls(point, ref) {
  const binary = [3, 4, 5].includes(Number(ref.objectType));
  const valueInput = binary
    ? el("select", { id: "bw-write-value", class: "nm-input bw-write-value" },
        el("option", { value: "0" }, "inactive (0)"), el("option", { value: "1" }, "active (1)"))
    : el("input", { id: "bw-write-value", type: "number", class: "nm-input bw-write-value", placeholder: "value", step: "any" });
  const prioritySelect = el("select", { id: "bw-write-priority", class: "nm-input bw-write-priority", title: "Command priority (8 = manual operator)" },
    ...Array.from({ length: 16 }, (_, i) => el("option", { value: String(i + 1), selected: i + 1 === 8 ? "selected" : undefined }, `priority ${i + 1}`)));
  const readVal = () => document.getElementById("bw-write-value")?.value;
  const readPrio = () => document.getElementById("bw-write-priority")?.value;
  return el("div", { class: "bw-write-row" },
    el("label", { class: "nm-field" }, el("span", { class: "nm-field-label" }, "Value"), valueInput),
    el("label", { class: "nm-field" }, el("span", { class: "nm-field-label" }, "Priority"), prioritySelect),
    el("button", { class: "btn", disabled: bw.busy ? "disabled" : undefined, onclick: () => bwWritePoint(point, { value: readVal(), priority: readPrio() }) }, "Write"),
    el("button", { class: "btn btn-primary", disabled: bw.busy ? "disabled" : undefined, title: "Write, then read back and confirm it landed", onclick: () => bwWritePoint(point, { value: readVal(), priority: readPrio(), verify: true }) }, "Write & verify"),
    el("button", { class: "btn-ghost", disabled: bw.busy ? "disabled" : undefined, title: "Release the selected priority slot", onclick: () => bwWritePoint(point, { priority: readPrio(), relinquish: true }) }, "Relinquish"),
  );
}

// Auto-polling live panel for a selected point. The #bw-live-display container is what
// the poll refreshes; write controls live outside it so typed values keep focus.
function bwLivePanel(inv, point) {
  const ref = bwPointRef(point);
  if (!ref) return null;
  const children = [
    bwLiveControls(),
    el("div", { id: "bw-live-display", class: "bw-live-display" }, ...bwLiveDisplayChildren(point)),
  ];
  if (point.tags?.writable) children.push(bwWriteControls(point, ref));
  else children.push(el("p", { class: "muted small" }, "Read-only object (not commandable)."));
  return el("div", { class: "bw-live" }, ...children);
}

// Auto-polling live values for every modeled point under a selected device.
function bwDeviceLivePanel(inv, equip) {
  if (!(equip.deviceInstance != null || equip.deviceRef)) return null;
  return el("div", { class: "bw-live" },
    bwLiveControls(),
    el("div", { class: "table-scroll" },
      el("table", { class: "bac-table bw-dlive-table" },
        el("thead", {}, el("tr", {}, el("th", {}, "Point"), el("th", {}, "Object"), el("th", {}, "Live value"))),
        el("tbody", { id: "bw-device-live" }, ...bwDeviceLiveRows(equip)))),
  );
}

function bwPointDetails(inv, point) {
  return [
    el("div", { class: "bw-detail-grid" },
      bwDetailRow("Unit", point.unit),
      bwDetailRow("Device instance", point.deviceInstance),
      bwDetailRow("Object", point.objectType != null && point.instance != null ? `${point.objectType}:${point.instance}` : ""),
      bwDetailRow("Source", (point.sourceRefs || []).join(", ")),
      bwDetailRow("Tags", Object.keys(point.tags || {}).join(", "))),
    bwLivePanel(inv, point),
  ];
}

function bwSelectionDetails(inv, entities) {
  const counts = {
    site: entities.filter((e) => e.type === "site").length,
    building: entities.filter((e) => e.type === "building").length,
    floor: entities.filter((e) => e.type === "floor").length,
    equip: entities.filter((e) => e.type === "equip").length,
    point: entities.filter((e) => e.type === "point").length,
  };
  const points = bwPointsForEntities(inv, entities);
  const devices = entities.filter((e) => e.type === "equip");
  const templates = inv.listEntities({ type: "template" });
  return [
    el("p", { class: "muted small bw-selection-hint" }, "Ctrl-click toggles nodes. Shift-click selects a range from the last clicked node."),
    el("div", { class: "bw-count-grid" },
      bwCountTile("Sites", counts.site),
      bwCountTile("Buildings", counts.building),
      bwCountTile("Floors", counts.floor),
      bwCountTile("Devices", counts.equip),
      bwCountTile("Points", counts.point)),
    el("div", { class: "tool-actions" },
      el("button", { class: "btn btn-primary", disabled: points.length ? undefined : "disabled", onclick: bwHistorizeSelectedEntities }, `Historize ${points.length} point${points.length === 1 ? "" : "s"}`),
      el("select", {
        class: "nm-input bw-template-select",
        disabled: devices.length ? undefined : "disabled",
        onchange: (e) => { bw.template = e.target.value; bwSaveState(); },
      },
        ...templates.map((t) => el("option", { value: t.id, selected: bw.template === t.id || bw.template === t.id.replace("template:", "") ? "selected" : undefined }, t.name))),
      el("button", { class: "btn-ghost", disabled: devices.length ? undefined : "disabled", onclick: () => bwApplyTemplateToSelected(bw.template) }, `Apply to ${devices.length} device${devices.length === 1 ? "" : "s"}`),
      el("button", { class: "btn-ghost", onclick: () => { bwSetSelection([]); bw.selectionAnchorId = ""; bwSaveState(); bwRenderModelScope({ tree: true, details: true, header: true }); } }, "Clear"),
      el("button", { class: "btn-ghost danger", onclick: bwRemoveSelectedEntities }, "Remove selected")),
    el("ol", { class: "plugin-log bw-selection-list" },
      ...entities.map((entity) => el("li", { class: "log-info" },
        el("span", { class: "log-time" }, bwTreeNodeLabel(entity)),
        el("span", { class: "log-msg" }, entity.name || entity.id)))),
  ];
}

function bwModelDetails(inv) {
  const selected = bwSelectedEntities(inv);
  if (selected.length > 1) return el("section", { id: "bw-model-details", class: "plugin-section bw-detail-panel" }, ...bwSelectionDetails(inv, selected));
  const entity = selected.length === 1 ? selected[0] : bwSelectedEntity(inv);
  const content = !entity ? bwRootDetails(inv)
    : entity.type === "site" ? bwSiteDetails(inv, entity)
    : entity.type === "building" ? bwBuildingDetails(inv, entity)
    : entity.type === "floor" ? bwFloorDetails(inv, entity)
    : entity.type === "equip" ? bwDeviceDetails(inv, entity)
    : entity.type === "point" ? bwPointDetails(inv, entity)
    : bwRootDetails(inv);
  return el("section", { id: "bw-model-details", class: "plugin-section bw-detail-panel" }, ...content);
}

function bwModelTab(inv) {
  return el("div", { id: "bw-model-tab", class: "bw-model-layout", onclick: () => { if (bw.contextMenu) bwCloseTreeMenu(); } },
    bwTreePanel(inv),
    el("div", { class: "bw-model-main" }, bwModelDetails(inv)),
  );
}

function bwBacnetTab(inv) {
  const floor = bwCurrentFloorForInbox(inv);
  return el("section", { class: "plugin-section bw-detail-panel bw-protocol-panel" },
    el("div", { class: "section-head" },
      el("h3", {}, "BACnet Device Management"),
      el("span", { class: "muted small" }, floor ? `Import target: ${bwInboxPathLabel(inv, floor)}` : "Select a floor in Model to set the import target")),
    bwDeviceInbox(inv, floor));
}

function bwHistorianTab(inv) {
  const hist = historianInstance();
  const pts = hist ? hist.points() : [];
  const modelPoints = bwPointRows(inv);
  return el("section", { class: "plugin-section" },
    el("div", { class: "section-head" },
      el("h3", {}, "Historian"),
      el("span", { class: `pill ${hist && hist.isRunning() ? "pill-running" : "pill-idle"}` }, hist && hist.isRunning() ? "Logging" : "Idle")),
    el("p", { class: "muted small" }, "Historize modeled points with site/equipment/point tags. Existing manual Historian controls remain available."),
    el("div", { class: "tool-actions" },
      el("button", { class: "btn btn-primary", disabled: modelPoints.length ? undefined : "disabled", onclick: () => modelPoints.forEach((p) => bwHistorizePoint(p.id)) }, "Historize modeled points"),
      el("button", { class: "btn-ghost", onclick: () => setView(pluginView("bacnet-historian")) }, "Open BACnet Historian")),
    pts.length
      ? el("ol", { class: "plugin-log" },
          ...pts.map((p) => el("li", { class: p.lastError ? "log-error" : "log-info" },
            el("span", { class: "log-msg" }, `${[p.site, p.building, p.floor, p.equip].filter(Boolean).join(" · ")}${p.site || p.building || p.floor || p.equip ? " · " : ""}${p.label || p.pointId || `${p.objectType}:${p.instance}`} → ${p.lastError ? "ERR " + p.lastError : (p.lastValue ?? "—")}`))))
      : el("p", { class: "muted small" }, "No historian points yet."));
}

function bwDashboardTab(inv) {
  const snapshot = inv.exportSnapshot();
  const site = bwActiveSite(inv);
  const building = bwActiveBuilding(inv, site?.id);
  const floor = bwActiveFloor(inv, building?.id);
  const dashboardScope = {
    siteId: site?.id || null,
    buildingId: building?.id || null,
    floorId: floor?.id || null,
  };
  const points = inv.listEntities({ type: "point", ...dashboardScope });
  const dashboardUrl = telemetry ? telemetry.panelUrl({ dashboard: "stier-building-workspace" }) : null;
  const json = bw.dashboardJson || JSON.stringify(generateBuildingDashboard(snapshot, dashboardScope), null, 2);
  return el("section", { class: "plugin-section" },
    el("div", { class: "section-head" },
      el("h3", {}, "Template Dashboard"),
      el("span", { class: "muted small" }, `${points.length} modeled point${points.length === 1 ? "" : "s"}${floor ? ` on ${floor.name}` : ""}`)),
    el("p", { class: "muted small" },
      dashboardUrl ? "Observability is connected; open Grafana to view provisioned dashboards." : "Ready to chart after the Observability Pack starts; metrics stay in the local ring buffer until then."),
    el("div", { class: "tool-actions" },
      el("button", {
        class: "btn btn-primary",
        onclick: () => {
          bw.dashboardJson = JSON.stringify(generateBuildingDashboard(snapshot, dashboardScope), null, 2);
          logTo("building-workspace", "Generated dashboard JSON from the current model.", "ok");
          bwRenderTabScope();
        },
      }, "Generate dashboard JSON"),
      el("button", { class: "btn-ghost", onclick: () => bwDownload(`building-dashboard-${bacTimestamp()}.json`, json, "application/json;charset=utf-8") }, "Export JSON"),
      dashboardUrl ? el("button", { class: "btn-ghost", onclick: () => openExternal(dashboardUrl) }, "Open Grafana dashboard") : null),
    el("textarea", { class: "nm-input bw-json", rows: "12", readonly: "readonly" }, json));
}

async function bwRunCommissioning(inv) {
  const bacnet = platform ? platform.capability("bacnet.read.v1") : null;
  if (!bacnet) return;
  bw.busy = true;
  bwRenderTabScope();
  try {
    const points = inv.listEntities({ type: "point" });
    const run = await runCommissioning({
      points,
      bacnet,
      writeProperty: async ({ point, ref, value, priority, relinquish }) => bacnet.writeProperty({
        device: point.deviceRef || { deviceInstance: ref.deviceInstance },
        objectType: ref.objectType,
        instance: ref.instance,
        property: 85,
        arrayIndex: null,
        priority,
        value: relinquish ? { kind: "null" } : bwBacnetWriteValue(ref.objectType, value),
      }),
      options: {
        min: bw.cxMin,
        max: bw.cxMax,
        notes: bw.cxNotes,
        commandValue: String(bw.cxCommand ?? "").trim() === "" ? null : Number(bw.cxCommand),
        verify: Boolean(bw.cxVerify),
        toggleVerify: Boolean(bw.cxToggle),
        priority: parseInt(bw.cxPriority, 10) || 8,
      },
    });
    const saved = inv.recordCommissioningRun(run);
    bw.lastRunId = saved.id;
    bwSaveState();
    logTo("building-workspace", `Commissioning finished: ${saved.status}.`, saved.status === "fail" ? "warn" : "ok");
  } catch (err) {
    logTo("building-workspace", `Commissioning failed: ${err}`, "error");
  } finally {
    bw.busy = false;
    bwRenderTabScope();
  }
}

function bwCommissioningTab(inv) {
  const points = bwPointRows(inv);
  const run = bw.lastRunId ? inv.getEntity(bw.lastRunId) : null;
  return el("section", { class: "plugin-section" },
    el("div", { class: "section-head" },
      el("h3", {}, "Commissioning"),
      el("span", { class: "muted small" }, `${points.length} point${points.length === 1 ? "" : "s"} in scope`)),
    el("div", { class: "bac-discover-controls" },
      el("label", { class: "nm-field" }, el("span", { class: "nm-field-label" }, "Min"), el("input", { class: "nm-input bac-range-input", value: bw.cxMin, oninput: (e) => { bw.cxMin = e.target.value; } })),
      el("label", { class: "nm-field" }, el("span", { class: "nm-field-label" }, "Max"), el("input", { class: "nm-input bac-range-input", value: bw.cxMax, oninput: (e) => { bw.cxMax = e.target.value; } })),
      el("button", { class: "btn btn-primary", disabled: bw.busy || points.length === 0 ? "disabled" : undefined, onclick: () => bwRunCommissioning(inv) }, bw.busy ? "Running…" : "Run checks")),
    el("div", { class: "bac-discover-controls bw-cx-command" },
      el("label", { class: "nm-field" }, el("span", { class: "nm-field-label" }, "Command (optional)"),
        el("input", { class: "nm-input bac-range-input", placeholder: "value", value: bw.cxCommand || "", oninput: (e) => { bw.cxCommand = e.target.value; } })),
      el("label", { class: "nm-field" }, el("span", { class: "nm-field-label" }, "Priority"),
        el("select", { class: "nm-input bw-write-priority", onchange: (e) => { bw.cxPriority = e.target.value; } },
          ...Array.from({ length: 16 }, (_, i) => el("option", { value: String(i + 1), selected: String(i + 1) === String(bw.cxPriority || "8") ? "selected" : undefined }, `p${i + 1}`)))),
      el("label", { class: "bw-cx-check" }, el("input", { type: "checkbox", checked: bw.cxVerify ? "checked" : undefined, onchange: (e) => { bw.cxVerify = e.target.checked; } }), el("span", {}, "Verify writes (read back)")),
      el("label", { class: "bw-cx-check" }, el("input", { type: "checkbox", checked: bw.cxToggle ? "checked" : undefined, onchange: (e) => { bw.cxToggle = e.target.checked; } }), el("span", {}, "Toggle binary outputs")),
    ),
    el("p", { class: "muted small" }, "Checks read present-value + range. A command value (or toggle) writes to writable points at the chosen priority, optionally verifies the read-back, then relinquishes."),
    el("textarea", { class: "nm-input bw-notes", rows: "3", placeholder: "Operator notes", oninput: (e) => { bw.cxNotes = e.target.value; } }, bw.cxNotes),
    run
      ? el("ol", { class: "plugin-log" },
          ...(run.steps || []).map((s) => el("li", { class: s.status === "fail" ? "log-error" : s.status === "warn" ? "log-warn" : "log-info" },
            el("span", { class: "log-time" }, s.status),
            el("span", { class: "log-msg" }, `${s.pointName || s.pointId} · ${s.check}${s.value != null ? ` · ${s.value}` : ""}${s.error ? ` · ${s.error}` : ""}`))))
      : el("p", { class: "muted small" }, "No run yet."));
}

function bwReportsTab(inv) {
  const runs = inv.listEntities({ type: "commissioningRun" });
  const run = bw.lastRunId ? inv.getEntity(bw.lastRunId) : runs.at(-1);
  const snapshot = inv.exportSnapshot();
  const md = run ? exportCommissioningMarkdown(snapshot, run) : "";
  const csv = run ? exportCommissioningCsv(run) : "";
  return el("section", { class: "plugin-section" },
    el("div", { class: "section-head" },
      el("h3", {}, "Reports"),
      el("span", { class: "muted small" }, `${runs.length} run${runs.length === 1 ? "" : "s"}`)),
    run
      ? el("div", { class: "tool-actions" },
          el("button", { class: "btn btn-primary", onclick: () => bwDownload(`commissioning-${bacTimestamp()}.md`, md, "text/markdown;charset=utf-8") }, "Export Markdown"),
          el("button", { class: "btn-ghost", onclick: () => bwDownload(`commissioning-${bacTimestamp()}.csv`, csv, "text/csv;charset=utf-8") }, "Export CSV"),
          el("button", { class: "btn-ghost", onclick: () => copyText(md) }, "Copy Markdown"))
      : el("p", { class: "muted small" }, "Run commissioning checks to create a report."),
    run ? el("textarea", { class: "nm-input bw-json", rows: "16", readonly: "readonly" }, md) : null);
}

function bwCurrentTabBody(inv) {
  return bw.tab === "bacnet" ? bwBacnetTab(inv)
    : bw.tab === "historian" ? bwHistorianTab(inv)
    : bw.tab === "dashboard" ? bwDashboardTab(inv)
    : bw.tab === "commissioning" ? bwCommissioningTab(inv)
    : bw.tab === "reports" ? bwReportsTab(inv)
    : bwModelTab(inv);
}

function renderBuildingWorkspacePage() {
  const inv = inventoryInstance();
  const synced = histSyncFromInventory();
  if (synced) histPersist();
  if (!inv) {
    return el("div", { class: "plugin-controls" },
      el("section", { class: "plugin-section" },
        el("p", { class: "muted" }, "Building Workspace unavailable — the platform kernel did not resolve inventory dependencies.")));
  }
  const body = bwCurrentTabBody(inv);
  setTimeout(bwSyncLivePoll, 0); // after this page mounts, sync the live poll to the selection
  return el("div", { id: "bw-root", class: "plugin-controls bw-root" },
    bwTabs(),
    el("div", { id: "bw-tab-body" }, body),
  );
}

// ============================================================================
// Third-party MCP tools (install / page / remove)
// ============================================================================

function mcpStatusPill(m) {
  if (platform && platform.isBooted(m.id)) return { label: "Connected", cls: "pill-running" };
  return { label: "Off", cls: "pill-muted" };
}

function renderMcpToolPage(m) {
  const booted = platform && platform.isBooted(m.id);
  const caps = (m.provides || []).map((p) => `${p.capability}.v${String(p.version).split(".")[0]}`);
  const entry = m.entry || {};
  return el("div", { class: "plugin-controls" },
    el("section", { class: "plugin-section" },
      el("h3", {}, "Third-party MCP tool"),
      el("p", { class: "muted small" },
        booted
          ? "Connected — its capabilities are available to other tools via the kernel."
          : "Not connected — the MCP server failed to start (check the command is installed)."),
      el("p", { class: "muted small" }, `Provides: ${caps.length ? caps.join(", ") : "—"}`),
      el("p", { class: "muted small" }, `Permissions: ${(m.permissions || []).join(", ") || "none"}`),
      el("p", { class: "muted small" }, `Command: ${entry.command || "?"} ${(entry.args || []).join(" ")}`),
      el("div", { class: "tool-actions" },
        el("button", { class: "btn-ghost", onclick: () => mcpRemove(m.id) }, "Remove tool"),
      ),
    ),
  );
}

// Install a kind:"mcp" tool from a pasted manifest: validate, get permission
// approval, persist, then reload so the kernel boots it.
async function mcpInstallFromJson(jsonText) {
  let manifest;
  try { manifest = JSON.parse(jsonText); }
  catch (e) { alert(`Invalid JSON: ${e.message}`); return; }

  const { valid, errors } = validateManifest(manifest);
  if (!valid) { alert(`Invalid manifest:\n${errors.join("\n")}`); return; }
  if (manifest.kind !== "mcp") { alert('Only kind:"mcp" tools can be installed here.'); return; }
  const exists = ALL_MANIFESTS.some((t) => t.id === manifest.id);
  if (exists) { alert(`A tool with id "${manifest.id}" already exists.`); return; }

  // SECURITY: installing an MCP tool runs a native program on every launch, so
  // always require an explicit, command-disclosing confirmation — even when the
  // manifest declares no permissions. This (not the permission list) is the real
  // gate: the user is deciding whether to trust an executable.
  const entry = manifest.entry || {};
  const cmdLine = `${entry.command || "?"} ${(entry.args || []).join(" ")}`.trim();
  const envKeys = entry.env ? Object.keys(entry.env) : [];
  const ok = confirm(
    `Install "${manifest.name}"?\n\n` +
    `⚠ This runs a program on your computer every time the app launches:\n  ${cmdLine}\n` +
    (envKeys.length ? `Environment: ${envKeys.join(", ")}\n` : "") +
    `\nCapabilities it will provide: ${(manifest.provides || []).map((p) => p.capability).join(", ") || "none"}\n` +
    `Permissions requested: ${(manifest.permissions || []).join(", ") || "none"}\n\n` +
    `Only install tools from sources you trust — this is arbitrary code execution.`,
  );
  if (!ok) { alert("Install cancelled."); return; }

  // Record the approved permission set (the command was already consented to above).
  const granted = await approveInstall(manifest, () => true);

  userState.installedTools = [...(userState.installedTools || []), manifest];
  userState.installedGrants = { ...(userState.installedGrants || {}), [manifest.id]: [...granted] };
  saveUserState();
  alert(`Installed "${manifest.name}". The app will reload to start it.`);
  location.reload();
}

async function mcpRemove(id) {
  if (!confirm("Remove this MCP tool?")) return;
  try { await invoke("mcp_stop", { id }); } catch (_) {}
  userState.installedTools = (userState.installedTools || []).filter((t) => t.id !== id);
  const grants = { ...(userState.installedGrants || {}) };
  delete grants[id];
  userState.installedGrants = grants;
  if (currentPluginId() === id) userState.view = "library";
  saveUserState();
  location.reload();
}

// ============================================================================
// Library card (compact)
// ============================================================================

// Shared library affordances, so the card and the list-row can't drift apart.
function toolStarBtn(tool) {
  const fav = isFavorite(tool.id);
  return el("button", {
    class: `star-btn ${fav ? "star-on" : ""}`,
    title: fav ? "Unfavorite" : "Favorite",
    "aria-pressed": fav ? "true" : "false",
    onclick: (e) => { e.stopPropagation(); setFavorite(tool.id, !fav); },
  }, fav ? "★" : "☆");
}

// Compact "hide" affordance — revealed on hover/focus (see .tool-hide in styles.css).
// The whole card/row is the open action, so this replaces the old "Open →" button.
function toolHideBtn(tool) {
  return el("button", {
    class: "tool-hide",
    title: "Hide from library",
    "aria-label": `Hide ${tool.name}`,
    onclick: (e) => { e.stopPropagation(); setHidden(tool.id, true); },
  }, "×");
}

function toolStatusPill(tool) {
  const status = tool.renderStatusPill ? tool.renderStatusPill() : null;
  return status ? el("span", { class: `pill ${status.cls}` }, status.label) : null;
}

function renderToolCard(tool) {
  return el("article",
    {
      class: "tool-card",
      id: `tool-card-${tool.id}`,
      title: tool.tagline || tool.name,
      role: "button",
      tabindex: "0",
      onclick: () => setView(pluginView(tool.id)),
      onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setView(pluginView(tool.id)); } },
    },
    el("div", { class: "tool-icon" }, tool.emoji),
    el("div", { class: "tool-body" },
      el("div", { class: "tool-header" },
        el("h3", {}, tool.name),
        el("div", { class: "card-header-right" },
          toolStatusPill(tool),
          toolStarBtn(tool),
          toolHideBtn(tool),
        ),
      ),
      el("p", { class: "tool-tagline" }, tool.tagline),
    ),
  );
}

// Compact one-line-per-tool row for the list view. The empty-span fallback keeps
// the fixed 6-column grid aligned when a tool has no status pill.
function renderToolRow(tool) {
  return el("li",
    {
      class: "tool-row",
      id: `tool-card-${tool.id}`,
      title: tool.tagline || tool.name,
      role: "button",
      tabindex: "0",
      onclick: () => setView(pluginView(tool.id)),
      onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setView(pluginView(tool.id)); } },
    },
    el("span", { class: "tool-row-icon" }, tool.emoji),
    el("span", { class: "tool-row-name" }, tool.name),
    el("span", { class: "tool-row-tag" }, tool.tagline),
    toolStatusPill(tool) || el("span", {}),
    toolStarBtn(tool),
    toolHideBtn(tool),
  );
}

function renderHiddenRow(tool) {
  return el("li", { class: "hidden-row" },
    el("span", { class: "hidden-row-icon" }, tool.emoji),
    el("span", { class: "hidden-row-name" }, tool.name),
    el("span", { class: "hidden-row-tag" }, "hidden"),
    el("button", { class: "btn-ghost", onclick: () => setHidden(tool.id, false) }, "Restore"),
  );
}

// ============================================================================
// Views
// ============================================================================

function renderLibrary() {
  const root = document.getElementById("view-root");
  root.replaceChildren();

  const visible = TOOLS.filter((t) => !isHidden(t.id));
  const hidden = TOOLS.filter((t) => isHidden(t.id));

  const listView = userState.libraryView === "list";
  const viewToggle = el("div", { class: "lib-toggle", role: "group", "aria-label": "Library layout" },
    el("button", {
      class: listView ? "" : "active",
      title: "Grid view", "aria-pressed": String(!listView),
      onclick: () => setLibraryView("grid"),
    }, "▦ Grid"),
    el("button", {
      class: listView ? "active" : "",
      title: "List view", "aria-pressed": String(listView),
      onclick: () => setLibraryView("list"),
    }, "☰ List"),
  );

  root.appendChild(el("div", { class: "view-header" },
    el("h2", {}, "Library"),
    el("div", { class: "view-header-right" },
      viewToggle,
      el("label", { class: "checkbox-row" },
        el("input", {
          type: "checkbox",
          checked: userState.showHidden ? "checked" : undefined,
          onchange: (e) => setShowHidden(e.target.checked),
        }),
        el("span", {}, `Show hidden (${hidden.length})`),
      ),
    ),
  ));

  if (visible.length === 0) {
    root.appendChild(el("p", { class: "empty-state" },
      hidden.length > 0
        ? "All tools are hidden. Toggle “Show hidden” to restore them."
        : "No tools available.",
    ));
  } else if (listView) {
    const list = el("ul", { class: "tool-list" });
    for (const tool of visible) list.appendChild(renderToolRow(tool));
    root.appendChild(list);
  } else {
    const grid = el("section", { class: "tool-grid" });
    for (const tool of visible) grid.appendChild(renderToolCard(tool));
    root.appendChild(grid);
  }

  if (userState.showHidden && hidden.length > 0) {
    root.appendChild(el("h3", { class: "section-subhead" }, "Hidden"));
    const list = el("ul", { class: "hidden-list" });
    for (const tool of hidden) list.appendChild(renderHiddenRow(tool));
    root.appendChild(list);
  }
}

function setActivityFilter(key, value) {
  userState[key] = value;
  saveUserState();
  renderActivityPage();
}

function clearActivityFiltered() {
  const toolFilter = userState.activityToolFilter || "all";
  const kindFilter = userState.activityKindFilter || "all";
  if (toolFilter === "all" && kindFilter === "all") {
    pluginLogs.clear();
  } else {
    for (const [toolId, entries] of pluginLogs.entries()) {
      if (toolFilter !== "all" && toolId !== toolFilter) continue;
      if (kindFilter === "all") {
        // No kind filter: clear every entry for this tool.
        pluginLogs.delete(toolId);
        continue;
      }
      const remaining = entries.filter((entry) => entry.kind !== kindFilter);
      if (remaining.length) pluginLogs.set(toolId, remaining);
      else pluginLogs.delete(toolId);
    }
  }
  renderActivityPage();
}

function renderActivityPage() {
  const root = document.getElementById("view-root");
  root.replaceChildren();
  const entries = filteredActivityEntries();
  const allEntries = activityEntries();
  const toolFilter = userState.activityToolFilter || "all";
  const kindFilter = userState.activityKindFilter || "all";
  const toolIds = new Set(TOOLS.filter((tool) => !isHidden(tool.id)).map((tool) => tool.id));
  for (const entry of allEntries) toolIds.add(entry.toolId);
  if (toolFilter !== "all") toolIds.add(toolFilter);
  const activityToolIds = [...toolIds].sort((a, b) => activityToolLabel(a).localeCompare(activityToolLabel(b)));
  const kinds = ["ok", "info", "warn", "error"];

  root.appendChild(el("div", { class: "view-header" },
    el("h2", {}, "Activity"),
    el("div", { class: "view-header-right" },
      el("button", { class: "btn-ghost", disabled: allEntries.length ? undefined : "disabled", onclick: clearActivityFiltered }, "Clear"),
    ),
  ));

  root.appendChild(el("section", { class: "plugin-section plugin-section-fill activity-panel" },
    el("div", { class: "activity-controls" },
      el("label", { class: "nm-field activity-filter" },
        el("span", { class: "nm-field-label" }, "Tool"),
        el("select", {
          class: "nm-input",
          onchange: (e) => setActivityFilter("activityToolFilter", e.target.value),
        },
          el("option", { value: "all", selected: toolFilter === "all" ? "selected" : undefined }, "All tools"),
          ...activityToolIds.map((toolId) => {
            const count = allEntries.filter((entry) => entry.toolId === toolId).length;
            return el("option", { value: toolId, selected: toolFilter === toolId ? "selected" : undefined }, `${activityToolLabel(toolId)} (${count})`);
          }))),
      el("label", { class: "nm-field activity-filter" },
        el("span", { class: "nm-field-label" }, "Status"),
        el("select", {
          class: "nm-input",
          onchange: (e) => setActivityFilter("activityKindFilter", e.target.value),
        },
          el("option", { value: "all", selected: kindFilter === "all" ? "selected" : undefined }, "All statuses"),
          ...kinds.map((kind) => {
            const count = allEntries.filter((entry) => entry.kind === kind).length;
            return el("option", { value: kind, selected: kindFilter === kind ? "selected" : undefined }, `${kind} (${count})`);
          })))),
    entries.length === 0
      ? el("p", { class: "muted small activity-empty" }, allEntries.length ? "No activity matches the current filters." : "No activity yet. Use a tool and its events will appear here.")
      : el("ol", { id: "activity-log-list", class: "plugin-log activity-log scroll-fill" },
          ...entries.map(renderActivityLogEntry),
        ),
  ));
}

// ----------------------------------------------------------------------------
// Services & Capabilities — the developer API reference, generated from the live
// capability graph joined with the contract docs (src/platform/service-catalog.js).
// ----------------------------------------------------------------------------

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const prev = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => { btn.textContent = prev; }, 1200);
    }
  } catch (err) {
    console.warn("copyText failed:", err);
  }
}

function serviceBadge(provider) {
  if (provider.category === "service") return { label: "Service", cls: "svc-badge-service" };
  if (provider.category === "app") return { label: "App", cls: "svc-badge-app" };
  return { label: "Provider", cls: "" };
}

function renderCapabilityCard(e) {
  const methods = (e.doc ? e.doc.methods : []).map((m) =>
    el("div", { class: "svc-method" },
      el("code", { class: "svc-method-sig" }, m.sig),
      el("span", { class: "svc-method-ret muted small" }, `→ ${m.returns}`),
      el("p", { class: "svc-method-desc muted small" }, m.desc),
    ),
  );

  const consumers = e.consumers.length
    ? `Used by: ${e.consumers.map((c) => c.name + (c.optional ? " (optional)" : "")).join(", ")}`
    : "Not yet consumed by any tool.";

  return el("div", { class: "svc-cap" },
    el("div", { class: "svc-cap-head" },
      el("code", { class: "svc-cap-ref" }, e.ref),
      el("span", { class: "svc-cap-ver muted small" }, `contract v${e.version}`),
      el("button", {
        class: "btn-ghost svc-copy", title: "Copy the consume-this-capability snippet",
        onclick: (ev) => copyText(e.usage, ev.currentTarget),
      }, "Copy"),
    ),
    e.doc
      ? el("p", { class: "svc-cap-summary" }, e.doc.summary)
      : el("p", { class: "muted small" }, "No contract docs yet — see the provider's source."),
    methods.length ? el("div", { class: "svc-methods" }, ...methods) : null,
    e.doc && e.doc.notes ? el("p", { class: "svc-note small muted" }, `ℹ ${e.doc.notes}`) : null,
    el("details", { class: "svc-usage" },
      el("summary", {}, "How to use"),
      el("pre", { class: "svc-usage-code" }, el("code", {}, e.usage)),
    ),
    el("p", { class: "svc-consumers muted small" }, consumers),
  );
}

function renderServiceProvider(provider, caps) {
  const badge = serviceBadge(provider);
  const head = el("div", { class: "svc-provider-head" },
    el("span", { class: "svc-provider-icon" }, provider.emoji),
    el("div", { class: "svc-provider-titles" },
      el("h3", { class: "svc-provider-name" }, provider.name),
      el("span", { class: `pill svc-badge ${badge.cls}` }, badge.label),
    ),
    provider.permissions.length
      ? el("span", { class: "svc-perms muted small", title: "Permissions this provider holds" },
          `🔑 ${provider.permissions.join(", ")}`)
      : null,
  );
  return el("section", { class: "svc-provider" }, head, ...caps.map(renderCapabilityCard));
}

function renderServicesPage() {
  const root = document.getElementById("view-root");
  root.replaceChildren();

  // Built from ALL_MANIFESTS so installed third-party (mcp) capabilities appear too.
  const { entries } = buildServiceCatalog(ALL_MANIFESTS);

  root.appendChild(el("div", { class: "view-header" },
    el("h2", {}, "Services & Capabilities"),
    el("span", { class: "muted small" }, `${entries.length} capabilities`),
  ));
  root.appendChild(el("p", { class: "services-intro muted" },
    "Every capability a tool exposes is a versioned contract any app or connector can build against. ",
    "Declare it in your manifest's ", el("code", {}, "requires"),
    ", then resolve it from your scoped host with ", el("code", {}, "host.use()"),
    " — you never reach into another tool directly. Provider, version and consumers below are read live from the capability graph.",
  ));

  if (entries.length === 0) {
    root.appendChild(el("p", { class: "empty-state" }, "No capabilities are registered."));
    return;
  }

  // Group capabilities by their provider; list Services before Apps.
  const byProvider = new Map();
  for (const e of entries) {
    if (!byProvider.has(e.provider.id)) byProvider.set(e.provider.id, { provider: e.provider, caps: [] });
    byProvider.get(e.provider.id).caps.push(e);
  }
  const rank = (p) => (p.category === "service" ? 0 : 1);
  const groups = [...byProvider.values()].sort((a, b) =>
    rank(a.provider) - rank(b.provider) || a.provider.name.localeCompare(b.provider.name),
  );
  for (const g of groups) root.appendChild(renderServiceProvider(g.provider, g.caps));
}

// Body for the per-tool "About" modal: the description plus a source link.
function aboutModalBody(tool) {
  const parts = [
    el("p", { class: "modal-desc" }, tool.description || "No description available."),
  ];
  if (tool.repo) {
    parts.push(el("p", { class: "modal-foot" },
      el("a", {
        href: "#",
        onclick: (e) => { e.preventDefault(); openExternal(tool.repo); },
      }, "Source on GitHub →"),
    ));
  }
  return parts;
}

function renderPluginHeaderAddon(tool) {
  if (tool.id === "building-workspace") return bwHeaderBreadcrumb();
  return null;
}

function renderPluginPage(id) {
  const root = document.getElementById("view-root");
  root.replaceChildren();
  const tool = toolById(id);
  if (!tool) {
    root.appendChild(el("p", { class: "empty-state" }, "Unknown plugin."));
    return;
  }
  const status = tool.renderStatusPill ? tool.renderStatusPill() : null;
  const fav = isFavorite(tool.id);
  const headerAddon = renderPluginHeaderAddon(tool);

  root.appendChild(el("nav", { class: "breadcrumb" },
    el("a", {
      href: "#",
      onclick: (e) => { e.preventDefault(); setView("library"); },
    }, "← Library"),
  ));

  const hasAbout = Boolean(tool.description || tool.repo);
  root.appendChild(el("header", { class: "plugin-header" },
    el("div", { class: "plugin-header-left" },
      el("div", { class: "tool-icon plugin-icon" }, tool.emoji),
      el("div", { class: "plugin-header-copy" },
        el("div", { class: "plugin-title-row" },
          el("h2", { class: "plugin-title" }, tool.name),
          hasAbout && el("button", {
            class: "info-btn",
            title: "About this tool",
            "aria-label": `About ${tool.name}`,
            onclick: () => openModal({ title: `About ${tool.name}`, body: aboutModalBody(tool) }),
          }, "ⓘ"),
        ),
        el("p", { class: "plugin-tagline" }, tool.tagline),
        headerAddon,
      ),
    ),
    el("div", { class: "plugin-header-right" },
      status && el("span", { class: `pill ${status.cls}` }, status.label),
      el("button", {
        class: `star-btn ${fav ? "star-on" : ""}`,
        title: fav ? "Unfavorite" : "Favorite",
        "aria-pressed": fav ? "true" : "false",
        onclick: () => setFavorite(tool.id, !fav),
      }, fav ? "★" : "☆"),
    ),
  ));

  // Plugin-specific page body.
  if (tool.renderPage) root.appendChild(tool.renderPage(tool));

  // (The former "About" section now lives behind the ⓘ button in the header.)
}

function renderAccountPage() {
  const root = document.getElementById("view-root");
  root.replaceChildren();

  root.appendChild(el("div", { class: "view-header" },
    el("h2", {}, "Account"),
  ));

  const user = activeAuthUser();
  const org = activeAuthOrg();
  const session = authState && authState.session;
  const userOrgs = session
    ? (authState.orgs || []).filter((o) => o.ownerUserId === session.userId)
    : [];
  const lastSynced = authState && authState.lastSyncedAt
    ? new Date(authState.lastSyncedAt * 1000).toLocaleString()
    : "";
  root.appendChild(el("section", { class: "settings-card" },
    el("h3", {}, "Profile & sync"),
    session
      ? el("div", { class: "settings-stack" },
          el("p", { class: "muted small" },
            "Preferences, last page, installed tools, and workspace state are saved under this local user and organization."),
          el("div", { class: "settings-kv" },
            el("span", { class: "muted small" }, "User"),
            el("strong", {}, user ? user.name : session.userId),
            el("span", { class: "muted small" }, "Email"),
            el("span", {}, user ? user.email : "local"),
            el("span", { class: "muted small" }, "Organization"),
            el("select", {
              class: "nm-input",
              onchange: (e) => authSwitchOrg(e.target.value),
            }, ...userOrgs.map((o) => el("option", {
              value: o.id,
              selected: o.id === session.orgId ? "selected" : undefined,
            }, o.name))),
            el("span", { class: "muted small" }, "Device"),
            el("code", {}, authState.deviceId || session.deviceId),
          ),
          el("div", { class: "settings-inline" },
            el("input", {
              class: "nm-input",
              value: authDraft.newOrgName,
              placeholder: "New organization",
              oninput: (e) => { authDraft.newOrgName = e.target.value; },
              onkeydown: (e) => { if (e.key === "Enter") authCreateOrg(); },
            }),
            el("button", {
              class: "btn-ghost",
              disabled: !authDraft.newOrgName.trim() ? "disabled" : undefined,
              onclick: authCreateOrg,
            }, "Add org"),
          ),
          el("p", { class: "muted small" },
            authState.syncStatus ? authState.syncStatus.message : "Local-first profile."),
          authState.syncFolder && el("div", { class: "settings-kv" },
            el("span", { class: "muted small" }, "Sync folder"),
            el("code", {}, authState.syncFolder),
            lastSynced && el("span", { class: "muted small" }, "Last sync"),
            lastSynced && el("span", {}, lastSynced),
          ),
          authSyncMessage && el("p", { class: "muted small" }, authSyncMessage),
          el("div", { class: "tool-actions" },
            el("button", {
              class: "btn-ghost",
              disabled: authSyncBusy ? "disabled" : undefined,
              onclick: authPickSyncFolder,
            }, authState.syncFolder ? "Change sync folder" : "Choose sync folder"),
            authState.syncFolder && el("button", {
              class: "btn btn-primary",
              disabled: authSyncBusy ? "disabled" : undefined,
              onclick: () => authSyncNow(),
            }, authSyncBusy ? "Syncing..." : "Sync now"),
            authState.syncFolder && el("button", {
              class: "btn-ghost",
              disabled: authSyncBusy ? "disabled" : undefined,
              onclick: authClearSyncFolder,
            }, "Disconnect sync"),
            el("button", { class: "btn-ghost", onclick: authExportSnapshot }, "Copy snapshot"),
            el("button", { class: "btn-ghost", onclick: authSignOut }, "Sign out"),
          ),
        )
      : el("div", { class: "settings-stack" },
          el("p", { class: "muted small" },
            "Create a local profile so app state is scoped by user and organization instead of only browser storage."),
          el("div", { class: "settings-form-grid" },
            el("label", { class: "field-label" },
              "Name",
              el("input", {
                class: "nm-input",
                value: authDraft.name,
                placeholder: "Local User",
                oninput: (e) => { authDraft.name = e.target.value; },
              }),
            ),
            el("label", { class: "field-label" },
              "Email",
              el("input", {
                class: "nm-input",
                value: authDraft.email,
                placeholder: "name@example.com",
                oninput: (e) => { authDraft.email = e.target.value; },
              }),
            ),
            el("label", { class: "field-label" },
              "Organization",
              el("input", {
                class: "nm-input",
                value: authDraft.orgName,
                placeholder: "Personal",
                oninput: (e) => { authDraft.orgName = e.target.value; },
              }),
            ),
          ),
          el("div", { class: "tool-actions" },
            el("button", { class: "btn btn-primary", onclick: authCreateLocalAccount }, "Create local profile"),
            el("button", {
              class: "btn-ghost",
              disabled: authSyncBusy ? "disabled" : undefined,
              onclick: authPickSyncFolder,
            }, authSyncBusy ? "Connecting..." : "Connect sync folder"),
          ),
          authSyncMessage && el("p", { class: "muted small" }, authSyncMessage),
        ),
  ));
}

function renderSettings() {
  const root = document.getElementById("view-root");
  root.replaceChildren();
  const session = authState && authState.session;

  root.appendChild(el("div", { class: "view-header" },
    el("h2", {}, "Settings"),
  ));

  // ===== Third-party tools (MCP) =====
  const installed = userState.installedTools || [];
  const mcpTextarea = el("textarea", {
    class: "nm-input",
    rows: "6",
    style: "width:100%; font-family:monospace; font-size:12px;",
    placeholder: '{ "id": "my-tool", "name": "My Tool", "version": "0.1.0", "apiVersion": "1", "kind": "mcp", "entry": { "transport": "stdio", "command": "my-mcp.exe" }, "provides": [{ "capability": "my.thing", "version": "1.0" }], "permissions": [] }',
  });
  root.appendChild(el("section", { class: "settings-card" },
    el("h3", {}, "Third-party tools (MCP)"),
    el("p", { class: "muted small" },
      "Install a tool that plugs in as an MCP server. Paste its manifest below; you'll approve its permissions, then the app restarts to connect it. Its capabilities become available to other tools."),
    installed.length
      ? el("ul", { class: "hidden-list" },
          ...installed.map((m) => el("li", { class: "hidden-row" },
            el("span", { class: "hidden-row-icon" }, (m.ui && m.ui.emoji) || "🧩"),
            el("span", { class: "hidden-row-name" }, `${m.name} (${m.id})`),
            el("span", { class: "hidden-row-tag" }, platform && platform.isBooted(m.id) ? "connected" : "off"),
            el("button", { class: "btn-ghost", onclick: () => mcpRemove(m.id) }, "Remove"),
          )))
      : el("p", { class: "muted small" }, "No third-party tools installed."),
    mcpTextarea,
    el("div", { class: "tool-actions", style: "margin-top:8px;" },
      el("button", { class: "btn btn-primary", onclick: () => mcpInstallFromJson(mcpTextarea.value) }, "Install MCP tool"),
    ),
  ));

  // ===== Preferences =====
  root.appendChild(el("section", { class: "settings-card" },
    el("h3", {}, "Preferences"),
    el("p", { class: "muted small" },
      session
        ? "Favorites and hidden tools are saved to the active local profile."
        : "Favorites and hidden tools are stored locally in this app.",
    ),
    el("button", {
      class: "btn-ghost",
      onclick: resetPreferences,
    }, "Reset preferences"),
  ));
}

// ============================================================================
// Updater
// ============================================================================

let updateInFlight = false;

function setUpdateStatus(text, kind = "info") {
  const node = document.getElementById("update-status");
  if (!node) return;
  node.textContent = text;
  node.className = `menu-app-version update-status-${kind}`;
}

async function checkForUpdates({ manual = false, silent = false } = {}) {
  if (updateInFlight) return;
  updateInFlight = true;
  try {
    if (!silent) setUpdateStatus("Checking for updates…");
    const update = await updater.check();
    if (!update) {
      if (!silent) setUpdateStatus(`You're on the latest version (v${APP_VERSION}).`, "ok");
      // When triggered off a page without update UI (e.g. the header Account menu),
      // there's no status line to update — surface the result directly.
      if (manual && !document.getElementById("update-status")) {
        alert(`You're on the latest version (v${APP_VERSION}).`);
      }
      return;
    }
    setUpdateStatus(`Update available: v${update.version}. Download will start when confirmed.`, "warn");

    const ok = confirm(
      `A new version is available.\n\n` +
      `Installed: v${APP_VERSION}\n` +
      `Latest:    v${update.version}\n\n` +
      (update.body ? `Notes:\n${update.body}\n\n` : "") +
      `Download and install now?`,
    );
    if (!ok) {
      setUpdateStatus(`Update v${update.version} available. Use "Check for update" to install later.`, "warn");
      return;
    }

    // Show progress bar
    const bar = document.getElementById("update-progress");
    const fill = document.getElementById("update-progress-fill");
    if (bar) bar.style.display = "block";

    let downloaded = 0;
    let total = 0;
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength || 0;
        setUpdateStatus(`Downloading v${update.version}… 0%`);
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength || 0;
        if (total > 0 && fill) {
          const pct = Math.min(100, Math.round((downloaded / total) * 100));
          fill.style.width = `${pct}%`;
          setUpdateStatus(`Downloading v${update.version}… ${pct}%`);
        }
      } else if (event.event === "Finished") {
        setUpdateStatus("Installing… the app will relaunch.", "ok");
      }
    });

    // Installer should relaunch the app on Windows, but force it for safety.
    try {
      await tauriProcess.relaunch();
    } catch (_) {}
  } catch (err) {
    setUpdateStatus(`Update check failed: ${err}`, "error");
    if (manual) {
      alert(`Update check failed:\n${err}`);
    }
  } finally {
    updateInFlight = false;
  }
}

// ============================================================================
// Sidebar
// ============================================================================

function renderSidebar() {
  const favList = document.getElementById("sidebar-favorites");
  favList.replaceChildren();
  const favTools = TOOLS.filter((t) => isFavorite(t.id) && !isHidden(t.id));
  if (favTools.length === 0) {
    favList.appendChild(el("li", { class: "sidebar-empty" },
      "No favorites yet. Tap the star on a tool.",
    ));
  } else {
    for (const tool of favTools) {
      const active = currentPluginId() === tool.id;
      favList.appendChild(el("li", {
        class: `sidebar-fav ${active ? "active" : ""}`,
        onclick: () => setView(pluginView(tool.id)),
        title: tool.name,
      },
        el("span", { class: "sidebar-fav-icon" }, tool.emoji),
        el("span", { class: "sidebar-fav-name" }, tool.name),
      ));
    }
  }

  const view = currentView();
  for (const btn of document.querySelectorAll(".header-nav-item")) {
    btn.classList.toggle(
      "active",
      btn.dataset.view === "library"
        ? (view === "library" || view.startsWith("plugin:"))
        : btn.dataset.view === view,
    );
  }
}

// ============================================================================
// Top-level render
// ============================================================================

let lastRenderedView = "";

function renderScrollTargets() {
  const selectors = [
    "#view-root",
    ".plugin-page",
    ".scroll-fill",
    ".bw-device-inbox-scroll",
    ".bw-tree-list",
    ".activity-log",
    ".bac-table-wrap",
    ".nm-scan-results",
  ];
  return selectors.flatMap((selector) =>
    [...document.querySelectorAll(selector)].map((node, index) => ({ selector, index, node })));
}

function captureRenderUiState() {
  const active = document.activeElement;
  const activeState = active && active !== document.body && active.id
    ? {
        id: active.id,
        start: typeof active.selectionStart === "number" ? active.selectionStart : null,
        end: typeof active.selectionEnd === "number" ? active.selectionEnd : null,
      }
    : null;
  return {
    active: activeState,
    scrolls: renderScrollTargets()
      .filter(({ node }) => node.scrollTop || node.scrollLeft)
      .map(({ selector, index, node }) => ({
        selector,
        index,
        top: node.scrollTop,
        left: node.scrollLeft,
      })),
  };
}

function restoreRenderUiState(state) {
  if (!state) return;
  for (const item of state.scrolls || []) {
    const node = document.querySelectorAll(item.selector)[item.index];
    if (!node) continue;
    node.scrollTop = item.top;
    node.scrollLeft = item.left;
  }
  if (state.active?.id) {
    const active = document.getElementById(state.active.id);
    if (active && typeof active.focus === "function") {
      active.focus({ preventScroll: true });
      if (state.active.start != null && typeof active.setSelectionRange === "function") {
        active.setSelectionRange(state.active.start, state.active.end ?? state.active.start);
      }
    }
  }
}

function renderHeaderBreadcrumb() {
  const bc = document.getElementById("header-breadcrumb");
  if (!bc) return;
  bc.replaceChildren();
  const view = currentView();
  if (view === "settings") {
    bc.appendChild(el("span", { class: "crumb-current" }, "Settings"));
  } else if (view === "account") {
    bc.appendChild(el("span", { class: "crumb-current" }, "Account"));
  } else if (view === "services") {
    bc.appendChild(el("span", { class: "crumb-current" }, "Services & Capabilities"));
  } else if (view === "activity") {
    bc.appendChild(el("span", { class: "crumb-current" }, "Activity"));
  } else if (view.startsWith("plugin:")) {
    const id = view.slice("plugin:".length);
    const tool = TOOLS.find((t) => t.id === id);
    bc.appendChild(el("a", {
      class: "crumb-link", href: "#",
      onclick: (e) => { e.preventDefault(); setView("library"); },
    }, "Library"));
    bc.appendChild(el("span", { class: "crumb-sep" }, "›"));
    bc.appendChild(el("span", { class: "crumb-current" },
      tool ? `${tool.emoji} ${tool.name}` : id));
  } else {
    bc.appendChild(el("span", { class: "crumb-current" }, "Library"));
  }
}

function renderChrome() {
  renderSidebar();
  const view = currentView();
  renderHeaderBreadcrumb();
  document.getElementById("header-account-menu")?.classList.toggle(
    "active",
    view === "account" || view === "settings" || view === "services",
  );
}

function renderCurrentPage() {
  const view = currentView();
  if (view === "settings") renderSettings();
  else if (view === "account") renderAccountPage();
  else if (view === "services") renderServicesPage();
  else if (view === "activity") renderActivityPage();
  else if (view.startsWith("plugin:")) renderPluginPage(view.slice("plugin:".length));
  else renderLibrary();
}

function renderScoped(scope = "page") {
  if (scope === "chrome") {
    renderChrome();
    return;
  }
  if (scope === "building-workspace") {
    bwRenderWorkspaceScope();
    return;
  }
  if (scope === "building-workspace:tab") {
    bwRenderTabScope();
    return;
  }
  if (scope === "building-workspace:model") {
    bwRenderModelScope({ tree: true, details: true, header: true });
    return;
  }
  if (scope === "building-workspace:inbox") {
    bwRenderInboxScope();
    return;
  }
  if (scope === "all") {
    renderAll();
    return;
  }
  const view = currentView();
  const uiState = view === lastRenderedView ? captureRenderUiState() : null;
  renderCurrentPage();
  lastRenderedView = view;
  if (uiState) requestAnimationFrame(() => restoreRenderUiState(uiState));
}

function renderAll() {
  const view = currentView();
  const uiState = view === lastRenderedView ? captureRenderUiState() : null;
  renderChrome();
  renderCurrentPage();
  lastRenderedView = view;
  if (uiState) requestAnimationFrame(() => restoreRenderUiState(uiState));
}

let startupWarmupApplied = false;
const startupDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function applyStartupWarmupStatus(status) {
  if (!status || startupWarmupApplied) return false;
  let changed = false;
  if (status.network) changed = (await nmApplyStartupSnapshot(status.network)) || changed;
  changed = (await obsApplyStartupStatus(status)) || changed;
  if (!status.running) startupWarmupApplied = true;
  if (changed) renderAll();
  return changed;
}

async function hydrateFromStartupWarmup({ waitMs = 12000 } = {}) {
  const started = Date.now();
  while (Date.now() - started <= waitMs) {
    let status = null;
    try {
      status = await invoke("app_startup_status");
    } catch (_) {
      return;
    }
    await applyStartupWarmupStatus(status);
    if (!status || !status.running) break;
    await startupDelay(400);
  }
  if (pack && !obsHealth) {
    await obsRefreshHealth();
  } else if (!obsHealth) {
    obsHealthChecking = false;
    obsHealthMessage = "Startup health check did not complete.";
    renderAll();
  }
}

// ============================================================================
// Tauri event wiring
// ============================================================================

listen("clipboardtyper:state", (event) => {
  const p = event.payload;
  // Skip the re-render when this is just the echo of our own settings push —
  // otherwise editing a rule field would lose focus mid-keystroke. Still
  // re-render on external settings changes or enable/arm changes.
  const settingsSame = JSON.stringify(p.settings) === JSON.stringify(ctPending);
  const liveSame = p.running === ct.running && p.armed === ct.armed;
  ct = p;
  if (!settingsSame) ctPending = ctClonePending(p.settings);
  if (!settingsSame || !liveSame) renderAll();
});

listen("clipboardtyper:typed", (event) => {
  const { chars, error } = event.payload;
  if (error) logTo("clipboardtyper", `Typing failed: ${error}`, "error");
  else logTo("clipboardtyper", `Sent ${chars} char${chars === 1 ? "" : "s"} locally.`, "ok");
});

// ============================================================================
// Bootstrap
// ============================================================================

// Cancel any live COV subscription if the webview is torn down (reload, close),
// so the backend keep-alive thread doesn't orphan. Best-effort and synchronous-
// ish; the backend also self-terminates the keep-alive after repeated failures.
window.addEventListener("pagehide", () => {
  flushUserStatePersistence();
  bwStopLivePoll();
  if (packFlushTimer) {
    clearInterval(packFlushTimer);
    packFlushTimer = null;
  }
  if (nmSaveTimer) {
    clearTimeout(nmSaveTimer);
    nmSaveTimer = null;
    nmSaveNow().catch((err) => console.warn("[networkmanager] final profile save failed:", err));
  }
  if (bac.cov.processId != null && bac.cov.objectKey) {
    const dev = bacSelectedDevice();
    const [t, i] = bac.cov.objectKey.split(":").map((n) => parseInt(n, 10));
    if (dev) {
      bacnetRead().unsubscribeCov({
        device: bacDeviceRef(dev), objectType: t, instance: i, processId: bac.cov.processId,
      }).catch(() => {});
    }
  }
});

window.addEventListener("DOMContentLoaded", async () => {
  for (const btn of document.querySelectorAll(".header-nav-item")) {
    btn.addEventListener("click", () => setView(btn.dataset.view));
  }

  document
    .getElementById("sidebar-toggle")
    ?.addEventListener("click", () => setSidebarCollapsed(!userState.sidebarCollapsed));
  applySidebarCollapsed();

  // App-header actions
  document.querySelector(".app-header")?.appendChild(buildAccountMenu());
  document.getElementById("header-account-menu")?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleAccountMenu();
  });

  // Custom titlebar window controls (native window decorations are disabled,
  // so the app header doubles as the titlebar — drag via data-tauri-drag-region).
  const appWindow = window.__TAURI__.window.getCurrentWindow();
  const MAX_ICON =
    '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1"/></svg>';
  const RESTORE_ICON =
    '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1"/><path d="M2.5 2.5V0.5H9.5V7.5H7.5" fill="none" stroke="currentColor" stroke-width="1"/></svg>';
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

  await authBootstrapUserState();
  applySidebarCollapsed();

  try {
    const s = await invoke("clipboardtyper_get_state");
    ct = s;
    ctPending = ctClonePending(s.settings);
  } catch (err) {
    logTo("clipboardtyper", `Could not read state: ${err}`, "error");
  }

  // Boot the platform kernel: validate the tool manifests, resolve the
  // capability dependency graph, and register native capability implementations
  // (network.adapters, netscan, media.convert, bacnet.read, …). Defensive — a
  // kernel failure must never take down the rest of the UI.
  try {
    telemetry = createTimeseries();
    scheduler = createScheduler();
    rebuildCatalog();
    const installed = ALL_MANIFESTS.filter((m) => m.kind === "mcp");
    const factories = new Map([
      ...buildFactories(invoke, { timeseries: telemetry, scheduler, inventoryStorage: createAppInventoryStorage() }),
      ...buildMcpFactories(invoke, installed),
    ]);
    const installGrants = new Map(
      Object.entries(userState.installedGrants || {}).map(([id, perms]) => [id, new Set(perms)]),
    );
    platform = createKernel({
      manifests: ALL_MANIFESTS,
      factories,
      grant: grantsFromInstall(installGrants),
      onLog: (e) => console.debug(`[platform:${e.toolId}] ${e.msg}`),
    });
    const res = await platform.boot();
    if (!res.ok) console.warn("[platform] capability graph issues:", res.errors);

    // Observability Pack controller. The service starts degraded (ring buffer);
    // connecting attaches the live InfluxDB transport. The periodic flush is a
    // no-op until then, so it's safe to run unconditionally.
    pack = createPackController({ invoke, timeseries: telemetry });
    packFlushTimer = setInterval(() => { pack.flush().catch(() => {}); }, 10000);

    // Granular per-component install progress (download %, rate, ETA, extract…)
    // from the Rust downloader, rendered as a live progress bar.
    listen("observability://install", (e) => {
      obsProgress = e.payload || null;
      if (currentPluginId() === "observability") renderAll();
    });

    // Restore any previously-configured Historian points + resume logging.
    histRestore();

    // Passive pack-update check: surface in the Observability activity log if an
    // app update bumped a pinned component version past what's installed.
    pack.packStatus()
      .then((s) => {
        obsPack = s;
        if (s && s.updatesAvailable) {
          const outdated = (s.components || []).filter((c) => c.present && c.needsUpdate)
            .map((c) => `${OBS_COMPONENT_NAMES[c.name] || c.name} ${c.installedVersion}→${c.pinnedVersion}`).join(", ");
          logTo("observability", `Pack update available: ${outdated}. Open Observability → "Update & restart pack".`, "info");
        }
      })
      .catch(() => {});
  } catch (err) {
    console.error("[platform] kernel boot failed:", err);
  }

  // Load saved network profiles up front, then hydrate from the native startup
  // warmup if it already refreshed adapters / started the Observability Pack.
  await nmLoadProfiles();
  hydrateFromStartupWarmup().catch((err) => console.warn("[startup] warmup hydrate failed:", err));

  renderAll();

  // Background update check on launch. Runs silently — only surfaces a
  // prompt when an update is found.
  setTimeout(() => { checkForUpdates({ silent: true }).catch(() => {}); }, 2500);
});
