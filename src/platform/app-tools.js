// Tool catalog, first-party UI factories, and app shell assembly.

import { TOOL_MANIFESTS } from "../tools/manifests.js";
import { validateManifest } from "./manifest.js";
import { createUserStateInventoryStorage } from "../tools/inventory.js";
import { createUserStateManager } from "./user-state.js";
import {
  el,
  pickHeicMovFiles,
  pickFolder,
  createActivityLog,
  createLibraryUi,
  createServicesPageUi,
  createAccountPageUi,
  createSettingsPageUi,
  createPluginPageUi,
  createAppShell,
} from "../ui/index.js";
import { createClipboardTyperUi } from "../tools/ui/clipboardtyper.js";
import { createHeicMovUi } from "../tools/ui/heicmov.js";
import { createNetworkManagerUi } from "../tools/ui/networkmanager.js";
import { createBacnetUi } from "../tools/ui/bacnet.js";
import { createObservabilityUi } from "../tools/ui/observability.js";
import { createBuildingWorkspaceUi } from "../tools/ui/buildingworkspace.js";
import { createBacnetHistorianUi } from "../tools/ui/bacnethistorian.js";

/**
 * @param {object} deps
 * @param {{ renderAll(): void, renderScoped(scope?: string): void }} deps.appUi
 * @param {typeof import("./tauri.js").invoke} deps.invoke
 * @param {typeof import("./tauri.js").listen} deps.listen
 * @param {typeof import("./tauri.js").convertFileSrc} deps.convertFileSrc
 * @param {string} deps.appVersion
 * @param {() => object|null} [deps.getTelemetry]
 */
export function createApplication({ appUi, invoke, listen, convertFileSrc, appVersion, getTelemetry = () => null }) {
  const TOOL_RENDERERS = {};
  let pluginPage = null;

  let platform = null;
  let pack = null;
  let packFlushTimer = null;
  let buildingWorkspace = null;
  let bacnetHistorian = null;

  let ALL_MANIFESTS = [...TOOL_MANIFESTS];
  let TOOLS = [];

  function manifestToTool(m) {
    let renderers = TOOL_RENDERERS[m.id];
    if (!renderers && m.kind === "mcp" && pluginPage) {
      renderers = pluginPage.mcpToolRenderers(m);
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

  function rebuildCatalog() {
    const installed = (userState.installedTools || []).filter((m) => validateManifest(m).valid);
    ALL_MANIFESTS = [...TOOL_MANIFESTS, ...installed];
    TOOLS = ALL_MANIFESTS.map(manifestToTool).filter((t) => t.renderPage);
  }

  function toolById(id) { return TOOLS.find((t) => t.id === id); }

  function platformHost(toolId) {
    try { return platform ? platform.hostFor(toolId) : null; }
    catch (_) { return null; }
  }

  function inventoryInstance() {
    return platform ? platform.capability("inventory.v1") : null;
  }

  function applyScopedUserState() {
    rebuildCatalog();
    buildingWorkspace?.restoreState();
    applySidebarCollapsed();
    inventoryInstance()?.reload?.();
    bacnetHistorian?.restore({ replace: true });
  }

  const userStateApi = createUserStateManager({
    invoke,
    pickFolder,
    renderAll: () => appUi.renderAll(),
    getAllManifests: () => ALL_MANIFESTS,
    onCatalogRebuild: rebuildCatalog,
    onScopedStateReload: applyScopedUserState,
    onBeforeViewChange: () => buildingWorkspace?.stopLivePoll(),
  });

  const {
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
  } = userStateApi;

  rebuildCatalog();

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

  function activityToolLabel(toolId) {
    const tool = toolById(toolId) || ALL_MANIFESTS.map(manifestToTool).find((t) => t.id === toolId);
    return tool ? `${tool.emoji || ""} ${tool.name}`.trim() : toolId;
  }

  const activity = createActivityLog({
    el,
    getUserState: () => userState,
    saveUserState,
    currentView,
    getTools: () => TOOLS,
    isHidden,
    toolLabel: activityToolLabel,
  });
  const logTo = activity.logTo;

  const clipboardTyper = createClipboardTyperUi({
    invoke, el, logTo, renderAll: () => appUi.renderAll(),
  });
  const heicMov = createHeicMovUi({
    invoke, convertFileSrc, el, logTo, renderAll: () => appUi.renderAll(),
    pickHeicMovFiles, pickFolder,
  });
  const networkManager = createNetworkManagerUi({
    invoke, listen, el, logTo, renderAll: () => appUi.renderAll(),
    userState, saveUserState, currentPluginId,
  });
  const bacnet = createBacnetUi({
    invoke, listen, el, logTo, renderAll: () => appUi.renderAll(),
    networkManager, platformHost, userState, saveUserState, currentPluginId,
    getInventory: () => (platform ? platform.capability("inventory.v1") : null),
    getBuildingWorkspace: () => buildingWorkspace,
    getInboxQueuedCount: () => buildingWorkspace?.getInboxQueuedCount?.() ?? 0,
  });
  const observability = createObservabilityUi({
    invoke, listen, el, logTo, renderAll: () => appUi.renderAll(),
    getPack: () => pack, getTelemetry, currentPluginId,
  });
  bacnetHistorian = createBacnetHistorianUi({
    el, logTo, renderAll: () => appUi.renderAll(),
    userState, saveUserState,
    getPlatform: () => platform,
    getInventory: () => (platform ? platform.capability("inventory.v1") : null),
    bacnet, getBuildingWorkspace: () => buildingWorkspace,
  });
  buildingWorkspace = createBuildingWorkspaceUi({
    invoke, el, logTo,
    renderAll: () => appUi.renderAll(),
    renderScoped: (scope) => appUi.renderScoped(scope),
    userState, saveUserState, getPlatform: () => platform,
    networkManager, bacnet, setView, pluginView, currentPluginId,
    getPack: () => pack, getTelemetry,
    getHistorian: () => bacnetHistorian.getInstance(),
    histSyncFromInventory: () => bacnetHistorian.syncFromInventory(),
    histPersist: () => bacnetHistorian.persist(),
  });

  Object.assign(TOOL_RENDERERS, {
    clipboardtyper: { renderStatusPill: clipboardTyper.renderStatusPill, renderPage: clipboardTyper.renderPage },
    heicmov: { renderStatusPill: heicMov.renderStatusPill, renderPage: heicMov.renderPage },
    networkmanager: { renderStatusPill: networkManager.renderStatusPill, renderPage: networkManager.renderPage },
    bacnet: { renderStatusPill: bacnet.renderStatusPill, renderPage: bacnet.renderPage },
    observability: { renderStatusPill: observability.renderStatusPill, renderPage: observability.renderPage },
    "building-workspace": { renderStatusPill: buildingWorkspace.renderStatusPill, renderPage: buildingWorkspace.renderPage },
    "bacnet-historian": { renderStatusPill: bacnetHistorian.renderStatusPill, renderPage: bacnetHistorian.renderPage },
  });
  rebuildCatalog();
  clipboardTyper.bindEvents(listen);

  const settingsPage = createSettingsPageUi({
    invoke, el,
    getUserState: () => userState,
    saveUserState,
    getAllManifests: () => ALL_MANIFESTS,
    getPlatform: () => platform,
    currentPluginId,
    hasAuthSession,
    resetPreferences,
  });

  pluginPage = createPluginPageUi({
    el, toolById, isFavorite, setFavorite, setView, pluginView,
    headerAddonFor: (tool) => (tool.id === "building-workspace" ? buildingWorkspace.headerBreadcrumb() : null),
    getPlatform: () => platform,
    mcpRemove: (id) => settingsPage.mcpRemove(id),
  });
  rebuildCatalog();

  const library = createLibraryUi({
    el, getUserState: () => userState, saveUserState, getTools: () => TOOLS,
    isFavorite, isHidden, setFavorite, setHidden, setView, pluginView,
  });
  const servicesPage = createServicesPageUi({ el, getAllManifests: () => ALL_MANIFESTS });
  const accountPage = createAccountPageUi({
    el, getAuthState, activeAuthUser, activeAuthOrg, authDraft,
    getAuthSyncBusy, getAuthSyncMessage,
    authCreateLocalAccount, authSwitchOrg, authCreateOrg, authSignOut,
    authExportSnapshot, authPickSyncFolder, authClearSyncFolder, authSyncNow,
    renderAll: () => appUi.renderAll(),
  });

  const appShell = createAppShell({
    appVersion,
    getTools: () => TOOLS,
    isFavorite, isHidden, setView, pluginView, currentView, currentPluginId,
    applySidebarCollapsed, setSidebarCollapsed,
    pages: {
      library,
      settings: settingsPage,
      account: accountPage,
      services: servicesPage,
      activity,
      plugin: pluginPage,
    },
    getBuildingWorkspace: () => buildingWorkspace,
  });

  return {
    renderAll: appShell.renderAll,
    renderScoped: appShell.renderScoped,
    checkForUpdates: appShell.checkForUpdates,
    userState,
    logTo,
    rebuildCatalog,
    getAllManifests: () => ALL_MANIFESTS,
    createAppInventoryStorage,
    flushUserStatePersistence,
    getAuthState,
    activeAuthUser,
    activeAuthOrg,
    authBootstrapUserState,
    authSignOut,
    setView,
    setSidebarCollapsed,
    applySidebarCollapsed,
    setPlatform: (p) => { platform = p; },
    setPack: (p) => { pack = p; },
    getPack: () => pack,
    getPackFlushTimer: () => packFlushTimer,
    setPackFlushTimer: (timer) => { packFlushTimer = timer; },
    tools: { clipboardTyper, networkManager, observability, bacnetHistorian },
    get buildingWorkspace() { return buildingWorkspace; },
    get bacnet() { return bacnet; },
    get networkManager() { return networkManager; },
    get observability() { return observability; },
  };
}
