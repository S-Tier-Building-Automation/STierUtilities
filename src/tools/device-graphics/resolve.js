import { DEVICE_GRAPHICS, TEMPLATE_GRAPHIC_FALLBACK } from "./definitions.js";

/**
 * @typedef {{ x: number, y: number }} GraphicAnchor
 * @typedef {{ id: string, label: string, roles?: string[], format?: string, anchor?: GraphicAnchor, leader?: GraphicAnchor }} GraphicSlot
 * @typedef {{ id: string, title?: string, templateIds?: string[], statusSlots?: string[], roleMatchers?: { role: string, patterns: string[] }[], slots?: GraphicSlot[], parameters?: GraphicSlot[] }} DeviceGraphicDefinition
 * @typedef {{ slotId: string, label: string, pointId: string|null, pointName: string|null, display: string, value: *, error: string|null, loading: boolean, format: string, updatedAt?: string|null }} GraphicSlotBinding
 * @typedef {{ graphic: DeviceGraphicDefinition|null, callouts: GraphicSlotBinding[], status: GraphicSlotBinding[], parameters: GraphicSlotBinding[], boundCount: number, totalSlots: number, unboundSlots: GraphicSlot[] }} ResolvedGraphicBindings
 */

export function normalizeGraphicRole(role) {
  return String(role || "").trim().toLowerCase().replace(/_/g, "-");
}

export function graphicById(id) {
  const key = String(id || "").trim();
  if (!key) return null;
  return DEVICE_GRAPHICS.find((g) => g.id === key) || null;
}

export function graphicForTemplate(template) {
  if (!template) return null;
  const graphicId = template.graphicId || TEMPLATE_GRAPHIC_FALLBACK[template.id] || TEMPLATE_GRAPHIC_FALLBACK[String(template.id || "").replace(/^template:/, "")];
  return graphicId ? graphicById(graphicId) : null;
}

export function graphicForEquip(equip, template = null) {
  if (!equip) return null;
  if (equip.graphicId) return graphicById(equip.graphicId);
  if (template) return graphicForTemplate(template);
  const templateId = equip.templateId || "";
  const fallbackId = TEMPLATE_GRAPHIC_FALLBACK[templateId] || TEMPLATE_GRAPHIC_FALLBACK[templateId.replace(/^template:/, "")];
  return fallbackId ? graphicById(fallbackId) : null;
}

export function pointGraphicRole(point) {
  return normalizeGraphicRole(point?.tags?.graphicRole || "");
}

export function slotRoleKeys(slot) {
  return [slot.id, ...(slot.roles || [])].map(normalizeGraphicRole).filter(Boolean);
}

function matcherForRole(graphic, role) {
  const key = normalizeGraphicRole(role);
  return (graphic.roleMatchers || []).find((m) => normalizeGraphicRole(m.role) === key) || null;
}

export function inferPointGraphicRole(point, graphic, roles = []) {
  const explicit = pointGraphicRole(point);
  const allowed = new Set(roles.map(normalizeGraphicRole));
  if (explicit && (!allowed.size || allowed.has(explicit))) return explicit;
  const name = String(point?.name || "").toUpperCase();
  for (const role of roles) {
    const matcher = matcherForRole(graphic, role);
    if (!matcher) continue;
    for (const pattern of matcher.patterns || []) {
      if (name.includes(String(pattern).toUpperCase())) return normalizeGraphicRole(matcher.role);
    }
  }
  return "";
}

function liveEntryForPoint(pointId, liveValues) {
  if (!liveValues) return null;
  if (liveValues instanceof Map) return liveValues.get(pointId) || null;
  if (typeof liveValues === "object") return liveValues[pointId] || null;
  return null;
}

/**
 * @param {{ format?: string, display?: string|null, value?: *, point?: object|null, formatValue?: (point: object|null, raw: string) => string }} opts
 */
export function formatGraphicDisplay({ format, display, value, point = null, formatValue } = {}) {
  const fmt = String(format || "text").toLowerCase();
  const raw = display != null && display !== "" ? String(display) : (value != null ? String(value) : "");
  const base = formatValue && point ? formatValue(point, raw || "—") : (raw || "—");
  if (!raw || raw === "—") return base;

  const upper = base.toUpperCase();
  if (fmt === "onoff") {
    if (/^(1|ON|TRUE|ACTIVE|RUNNING|ENABLED)$/.test(upper)) return "ON";
    if (/^(0|OFF|FALSE|INACTIVE|IDLE|DISABLED)$/.test(upper)) return "OFF";
    return base;
  }
  if (fmt === "temperature") {
    if (/°|DEG|DEGC|DEGF|F\b|C\b/i.test(base)) return base;
    const n = numericFromDisplay(base);
    return n != null ? `${roundForDisplay(n)} °F` : base;
  }
  if (fmt === "percent") {
    if (/%/.test(base)) return base;
    const n = numericFromDisplay(base);
    return n != null ? `${roundForDisplay(n)} %` : base;
  }
  if (fmt === "cfm") {
    if (/cfm/i.test(base)) return base;
    const n = numericFromDisplay(base);
    return n != null ? `${roundForDisplay(n)} cfm` : base;
  }
  if (fmt === "humidity") {
    if (/%rh|rh/i.test(base)) return base;
    const n = numericFromDisplay(base);
    return n != null ? `${roundForDisplay(n)} %RH` : base;
  }
  if (fmt === "ppm") {
    if (/ppm/i.test(base)) return base;
    const n = numericFromDisplay(base);
    return n != null ? `${roundForDisplay(n)} PPM` : base;
  }
  if (fmt === "ppb") {
    if (/ppb/i.test(base)) return base;
    const n = numericFromDisplay(base);
    return n != null ? `${roundForDisplay(n)} PPB` : base;
  }
  return base;
}

/** Parse a number out of a display string, or null when not numeric. */
function numericFromDisplay(base) {
  const n = Number(String(base).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Round a raw float for display: at most `maxDecimals` places, no trailing zeros. */
function roundForDisplay(n, maxDecimals = 2) {
  return String(Number(n.toFixed(maxDecimals)));
}

function humanizeGraphicSlot(id) {
  return String(id || "").split("-").filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function slotDefForId(graphic, id) {
  return (graphic.slots || []).find((s) => s.id === id)
    || (graphic.parameters || []).find((s) => s.id === id)
    || { id, label: humanizeGraphicSlot(id), roles: [id], format: String(id).includes("temperature") ? "temperature" : "text" };
}

function bindSlot(graphic, slot, points, usedPointIds, liveValues, formatValue) {
  const roles = slotRoleKeys(slot);
  let point = points.find((p) => {
    const role = pointGraphicRole(p);
    return role && roles.includes(role) && !usedPointIds.has(p.id);
  }) || null;

  if (!point) {
    for (const p of points) {
      if (usedPointIds.has(p.id)) continue;
      if (pointGraphicRole(p)) continue;
      const inferred = inferPointGraphicRole(p, graphic, roles);
      if (inferred && roles.includes(inferred)) {
        point = p;
        break;
      }
    }
  }

  if (point) usedPointIds.add(point.id);

  const live = point ? liveEntryForPoint(point.id, liveValues) : null;
  const loading = !!(point && !live);
  const error = live?.error ? String(live.error) : null;
  const display = point
    ? formatGraphicDisplay({
        format: slot.format,
        display: live?.display,
        value: live?.value,
        point,
        formatValue,
      })
    : "—";

  return {
    slotId: slot.id,
    label: slot.label,
    pointId: point?.id || null,
    pointName: point?.name || null,
    display: error ? "ERR" : display,
    value: live?.value ?? null,
    error,
    loading,
    format: slot.format || "text",
    updatedAt: live?.updatedAt || null,
  };
}

/**
 * @param {{ graphic: DeviceGraphicDefinition, points?: object[], liveValues?: Map<string, object>|Record<string, object>, formatValue?: (point: object|null, raw: string) => string }} opts
 * @returns {ResolvedGraphicBindings}
 */
export function resolveGraphicBindings({ graphic, points = [], liveValues = null, formatValue } = {}) {
  if (!graphic) {
    return {
      graphic: null,
      callouts: [],
      status: [],
      parameters: [],
      boundCount: 0,
      totalSlots: 0,
      unboundSlots: [],
    };
  }

  const usedPointIds = new Set();
  const callouts = (graphic.slots || []).map((slot) => bindSlot(graphic, slot, points, usedPointIds, liveValues, formatValue));
  const status = (graphic.statusSlots || []).map((id) => bindSlot(graphic, slotDefForId(graphic, id), points, usedPointIds, liveValues, formatValue));
  const parameters = (graphic.parameters || []).map((slot) => bindSlot(graphic, slot, points, usedPointIds, liveValues, formatValue));

  const boundCount = callouts.filter((b) => b.pointId).length
    + parameters.filter((b) => b.pointId).length
    + status.filter((b) => b.pointId).length;
  const totalSlots = (graphic.slots || []).length + (graphic.parameters || []).length + (graphic.statusSlots || []).length;
  const unboundSlots = [
    ...(graphic.slots || []).filter((slot) => !callouts.find((b) => b.slotId === slot.id && b.pointId)),
    ...(graphic.parameters || []).filter((slot) => !parameters.find((b) => b.slotId === slot.id && b.pointId)),
    ...(graphic.statusSlots || []).map((id) => slotDefForId(graphic, id)).filter((slot) => !status.find((b) => b.slotId === slot.id && b.pointId)),
  ];

  return { graphic, callouts, status, parameters, boundCount, totalSlots, unboundSlots };
}

/**
 * Suggest graphicRole tags for points under an equip. Does not write inventory.
 * @returns {{ pointId: string, role: string, pointName: string }[]}
 */
export function suggestGraphicAutoTags({ graphic, points = [] }) {
  if (!graphic) return [];
  const used = new Set();
  const suggestions = [];
  const allSlots = [...(graphic.slots || []), ...(graphic.parameters || []), ...(graphic.statusSlots || []).map((id) => ({ id, label: id }))];
  for (const slot of allSlots) {
    const roles = slotRoleKeys(slot);
    const point = points.find((p) => {
      const role = pointGraphicRole(p);
      return role && roles.includes(role);
    });
    if (point) {
      used.add(point.id);
      continue;
    }
    const candidate = points.find((p) => !used.has(p.id) && !pointGraphicRole(p) && inferPointGraphicRole(p, graphic, roles));
    if (!candidate) continue;
    const role = inferPointGraphicRole(candidate, graphic, roles) || roles[0];
    if (!role) continue;
    used.add(candidate.id);
    suggestions.push({ pointId: candidate.id, role, pointName: candidate.name || candidate.id });
  }
  return suggestions;
}

/**
 * @param {object} inventory
 * @param {string} equipId
 * @param {DeviceGraphicDefinition} graphic
 */
export function applyGraphicAutoTags(inventory, equipId, graphic) {
  if (!inventory || !graphic) return 0;
  const points = inventory.listEntities({ type: "point", equipId });
  const suggestions = suggestGraphicAutoTags({ graphic, points });
  let applied = 0;
  for (const s of suggestions) {
    const point = inventory.getEntity(s.pointId);
    if (!point || pointGraphicRole(point)) continue;
    inventory.upsertEntity({
      ...point,
      tags: { ...(point.tags || {}), graphicRole: s.role },
    });
    applied += 1;
  }
  return applied;
}

export function effectiveDeviceView({ deviceView = "auto", graphic, bindings }) {
  if (deviceView === "table" || deviceView === "graphic") return deviceView;
  if (!graphic || !bindings) return "table";
  const calloutBound = bindings.callouts?.filter((b) => b.pointId).length || 0;
  const statusBound = bindings.status?.filter((b) => b.pointId).length || 0;
  return (calloutBound + statusBound) > 0 ? "graphic" : "table";
}
