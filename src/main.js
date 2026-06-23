import { invoke, listen, convertFileSrc } from "./platform/tauri.js";
import { createApplication } from "./platform/app-tools.js";
import { installBootstrap, registerPagehideHandler, createStartupWarmup } from "./platform/bootstrap.js";
import { initWindowControls, createAccountMenu, initSidebarSplitter } from "./ui/index.js";

const APP_VERSION = "0.6.0";
const REPO_URL = "https://github.com/S-Tier-Building-Automation/STierUtilities";

/** @type {ReturnType<import("./platform/services/timeseries.js").createTimeseries>|null} */
let telemetry = null;

// renderAll/renderScoped are provided by the render bridge (configured inside
// createApplication), so there's no longer a late-bound appUi stub to patch.
const app = createApplication({
  invoke,
  listen,
  convertFileSrc,
  appVersion: APP_VERSION,
  getTelemetry: () => telemetry,
});

const { hydrateFromStartupWarmup } = createStartupWarmup({
  invoke,
  networkManager: app.networkManager,
  observability: app.observability,
  getPack: app.getPack,
  renderAll: app.renderAll,
});

registerPagehideHandler({
  flushUserStatePersistence: app.flushUserStatePersistence,
  flushInventoryStorage: app.flushInventoryStorage,
  stopLivePoll: () => app.buildingWorkspace?.stopLivePoll(),
  getPackFlushTimer: app.getPackFlushTimer,
  setPackFlushTimer: app.setPackFlushTimer,
  flushNetworkManagerSave: () => app.networkManager.flushPendingSave(),
  flushBacnetOnPageHide: () => app.bacnetManager?.flushOnPageHide?.(),
});

installBootstrap({
  invoke,
  listen,
  appVersion: APP_VERSION,
  repoUrl: REPO_URL,
  userState: app.userState,
  rebuildCatalog: app.rebuildCatalog,
  getAllManifests: app.getAllManifests,
  createAppInventoryStorage: app.createAppInventoryStorage,
  hydrateInventoryStore: app.hydrateInventoryStore,
  setPlatform: app.setPlatform,
  setTelemetry: (t) => { telemetry = t; },
  setScheduler: () => {},
  setPack: app.setPack,
  setPackFlushTimer: app.setPackFlushTimer,
  tools: app.tools,
  logTo: app.logTo,
  renderAll: app.renderAll,
  checkForUpdates: app.checkForUpdates,
  setView: app.setView,
  setSidebarCollapsed: app.setSidebarCollapsed,
  applySidebarCollapsed: app.applySidebarCollapsed,
  saveUserState: app.saveUserState,
  initSidebarSplitter,
  authBootstrapUserState: app.authBootstrapUserState,
  createAccountMenu,
  getAuthState: app.getAuthState,
  activeAuthUser: app.activeAuthUser,
  activeAuthOrg: app.activeAuthOrg,
  authSignOut: app.authSignOut,
  initWindowControls,
  hydrateFromStartupWarmup,
  getTools: app.getTools,
  isHidden: app.isHidden,
  pluginView: app.pluginView || ((id) => `plugin:${id}`),
});
