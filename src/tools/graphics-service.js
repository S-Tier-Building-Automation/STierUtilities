// building-graphics service — wraps the device-graphics resolver behind the
// graphics.v1 capability. The Graphics app and Building Workspace resolve
// device graphics and bindings through this service instead of importing the
// device-graphics module directly.

import {
  DEVICE_GRAPHICS,
  DEVICE_GRAPHIC_SVG,
} from "./device-graphics/definitions.js";
import {
  graphicById,
  graphicForEquip,
  graphicForTemplate,
  resolveGraphicBindings,
  inferPointGraphicRole,
  suggestGraphicAutoTags,
  applyGraphicAutoTags,
  effectiveDeviceView,
  normalizeGraphicRole,
  pointGraphicRole,
} from "./device-graphics/resolve.js";

/**
 * @param {{ inventory: object }} deps
 */
export function createGraphicsService({ inventory }) {
  if (!inventory) throw new Error("graphics service requires an inventory capability");

  /** Resolve the equip's template entity from inventory, if any. */
  function templateForEquip(equip) {
    return equip?.templateId ? inventory.getEntity(equip.templateId) : null;
  }

  return {
    /** All known device graphic definitions. */
    listDefinitions() {
      return DEVICE_GRAPHICS;
    },

    graphicById(id) {
      return graphicById(id);
    },

    graphicForTemplate(template) {
      return graphicForTemplate(template);
    },

    /** The graphic for an equip; resolves its template from inventory if omitted. */
    graphicForEquip(equip, template = undefined) {
      return graphicForEquip(equip, template === undefined ? templateForEquip(equip) : template);
    },

    /** The raw SVG art for a graphic id (for renderers). */
    svgFor(graphicId) {
      return DEVICE_GRAPHIC_SVG[graphicId] || "";
    },

    /**
     * Resolve slot/callout/status/parameter bindings for an equip. Accepts a
     * pre-fetched graphic + points, or resolves them from inventory.
     * @param {{ equip?: object, graphic?: object|null, points?: object[]|null, liveValues?: Map|Record|null, formatValue?: Function }} opts
     */
    resolveBindings({ equip = null, graphic = undefined, points = null, liveValues = null, formatValue } = {}) {
      const resolvedGraphic = graphic !== undefined ? graphic : (equip ? graphicForEquip(equip, templateForEquip(equip)) : null);
      const resolvedPoints = points || (equip ? inventory.listEntities({ type: "point", equipId: equip.id }) : []);
      return resolveGraphicBindings({ graphic: resolvedGraphic, points: resolvedPoints, liveValues, formatValue });
    },

    inferPointGraphicRole(point, graphic, roles = []) {
      return inferPointGraphicRole(point, graphic, roles);
    },

    suggestAutoTags({ equipId, graphic = undefined } = {}) {
      const equip = inventory.getEntity(equipId);
      if (!equip) return [];
      const resolvedGraphic = graphic !== undefined ? graphic : graphicForEquip(equip, templateForEquip(equip));
      const points = inventory.listEntities({ type: "point", equipId });
      return suggestGraphicAutoTags({ graphic: resolvedGraphic, points });
    },

    applyAutoTags(equipId, graphic = undefined) {
      const equip = inventory.getEntity(equipId);
      if (!equip) return 0;
      const resolvedGraphic = graphic !== undefined ? graphic : graphicForEquip(equip, templateForEquip(equip));
      return applyGraphicAutoTags(inventory, equipId, resolvedGraphic);
    },

    /** Bind (or clear) a point's graphicRole tag and persist it. */
    setPointGraphicRole(pointId, role) {
      const point = inventory.getEntity(pointId);
      if (!point) throw new Error(`graphics: point "${pointId}" not found`);
      const tags = { ...(point.tags || {}) };
      const normalized = normalizeGraphicRole(role);
      if (normalized) tags.graphicRole = normalized;
      else delete tags.graphicRole;
      return inventory.upsertEntity({ ...point, tags });
    },

    /**
     * Assign a slot/role to a point on an equip, clearing the role from any
     * other point on the same equip first so a rebind can't leave two points
     * fighting for one callout. Pass a falsy pointId to clear the slot.
     */
    setSlotBinding({ equipId, slotId, pointId }) {
      const role = normalizeGraphicRole(slotId);
      const points = inventory.listEntities({ type: "point", equipId });
      for (const p of points) {
        if (p.id !== pointId && pointGraphicRole(p) === role) {
          const tags = { ...(p.tags || {}) };
          delete tags.graphicRole;
          inventory.upsertEntity({ ...p, tags });
        }
      }
      return pointId ? this.setPointGraphicRole(pointId, slotId) : null;
    },

    effectiveDeviceView(opts) {
      return effectiveDeviceView(opts);
    },
  };
}
