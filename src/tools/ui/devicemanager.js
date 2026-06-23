// Device Manager app — the device-management workspace. A thin shell over the
// devices.v1 capability: a live inventory of every modeled device with health
// status, last-seen, latency, and lifecycle controls. It owns no BACnet or
// scheduling logic — the Device Health Service (devices.v1) does the work.

const STATUS_PILL = {
  online: "pill-running",
  degraded: "pill-warn",
  offline: "pill-error",
  unknown: "pill-muted",
};
const LIFECYCLE_OPTIONS = ["active", "maintenance", "decommissioned"];

/** Compact "Ns/Nm/Nh/Nd ago" from a ms timestamp, or "—". */
function ago(ts, now) {
  if (ts == null) return "—";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function deviceInstanceOf(e) {
  const n = Number(e?.deviceInstance ?? e?.deviceRef?.deviceInstance);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {object} deps
 * @param {import("../../ui/dom.js").el} deps.el
 * @param {(toolId: string, msg: string, kind?: string) => void} deps.logTo
 * @param {() => void} deps.renderAll
 * @param {() => object|null} deps.getPlatform
 * @param {() => object|null} deps.getInventory
 * @param {object} deps.userState
 * @param {() => void} deps.saveUserState
 */
export function createDeviceManagerUi({
  el, logTo, renderAll, getPlatform, getInventory, userState, saveUserState,
}) {
  let busy = false;

  function st() {
    if (!userState.deviceManager || typeof userState.deviceManager !== "object") {
      userState.deviceManager = { statusFilter: "", intervalSec: 60 };
    }
    return userState.deviceManager;
  }

  function devicesCap() {
    const platform = getPlatform();
    return platform ? platform.capability("devices.v1") : null;
  }

  async function runCheck() {
    const devices = devicesCap();
    if (!devices || busy) return;
    busy = true;
    renderAll();
    try {
      const tally = await devices.checkAll();
      const issues = tally.offline + tally.degraded;
      logTo("device-manager",
        issues
          ? `Health check: ${tally.online}/${tally.total} online · ${tally.offline} offline · ${tally.degraded} degraded.`
          : `Health check: all ${tally.total} device${tally.total === 1 ? "" : "s"} online.`,
        issues ? "warn" : "ok");
    } catch (err) {
      logTo("device-manager", `Health check failed: ${err}`, "error");
    } finally {
      busy = false;
      renderAll();
    }
  }

  function toggleMonitoring() {
    const devices = devicesCap();
    if (!devices) return;
    if (devices.isRunning()) {
      devices.stop();
      logTo("device-manager", "Continuous monitoring stopped.", "info");
    } else {
      const intervalMs = Math.max(5, Number(st().intervalSec) || 60) * 1000;
      devices.start(intervalMs);
      logTo("device-manager", `Continuous monitoring started (every ${Math.round(intervalMs / 1000)}s).`, "ok");
    }
    renderAll();
  }

  function setLifecycle(equipId, value) {
    const devices = devicesCap();
    if (!devices) return;
    try {
      devices.setLifecycle(equipId, value);
      logTo("device-manager", `Set lifecycle to ${value}.`, "ok");
    } catch (err) {
      logTo("device-manager", `Could not set lifecycle: ${err}`, "error");
    }
    renderAll();
  }

  function statusChip(status) {
    return el("span", { class: `pill ${STATUS_PILL[status] || "pill-muted"} pill-sm` }, status || "unknown");
  }

  function deviceRow(equip, now) {
    const h = equip.health || {};
    const inst = deviceInstanceOf(equip);
    const lifecycle = equip.lifecycle || "active";
    const addr = equip.address || equip.deviceRef?.address || "—";
    const vendorModel = [equip.vendorName, equip.modelName].filter(Boolean).join(" / ") || "—";
    return el("tr", {},
      el("td", {}, equip.name || equip.id),
      el("td", {}, inst != null ? String(inst) : "—"),
      el("td", {}, addr),
      el("td", {}, vendorModel),
      el("td", {}, statusChip(h.status)),
      el("td", {}, ago(h.lastSeenAt, now)),
      el("td", {}, typeof h.lastRttMs === "number" ? `${h.lastRttMs} ms` : "—"),
      el("td", {},
        el("select", {
          class: "nm-input",
          onchange: (e) => setLifecycle(equip.id, e.target.value),
        }, ...LIFECYCLE_OPTIONS.map((opt) =>
          el("option", { value: opt, selected: opt === lifecycle ? "selected" : undefined }, opt)))));
  }

  function renderPage() {
    const devices = devicesCap();
    const inv = getInventory();
    if (!devices || !inv) {
      return el("div", { class: "plugin-controls" },
        el("section", { class: "plugin-section" },
          el("p", { class: "empty-state" }, "Device Health Service or building model is not available.")));
    }

    const now = Date.now();
    const all = devices.getDevices();
    const counts = { online: 0, degraded: 0, offline: 0, unknown: 0 };
    for (const d of all) counts[d.health?.status || "unknown"]++;

    const filter = st().statusFilter;
    const rows = (filter ? all.filter((d) => (d.health?.status || "unknown") === filter) : all)
      .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));

    const running = devices.isRunning();
    const controls = el("div", { class: "bw-card bw-rule-controls" },
      el("div", { class: "bac-discover-controls" },
        el("button", { class: "btn btn-primary", disabled: busy ? "disabled" : undefined, onclick: () => runCheck() },
          busy ? "Checking…" : "Run health check"),
        el("button", { class: running ? "btn-ghost" : "btn", onclick: () => toggleMonitoring() },
          running ? "Stop monitoring" : "Start monitoring"),
        el("label", { class: "nm-field" }, el("span", { class: "nm-field-label" }, "Every (s)"),
          el("input", {
            class: "nm-input", type: "number", min: "5", value: String(st().intervalSec || 60),
            onchange: (e) => { st().intervalSec = Math.max(5, Number(e.target.value) || 60); saveUserState(); },
          })),
        el("label", { class: "nm-field" }, el("span", { class: "nm-field-label" }, "Status"),
          el("select", {
            class: "nm-input",
            onchange: (e) => { st().statusFilter = e.target.value; saveUserState(); renderAll(); },
          },
            el("option", { value: "" }, "All"),
            ...["online", "degraded", "offline", "unknown"].map((s) =>
              el("option", { value: s, selected: s === filter ? "selected" : undefined }, s))))),
      el("p", { class: "muted small" },
        `${counts.online} online · ${counts.degraded} degraded · ${counts.offline} offline · ${counts.unknown} unknown · ${all.length} device${all.length === 1 ? "" : "s"}${running ? " · monitoring" : ""}`));

    const table = rows.length
      ? el("table", { class: "nm-table scroll-fill" },
          el("thead", {}, el("tr", {},
            ...["Device", "Instance", "Address", "Vendor / Model", "Status", "Last seen", "Latency", "Lifecycle"]
              .map((h) => el("th", {}, h)))),
          el("tbody", {}, ...rows.map((r) => deviceRow(r, now))))
      : el("p", { class: "muted small" }, all.length
          ? "No devices match this filter."
          : "No modeled devices yet. Discover and import devices in BACnet Manager, then run a health check.");

    return el("div", { class: "plugin-controls" },
      el("section", { class: "plugin-section" }, controls, table));
  }

  function renderStatusPill() {
    const devices = devicesCap();
    if (!devices) return { label: "—", cls: "pill-muted" };
    const all = devices.getDevices();
    if (!all.length) return { label: "No devices", cls: "pill-muted" };
    const offline = all.filter((d) => d.health?.status === "offline").length;
    if (offline) return { label: `${offline} offline`, cls: "pill-error" };
    const degraded = all.filter((d) => d.health?.status === "degraded").length;
    if (degraded) return { label: `${degraded} degraded`, cls: "pill-warn" };
    const online = all.filter((d) => d.health?.status === "online").length;
    return { label: `${online}/${all.length} online`, cls: online ? "pill-running" : "pill-muted" };
  }

  return { renderPage, renderStatusPill };
}
