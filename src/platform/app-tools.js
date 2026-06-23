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
  createHomeUi,
  createServicesPageUi,
  createAccountPageUi,
  createSettingsPageUi,
  createPluginPageUi,
  createAppShell,
} from "../ui/index.js";
import { createClipboardTyperUi } from "../tools/ui/clipboardtyper.js";
import { createHeicMovUi } from "../tools/ui/heicmov.js";
import { createNetworkManagerUi } from "../tools/ui/networkmanager.js";
import { createBacnetManagerUi } from "../tools/ui/bacnetmanager.js";
import { createObservabilityUi } from "../tools/ui/observability.js";
import { createBuildingWorkspaceUi } from "../tools/ui/buildingworkspace.js";
import { createBacnetHistorianUi } from "../tools/ui/bacnethistorian.js";
import { createDeviceGraphicsUi } from "../tools/ui/devicegraphics.js";
import { createBuildingAnalyticsUi } from "../tools/ui/buildinganalytics.js";
import { createAlarmConsoleUi } from "../tools/ui/alarmconsole.js";
import { createDeviceManagerUi } from "../tools/ui/devicemanager.js";

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
  let bacnetManager = null;
  let buildingWorkspace = null;
  let bacnetHistorian = null;
  let deviceGraphics = null;
  let buildingAnalytics = null;
  let alarmConsole = null;
  let deviceManager = null;

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
    onBeforeViewChange: () => { buildingWorkspace?.stopLivePoll(); deviceGraphics?.stopPoll(); },
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
    getRecentTools,
    touchRecentTool,
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
    renderChrome: () => appUi.renderScoped("chrome"),
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
  const observability = createObservabilityUi({
    invoke, listen, el, logTo, renderAll: () => appUi.renderAll(),
    getPack: () => pack, getTelemetry, currentPluginId,
  });
  bacnetManager = createBacnetManagerUi({
    invoke, listen, el, logTo, renderAll: () => appUi.renderAll(),
    renderScoped: (scope) => appUi.renderScoped(scope),
    networkManager, platformHost, userState, saveUserState, currentPluginId,
    getInventory: () => (platform ? platform.capability("inventory.v1") : null),
    setView, pluginView,
  });
  bacnetHistorian = createBacnetHistorianUi({
    el, logTo, renderAll: () => appUi.renderAll(),
    userState, saveUserState,
    getPlatform: () => platform,
    getInventory: () => (platform ? platform.capability("inventory.v1") : null),
    bacnetManager, getBuildingWorkspace: () => buildingWorkspace, listen,
  });
  buildingWorkspace = createBuildingWorkspaceUi({
    invoke, el, logTo,
    renderAll: () => appUi.renderAll(),
    renderScoped: (scope) => appUi.renderScoped(scope),
    userState, saveUserState, getPlatform: () => platform,
    networkManager, setView, pluginView, currentPluginId, listen,
    getPack: () => pack, getTelemetry,
    getHistorian: () => bacnetHistorian.getInstance(),
    histSyncFromInventory: () => bacnetHistorian.syncFromInventory(),
    histPersist: () => bacnetHistorian.persist(),
  });
  deviceGraphics = createDeviceGraphicsUi({
    el, logTo, renderAll: () => appUi.renderAll(),
    getPlatform: () => platform,
    getInventory: () => (platform ? platform.capability("inventory.v1") : null),
    currentPluginId, userState, saveUserState,
  });
  buildingAnalytics = createBuildingAnalyticsUi({
    el, logTo, renderAll: () => appUi.renderAll(),
    getPlatform: () => platform,
    getInventory: () => (platform ? platform.capability("inventory.v1") : null),
    userState, saveUserState, setView, pluginView,
  });
  alarmConsole = createAlarmConsoleUi({
    el, logTo, renderAll: () => appUi.renderAll(),
    getPlatform: () => platform,
    getInventory: () => (platform ? platform.capability("inventory.v1") : null),
    userState, saveUserState,
  });
  deviceManager = createDeviceManagerUi({
    el, logTo, renderAll: () => appUi.renderAll(),
    getPlatform: () => platform,
    getInventory: () => (platform ? platform.capability("inventory.v1") : null),
    userState, saveUserState,
  });

  Object.assign(TOOL_RENDERERS, {
    clipboardtyper: { renderStatusPill: clipboardTyper.renderStatusPill, renderPage: clipboardTyper.renderPage },
    heicmov: { renderStatusPill: heicMov.renderStatusPill, renderPage: heicMov.renderPage },
    networkmanager: { renderStatusPill: networkManager.renderStatusPill, renderPage: networkManager.renderPage },
    "bacnet-manager": { renderStatusPill: bacnetManager.renderStatusPill, renderPage: bacnetManager.renderPage },
    observability: { renderStatusPill: observability.renderStatusPill, renderPage: observability.renderPage },
    "building-workspace": { renderStatusPill: buildingWorkspace.renderStatusPill, renderPage: buildingWorkspace.renderPage },
    "bacnet-historian": { renderStatusPill: bacnetHistorian.renderStatusPill, renderPage: bacnetHistorian.renderPage },
    "device-graphics": { renderStatusPill: deviceGraphics.renderStatusPill, renderPage: deviceGraphics.renderPage },
    "building-analytics": { renderStatusPill: buildingAnalytics.renderStatusPill, renderPage: buildingAnalytics.renderPage },
    "alarm-console": { renderStatusPill: alarmConsole.renderStatusPill, renderPage: alarmConsole.renderPage },
    "device-manager": { renderStatusPill: deviceManager.renderStatusPill, renderPage: deviceManager.renderPage },
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
    toolById, getRecentTools,
  });
  const getSystemStatus = () => {
    const obsPill = observability.renderStatusPill?.() || { label: "—", cls: "pill-muted" };
    const histPill = bacnetHistorian.renderStatusPill?.() || { label: "—", cls: "pill-muted" };
    const inv = inventoryInstance();
    const sites = inv ? inv.listEntities({ type: "site" }).length : 0;
    const points = inv ? inv.listEntities({ type: "point" }).length : 0;
    const bootedCount = platform
      ? ALL_MANIFESTS.filter((m) => platform.isBooted(m.id)).length
      : 0;
    const manifestCount = ALL_MANIFESTS.length;
    return {
      observability: {
        label: obsPill.label,
        cls: obsPill.cls,
        detail: observability.getHealthState?.().message || "Timeseries and optional Observability Pack.",
      },
      historian: {
        label: histPill.label,
        cls: histPill.cls,
        detail: histPill.label === "Logging" ? "BACnet points are being historized." : "Historian idle or not configured.",
      },
      inventory: {
        label: points ? `${points} pts` : sites ? `${sites} site${sites === 1 ? "" : "s"}` : "Empty",
        cls: points ? "pill-running" : sites ? "pill-idle" : "pill-muted",
        detail: sites
          ? `${sites} site${sites === 1 ? "" : "s"}, ${points} modeled point${points === 1 ? "" : "s"}.`
          : "Import BACnet devices in Building Workspace to start modeling.",
      },
      platform: {
        label: platform ? (bootedCount === manifestCount ? "Ready" : "Issues") : "Booting",
        cls: !platform ? "pill-muted" : bootedCount === manifestCount ? "pill-running" : "pill-warn",
        detail: platform ? `${bootedCount} of ${manifestCount} tools booted.` : "Platform kernel not ready.",
      },
    };
  };
  const home = createHomeUi({
    el,
    appVersion,
    getTools: () => TOOLS,
    isFavorite,
    isHidden,
    toolById,
    getRecentTools,
    setView,
    pluginView,
    getActivitySummary: () => activity.activitySummary(),
    getSystemStatus,
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
      home,
      library,
      settings: settingsPage,
      account: accountPage,
      services: servicesPage,
      activity,
      plugin: pluginPage,
    },
    getBuildingWorkspace: () => buildingWorkspace,
    getBacnetManager: () => bacnetManager,
    getActivitySummary: () => activity.activitySummary(),
    getSystemStatus,
    getRecentTools,
    toolById,
  });

  return {
    renderAll: appShell.renderAll,
    renderScoped: appShell.renderScoped,
    checkForUpdates: appShell.checkForUpdates,
    getTools: () => TOOLS,
    isHidden,
    pluginView,
    userState,
    saveUserState,
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
    get bacnetManager() { return bacnetManager; },
    get networkManager() { return networkManager; },
    get observability() { return observability; },
  };
}
