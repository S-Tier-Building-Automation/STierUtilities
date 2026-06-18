// BACnet Historian tool page — configure points and poll into timeseries.

/**
 * @param {object} deps
 * @param {import("../../ui/dom.js").el} deps.el
 * @param {(toolId: string, msg: string, kind?: string) => void} deps.logTo
 * @param {() => void} deps.renderAll
 * @param {object} deps.userState
 * @param {() => void} deps.saveUserState
 * @param {() => object|null} deps.getPlatform
 * @param {() => object|null} deps.getInventory
 * @param {ReturnType<typeof import("./bacnet.js").createBacnetUi>} deps.bacnet
 * @param {() => object|null} deps.getBuildingWorkspace
 * @param {typeof import("../../platform/tauri.js").listen} [deps.listen]
 */
export function createBacnetHistorianUi({
  el, logTo, renderAll, userState, saveUserState, getPlatform, getInventory, bacnet, getBuildingWorkspace, listen,
}) {

function historianInstance() {
  const platform = getPlatform();
  return platform ? platform.capability("bacnet.historian.v1") : null;
}

function inventoryInstance() {
  return getInventory ? getInventory() : null;
}

let histIntervalMs = 60000;
let histUseCov = false;
let histCovListenerReady = false;

function ensureHistorianCovListener() {
  if (histCovListenerReady || !listen) return;
  histCovListenerReady = true;
  listen("bacnet:cov", (event) => {
    const hist = historianInstance();
    if (hist?.handleCovEvent?.(event.payload)) renderAll();
  }).catch((err) => console.warn("listen bacnet:cov (historian) failed:", err));
}

function histStatusPill() {
  const hist = historianInstance();
  if (!hist) return { label: "Off", cls: "pill-muted" };
  return hist.isRunning() ? { label: "Logging", cls: "pill-running" } : { label: "Idle", cls: "pill-idle" };
}

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
    useCov: histUseCov,
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
  const buildingWorkspace = getBuildingWorkspace?.();
  if (!inv || !hist) return 0;
  let refreshed = 0;
  for (const current of hist.points()) {
    const sourceRef = histSourceRef(current);
    const point = (current.pointId ? inv.getEntity(current.pointId) : null)
      || inv.listEntities({ type: "point", sourceRef })[0];
    if (!point || point.type !== "point") continue;
    try {
      const record = buildingWorkspace?.historianRecordForPoint?.(inv, point);
      if (!record) continue;
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
  if (saved.useCov) histUseCov = Boolean(saved.useCov);
  ensureHistorianCovListener();
  const refreshed = histSyncFromInventory();
  if (refreshed) histPersist();
  if (saved.running && (saved.points || []).length) {
    hist.start(histIntervalMs, { cov: histUseCov });
    logTo("bacnet-historian", `Resumed logging ${saved.points.length} point(s).`, "info");
  }
}

function renderHistorianPage() {
  ensureHistorianCovListener();
  const hist = historianInstance();
  if (!hist) {
    return el("div", { class: "plugin-controls" },
      el("section", { class: "plugin-section" },
        el("p", { class: "muted" }, "Historian unavailable — the platform kernel did not resolve its dependencies.")));
  }
  const synced = histSyncFromInventory();
  if (synced) histPersist();

  const devices = bacnet.getDevices();
  let devIdx = devices.length ? "0" : "";
  const objTypeInput = el("input", { type: "number", class: "nm-input bac-range-input", value: "0", title: "Object type (0=AI, 1=AO, 2=AV, …)" });
  const instInput = el("input", { type: "number", class: "nm-input bac-range-input", value: "0" });
  const labelInput = el("input", { type: "text", class: "nm-input", placeholder: "label (optional)" });
  const devSelect = el("select", { class: "nm-input", onchange: (e) => { devIdx = e.target.value; } },
    ...(devices.length
      ? devices.map((d, i) => el("option", { value: String(i) }, bacnet.deviceLabel(d)))
      : [el("option", { value: "" }, "No devices — discover from Building Workspace first")]));

  const addBtn = el("button", {
    class: "btn",
    disabled: devices.length ? undefined : "disabled",
    onclick: () => {
      const dev = devices[Number(devIdx)];
      if (!dev) return;
      hist.addPoint({
        device: { ...bacnet.deviceRef(dev), deviceInstance: dev.instance },
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
  const covToggle = el("label", { class: "nm-field bac-cov-toggle" },
    el("input", {
      type: "checkbox",
      checked: histUseCov ? "checked" : undefined,
      onchange: (e) => { histUseCov = e.target.checked; histPersist(); },
    }),
    el("span", { class: "nm-field-label" }, "Use COV (event-driven updates between polls)"));
  const running = hist.isRunning();
  const controlCard = el("section", { class: "plugin-section" },
    el("div", { class: "section-head" },
      el("h3", {}, "Logging"),
      el("span", { class: `pill ${running ? "pill-running" : "pill-idle"}` }, running ? (hist.covEnabled?.() ? "Logging · COV" : "Logging") : "Idle")),
    el("p", { class: "muted small" },
      "Writes present-value to the time-series service. Poll interval remains as a fallback; enable COV for faster updates on supported objects. Unreachable devices are skipped when Network Manager is available."),
    el("div", { class: "bac-discover-controls" },
      el("label", { class: "nm-field" }, el("span", { class: "nm-field-label" }, "Interval (s)"), intervalInput),
      covToggle,
      el("button", {
        class: "btn btn-primary",
        onclick: () => {
          histIntervalMs = Math.max(5, Number(intervalInput.value) || 60) * 1000;
          hist.start(histIntervalMs, { cov: histUseCov });
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

return {
  renderStatusPill: histStatusPill,
  renderPage: renderHistorianPage,
  getInstance: historianInstance,
  persist: histPersist,
  syncFromInventory: histSyncFromInventory,
  restore: histRestore,
};
}
