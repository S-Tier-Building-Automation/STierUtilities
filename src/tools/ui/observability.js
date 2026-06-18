// Observability Pack service page — install, health, bring-up.

import { openExternal } from "../../ui/dom.js";

/**
 * @param {object} deps
 * @param {typeof import("../../platform/tauri.js").invoke} deps.invoke
 * @param {typeof import("../../platform/tauri.js").listen} deps.listen
 * @param {import("../../ui/dom.js").el} deps.el
 * @param {(toolId: string, msg: string, kind?: string) => void} deps.logTo
 * @param {() => void} deps.renderAll
 * @param {() => import("../../platform/services/pack-controller.js").createPackController extends Function ? ReturnType<import("../../platform/services/pack-controller.js").createPackController> : object|null} deps.getPack
 * @param {() => object|null} [deps.getTelemetry]
 * @param {() => string|null} deps.currentPluginId
 */
export function createObservabilityUi({
  invoke, listen, el, logTo, renderAll, getPack, getTelemetry = () => null, currentPluginId,
}) {

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
  if (obsPack !== null || obsPackLoading || !getPack()) return;
  obsPackLoading = true;
  getPack().packStatus()
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
  const ts = getTelemetry();
  const s = ts ? ts.stats() : null;
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
  if (!getPack()) return;
  obsHealthChecking = true;
  obsHealthMessage = "Checking health and smoke test…";
  renderAll();
  try {
    obsHealth = await getPack().health();
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
  if (getPack() && obs.started && obs.config && obs.health?.influxReady) {
    try {
      await getPack().connect(obs.config);
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
  if (!getPack() || obsBusy) return;
  obsBusy = true; obsPhase = OBS_PHASE_LABELS.status; obsProgress = null; renderAll();
  try {
    logTo("observability", "Bringing up the Observability Pack… (first run downloads ~400 MB)", "info");
    const cfg = await getPack().bringUp((s) => {
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
  if (!getPack()) return;
  try { await getPack().stop(); logTo("observability", "Stopped pack services.", "info"); await obsRefreshHealth(); }
  catch (err) { logTo("observability", `Stop failed: ${err}`, "error"); }
}

async function obsWriteConfigs() {
  if (!getPack()) return;
  try { const dir = await getPack().writeConfigs(); logTo("observability", `Wrote pack config files to ${dir}.`, "ok"); }
  catch (err) { logTo("observability", `Could not write configs: ${err}`, "error"); }
}

function renderObservabilityPage() {
  obsEnsurePackStatus();
  const ts = getTelemetry();
  const stats = ts ? ts.stats() : null;
  const recent = ts ? ts.recent(15) : [];
  const pack = getPack();
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

return {
  renderStatusPill: obsStatusPill,
  renderPage: renderObservabilityPage,
  applyStartupStatus: obsApplyStartupStatus,
  refreshHealth: obsRefreshHealth,
  getHealthState: () => ({ health: obsHealth, checking: obsHealthChecking, message: obsHealthMessage }),
  setHealthChecking: (checking, message) => {
    obsHealthChecking = checking;
    if (message != null) obsHealthMessage = message;
  },
  bindInstallListener: (listenFn) => {
    listenFn("observability://install", (e) => {
      obsProgress = e.payload;
      if (currentPluginId() === "observability") renderAll();
    }).catch((err) => console.warn("listen observability://install failed:", err));
  },
  checkPackUpdates: async () => {
    const pack = getPack();
    if (!pack) return;
    try {
      const status = await pack.packStatus();
      obsPack = status;
      const outdated = (status?.components || [])
        .filter((c) => c.updateAvailable)
        .map((c) => c.name)
        .join(", ");
      if (outdated) {
        logTo("observability", `Pack update available: ${outdated}. Open Observability → "Update & restart pack".`, "info");
      }
    } catch (_) {}
  },
};
}
