// Shared horizontal pane splitter — drag, keyboard, double-click reset.

export const PANE_SPLITTER_PX = 8;

/** Clamp a pane width to min/max bounds. */
export function clampPaneWidth(px, { min, max }) {
  const n = Number(px);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** Build a CSS grid-template-columns string for 2- or 3-pane layouts. */
export function buildGridColumns({ left, right = null, threePane = false, splitterPx = PANE_SPLITTER_PX } = {}) {
  const sp = `${splitterPx}px`;
  if (threePane && right != null) {
    return `${left}px ${sp} minmax(0, 1fr) ${sp} ${right}px`;
  }
  return `${left}px ${sp} minmax(0, 1fr)`;
}

/** Track drag on window so it survives the pointer leaving the handle. */
export function attachPaneDrag(handle, { getWidth, setWidth, persist, onEnd }) {
  function startDrag(e) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = getWidth();
    try { handle.setPointerCapture(e.pointerId); } catch (_) { /* not fatal */ }
    document.body.classList.add("pane-resizing");
    const onMove = (ev) => setWidth(startW + (ev.clientX - startX), false);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.body.classList.remove("pane-resizing");
      try { handle.releasePointerCapture(e.pointerId); } catch (_) { /* already released */ }
      if (persist) persist();
      onEnd?.();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }
  handle.addEventListener("pointerdown", startDrag);
  return () => handle.removeEventListener("pointerdown", startDrag);
}

/** Drag from the right edge inward (shrinks right pane / grows center). */
export function attachPaneDragRight(handle, { getWidth, setWidth, persist, onEnd }) {
  function startDrag(e) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = getWidth();
    try { handle.setPointerCapture(e.pointerId); } catch (_) { /* not fatal */ }
    document.body.classList.add("pane-resizing");
    const onMove = (ev) => setWidth(startW - (ev.clientX - startX), false);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.body.classList.remove("pane-resizing");
      try { handle.releasePointerCapture(e.pointerId); } catch (_) { /* already released */ }
      if (persist) persist();
      onEnd?.();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }
  handle.addEventListener("pointerdown", startDrag);
  return () => handle.removeEventListener("pointerdown", startDrag);
}

function paneKeyResize(e, getWidth, setWidth, persist, step = 16) {
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    setWidth(getWidth() - step, true);
    if (persist) persist();
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    setWidth(getWidth() + step, true);
    if (persist) persist();
  }
}

/**
 * Create a vertical pane splitter handle.
 * @param {object} opts
 * @param {string} [opts.id]
 * @param {string} opts.ariaLabel
 * @param {number} opts.min
 * @param {number} opts.max
 * @param {number} opts.value
 * @param {number} [opts.defaultValue]
 * @param {(e: PointerEvent) => void} opts.onPointerDown
 * @param {(e: KeyboardEvent) => void} [opts.onKeyDown]
 * @param {() => void} [opts.onDoubleReset]
 */
export function createPaneSplitter({
  id,
  ariaLabel,
  min,
  max,
  value,
  defaultValue,
  onPointerDown,
  onKeyDown,
  onDoubleReset,
  className = "pane-splitter",
}) {
  const node = document.createElement("div");
  node.className = className;
  if (id) node.id = id;
  node.setAttribute("role", "separator");
  node.tabIndex = 0;
  node.setAttribute("aria-orientation", "vertical");
  node.setAttribute("aria-label", ariaLabel);
  node.setAttribute("aria-valuemin", String(min));
  node.setAttribute("aria-valuemax", String(max));
  node.setAttribute("aria-valuenow", String(value));
  node.title = "Drag to resize · double-click to reset";
  if (onPointerDown) node.addEventListener("pointerdown", onPointerDown);
  if (onKeyDown) node.addEventListener("keydown", onKeyDown);
  if (onDoubleReset) node.addEventListener("dblclick", onDoubleReset);
  return node;
}

/** Wire keyboard resize (±step) on a splitter handle. */
export function paneSplitterKeyHandler(getWidth, setWidth, persist, step = 16) {
  return (e) => paneKeyResize(e, getWidth, setWidth, persist, step);
}

/** Update aria-valuenow on a splitter after width changes. */
export function updateSplitterAria(handle, value) {
  if (handle) handle.setAttribute("aria-valuenow", String(Math.round(value)));
}
