// Reactive projection of the app's user state. The imperative `userState` object
// in user-state.js stays the source of truth and owns persistence; these stores
// are pushed from it via syncFromUserState() so Svelte chrome can update
// surgically instead of through renderAll(). Plain svelte/store (no compiler) so
// this imports under `node --test`.

import { writable, derived, get } from "svelte/store";

export const favorites = writable({});
export const hidden = writable({});
export const recents = writable([]);
export const sidebarWidth = writable(200);
export const sidebarCollapsed = writable(false);
export const theme = writable("dark");

// Pushed by the app-tools wiring layer (never imported by services/kernel).
export const tools = writable([]);
export const systemStatus = writable({});
export const activitySummary = writable({ errors: 0, warns: 0 });

// Monotonic counter bumped on every inventory mutation/reload (inventory.js has
// no change event). Svelte tools that read inventory derive off this so they
// refresh when ANY tool writes the model: `$derived((($inventoryVersion), read()))`.
export const inventoryVersion = writable(0);
export function bumpInventoryVersion() {
  inventoryVersion.update((n) => n + 1);
}

/** Hidden test that mirrors user-state.isHidden: explicit flag wins, else manifest default. */
export function isToolHidden(tool, hiddenMap) {
  if (!tool) return false;
  if (Object.prototype.hasOwnProperty.call(hiddenMap || {}, tool.id)) {
    return Boolean(hiddenMap[tool.id]);
  }
  return Boolean(tool.manifest?.ui?.defaultHidden ?? tool.defaultHidden);
}

/** Visible favorited tools, in catalog order. */
export const favoriteTools = derived([tools, favorites, hidden], ([$tools, $fav, $hidden]) =>
  $tools.filter((t) => $fav[t.id] && !isToolHidden(t, $hidden)),
);

/** Recently-opened tools, newest first, excluding favorites and hidden. */
export const recentTools = derived(
  [tools, recents, favorites, hidden],
  ([$tools, $recents, $fav, $hidden]) =>
    $recents
      .filter((id) => !$fav[id])
      .map((id) => $tools.find((t) => t.id === id))
      .filter((t) => t && !isToolHidden(t, $hidden)),
);

/** Imperative reads for non-Svelte callers (parity with user-state helpers). */
export function isFavorite(id) {
  return Boolean(get(favorites)[id]);
}
export function isHidden(id) {
  const tool = get(tools).find((t) => t.id === id);
  return isToolHidden(tool || { id }, get(hidden));
}

/** Mirror the whole userState blob into the reactive stores (after load / scope switch). */
export function syncFromUserState(s) {
  if (!s) return;
  favorites.set({ ...(s.favorites || {}) });
  hidden.set({ ...(s.hidden || {}) });
  recents.set([...(s.recentTools || [])]);
  sidebarWidth.set(Number.isFinite(Number(s.sidebarWidth)) ? Number(s.sidebarWidth) : 200);
  sidebarCollapsed.set(Boolean(s.sidebarCollapsed));
  if (typeof s.theme === "string") theme.set(s.theme);
}

/** Resolve "system" against the OS preference; "dark"/"light" pass through. */
export function resolveTheme(t) {
  if (t === "system") {
    return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  }
  return t === "light" ? "light" : "dark";
}

/** Apply the theme to <html data-theme> (drives the [data-theme] token layer). */
export function applyTheme(t) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = resolveTheme(t);
}

/** Cycle dark → light → system → dark (used by the theme toggle / palette). */
export function cycleTheme() {
  const order = ["dark", "light", "system"];
  const next = order[(order.indexOf(get(theme)) + 1) % order.length];
  theme.set(next);
  return next;
}
