// Alarm Console app — one feed for analytics rule findings and live BACnet
// alarms. A thin shell over the alerts.v1 capability: it owns no rule or BACnet
// logic, only the filters, the unified list, and inline acknowledge.

import { takeAppIntent } from "../../ui/app-intent.js";

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
export function createAlarmConsoleUi({
  el, logTo, renderAll, getPlatform, getInventory, userState, saveUserState,
}) {
  let busy = false;
  let bacnetAlarms = null;   // null = not yet read; [] = read, none

  // Persisted, scope-aware UI state (site filter).
  function st() {
    if (!userState.alarmConsole || typeof userState.alarmConsole !== "object") {
      userState.alarmConsole = { siteId: "" };
    }
    return userState.alarmConsole;
  }
  function setSite(value) {
    st().siteId = value;
    saveUserState();
  }

  function alertsCap() {
    const platform = getPlatform();
    return platform ? platform.capability("alerts.v1") : null;
  }

  function bacnetCap() {
    const platform = getPlatform();
    return platform ? platform.capability("bacnet.read.v1") : null;
  }

  function deviceRefs(inv) {
    const equips = inv.listEntities({ type: "equip" });
    const seen = new Set();
    const refs = [];
    for (const e of equips) {
      if (st().siteId && e.siteId !== st().siteId) continue;
      const inst = e.deviceInstance ?? e.deviceRef?.deviceInstance;
      if (inst == null && !e.deviceRef) continue;
      const key = String(inst ?? JSON.stringify(e.deviceRef));
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push(e.deviceRef || { deviceInstance: inst });
    }
    return refs;
  }

  async function readBacnetAlarms(inv) {
    const alerts = alertsCap();
    if (!alerts || busy) return;
    busy = true;
    renderAll();
    try {
      bacnetAlarms = await alerts.listBacnetAlarms({ devices: deviceRefs(inv) });
      const active = bacnetAlarms.filter((a) => a.status === "active").length;
      logTo("alarm-console", active ? `Read ${active} active BACnet alarm${active === 1 ? "" : "s"}.` : "No active BACnet alarms.", active ? "warn" : "ok");
    } catch (err) {
      logTo("alarm-console", `Reading alarms failed: ${err}`, "error");
    } finally {
      busy = false;
      renderAll();
    }
  }

  async function runScan(inv) {
    const alerts = alertsCap();
    if (!alerts || busy) return;
    busy = true;
    renderAll();
    try {
      const run = await alerts.runRuleScan({ scope: { siteId: st().siteId || null } });
      const fails = run.summary?.fail || 0;
      logTo("alarm-console", fails ? `Analytics scan found ${fails} issue${fails === 1 ? "" : "s"}.` : "Analytics scan clear.", fails ? "warn" : "ok");
    } catch (err) {
      logTo("alarm-console", `Analytics scan failed: ${err}`, "error");
    } finally {
      busy = false;
      renderAll();
    }
  }

  async function acknowledge(alert) {
    const alerts = alertsCap();
    if (!alerts || !alert.ref) return;
    try {
      await alerts.acknowledge(alert.ref);
      logTo("alarm-console", `Acknowledged ${alert.message}.`, "ok");
    } catch (err) {
      logTo("alarm-console", `Acknowledge failed: ${err}`, "error");
    }
    const inv = getInventory();
    if (inv) readBacnetAlarms(inv);
  }

  const SOURCE_LABEL = { bacnet: "BACnet", device: "Device", rule: "Rule" };

  function alertRow(alert) {
    return el("li", { class: alert.status === "active" || alert.status === "fail" ? "log-error" : alert.status === "error" ? "log-warn" : "log-info" },
      el("span", { class: "log-time" }, SOURCE_LABEL[alert.source] || "Rule"),
      el("span", { class: "log-msg" }, `${alert.equipName ? `${alert.equipName} · ` : ""}${alert.message}`),
      alert.ackable
        ? el("button", { class: "btn-ghost btn-sm", onclick: () => acknowledge(alert) }, "Ack")
        : null);
  }

  function renderPage() {
    const inv = getInventory();
    const alerts = alertsCap();
    if (!inv || !alerts) {
      return el("div", { class: "plugin-controls" },
        el("section", { class: "plugin-section" },
          el("p", { class: "empty-state" }, "Building model or alerts engine is not available.")));
    }

    const intent = takeAppIntent("alarm-console");
    if (intent?.siteId && inv.getEntity(intent.siteId)) setSite(intent.siteId);

    const sites = inv.listEntities({ type: "site" });
    const ruleAlerts = alerts.listRuleFindings({ status: ["fail", "warn"] });
    const deviceAlerts = alerts.listDeviceAlerts ? alerts.listDeviceAlerts() : [];
    const liveAlerts = bacnetAlarms || [];
    const combined = [...deviceAlerts, ...liveAlerts, ...ruleAlerts];
    const deviceCount = deviceRefs(inv).length;

    const controls = el("div", { class: "bw-card bw-rule-controls" },
      el("div", { class: "bac-discover-controls" },
        sites.length
          ? el("label", { class: "nm-field" }, el("span", { class: "nm-field-label" }, "Site"),
              el("select", { class: "nm-input", onchange: (e) => { setSite(e.target.value); bacnetAlarms = null; renderAll(); } },
                el("option", { value: "" }, "All sites"),
                ...sites.map((s) => el("option", { value: s.id, selected: s.id === st().siteId ? "selected" : undefined }, s.name || s.id))))
          : null,
        el("button", { class: "btn btn-primary", disabled: busy ? "disabled" : undefined, onclick: () => runScan(inv) }, busy ? "Working…" : "Run analytics scan"),
        el("button", {
          class: "btn-ghost",
          disabled: busy || !bacnetCap() || deviceCount === 0 ? "disabled" : undefined,
          title: deviceCount === 0 ? "No bound devices in scope." : undefined,
          onclick: () => readBacnetAlarms(inv),
        }, busy ? `Reading ${deviceCount} device${deviceCount === 1 ? "" : "s"}…` : `Read BACnet alarms (${deviceCount})`)),
      el("p", { class: "muted small" }, `${ruleAlerts.length} analytics finding${ruleAlerts.length === 1 ? "" : "s"} · ${liveAlerts.filter((a) => a.status === "active").length} active BACnet alarm${liveAlerts.filter((a) => a.status === "active").length === 1 ? "" : "s"} · ${deviceCount} device${deviceCount === 1 ? "" : "s"} in scope`));

    const list = combined.length
      ? el("ol", { class: "plugin-log scroll-fill" }, ...combined.map(alertRow))
      : el("p", { class: "muted small" }, bacnetAlarms == null
          ? "No analytics findings. Run an analytics scan or read BACnet alarms to populate the feed."
          : "No active alerts.");

    return el("div", { class: "plugin-controls" },
      el("section", { class: "plugin-section" }, controls, list));
  }

  function renderStatusPill() {
    const inv = getInventory();
    const alerts = alertsCap();
    if (!inv || !alerts) return { label: "—", cls: "pill-muted" };
    const ruleFails = alerts.listRuleFindings({ status: ["fail"] }).length;
    const liveActive = (bacnetAlarms || []).filter((a) => a.status === "active").length;
    const total = ruleFails + liveActive;
    return total ? { label: `${total} alert${total === 1 ? "" : "s"}`, cls: "pill-warn" } : { label: "Clear", cls: "pill-running" };
  }

  return { renderPage, renderStatusPill };
}
