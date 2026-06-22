// Schedule editor — read a BACnet Schedule object, plan a weekly schedule with
// the tested model, and command/override its present-value. Talks to the BACnet
// integration directly (it is a protocol-management tool), resolving devices
// from the discovery cache.

import { toast } from "../../ui/toast.js";
import { confirmAction } from "../../ui/modal.js";
import {
  createScheduleService,
  createWeeklySchedule,
  addEntry,
  removeEntry,
  valueAt,
  findConflicts,
  SCHEDULE_DAYS,
} from "../schedule-service.js";

const VALUE_KINDS = ["real", "unsigned", "enumerated", "boolean", "null"];

export function createSchedulesUi({
  el, logTo, renderAll, getPlatform, getInventory, userState, saveUserState,
}) {
  let busy = false;
  let properties = null; // last readSchedule result
  // Ephemeral add-entry draft.
  let draft = { day: "Mon", time: "08:00", value: "" };

  function st() {
    if (!userState.schedules || typeof userState.schedules !== "object") {
      userState.schedules = { deviceKey: "", instance: 1, plan: null, commandKind: "real", commandValue: "", priority: "" };
    }
    if (!userState.schedules.plan) userState.schedules.plan = createWeeklySchedule({ scheduleDefault: null });
    return userState.schedules;
  }
  function patchState(patch) {
    Object.assign(st(), patch);
    saveUserState();
  }

  function bacnetCap() {
    const platform = getPlatform();
    return platform ? platform.capability("bacnet.read.v1") : null;
  }
  function scheduleSvc() {
    const bacnet = bacnetCap();
    return bacnet ? createScheduleService({ bacnet }) : null;
  }

  function devices() {
    return Array.isArray(userState.bacnetDiscoveryCache) ? userState.bacnetDiscoveryCache : [];
  }
  function selectedDevice() {
    const s = st();
    const d = devices().find((x) => x.key === s.deviceKey);
    return d ? { address: d.address, network: d.network ?? null, mac: d.mac ?? null } : null;
  }

  async function readSchedule() {
    const svc = scheduleSvc();
    const device = selectedDevice();
    if (!svc || !device) { toast("Pick a discovered device first.", "warn"); return; }
    busy = true; renderAll();
    try {
      properties = await svc.read({ device, instance: Number(st().instance) });
      logTo("schedules", `Read schedule ${st().instance} (${properties.length} properties).`, "ok");
    } catch (err) {
      properties = null;
      logTo("schedules", `Read failed: ${err}`, "error");
      toast(`Read failed: ${err}`, "error");
    } finally {
      busy = false; renderAll();
    }
  }

  function buildCommandValue() {
    const s = st();
    if (s.commandKind === "null") return { kind: "null" };
    if (s.commandKind === "boolean") return { kind: "boolean", value: String(s.commandValue).toLowerCase() === "true" || s.commandValue === "1" };
    if (s.commandKind === "real") return { kind: "real", value: Number(s.commandValue) };
    return { kind: s.commandKind, value: Math.trunc(Number(s.commandValue)) };
  }

  async function commandPresentValue() {
    const svc = scheduleSvc();
    const device = selectedDevice();
    if (!svc || !device) { toast("Pick a discovered device first.", "warn"); return; }
    const s = st();
    const priority = s.priority ? Number(s.priority) : null;
    const ok = await confirmAction({
      title: "Command schedule",
      message: `Override Schedule ${s.instance} present-value${priority ? ` at priority ${priority}` : ""}? This writes to the live device.`,
      confirmLabel: "Command",
      danger: true,
    });
    if (!ok) return;
    busy = true; renderAll();
    try {
      await svc.command({ device, instance: Number(s.instance), value: buildCommandValue(), priority });
      logTo("schedules", `Commanded schedule ${s.instance}.`, "ok");
      toast("Command sent.", "ok");
    } catch (err) {
      logTo("schedules", `Command failed: ${err}`, "error");
      toast(`Command failed: ${err}`, "error");
    } finally {
      busy = false; renderAll();
    }
  }

  // ---- device + command card ----

  function deviceCard() {
    const s = st();
    const devs = devices();
    return el("section", { class: "plugin-section" },
      el("h3", { class: "sch-h3" }, "Device & schedule object"),
      devs.length
        ? el("div", { class: "sch-row" },
            el("label", { class: "nm-field" }, el("span", { class: "nm-field-label" }, "Device"),
              el("select", { class: "nm-input", onchange: (e) => { patchState({ deviceKey: e.target.value }); renderAll(); } },
                el("option", { value: "" }, "— select —"),
                ...devs.map((d) => el("option", { value: d.key, selected: s.deviceKey === d.key ? "selected" : undefined },
                  `${d.name || "Device"} (${d.instance}) @ ${d.address}`)))),
            el("label", { class: "nm-field sch-narrow" }, el("span", { class: "nm-field-label" }, "Schedule #"),
              el("input", { class: "nm-input", type: "number", value: String(s.instance), onchange: (e) => patchState({ instance: Number(e.target.value) }) })),
            el("button", { class: "btn btn-primary btn-sm", disabled: busy ? "disabled" : undefined, onclick: readSchedule }, busy ? "Reading…" : "Read schedule"))
        : el("p", { class: "muted small" }, "No discovered devices yet — run discovery in BACnet Manager first."),
      properties ? propsTable(properties) : null,
      commandCard());
  }

  function propsTable(props) {
    return el("div", { class: "sch-props" },
      el("table", { class: "sch-table" },
        el("thead", {}, el("tr", {}, el("th", {}, "Property"), el("th", {}, "Value"))),
        el("tbody", {}, ...props.map((p) => el("tr", {},
          el("td", {}, p.name || String(p.id)),
          el("td", {}, p.error ? `error: ${p.error}` : (p.display || (p.values || []).map((v) => v.value).join(", "))))))));
  }

  function commandCard() {
    const s = st();
    return el("div", { class: "sch-command" },
      el("h4", { class: "sch-h4" }, "Command present-value (override)"),
      el("div", { class: "sch-row" },
        el("label", { class: "nm-field sch-narrow" }, el("span", { class: "nm-field-label" }, "Kind"),
          el("select", { class: "nm-input", onchange: (e) => { patchState({ commandKind: e.target.value }); renderAll(); } },
            ...VALUE_KINDS.map((k) => el("option", { value: k, selected: s.commandKind === k ? "selected" : undefined }, k)))),
        s.commandKind !== "null"
          ? el("label", { class: "nm-field sch-narrow" }, el("span", { class: "nm-field-label" }, "Value"),
              el("input", { class: "nm-input", type: "text", value: s.commandValue, onchange: (e) => patchState({ commandValue: e.target.value }) }))
          : null,
        el("label", { class: "nm-field sch-narrow" }, el("span", { class: "nm-field-label" }, "Priority"),
          el("select", { class: "nm-input", onchange: (e) => patchState({ priority: e.target.value }) },
            el("option", { value: "", selected: !s.priority ? "selected" : undefined }, "none"),
            ...Array.from({ length: 16 }, (_, i) => i + 1).map((p) => el("option", { value: String(p), selected: s.priority === String(p) ? "selected" : undefined }, String(p))))),
        el("button", { class: "btn btn-ghost btn-sm", disabled: busy ? "disabled" : undefined, onclick: commandPresentValue }, "Command")),
      el("p", { class: "muted small" }, "Commands the schedule's present-value on the live device. Writing the full weekly schedule back to the device is not yet supported."));
  }

  // ---- weekly planner ----

  function plannerCard() {
    const s = st();
    const plan = s.plan;
    const conflicts = findConflicts(plan);
    return el("section", { class: "plugin-section" },
      el("h3", { class: "sch-h3" }, "Weekly schedule planner"),
      conflicts.length
        ? el("p", { class: "pill pill-warn sch-conflict" }, `${conflicts.length} duplicate time(s): ${conflicts.map((c) => `${c.day} ${c.time}`).join(", ")}`)
        : null,
      el("div", { class: "sch-week" }, ...SCHEDULE_DAYS.map((day, i) => el("div", { class: "sch-day" },
        el("div", { class: "sch-day-name" }, day),
        ...(plan.days[i].length
          ? plan.days[i].map((entry) => el("div", { class: "sch-entry" },
              el("span", { class: "sch-entry-time" }, entry.time),
              el("span", { class: "sch-entry-val" }, String(entry.value)),
              el("button", { class: "btn btn-ghost btn-sm sch-x", title: "Remove",
                onclick: () => { patchState({ plan: removeEntry(plan, day, entry.time) }); renderAll(); } }, "×")))
          : [el("span", { class: "muted small" }, "—")])))),
      addEntryRow(),
      el("p", { class: "muted small" }, "The planner is a local design aid; persist plans with the model and hand off via a report."));
  }

  function addEntryRow() {
    return el("div", { class: "sch-row sch-add" },
      el("label", { class: "nm-field sch-narrow" }, el("span", { class: "nm-field-label" }, "Day"),
        el("select", { class: "nm-input", onchange: (e) => { draft.day = e.target.value; } },
          ...SCHEDULE_DAYS.map((d) => el("option", { value: d, selected: draft.day === d ? "selected" : undefined }, d)))),
      el("label", { class: "nm-field sch-narrow" }, el("span", { class: "nm-field-label" }, "Time"),
        el("input", { class: "nm-input", type: "time", value: draft.time, onchange: (e) => { draft.time = e.target.value; } })),
      el("label", { class: "nm-field sch-narrow" }, el("span", { class: "nm-field-label" }, "Value"),
        el("input", { class: "nm-input", type: "text", value: draft.value, onchange: (e) => { draft.value = e.target.value; } })),
      el("button", { class: "btn btn-primary btn-sm", onclick: () => {
        const s = st();
        const num = Number(draft.value);
        const value = draft.value !== "" && !Number.isNaN(num) ? num : draft.value;
        try {
          patchState({ plan: addEntry(s.plan, draft.day, draft.time, value) });
          renderAll();
        } catch (err) { toast(String(err), "error"); }
      } }, "Add entry"));
  }

  function renderPage() {
    if (!bacnetCap()) {
      return el("div", { class: "plugin-controls" },
        el("section", { class: "plugin-section" },
          el("p", { class: "empty-state" }, "BACnet service is not available.")));
    }
    return el("div", { class: "plugin-controls" }, deviceCard(), plannerCard());
  }

  function renderStatusPill() {
    if (busy) return { label: "Working", cls: "pill-running" };
    if (!bacnetCap()) return { label: "—", cls: "pill-muted" };
    const entries = (st().plan?.days || []).reduce((n, d) => n + d.length, 0);
    return entries ? { label: `${entries} entr${entries === 1 ? "y" : "ies"}`, cls: "pill-idle" } : { label: "Idle", cls: "pill-idle" };
  }

  return { renderPage, renderStatusPill };
}
