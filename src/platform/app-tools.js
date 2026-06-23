// Tool catalog, first-party UI factories, and app shell assembly.

import { mount } from "svelte";
import ContentRoot from "../ui/components/ContentRoot.svelte";
import CommandPalette from "../ui/components/CommandPalette.svelte";
import Sidebar from "../ui/components/Sidebar.svelte";
import Breadcrumb from "../ui/components/Breadcrumb.svelte";
import { TOOL_MANIFESTS } from "../tools/manifests.js";
import { validateManifest } from "./manifest.js";
import { createSqlInventoryStorage } from "./services/inventory-sql-storage.js";
import { createUserStateManager } from "./user-state.js";
import {
  renderAll as renderAllBridge,
  renderScoped as renderScopedBridge,
  configureRenderBridge,
} from "./render-bridge.js";
import { registerScopedRenderer } from "./scope-registry.js";
import {
  systemStatus as systemStatusStore,
  activitySummary as activitySummaryStore,
  tools as toolsStore,
  theme as themeStore,
  applyTheme,
  syncFromUserState,
} from "./store.js";
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
import { createNetworkManagerUi } from "../tools/ui/networkmanager.js";
import { createBacnetManagerUi } from "../tools/ui/bacnetmanager.js";
import { createObservabilityUi } from "../tools/ui/observability.js";
import { createBuildingWorkspaceUi } from "../tools/ui/buildingworkspace.js";
import { createBacnetHistorianUi } from "../tools/ui/bacnethistorian.js";
import { createDeviceGraphicsUi } from "../tools/ui/devicegraphics.js";
import { createGraphicsBuilderUi } from "../tools/ui/graphicsbuilder.js";
import Notes, { statusPill as notesStatusPill } from "../tools/ui/Notes.svelte";
import DesignSystem from "../tools/ui/DesignSystem.svelte";
// Migrated Svelte tools (Phase 3).
import AlarmConsole, { statusPill as alarmConsoleStatusPill } from "../tools/ui/AlarmConsole.svelte";
import Schedules, { statusPill as schedulesStatusPill } from "../tools/ui/Schedules.svelte";
import HeicMov, { statusPill as heicMovStatusPill } from "../tools/ui/HeicMov.svelte";
import ClipboardTyper, { statusPill as clipboardTyperStatusPill } from "../tools/ui/ClipboardTyper.svelte";
import BuildingAnalytics, { statusPill as buildingAnalyticsStatusPill } from "../tools/ui/BuildingAnalytics.svelte";
// Device Manager is a new imperative el()-built tool (not yet migrated to Svelte).
import { createDeviceManagerUi } from "../tools/ui/devicemanager.js";

/**
 * @param {object} deps
 * @param {typeof import("./tauri.js").invoke} deps.invoke
 * @param {typeof import("./tauri.js").listen} deps.listen
 * @param {typeof import("./tauri.js").convertFileSrc} deps.convertFileSrc
 * @param {string} deps.appVersion
 * @param {() => object|null} [deps.getTelemetry]
 */
export function createApplication({ invoke, listen, convertFileSrc, appVersion, getTelemetry = () => null }) {
  const TOOL_RENDERERS = {};
  let pluginPage = null;

  let platform = null;
  let pack = null;
  let packFlushTimer = null;
  let bacnetManager = null;
  let buildingWorkspace = null;
  let bacnetHistorian = null;
  let deviceGraphics = null;
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
    TOOLS = ALL_MANIFESTS.map(manifestToTool).filter((t) => t.renderPage || t.component);
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
    // The active org/user may have changed; re-hydrate the SQLite-backed store
    // for the new scope, then reload the inventory from the fresh snapshot.
    Promise.resolve(inventoryStorage?.hydrate?.())
      .then((wasActive) => {
        if (wasActive) {
          inventoryInstance()?.reload?.();
          bacnetHistorian?.restore({ replace: true });
        }
      })
      .catch(() => {});
  }

  const userStateApi = createUserStateManager({
    invoke,
    pickFolder,
    renderAll: renderAllBridge,
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

  // Single SQLite-backed inventory storage adapter, reused for the lifetime of
  // the app so its hydrated mirror survives re-wiring. Falls back to the legacy
  // user-state blob storage until a scope is hydrated from the database.
  const inventoryStorage = createSqlInventoryStorage({
    invoke,
    getState: () => userState,
    setInventory: (inventory, meta = {}) => {
      userState.inventory = inventory;
      if (meta.legacyMigrated) userState.inventoryLegacyMigrated = true;
      saveUserState();
    },
    saveUserState,
  });

  function createAppInventoryStorage() {
    return inventoryStorage;
  }

  function hydrateInventoryStore() {
    return inventoryStorage.hydrate();
  }

  function persistBacnetCache(devices) {
    inventoryStorage.saveBacnetCache(devices);
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
    renderChrome: () => renderScopedBridge("chrome"),
  });
  const logTo = activity.logTo;

  const networkManager = createNetworkManagerUi({
    invoke, listen, el, logTo, renderAll: renderAllBridge,
    userState, saveUserState, currentPluginId,
  });
  const observability = createObservabilityUi({
    invoke, listen, el, logTo, renderAll: renderAllBridge,
    getPack: () => pack, getTelemetry, currentPluginId,
  });
  bacnetManager = createBacnetManagerUi({
    invoke, listen, el, logTo, renderAll: renderAllBridge,
    renderScoped: renderScopedBridge,
    networkManager, platformHost, userState, saveUserState, currentPluginId,
    getInventory: () => (platform ? platform.capability("inventory.v1") : null),
    persistBacnetCache,
    setView, pluginView,
  });
  bacnetHistorian = createBacnetHistorianUi({
    el, logTo, renderAll: renderAllBridge,
    userState, saveUserState,
    getPlatform: () => platform,
    getInventory: () => (platform ? platform.capability("inventory.v1") : null),
    bacnetManager, getBuildingWorkspace: () => buildingWorkspace, listen,
  });
  buildingWorkspace = createBuildingWorkspaceUi({
    invoke, el, logTo,
    renderAll: renderAllBridge,
    renderScoped: renderScopedBridge,
    userState, saveUserState, getPlatform: () => platform,
    networkManager, setView, pluginView, currentPluginId, listen,
    getPack: () => pack, getTelemetry,
    getHistorian: () => bacnetHistorian.getInstance(),
    histSyncFromInventory: () => bacnetHistorian.syncFromInventory(),
    histPersist: () => bacnetHistorian.persist(),
  });
  deviceGraphics = createDeviceGraphicsUi({
    el, logTo, renderAll: renderAllBridge,
    getPlatform: () => platform,
    getInventory: () => (platform ? platform.capability("inventory.v1") : null),
    currentPluginId, userState, saveUserState,
  });
  const graphicsBuilder = createGraphicsBuilderUi({
    el, logTo, renderAll: renderAllBridge,
    getPlatform: () => platform,
    getInventory: () => (platform ? platform.capability("inventory.v1") : null),
    userState, saveUserState,
  });
  // Shared getter for the migrated Svelte tools that read the building model.
  const toolGetInventory = () => (platform ? platform.capability("inventory.v1") : null);
  const getPlatformFn = () => platform;
  // HeicMov publishes its live $state proxy here (via bindState) so the shell's
  // synchronous status pill can read it; seeded with a safe default pre-mount.
  let heicMovState = { files: [], busy: false, busyLabel: "", progress: null };
  deviceManager = createDeviceManagerUi({
    el, logTo, renderAll: renderAllBridge,
    getPlatform: () => platform,
    getInventory: () => (platform ? platform.capability("inventory.v1") : null),
    userState, saveUserState,
  });

  Object.assign(TOOL_RENDERERS, {
    clipboardtyper: {
      renderStatusPill: clipboardTyperStatusPill,
      component: ClipboardTyper,
      componentProps: { invoke, logTo, listen },
    },
    heicmov: {
      renderStatusPill: () => heicMovStatusPill(heicMovState),
      component: HeicMov,
      componentProps: {
        invoke, convertFileSrc, logTo, pickHeicMovFiles, pickFolder,
        bindState: (s) => { heicMovState = s; },
      },
    },
    networkmanager: { renderStatusPill: networkManager.renderStatusPill, renderPage: networkManager.renderPage },
    "bacnet-manager": { renderStatusPill: bacnetManager.renderStatusPill, renderPage: bacnetManager.renderPage },
    observability: { renderStatusPill: observability.renderStatusPill, renderPage: observability.renderPage },
    "building-workspace": { renderStatusPill: buildingWorkspace.renderStatusPill, renderPage: buildingWorkspace.renderPage },
    "bacnet-historian": { renderStatusPill: bacnetHistorian.renderStatusPill, renderPage: bacnetHistorian.renderPage },
    "device-graphics": { renderStatusPill: deviceGraphics.renderStatusPill, renderPage: deviceGraphics.renderPage },
    "building-analytics": {
      renderStatusPill: () => buildingAnalyticsStatusPill(toolGetInventory, userState),
      component: BuildingAnalytics,
      componentProps: { logTo, getPlatform: getPlatformFn, getInventory: toolGetInventory, userState, saveUserState, setView, pluginView },
    },
    "alarm-console": {
      renderStatusPill: () => alarmConsoleStatusPill(getPlatformFn, toolGetInventory),
      component: AlarmConsole,
      componentProps: { logTo, getPlatform: getPlatformFn, getInventory: toolGetInventory, userState, saveUserState },
    },
    "graphics-builder": { renderStatusPill: graphicsBuilder.renderStatusPill, renderPage: graphicsBuilder.renderPage },
    schedules: {
      renderStatusPill: () => schedulesStatusPill(getPlatformFn, userState),
      component: Schedules,
      componentProps: { logTo, getPlatform: getPlatformFn, getInventory: toolGetInventory, userState, saveUserState },
    },
    notes: {
      renderStatusPill: () => notesStatusPill(toolGetInventory, userState),
      component: Notes,
      componentProps: { getInventory: toolGetInventory, userState, saveUserState, logTo },
    },
    "design-system": { renderStatusPill: () => ({ label: "Reference", cls: "pill-idle" }), component: DesignSystem },
    "device-manager": { renderStatusPill: deviceManager.renderStatusPill, renderPage: deviceManager.renderPage },
  });
  rebuildCatalog();

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

  // Mount the Svelte ContentRoot that owns the keep-alive pool for tool pages.
  // It registers its imperative {showTool, showBuiltin} API via content-host.js,
  // which app-shell.renderCurrentPage drives. Built-in pages still use #view-root.
  const contentRootTarget = document.getElementById("app-content-root");
  if (contentRootTarget) {
    mount(ContentRoot, {
      target: contentRootTarget,
      props: { renderTool: (id, host) => pluginPage.renderPage(id, host) },
    });
  }

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
    renderAll: renderAllBridge,
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
    getActivitySummary: () => activity.activitySummary(),
    getSystemStatus,
    getRecentTools,
    toolById,
  });

  // Route the legacy renderAll()/renderScoped() API through the render bridge.
  // Chrome + page rendering stay imperative (app-shell) for now; the bridge just
  // composes them and lets tools register scoped renderers instead of the shell
  // hard-coding tool-specific dispatch.
  configureRenderBridge({
    renderChrome: appShell.renderChrome,
    renderPage: () => appShell.renderScoped("page"),
    pushStatus: () => {
      systemStatusStore.set(getSystemStatus());
      activitySummaryStore.set(activity.activitySummary());
      // Refresh the chrome stores from the source-of-truth userState/catalog so
      // the Svelte Sidebar reacts on the same triggers the old renderChrome used.
      syncFromUserState(userState);
      toolsStore.set(TOOLS);
    },
  });
  registerScopedRenderer("building-workspace", () => buildingWorkspace?.renderWorkspaceScope?.());
  registerScopedRenderer("building-workspace:tab", () => buildingWorkspace?.renderTabScope?.());
  registerScopedRenderer("building-workspace:model", () =>
    buildingWorkspace?.renderModelScope?.({ tree: true, details: true, header: true }));
  registerScopedRenderer("bacnet-manager:devices", () => bacnetManager?.renderDevicesScope?.());
  registerScopedRenderer("bacnet-manager:inbox", () => bacnetManager?.renderInboxScope?.());
  // Seed the reactive stores from current state (consumed by Svelte chrome in Phase 2).
  syncFromUserState(userState);
  toolsStore.set(TOOLS);

  // Theme: apply current preference to <html data-theme>, then keep DOM + persisted
  // state in sync when the theme store changes (toggle / command palette).
  applyTheme(userState.theme);
  themeStore.subscribe((t) => {
    applyTheme(t);
    if (userState.theme !== t) {
      userState.theme = t;
      saveUserState();
    }
  });

  // Command palette (Ctrl/Cmd-K) — global overlay, mounted once on the body.
  mount(CommandPalette, {
    target: document.body,
    props: {
      setView,
      pluginView,
      checkForUpdates: appShell.checkForUpdates,
      setSidebarCollapsed,
      getSidebarCollapsed: () => userState.sidebarCollapsed,
    },
  });

  // Reactive chrome: Svelte Sidebar + route-driven Breadcrumb replace the
  // imperative renderSidebar()/renderHeaderBreadcrumb() in app-shell. They mount
  // into the existing static containers (clearing the placeholder markup).
  const sidebarEl = document.querySelector("aside.sidebar");
  if (sidebarEl) {
    sidebarEl.replaceChildren();
    mount(Sidebar, { target: sidebarEl, props: { setView, pluginView, appVersion } });
  }
  const breadcrumbEl = document.getElementById("header-breadcrumb");
  if (breadcrumbEl) {
    breadcrumbEl.replaceChildren();
    mount(Breadcrumb, { target: breadcrumbEl, props: { setView } });
  }

  return {
    renderAll: renderAllBridge,
    renderScoped: renderScopedBridge,
    renderChrome: appShell.renderChrome,
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
    hydrateInventoryStore,
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
    tools: { networkManager, observability, bacnetHistorian },
    get buildingWorkspace() { return buildingWorkspace; },
    get bacnetManager() { return bacnetManager; },
    get networkManager() { return networkManager; },
    get observability() { return observability; },
  };
}
