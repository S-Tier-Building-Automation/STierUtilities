// Graphics Builder — an interactive SVG canvas for drawing per-job graphics and
// binding shapes to modeled points. The document model, immutable ops, and SVG
// rendering live in the tested service (../graphics-builder.js); this module is
// the editor UI: a doc list, a drag/select canvas, and a shape inspector.

import { svgEl } from "../../ui/dom.js";
import { toast } from "../../ui/toast.js";
import { confirmAction } from "../../ui/modal.js";
import {
  createGraphicsBuilder,
  createGraphicDoc,
  addShape,
  updateShape,
  moveShape,
  removeShape,
  bindShape,
  docBindings,
} from "../graphics-builder.js";

const SHAPE_TOOLS = [
  { id: "select", label: "Select" },
  { id: "rect", label: "Rect" },
  { id: "ellipse", label: "Ellipse" },
  { id: "line", label: "Line" },
  { id: "text", label: "Text" },
  { id: "value", label: "Value" },
];

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
export function createGraphicsBuilderUi({
  el, logTo, renderAll, getPlatform, getInventory, userState, saveUserState,
}) {
  let workingDoc = null;       // the doc being edited (closure; persisted via saveDoc)
  let liveValues = {};         // pointId -> display string, for preview
  let saveTimer = null;
  let drag = null;             // { id, startX, startY, moved }

  function st() {
    if (!userState.graphicsBuilder || typeof userState.graphicsBuilder !== "object") {
      userState.graphicsBuilder = { currentDocId: null, selectedShapeId: null, activeTool: "select" };
    }
    return userState.graphicsBuilder;
  }
  function patchState(patch) {
    const cur = st();
    const changed = Object.entries(patch).some(([k, v]) => cur[k] !== v);
    if (!changed) return;
    Object.assign(cur, patch);
    saveUserState();
  }

  function builderSvc() {
    const inventory = getInventory();
    return inventory ? createGraphicsBuilder({ inventory }) : null;
  }
  function bacnetCap() {
    const platform = getPlatform();
    return platform ? platform.capability("bacnet.read.v1") : null;
  }

  function ensureWorkingDoc(builder) {
    const s = st();
    if (!s.currentDocId) { workingDoc = null; return; }
    if (!workingDoc || workingDoc.id !== s.currentDocId) {
      workingDoc = builder.loadDoc(s.currentDocId) || null;
    }
  }

  function commitDoc(builder, nextDoc, { reselect } = {}) {
    workingDoc = nextDoc;
    if (reselect !== undefined) patchState({ selectedShapeId: reselect });
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { builder.saveDoc(workingDoc); }
      catch (err) { logTo("graphics-builder", `Save failed: ${err}`, "error"); }
    }, 250);
  }

  // ---- canvas ----

  function selectedShape() {
    const id = st().selectedShapeId;
    return workingDoc?.shapes.find((s) => s.id === id) || null;
  }

  function shapeNode(builder, shape) {
    const p = shape.props || {};
    const selected = shape.id === st().selectedShapeId;
    const common = {
      "data-shape": shape.id,
      style: "cursor:move",
      onpointerdown: (e) => beginDrag(e, builder, shape.id),
    };
    let node;
    if (shape.kind === "rect") {
      node = svgEl("rect", { ...common, x: shape.x, y: shape.y, width: shape.w, height: shape.h, fill: p.fill, stroke: p.stroke, "stroke-width": p.strokeWidth });
    } else if (shape.kind === "ellipse") {
      node = svgEl("ellipse", { ...common, cx: shape.x + shape.w / 2, cy: shape.y + shape.h / 2, rx: shape.w / 2, ry: shape.h / 2, fill: p.fill, stroke: p.stroke, "stroke-width": p.strokeWidth });
    } else if (shape.kind === "line") {
      node = svgEl("line", { ...common, x1: shape.x, y1: shape.y, x2: shape.x + shape.w, y2: shape.y + shape.h, stroke: p.stroke, "stroke-width": p.strokeWidth });
    } else {
      let label = shape.text;
      if (shape.kind === "value" && shape.binding) {
        const key = shape.binding.pointId || shape.binding.sourceRef;
        label = liveValues[key] != null ? liveValues[key] : (shape.text || "—");
      }
      node = svgEl("text", { ...common, x: shape.x, y: shape.y + (p.fontSize || 14), "font-size": p.fontSize, fill: p.color }, label || "");
    }
    if (selected) {
      const box = svgEl("rect", {
        x: shape.x - 3, y: shape.y - 3, width: (shape.w || 1) + 6, height: (shape.h || (p.fontSize || 14)) + 6,
        fill: "none", stroke: "var(--accent-2)", "stroke-width": 1, "stroke-dasharray": "4 3", "pointer-events": "none",
      });
      return svgEl("g", {}, node, box);
    }
    return node;
  }

  function toSvgPoint(svg, clientX, clientY) {
    const rect = svg.getBoundingClientRect();
    const sx = workingDoc.width / rect.width;
    const sy = workingDoc.height / rect.height;
    return { x: (clientX - rect.left) * sx, y: (clientY - rect.top) * sy };
  }

  function beginDrag(e, builder, shapeId) {
    e.preventDefault();
    e.stopPropagation();
    patchState({ selectedShapeId: shapeId });
    const svg = e.currentTarget.ownerSVGElement || e.currentTarget;
    const start = toSvgPoint(svg, e.clientX, e.clientY);
    drag = { id: shapeId, startX: start.x, startY: start.y, moved: false };
    const onMove = (ev) => {
      if (!drag) return;
      const pt = toSvgPoint(svg, ev.clientX, ev.clientY);
      const dx = Math.round(pt.x - drag.startX);
      const dy = Math.round(pt.y - drag.startY);
      const g = svg.querySelector(`[data-shape="${shapeId}"]`);
      if (g) g.setAttribute("transform", `translate(${dx} ${dy})`);
      drag.lastDx = dx; drag.lastDy = dy; drag.moved = true;
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const d = drag; drag = null;
      if (d && d.moved && (d.lastDx || d.lastDy)) {
        commitDoc(builder, moveShape(workingDoc, shapeId, d.lastDx, d.lastDy));
      }
      renderAll();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    renderAll();
  }

  function onCanvasClick(e, builder, svg) {
    const tool = st().activeTool;
    if (tool === "select" || drag) return;
    const pt = toSvgPoint(svg, e.clientX, e.clientY);
    const next = addShape(workingDoc, { kind: tool, x: Math.round(pt.x), y: Math.round(pt.y), text: tool === "text" ? "Label" : "" });
    const newId = next.shapes[next.shapes.length - 1].id;
    commitDoc(builder, next, { reselect: newId });
    patchState({ activeTool: "select" });
    renderAll();
  }

  function canvasNode(builder) {
    const svg = svgEl("svg", {
      viewBox: `0 0 ${workingDoc.width} ${workingDoc.height}`,
      class: "gb-canvas",
      width: workingDoc.width,
      height: workingDoc.height,
    });
    svg.appendChild(svgEl("rect", { x: 0, y: 0, width: workingDoc.width, height: workingDoc.height, fill: workingDoc.background || "#0b0f17" }));
    for (const shape of workingDoc.shapes) svg.appendChild(shapeNode(builder, shape));
    svg.addEventListener("click", (e) => onCanvasClick(e, builder, svg));
    return svg;
  }

  // ---- inspector ----

  function numberField(label, value, onCommit) {
    return el("label", { class: "nm-field gb-field" },
      el("span", { class: "nm-field-label" }, label),
      el("input", { class: "nm-input", type: "number", value: String(value ?? 0),
        onchange: (e) => onCommit(Number(e.target.value)) }));
  }
  function colorField(label, value, onCommit) {
    return el("label", { class: "nm-field gb-field" },
      el("span", { class: "nm-field-label" }, label),
      el("input", { class: "nm-input", type: "text", value: value || "",
        onchange: (e) => onCommit(e.target.value) }));
  }

  function inspector(builder, inv) {
    const shape = selectedShape();
    if (!shape) return el("p", { class: "muted small" }, "Select a shape, or pick a tool and click the canvas to add one.");
    const set = (patch) => { commitDoc(builder, updateShape(workingDoc, shape.id, patch)); renderAll(); };
    const setProp = (patch) => set({ props: { ...shape.props, ...patch } });

    const rows = [
      el("div", { class: "gb-row" }, numberField("X", shape.x, (v) => set({ x: v })), numberField("Y", shape.y, (v) => set({ y: v }))),
      el("div", { class: "gb-row" }, numberField("W", shape.w, (v) => set({ w: v })), numberField("H", shape.h, (v) => set({ h: v }))),
      el("div", { class: "gb-row" }, colorField("Fill", shape.props.fill, (v) => setProp({ fill: v })), colorField("Stroke", shape.props.stroke, (v) => setProp({ stroke: v }))),
    ];
    if (shape.kind === "text" || shape.kind === "value") {
      rows.push(el("label", { class: "nm-field" }, el("span", { class: "nm-field-label" }, shape.kind === "value" ? "Fallback text" : "Text"),
        el("input", { class: "nm-input", type: "text", value: shape.text || "", onchange: (e) => set({ text: e.target.value }) })));
      rows.push(el("div", { class: "gb-row" }, numberField("Font", shape.props.fontSize, (v) => setProp({ fontSize: v })), colorField("Color", shape.props.color, (v) => setProp({ color: v }))));
    }
    if (shape.kind === "value") rows.push(bindingEditor(builder, inv, shape));

    rows.push(el("div", { class: "tool-actions" },
      el("button", { class: "btn btn-ghost btn-danger btn-sm", onclick: () => { commitDoc(builder, removeShape(workingDoc, shape.id), { reselect: null }); renderAll(); } }, "Delete shape")));
    return el("div", { class: "gb-inspector" }, ...rows);
  }

  function bindingEditor(builder, inv, shape) {
    const points = inv ? inv.listEntities({ type: "point" }) : [];
    const b = shape.binding || {};
    const select = el("select", { class: "nm-input",
      onchange: (e) => { commitDoc(builder, bindShape(workingDoc, shape.id, e.target.value ? { ...b, pointId: e.target.value } : null)); renderAll(); } },
      el("option", { value: "" }, "— unbound —"),
      ...points.map((p) => el("option", { value: p.id, selected: b.pointId === p.id ? "selected" : undefined }, p.name || p.id)));
    return el("div", { class: "gb-binding" },
      el("label", { class: "nm-field" }, el("span", { class: "nm-field-label" }, "Bound point"), select),
      el("div", { class: "gb-row" },
        el("label", { class: "nm-field gb-field" }, el("span", { class: "nm-field-label" }, "Unit"),
          el("input", { class: "nm-input", type: "text", value: b.unit || "", onchange: (e) => { commitDoc(builder, bindShape(workingDoc, shape.id, { ...b, unit: e.target.value || null })); } })),
        numberField("Precision", b.precision ?? 1, (v) => commitDoc(builder, bindShape(workingDoc, shape.id, { ...b, precision: v })))));
  }

  // ---- live preview ----

  async function refreshValues(inv) {
    const bacnet = bacnetCap();
    if (!bacnet || !workingDoc) { toast("No BACnet service for live values.", "warn"); return; }
    const next = {};
    for (const binding of docBindings(workingDoc)) {
      const point = binding.pointId ? inv.getEntity(binding.pointId) : null;
      const objectType = Number(point?.objectType);
      const instance = Number(point?.instance);
      if (!point || !Number.isFinite(objectType) || !Number.isFinite(instance)) continue;
      try {
        const props = await bacnet.readPoint(point.deviceRef || { deviceInstance: point.deviceInstance }, objectType, instance);
        const pv = (props || []).find((p) => p && (p.id === 85 || p.name === "present-value"));
        let v = pv?.display ?? pv?.values?.[0]?.value;
        if (v != null && binding.unit) v = `${v} ${binding.unit}`;
        next[binding.pointId] = v != null ? String(v) : "—";
      } catch (err) {
        next[binding.pointId] = "ERR";
      }
    }
    liveValues = next;
    renderAll();
  }

  // ---- doc list ----

  function docList(builder) {
    const docs = builder.listDocs();
    const s = st();
    return el("div", { class: "gb-doclist" },
      el("div", { class: "tool-actions" },
        el("button", { class: "btn btn-primary btn-sm", onclick: () => {
          const doc = createGraphicDoc({ name: `Graphic ${docs.length + 1}` });
          builder.saveDoc(doc);
          workingDoc = doc;
          patchState({ currentDocId: doc.id.startsWith("template:") ? doc.id : `template:${doc.id}`, selectedShapeId: null });
          renderAll();
        } }, "+ New graphic")),
      docs.length
        ? el("ul", { class: "gb-doc-items" }, ...docs.map((d) => {
            const entityId = d.id.startsWith("template:") ? d.id : `template:${d.id}`;
            return el("li", {},
              el("button", { class: `btn btn-ghost btn-sm gb-doc${s.currentDocId === entityId ? " is-active" : ""}`,
                onclick: () => { patchState({ currentDocId: entityId, selectedShapeId: null }); workingDoc = builder.loadDoc(entityId); renderAll(); } },
                d.name || entityId));
          }))
        : el("p", { class: "muted small" }, "No graphics yet."));
  }

  function toolbar() {
    const active = st().activeTool;
    return el("div", { class: "gb-toolbar" }, ...SHAPE_TOOLS.map((t) =>
      el("button", { class: `btn btn-sm${active === t.id ? " btn-primary" : " btn-ghost"}`,
        onclick: () => { patchState({ activeTool: t.id }); renderAll(); } }, t.label)));
  }

  function renderPage() {
    const inv = getInventory();
    const builder = builderSvc();
    if (!inv || !builder) {
      return el("div", { class: "plugin-controls" },
        el("section", { class: "plugin-section" },
          el("p", { class: "empty-state" }, "Building model is not available.")));
    }
    ensureWorkingDoc(builder);

    const center = workingDoc
      ? el("div", { class: "gb-stage" }, toolbar(),
          el("div", { class: "gb-canvas-wrap" }, canvasNode(builder)),
          el("div", { class: "tool-actions" },
            el("button", { class: "btn btn-ghost btn-sm", onclick: () => refreshValues(inv) }, "Refresh live values")))
      : el("p", { class: "empty-state" }, "Create or select a graphic to start drawing.");

    return el("div", { class: "plugin-controls" },
      el("section", { class: "plugin-section gb-grid" },
        el("div", { class: "gb-col gb-col-left" }, docList(builder)),
        el("div", { class: "gb-col gb-col-center" }, center),
        el("div", { class: "gb-col gb-col-right" }, el("h3", { class: "gb-h3" }, "Inspector"), inspector(builder, inv))));
  }

  function renderStatusPill() {
    const builder = builderSvc();
    if (!builder) return { label: "—", cls: "pill-muted" };
    if (workingDoc) return { label: `${workingDoc.shapes.length} shape${workingDoc.shapes.length === 1 ? "" : "s"}`, cls: "pill-idle" };
    const count = builder.listDocs().length;
    return count ? { label: `${count} graphic${count === 1 ? "" : "s"}`, cls: "pill-idle" } : { label: "Empty", cls: "pill-muted" };
  }

  return { renderPage, renderStatusPill };
}
