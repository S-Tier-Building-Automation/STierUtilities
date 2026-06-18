// App bootstrap — platform kernel boot, startup warmup, lifecycle hooks.

import { createKernel } from "./host.js";
import { buildFactories } from "../tools/capabilities.js";
import { grantsFromInstall } from "./mcp-loader.js";
import { buildMcpFactories } from "./services/mcp-client.js";
import { createTimeseries } from "./services/timeseries.js";
import { createScheduler } from "./services/scheduler.js";
import { createPackController } from "./services/pack-controller.js";

/**
 * @param {object} deps
 * @param {() => void} deps.flushUserStatePersistence
 * @param {() => void} [deps.stopLivePoll]
 * @param {() => number|null} deps.getPackFlushTimer
 * @param {(timer: number|null) => void} deps.setPackFlushTimer
 * @param {() => void} deps.flushNetworkManagerSave
 * @param {() => void} deps.flushBacnetOnPageHide
 */
export function registerPagehideHandler({
  flushUserStatePersistence,
  stopLivePoll,
  getPackFlushTimer,
  setPackFlushTimer,
  flushNetworkManagerSave,
  flushBacnetOnPageHide,
}) {
  window.addEventListener("pagehide", () => {
    flushUserStatePersistence();
    stopLivePoll?.();
    const timer = getPackFlushTimer();
    if (timer) {
      clearInterval(timer);
      setPackFlushTimer(null);
    }
    flushNetworkManagerSave();
    flushBacnetOnPageHide();
  });
}

/**
 * @param {object} deps
 * @param {typeof import("./tauri.js").invoke} deps.invoke
 * @param {object} deps.networkManager
 * @param {object} deps.observability
 * @param {() => object|null} deps.getPack
 * @param {() => void} deps.renderAll
 */
export function createStartupWarmup({ invoke, networkManager, observability, getPack, renderAll }) {
  let startupWarmupApplied = false;
  const startupDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function applyStartupWarmupStatus(status) {
    if (!status || startupWarmupApplied) return false;
    let changed = false;
    if (status.network) changed = (await networkManager.applyStartupSnapshot(status.network)) || changed;
    changed = (await observability.applyStartupStatus(status)) || changed;
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
    const obsState = observability.getHealthState();
    const pack = getPack();
    if (pack && !obsState.health) {
      await observability.refreshHealth();
    } else if (!obsState.health) {
      observability.setHealthChecking(false, "Startup health check did not complete.");
      renderAll();
    }
  }

  return { hydrateFromStartupWarmup };
}

/**
 * @param {object} deps
 * @param {typeof import("./tauri.js").invoke} deps.invoke
 * @param {typeof import("./tauri.js").listen} deps.listen
 * @param {string} deps.appVersion
 * @param {object} deps.userState
 * @param {() => void} deps.rebuildCatalog
 * @param {() => Array<object>} deps.getAllManifests
 * @param {() => object} deps.createAppInventoryStorage
 * @param {(platform: object) => void} deps.setPlatform
 * @param {(telemetry: object) => void} deps.setTelemetry
 * @param {(scheduler: object) => void} deps.setScheduler
 * @param {(pack: object) => void} deps.setPack
 * @param {(timer: number) => void} deps.setPackFlushTimer
 * @param {object} deps.tools — clipboardTyper, networkManager, observability, bacnetHistorian
 * @param {(msg: string, kind?: string) => void} deps.logTo
 * @param {() => void} deps.renderAll
 * @param {(opts?: object) => void|Promise<void>} deps.checkForUpdates
 * @param {(view: string) => void} deps.setView
 * @param {(on: boolean) => void} deps.setSidebarCollapsed
 * @param {() => void} deps.applySidebarCollapsed
 * @param {() => Promise<void>} deps.authBootstrapUserState
 * @param {object} deps.accountMenu — { mount() }
 * @param {() => void} deps.initWindowControls
 * @param {() => Promise<void>} deps.hydrateFromStartupWarmup
 */
export async function runBootstrap({
  invoke,
  listen,
  appVersion,
  userState,
  rebuildCatalog,
  getAllManifests,
  createAppInventoryStorage,
  setPlatform,
  setTelemetry,
  setScheduler,
  setPack,
  setPackFlushTimer,
  tools,
  logTo,
  renderAll,
  checkForUpdates,
  setView,
  setSidebarCollapsed,
  applySidebarCollapsed,
  authBootstrapUserState,
  accountMenu,
  initWindowControls,
  hydrateFromStartupWarmup,
}) {
  for (const btn of document.querySelectorAll(".header-nav-item")) {
    btn.addEventListener("click", () => setView(btn.dataset.view));
  }

  document
    .getElementById("sidebar-toggle")
    ?.addEventListener("click", () => setSidebarCollapsed(!userState.sidebarCollapsed));
  applySidebarCollapsed();

  accountMenu.mount();
  initWindowControls();

  await authBootstrapUserState();
  applySidebarCollapsed();

  try {
    await tools.clipboardTyper.hydrate(await invoke("clipboardtyper_get_state"));
  } catch (err) {
    logTo("clipboardtyper", `Could not read state: ${err}`, "error");
  }

  try {
    const telemetry = createTimeseries();
    const scheduler = createScheduler();
    setTelemetry(telemetry);
    setScheduler(scheduler);
    rebuildCatalog();
    const installed = getAllManifests().filter((m) => m.kind === "mcp");
    const factories = new Map([
      ...buildFactories(invoke, { timeseries: telemetry, scheduler, inventoryStorage: createAppInventoryStorage() }),
      ...buildMcpFactories(invoke, installed),
    ]);
    const installGrants = new Map(
      Object.entries(userState.installedGrants || {}).map(([id, perms]) => [id, new Set(perms)]),
    );
    const platform = createKernel({
      manifests: getAllManifests(),
      factories,
      grant: grantsFromInstall(installGrants),
      onLog: (e) => console.debug(`[platform:${e.toolId}] ${e.msg}`),
    });
    const res = await platform.boot();
    if (!res.ok) console.warn("[platform] capability graph issues:", res.errors);
    setPlatform(platform);

    const pack = createPackController({ invoke, timeseries: telemetry });
    setPack(pack);
    setPackFlushTimer(setInterval(() => { pack.flush().catch(() => {}); }, 10000));

    tools.observability.bindInstallListener(listen);
    tools.bacnetHistorian.restore();
    tools.observability.checkPackUpdates();
  } catch (err) {
    console.error("[platform] kernel boot failed:", err);
  }

  await tools.networkManager.loadProfiles();
  hydrateFromStartupWarmup().catch((err) => {
    const detail = err instanceof Error ? err.message : (typeof err === "string" ? err : JSON.stringify(err));
    console.warn("[startup] warmup hydrate failed:", detail || err);
  });

  renderAll();
  setTimeout(() => { checkForUpdates({ silent: true }).catch(() => {}); }, 2500);
}

/**
 * Wire DOMContentLoaded to {@link runBootstrap}.
 * @param {Parameters<typeof runBootstrap>[0] & {
 *   createAccountMenu: Function,
 *   getAuthState: Function,
 *   activeAuthUser: Function,
 *   activeAuthOrg: Function,
 *   authSignOut: Function,
 *   repoUrl: string,
 * }} deps
 */
export function installBootstrap(deps) {
  const accountMenu = deps.createAccountMenu({
    invoke: deps.invoke,
    appVersion: deps.appVersion,
    repoUrl: deps.repoUrl,
    setView: deps.setView,
    getAuthState: deps.getAuthState,
    getActiveUser: deps.activeAuthUser,
    getActiveOrg: deps.activeAuthOrg,
    authSignOut: deps.authSignOut,
    checkForUpdates: deps.checkForUpdates,
  });

  window.addEventListener("DOMContentLoaded", () => runBootstrap({ ...deps, accountMenu }));
}
