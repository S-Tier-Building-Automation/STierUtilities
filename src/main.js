import { invoke, listen, convertFileSrc } from "./platform/tauri.js";
import { createApplication } from "./platform/app-tools.js";
import { installBootstrap, registerPagehideHandler, createStartupWarmup } from "./platform/bootstrap.js";
import { initWindowControls, createAccountMenu } from "./ui/index.js";

const APP_VERSION = "0.5.4";
const REPO_URL = "https://github.com/S-Tier-Building-Automation/STierUtilities";

const appUi = { renderAll() {}, renderScoped() {} };
/** @type {ReturnType<import("./platform/services/timeseries.js").createTimeseries>|null} */
let telemetry = null;

const app = createApplication({
  appUi,
  invoke,
  listen,
  convertFileSrc,
  appVersion: APP_VERSION,
  getTelemetry: () => telemetry,
});

appUi.renderAll = app.renderAll;
appUi.renderScoped = app.renderScoped;

const { hydrateFromStartupWarmup } = createStartupWarmup({
  invoke,
  networkManager: app.networkManager,
  observability: app.observability,
  getPack: app.getPack,
  renderAll: () => appUi.renderAll(),
});

registerPagehideHandler({
  flushUserStatePersistence: app.flushUserStatePersistence,
  stopLivePoll: () => app.buildingWorkspace?.stopLivePoll(),
  getPackFlushTimer: app.getPackFlushTimer,
  setPackFlushTimer: app.setPackFlushTimer,
  flushNetworkManagerSave: () => app.networkManager.flushPendingSave(),
  flushBacnetOnPageHide: () => app.bacnet.flushOnPageHide(),
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
  setPlatform: app.setPlatform,
  setTelemetry: (t) => { telemetry = t; },
  setScheduler: () => {},
  setPack: app.setPack,
  setPackFlushTimer: app.setPackFlushTimer,
  tools: app.tools,
  logTo: app.logTo,
  renderAll: () => appUi.renderAll(),
  checkForUpdates: app.checkForUpdates,
  setView: app.setView,
  setSidebarCollapsed: app.setSidebarCollapsed,
  applySidebarCollapsed: app.applySidebarCollapsed,
  authBootstrapUserState: app.authBootstrapUserState,
  createAccountMenu,
  getAuthState: app.getAuthState,
  activeAuthUser: app.activeAuthUser,
  activeAuthOrg: app.activeAuthOrg,
  authSignOut: app.authSignOut,
  initWindowControls,
  hydrateFromStartupWarmup,
});
