import { DEVICE_GRAPHIC_SVG } from "../device-graphics/definitions.js";

/**
 * @param {import("../dom.js").el} el
 * @param {{ equip: object, graphic: object, bindings: import("../device-graphics/resolve.js").ResolvedGraphicBindings, svg?: string }} opts
 */
export function renderDeviceGraphic(el, { equip, graphic, bindings, svg }) {
  const art = svg || DEVICE_GRAPHIC_SVG[graphic?.id] || "";
  const calloutNodes = (graphic?.slots || []).map((slot) => {
    const binding = bindings.callouts.find((b) => b.slotId === slot.id);
    const ax = Math.round((slot.anchor?.x ?? 0.5) * 10000) / 100;
    const ay = Math.round((slot.anchor?.y ?? 0.5) * 10000) / 100;
    const lx = slot.leader ? Math.round(slot.leader.x * 10000) / 100 : null;
    const ly = slot.leader ? Math.round(slot.leader.y * 10000) / 100 : null;
    return el("div", {
      class: `bw-graphic-callout${binding?.error ? " bw-graphic-callout-err" : ""}${binding?.loading ? " bw-graphic-callout-loading" : ""}`,
      "data-graphic-slot": slot.id,
      style: `--gx:${ax}%;--gy:${ay}%;${lx != null ? `--lx:${lx}%;--ly:${ly}%;` : ""}`,
      title: binding?.pointName || slot.label,
    },
      el("span", { class: "bw-graphic-callout-label" }, slot.label),
      el("span", { class: "bw-graphic-callout-value", "data-graphic-value": "1" }, binding?.display ?? "—"),
    );
  });

  const artNode = el("div", { class: "bw-graphic-art" });
  if (art) artNode.innerHTML = art;

  const leaderLines = (graphic?.slots || []).filter((s) => s.leader).map((slot) => {
    const x1 = (slot.leader.x ?? 0.5) * 100;
    const y1 = (slot.leader.y ?? 0.5) * 100;
    const x2 = (slot.anchor?.x ?? 0.5) * 100;
    const y2 = (slot.anchor?.y ?? 0.5) * 100;
    return `<line data-graphic-leader="${slot.id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
  }).join("");
  const leaderNode = el("div", { class: "bw-graphic-leaders-wrap", "aria-hidden": "true" });
  if (leaderLines) {
    leaderNode.innerHTML = `<svg class="bw-graphic-leaders" viewBox="0 0 100 100" preserveAspectRatio="none">${leaderLines}</svg>`;
  }

  return el("div", {
    id: "bw-device-graphic",
    class: "bw-device-graphic",
    "data-bw-device-id": equip.id,
  },
    el("div", { class: "bw-graphic-stage" },
      artNode,
      leaderNode,
      el("div", { class: "bw-graphic-callouts" }, ...calloutNodes),
    ),
  );
}

/**
 * @param {import("../dom.js").el} el
 * @param {{ bindings: import("../device-graphics/resolve.js").ResolvedGraphicBindings }} opts
 */
export function renderGraphicStatusRow(el, { bindings }) {
  if (!bindings.status?.length) return null;
  return el("div", { id: "bw-graphic-status", class: "bw-graphic-status-row" },
    ...bindings.status.map((s) =>
      el("div", { class: "bw-graphic-status-chip", "data-graphic-slot": s.slotId },
        el("span", { class: "bw-graphic-status-label" }, s.label),
        el("span", { class: "bw-graphic-status-value", "data-graphic-value": "1" }, s.display),
      ),
    ),
  );
}

/**
 * @param {import("../dom.js").el} el
 * @param {{ mode: "auto"|"graphic"|"table", activeMode?: "graphic"|"table", onChange: (mode: string) => void, boundCount?: number, totalSlots?: number }} opts
 */
export function renderDeviceViewToggle(el, { mode, activeMode, onChange, boundCount = 0, totalSlots = 0 }) {
  const active = activeMode || (mode === "auto" ? "graphic" : mode);
  const mk = (value, label) => el("button", {
    type: "button",
    class: `bw-device-view-btn${active === value ? " is-active" : ""}`,
    "aria-pressed": active === value ? "true" : "false",
    onclick: () => onChange(value),
  }, label);
  return el("div", { class: "bw-device-view-toggle", role: "group", "aria-label": "Device view" },
    mk("graphic", "Graphic"),
    mk("table", "Table"),
    boundCount > 0
      ? el("span", { class: "muted small bw-device-view-meta" }, `${boundCount}/${totalSlots} bound`)
      : el("span", { class: "muted small bw-device-view-meta" }, "No bindings"),
  );
}

/**
 * Patch live values into an existing graphic without rebuilding the pane.
 * @param {import("../device-graphics/resolve.js").ResolvedGraphicBindings} bindings
 */
export function patchDeviceGraphicValues(bindings) {
  if (!bindings || typeof document === "undefined") return;
  for (const item of [...(bindings.callouts || []), ...(bindings.status || [])]) {
    const valueNode = document.querySelector(`[data-graphic-slot="${item.slotId}"] [data-graphic-value]`);
    if (valueNode) valueNode.textContent = item.display ?? "—";
    const chip = document.querySelector(`#bw-graphic-status [data-graphic-slot="${item.slotId}"]`);
    if (chip) {
      chip.classList.toggle("bw-graphic-callout-err", !!item.error);
      chip.classList.toggle("bw-graphic-callout-loading", !!item.loading);
    }
    const callout = document.querySelector(`.bw-graphic-callout[data-graphic-slot="${item.slotId}"]`);
    if (callout) {
      callout.classList.toggle("bw-graphic-callout-err", !!item.error);
      callout.classList.toggle("bw-graphic-callout-loading", !!item.loading);
    }
  }
}

/**
 * @param {import("../dom.js").el} el
 * @param {{ bindings: import("../device-graphics/resolve.js").ResolvedGraphicBindings, showUpdated: boolean, onToggleUpdated?: (on: boolean) => void, onBindSlot?: (slotId: string, pointId: string) => void, points?: object[] }} opts
 */
export function renderMonitoringParameters(el, { bindings, showUpdated, onToggleUpdated, onBindSlot, points = [] }) {
  if (!bindings.parameters?.length) return null;
  const rows = bindings.parameters.map((p) => {
    const slot = bindings.graphic?.parameters?.find((s) => s.id === p.slotId);
    const unbound = !p.pointId && onBindSlot && points.length;
    return el("div", { class: "bw-monitor-row", "data-graphic-slot": p.slotId },
      el("span", { class: "bw-monitor-label" }, p.label),
      el("span", { class: "bw-monitor-value", "data-graphic-value": "1" }, p.display ?? "—"),
      showUpdated && p.updatedAt
        ? el("span", { class: "muted small bw-monitor-updated" }, p.updatedAt)
        : null,
      unbound
        ? el("select", {
            class: "nm-input bw-bind-select",
            onchange: (e) => { if (e.target.value) onBindSlot(p.slotId, e.target.value); },
          },
            el("option", { value: "" }, "Bind point…"),
            ...points.map((pt) => el("option", { value: pt.id }, pt.name || pt.id)),
          )
        : null,
    );
  });
  return el("div", { class: "bw-card bw-detail-card bw-monitor-card" },
    el("div", { class: "bw-monitor-head" },
      el("h4", { class: "bw-card-title" }, "Monitoring parameters"),
      onToggleUpdated
        ? el("label", { class: "bw-monitor-toggle muted small" },
            el("input", {
              type: "checkbox",
              checked: showUpdated ? "checked" : undefined,
              onchange: (e) => onToggleUpdated(e.target.checked),
            }),
            "Show last updated",
          )
        : null,
    ),
    el("div", { class: "bw-monitor-list" }, ...rows),
  );
}

/**
 * @param {import("../dom.js").el} el
 * @param {{ graphic: object, unboundSlots: object[], points: object[], onBindSlot: (slotId: string, pointId: string) => void, onAutoTag: () => void }} opts
 */
export function renderGraphicBindingCard(el, { graphic, unboundSlots, points, onBindSlot, onAutoTag }) {
  if (!graphic || !unboundSlots.length) return null;
  return el("div", { class: "bw-card bw-detail-card" },
    el("h4", { class: "bw-card-title" }, "Graphic bindings"),
    el("p", { class: "muted small" }, `${unboundSlots.length} slot${unboundSlots.length === 1 ? "" : "s"} unbound. Auto-tag from point names or assign manually.`),
    el("div", { class: "tool-actions" },
      el("button", { class: "btn-ghost", onclick: onAutoTag }, "Auto-tag from names"),
    ),
    el("div", { class: "bw-bind-list" },
      ...unboundSlots.map((slot) =>
        el("div", { class: "bw-bind-row" },
          el("span", { class: "bw-bind-label" }, slot.label),
          el("select", {
            class: "nm-input bw-bind-select",
            onchange: (e) => { if (e.target.value) onBindSlot(slot.id, e.target.value); },
          },
            el("option", { value: "" }, "Select point…"),
            ...points.map((p) => el("option", { value: p.id }, p.name || p.id)),
          ),
        ),
      ),
    ),
  );
}
