// Persistent UI preferences and local profile / folder sync.

export const STORAGE_KEY = "microtools.user_state.v2";

export function normalizeUserState(stored = {}) {
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

function hasMeaningfulSavedState(value) {
  return value && typeof value === "object" && Object.keys(value).length > 0;
}

/**
 * @param {object} deps
 * @param {typeof import("./tauri.js").invoke} deps.invoke
 * @param {() => Promise<string|null>} deps.pickFolder
 * @param {() => void} deps.renderAll
 * @param {() => Array<object>} deps.getAllManifests
 * @param {() => void} deps.onCatalogRebuild
 * @param {() => void} deps.onScopedStateReload
 * @param {() => void} deps.onBeforeViewChange
 */
export function createUserStateManager({
  invoke,
  pickFolder,
  renderAll,
  getAllManifests,
  onCatalogRebuild,
  onScopedStateReload,
  onBeforeViewChange,
}) {
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

  function saveUserState() {
    userState._persistedAt = Date.now();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(userState));
    queueAuthUserStateSave();
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

  function getAuthState() { return authState; }
  function getAuthSyncBusy() { return authSyncBusy; }
  function getAuthSyncMessage() { return authSyncMessage; }
  function hasAuthSession() { return Boolean(authState && authState.session); }

  function activeAuthUser() {
    if (!authState || !authState.session) return null;
    return (authState.users || []).find((u) => u.id === authState.session.userId) || null;
  }

  function activeAuthOrg() {
    if (!authState || !authState.session) return null;
    return (authState.orgs || []).find((o) => o.id === authState.session.orgId) || null;
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
      onCatalogRebuild();
      onScopedStateReload();
    } else if (migrateIfEmpty) {
      await invoke("auth_save_user_state", { userId: null, orgId: null, state: userState });
      onScopedStateReload();
    } else {
      Object.assign(userState, normalizeUserState({}));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(userState));
      onScopedStateReload();
    }
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

  async function authCreateLocalAccount() {
    const name = authDraft.name.trim();
    const email = authDraft.email.trim();
    const orgName = authDraft.orgName.trim();
    try {
      authState = await invoke("auth_create_local_session", { name, email, orgName });
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
      const folder = await pickFolder();
      if (!folder) {
        authSyncBusy = false;
        authSyncMessage = "";
        renderAll();
        return;
      }
      authState = await invoke("auth_set_sync_folder", { folder });
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

  function isDefaultHidden(id) {
    const manifest = getAllManifests().find((m) => m.id === id);
    return Boolean(manifest?.ui?.defaultHidden);
  }

  function isFavorite(id) { return Boolean(userState.favorites[id]); }

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
      if (currentPluginId() === id) userState.view = "library";
    } else {
      if (isDefaultHidden(id)) userState.hidden[id] = false;
      else delete userState.hidden[id];
    }
    saveUserState();
    renderAll();
  }

  function setView(view) {
    onBeforeViewChange();
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

  return {
    userState,
    authDraft,
    saveUserState,
    flushUserStatePersistence,
    getAuthState,
    getAuthSyncBusy,
    getAuthSyncMessage,
    hasAuthSession,
    activeAuthUser,
    activeAuthOrg,
    authBootstrapUserState,
    authCreateLocalAccount,
    authSwitchOrg,
    authCreateOrg,
    authSignOut,
    authExportSnapshot,
    authPickSyncFolder,
    authClearSyncFolder,
    authSyncNow,
    resetPreferences,
    isFavorite,
    isHidden,
    setFavorite,
    setHidden,
    setView,
    applySidebarCollapsed,
    setSidebarCollapsed,
    currentView,
    currentPluginId,
    pluginView,
  };
}
