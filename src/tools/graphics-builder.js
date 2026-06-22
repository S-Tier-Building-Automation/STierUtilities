// Custom graphics builder — the integrator's daily deliverable. Where
// device-graphics ships fixed templates (e.g. vav-reheat-series), this lets an
// integrator draw a per-job graphic from primitive shapes and bind each shape to
// a modeled point, then render it live.
//
// The document model and SVG renderer are pure and fully unit-tested; the
// editor UI (drag/drop, handles) is a thin layer that calls these immutable
// operations. Documents persist as inventory `template` entities tagged
// {customGraphic:true} so they ride the same SQLite + Supabase sync as the model.

const SHAPE_KINDS = new Set(["rect", "ellipse", "line", "text", "value"]);

function uid(prefix) {
  const r = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}:${r}`;
}

function clone(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

function escapeXml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** A fresh, empty graphic document. */
export function createGraphicDoc({ name = "Untitled Graphic", width = 800, height = 480, background = "#0b0f17" } = {}) {
  return {
    id: uid("graphic"),
    kind: "customGraphic",
    name,
    width,
    height,
    background,
    shapes: [],
    version: 1,
  };
}

function normalizeShape(shape = {}) {
  const kind = SHAPE_KINDS.has(shape.kind) ? shape.kind : "rect";
  return {
    id: shape.id || uid("shape"),
    kind,
    x: Number(shape.x) || 0,
    y: Number(shape.y) || 0,
    w: Number(shape.w) || (kind === "text" || kind === "value" ? 160 : 80),
    h: Number(shape.h) || (kind === "text" || kind === "value" ? 28 : 60),
    text: shape.text != null ? String(shape.text) : "",
    props: {
      fill: shape.props?.fill ?? "#1b2430",
      stroke: shape.props?.stroke ?? "#5b6b7f",
      strokeWidth: Number(shape.props?.strokeWidth ?? 1),
      fontSize: Number(shape.props?.fontSize ?? 14),
      color: shape.props?.color ?? "#e6edf3",
    },
    // binding: { pointId?, sourceRef?, unit?, precision? } — value shapes show the live value.
    binding: shape.binding ? clone(shape.binding) : null,
  };
}

export function addShape(doc, shape) {
  const next = clone(doc);
  next.shapes.push(normalizeShape(shape));
  return next;
}

export function updateShape(doc, shapeId, patch) {
  const next = clone(doc);
  const i = next.shapes.findIndex((s) => s.id === shapeId);
  if (i >= 0) next.shapes[i] = normalizeShape({ ...next.shapes[i], ...patch, id: shapeId });
  return next;
}

export function moveShape(doc, shapeId, dx, dy) {
  const next = clone(doc);
  const s = next.shapes.find((x) => x.id === shapeId);
  if (s) {
    s.x += Number(dx) || 0;
    s.y += Number(dy) || 0;
  }
  return next;
}

export function removeShape(doc, shapeId) {
  const next = clone(doc);
  next.shapes = next.shapes.filter((s) => s.id !== shapeId);
  return next;
}

/** Bind (or clear, with null) a shape to a modeled point. */
export function bindShape(doc, shapeId, binding) {
  const next = clone(doc);
  const s = next.shapes.find((x) => x.id === shapeId);
  if (s) s.binding = binding ? clone(binding) : null;
  return next;
}

/** All bindings in a doc, for resolving live values. */
export function docBindings(doc) {
  return (doc?.shapes || [])
    .filter((s) => s.binding && (s.binding.pointId || s.binding.sourceRef))
    .map((s) => ({ shapeId: s.id, ...s.binding }));
}

/** Format a bound value for display (precision + unit). */
function formatValue(raw, binding) {
  if (raw == null) return "—";
  let out = raw;
  if (typeof raw === "number" && binding && Number.isFinite(binding.precision)) {
    out = raw.toFixed(binding.precision);
  }
  return binding?.unit ? `${out} ${binding.unit}` : String(out);
}

/**
 * Render the document to an SVG string. `values` maps pointId/sourceRef to a
 * live value; bound "value" shapes show it. Pure and deterministic.
 */
export function renderSvg(doc, { values = {} } = {}) {
  if (!doc) return "";
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${doc.width} ${doc.height}" width="${doc.width}" height="${doc.height}">`,
    `<rect x="0" y="0" width="${doc.width}" height="${doc.height}" fill="${escapeXml(doc.background)}"/>`,
  ];
  for (const s of doc.shapes || []) {
    const p = s.props || {};
    if (s.kind === "rect") {
      parts.push(`<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" fill="${escapeXml(p.fill)}" stroke="${escapeXml(p.stroke)}" stroke-width="${p.strokeWidth}"/>`);
    } else if (s.kind === "ellipse") {
      parts.push(`<ellipse cx="${s.x + s.w / 2}" cy="${s.y + s.h / 2}" rx="${s.w / 2}" ry="${s.h / 2}" fill="${escapeXml(p.fill)}" stroke="${escapeXml(p.stroke)}" stroke-width="${p.strokeWidth}"/>`);
    } else if (s.kind === "line") {
      parts.push(`<line x1="${s.x}" y1="${s.y}" x2="${s.x + s.w}" y2="${s.y + s.h}" stroke="${escapeXml(p.stroke)}" stroke-width="${p.strokeWidth}"/>`);
    } else if (s.kind === "text" || s.kind === "value") {
      let label = s.text;
      if (s.kind === "value" && s.binding) {
        const key = s.binding.pointId || s.binding.sourceRef;
        label = formatValue(values[key], s.binding);
      }
      parts.push(`<text x="${s.x}" y="${s.y + (p.fontSize || 14)}" font-size="${p.fontSize}" fill="${escapeXml(p.color)}">${escapeXml(label)}</text>`);
    }
  }
  parts.push("</svg>");
  return parts.join("");
}

/**
 * Persistence + listing service over the inventory capability. Custom graphics
 * are stored as `template` entities tagged {customGraphic:true} with the doc in
 * a `graphicDoc` field, so they sync with the rest of the model.
 */
export function createGraphicsBuilder({ inventory } = {}) {
  if (!inventory) throw new Error("graphics builder requires an inventory capability");

  return {
    createGraphicDoc,
    addShape,
    updateShape,
    moveShape,
    removeShape,
    bindShape,
    renderSvg,
    docBindings,

    /** Persist a graphic doc as a tagged template entity. */
    saveDoc(doc, { equipId = null } = {}) {
      const entity = inventory.upsertEntity({
        id: doc.id?.startsWith("template:") ? doc.id : `template:${doc.id}`,
        type: "template",
        name: doc.name,
        equipId,
        tags: { customGraphic: true },
        graphicDoc: doc,
      });
      return entity;
    },

    /** List saved custom graphics. */
    listDocs() {
      return inventory
        .listEntities({ type: "template", tag: "customGraphic" })
        .map((e) => e.graphicDoc)
        .filter(Boolean);
    },

    /** Load one saved graphic doc by its entity id. */
    loadDoc(entityId) {
      const id = entityId?.startsWith("template:") ? entityId : `template:${entityId}`;
      return inventory.getEntity(id)?.graphicDoc || null;
    },
  };
}
