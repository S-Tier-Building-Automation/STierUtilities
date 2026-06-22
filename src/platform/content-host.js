// Bridge between the imperative render path (app-shell.renderCurrentPage) and the
// Svelte ContentRoot that owns the keep-alive pool of tool pages. ContentRoot
// registers its imperative API here on mount; renderCurrentPage looks it up to
// show/refresh tools without importing the Svelte component (keeps app-shell.js
// free of .svelte imports so it stays node --test-able).

/** @type {{ showTool(id: string): void, showBuiltin(): void } | null} */
let host = null;

export function setContentHost(api) {
  host = api;
}

export function getContentHost() {
  return host;
}
