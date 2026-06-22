// Compatibility layer for the legacy renderAll()/renderScoped() API. The ~130
// existing call sites keep calling these; this module routes them to the new
// world: push status into stores, re-render chrome (imperative until Phase 2),
// re-render the current page/tool, or dispatch a scope to its registered
// renderer (scope-registry) instead of a hard-coded shell if/else.
//
// The concrete render functions are injected by the wiring layer (app-tools.js)
// via configureRenderBridge so this module imports nothing from the UI/shell and
// stays unit-testable.

import { getScopedRenderer } from "./scope-registry.js";

let _renderChrome = () => {};
let _renderPage = () => {};
let _pushStatus = () => {};

export function configureRenderBridge({ renderChrome, renderPage, pushStatus } = {}) {
  if (renderChrome) _renderChrome = renderChrome;
  if (renderPage) _renderPage = renderPage;
  if (pushStatus) _pushStatus = pushStatus;
}

export function renderAll() {
  _pushStatus();
  _renderChrome();
  _renderPage();
}

export function renderScoped(scope = "page") {
  if (scope === "all") return renderAll();
  if (scope === "chrome") {
    _pushStatus();
    _renderChrome();
    return;
  }
  if (scope === "page") return _renderPage();
  const fn = getScopedRenderer(scope);
  if (fn) return fn();
  // Unknown/typo'd scope: fall back to a current-page re-render rather than a
  // silent no-op, matching the old default-"page" behavior in app-shell.js.
  return _renderPage();
}

/** Test helper: reset injected functions. */
export function resetRenderBridge() {
  _renderChrome = () => {};
  _renderPage = () => {};
  _pushStatus = () => {};
}
