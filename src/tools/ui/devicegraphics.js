// Graphics app — device-level graphics for modeled equipment. A thin shell over
// the graphics.v1 capability: it picks a piece of equipment, resolves its
// graphic + point bindings through the service, renders the schematic with the
// shared device-graphic renderers, polls live BACnet values, and lets the
// operator (re)bind points to graphic roles.

import {
  renderDeviceGraphic,
  renderGraphicStatusRow,
  renderDeviceViewToggle,
  patchDeviceGraphicValues,
  renderMonitoringParameters,
} from "./device-graphic.js";
import { takeAppIntent } from "../../ui/app-intent.js";
import { formatModeledValue } from "../building-workspace.js";

const GFX_POLL_MS = 6000;

/**
 * @param {object} deps
 * @param {import("../../ui/dom.js").el} deps.el
 * @param {(toolId: string, msg: string, kind?: string) => void} deps.logTo
 * @param {() => void} deps.renderAll
 * @param {() => object|null} deps.getPlatform
 * @param {() => object|null} deps.getInventory
 * @param {() => string|null} deps.currentPluginId
 * @param {object} deps.userState
 * @param {() => void} deps.saveUserState
 */
export function createDeviceGraphicsUi({
  el, logTo, renderAll, getPlatform, getInventory, currentPluginId, userState, saveUserState,
}) {
  let liveValues = null;        // Map(pointId -> { value, display } | { error })
  let pollTimer = null;
  let pollBusy = false;
  let polling = false;

  // Persisted, scope-aware UI state (selected equip, view mode, updated toggle).
  function st() {
    if (!userState.deviceGraphics || typeof userState.deviceGraphics !== "object") {
      userState.deviceGraphics = { selectedEquipId: null, deviceView: "auto", showUpdated: false };
    }
    return userState.deviceGraphics;
  }
  function patchState(patch) {
    const cur = st();
    const changed = Object.entries(patch).some(([k, v]) => cur[k] !== v);
    if (!changed) return;
    Object.assign(cur, patch);
    saveUserState();
  }

  function graphicsCap() {
    const platform = getPlatform();
    return platform ? platform.capability("graphics.v1") : null;
  }

  function bacnetCap() {
    const platform = getPlatform();
    return platform ? platform.capability("bacnet.read.v1") : null;
  }

  function equipsWithGraphics(inv, graphics) {
    return inv.listEntities({ type: "equip" }).filter((e) => graphics.graphicForEquip(e));
  }

  function equipHasBinding(equip) {
    return !!(equip && (equip.deviceRef || equip.deviceInstance != null || equip.tags?.bacnet));
  }

  function pointRef(point) {
    const objectType = Number(point?.objectType);
    const instance = Number(point?.instance);
    if (!Number.isFinite(objectType) || !Number.isFinite(instance)) return null;
    return { device: point.deviceRef || { deviceInstance: point.deviceInstance }, objectType, instance };
  }

  function presentValue(props) {
    const entry = (props || []).find((p) => p && (p.id === 85 || p.name === "present-value"));
    if (!entry || entry.error || !Array.isArray(entry.values) || !entry.values.length) return { value: null, display: null };
    return { value: entry.values[0]?.value ?? null, display: entry.display ?? String(entry.values[0]?.value ?? "") };
  }

  function stopPoll() {
    polling = false;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function startPoll(equip) {
    stopPoll();
    polling = true;
    refreshLive(equip);
    pollTimer = setInterval(() => refreshLive(equip), GFX_POLL_MS);
  }

  async function refreshLive(equip) {
    if (pollBusy) return;
    const bacnet = bacnetCap();
    const inv = getInventory();
    const graphics = graphicsCap();
    if (!bacnet || !inv || !graphics || !equip) return;
    if (currentPluginId() !== "device-graphics" || st().selectedEquipId !== equip.id) { stopPoll(); return; }
    pollBusy = true;
    try {
      const dry = graphics.resolveBindings({ equip });
      const pointIds = new Set();
      for (const b of [...dry.callouts, ...dry.status, ...dry.parameters]) {
        if (b.pointId) pointIds.add(b.pointId);
      }
      const values = new Map();
      for (const pid of pointIds) {
        const point = inv.getEntity(pid);
        const ref = pointRef(point);
        if (!ref) { values.set(pid, { error: "no ref" }); continue; }
        try {
          const props = await bacnet.readPoint(ref.device, ref.objectType, ref.instance);
          values.set(pid, presentValue(props));
        } catch (err) {
          values.set(pid, { error: String(err && err.message ? err.message : err) });
        }
      }
      liveValues = values;
      if (currentPluginId() !== "device-graphics" || st().selectedEquipId !== equip.id) return;
      const patched = graphics.resolveBindings({ equip, liveValues, formatValue: formatModeledValue });
      patchDeviceGraphicValues(patched);
      for (const p of patched.parameters || []) {
        const node = document.querySelector(`.bw-monitor-row[data-graphic-slot="${p.slotId}"] [data-graphic-value]`);
        if (node) node.textContent = p.display ?? "—";
      }
    } finally {
      pollBusy = false;
    }
  }

  function selectEquip(id) {
    if (st().selectedEquipId !== id) liveValues = null;
    patchState({ selectedEquipId: id });
    stopPoll();
    renderAll();
  }

  function rebindSlot(slotId, pointId) {
    const graphics = graphicsCap();
    if (!graphics) return;
    try {
      graphics.setSlotBinding({ equipId: st().selectedEquipId, slotId, pointId: pointId || null });
      logTo("device-graphics", pointId ? `Bound graphic role ${slotId}.` : `Cleared graphic role ${slotId}.`, "ok");
    } catch (err) {
      logTo("device-graphics", `Rebind failed: ${err}`, "error");
    }
    renderAll();
  }

  function autoTag(equip) {
    const graphics = graphicsCap();
    if (!graphics) return;
    const tagged = graphics.applyAutoTags(equip.id);
    logTo("device-graphics", tagged
      ? `Auto-tagged ${tagged} point${tagged === 1 ? "" : "s"} from names.`
      : "No new graphic tags to apply.", tagged ? "ok" : "info");
    renderAll();
  }

  function slotBindingCard(bindings, points) {
    const allSlots = [...bindings.callouts, ...bindings.status, ...bindings.parameters];
    if (!allSlots.length) return null;
    const unbound = allSlots.filter((b) => !b.pointId).length;
    return el("div", { class: "bw-card bw-detail-card" },
      el("div", { class: "bw-monitor-head" },
        el("h4", { class: "bw-card-title" }, "Slot bindings"),
        el("button", { class: "btn-ghost btn-sm", onclick: () => autoTag(getInventory().getEntity(st().selectedEquipId)) }, "Auto-tag from names")),
      el("p", { class: "muted small" }, unbound
        ? `${unbound} slot${unbound === 1 ? "" : "s"} unbound. Assign or reassign any callout to a modeled point.`
        : "All slots bound. Reassign or clear any callout below."),
      el("div", { class: "bw-bind-list" },
        ...allSlots.map((b) => el("div", { class: "bw-bind-row" },
          el("span", { class: "bw-bind-label" }, b.label),
          el("select", {
            class: "nm-input bw-bind-select",
            onchange: (e) => rebindSlot(b.slotId, e.target.value),
          },
            el("option", { value: "", selected: !b.pointId ? "selected" : undefined }, b.pointId ? "Clear binding" : "Unbound"),
            ...points.map((p) => el("option", { value: p.id, selected: p.id === b.pointId ? "selected" : undefined }, p.name || p.id)),
          ),
        )),
      ),
    );
  }

  function renderPage() {
    const inv = getInventory();
    const graphics = graphicsCap();
    if (!inv || !graphics) {
      return el("div", { class: "plugin-controls" },
        el("section", { class: "plugin-section" },
          el("p", { class: "empty-state" }, "Building model or graphics engine is not available.")));
    }

    const intent = takeAppIntent("device-graphics");
    if (intent?.equipId && inv.getEntity(intent.equipId)) patchState({ selectedEquipId: intent.equipId });

    const equips = equipsWithGraphics(inv, graphics);
    if (!equips.some((e) => e.id === st().selectedEquipId)) patchState({ selectedEquipId: equips[0]?.id || null });
    const equip = st().selectedEquipId ? inv.getEntity(st().selectedEquipId) : null;

    const picker = el("div", { class: "bw-card bw-detail-card" },
      el("label", { class: "nm-field" },
        el("span", { class: "nm-field-label" }, "Equipment"),
        el("select", {
          class: "nm-input",
          onchange: (e) => selectEquip(e.target.value),
        },
          ...(equips.length ? [] : [el("option", { value: "" }, "No graphics-capable equipment")]),
          ...equips.map((e) => el("option", { value: e.id, selected: e.id === st().selectedEquipId ? "selected" : undefined }, e.name || e.id)),
        ),
      ),
    );

    if (!equip) {
      stopPoll();
      return el("div", { class: "plugin-controls" },
        el("section", { class: "plugin-section" }, picker,
          el("p", { class: "muted small" }, "Import and model equipment in Building Workspace to see device graphics here.")));
    }

    const graphic = graphics.graphicForEquip(equip);
    const bindings = graphics.resolveBindings({ equip, liveValues, formatValue: formatModeledValue });
    const view = graphics.effectiveDeviceView({ deviceView: st().deviceView, graphic, bindings });
    const boundCallouts = bindings.callouts.filter((b) => b.pointId).length;
    const points = inv.listEntities({ type: "point", equipId: equip.id });
    const canPoll = !!bacnetCap() && equipHasBinding(equip);

    const toggle = renderDeviceViewToggle(el, {
      mode: st().deviceView,
      activeMode: view,
      boundCount: boundCallouts,
      totalSlots: (graphic?.slots || []).length,
      onChange: (mode) => { patchState({ deviceView: mode }); renderAll(); },
    });

    const liveBtn = el("button", {
      class: `btn-ghost${polling ? " is-active" : ""}`,
      disabled: canPoll ? undefined : "disabled",
      title: canPoll ? undefined : "This equipment has no BACnet binding for live reads.",
      onclick: () => { if (polling) { stopPoll(); } else { startPoll(equip); } renderAll(); },
    }, polling ? "Stop live" : "Start live");

    const stage = view === "table"
      ? el("div", { class: "bw-card bw-detail-card" },
          el("h4", { class: "bw-card-title" }, "Bindings"),
          el("ul", { class: "bw-bind-list" },
            ...[...bindings.callouts, ...bindings.status, ...bindings.parameters].map((b) =>
              el("li", { class: "bw-bind-row" },
                el("span", { class: "bw-bind-label" }, b.label),
                el("span", { class: "bw-monitor-value" }, b.pointName || "—"),
                el("span", { class: "bw-monitor-value", "data-graphic-value": "1" }, b.display ?? "—")))))
      : el("div", { class: "bw-device-center-wrap bw-device-center-graphic", "data-bw-device-id": equip.id },
          renderGraphicStatusRow(el, { bindings }),
          el("div", { class: "bw-device-center-body pane-fill-body" },
            renderDeviceGraphic(el, { equip, graphic, bindings })),
          boundCallouts === 0
            ? el("p", { class: "muted small bw-graphic-hint" }, "Auto-tag or bind points below to populate callouts.")
            : null);

    if (!canPoll && polling) stopPoll();
    // Keep polling alive across re-renders, but don't restart the interval each
    // render — only (re)start when polling is on yet no timer is currently active.
    if (polling && !pollTimer && currentPluginId() === "device-graphics") startPoll(equip);

    return el("div", { class: "plugin-controls" },
      el("section", { class: "plugin-section" },
        picker,
        el("div", { class: "bw-device-center-toolbar" }, toggle, liveBtn),
        canPoll ? null : el("p", { class: "muted small" }, "No BACnet binding on this equipment — live values are unavailable; bindings can still be edited."),
        stage,
        renderMonitoringParameters(el, {
          bindings,
          showUpdated: st().showUpdated,
          onToggleUpdated: (on) => { patchState({ showUpdated: on }); renderAll(); },
        }),
        slotBindingCard(bindings, points),
      ),
    );
  }

  function renderStatusPill() {
    const inv = getInventory();
    const graphics = graphicsCap();
    if (!inv || !graphics) return { label: "—", cls: "pill-muted" };
    if (polling) return { label: "Live", cls: "pill-running" };
    const count = equipsWithGraphics(inv, graphics).length;
    return count ? { label: `${count} device${count === 1 ? "" : "s"}`, cls: "pill-idle" } : { label: "Empty", cls: "pill-muted" };
  }

  return { renderPage, renderStatusPill, stopPoll };
}
