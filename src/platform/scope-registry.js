// Registry of scoped renderers, keyed by scope string (e.g. "building-workspace",
// "bacnet-manager:devices"). Tools register their own scoped re-render functions
// here (in app-tools.js) instead of the generic shell hard-coding an if/else that
// reaches into specific tools. render-bridge.renderScoped() looks scopes up here.

const SCOPED_RENDERERS = new Map();

export function registerScopedRenderer(scope, fn) {
  if (typeof scope !== "string" || typeof fn !== "function") {
    throw new TypeError("registerScopedRenderer(scope:string, fn:function)");
  }
  SCOPED_RENDERERS.set(scope, fn);
}

export function getScopedRenderer(scope) {
  return SCOPED_RENDERERS.get(scope) || null;
}

export function hasScopedRenderer(scope) {
  return SCOPED_RENDERERS.has(scope);
}

/** Test/teardown helper. */
export function clearScopedRenderers() {
  SCOPED_RENDERERS.clear();
}

export { SCOPED_RENDERERS };
