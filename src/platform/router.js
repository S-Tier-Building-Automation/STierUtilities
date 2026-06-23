// Route as reactive state. The canonical navigation value is still the legacy
// `userState.view` string (persisted unchanged); this module projects it into a
// structured `route` store that Svelte chrome/pages subscribe to instead of
// re-parsing strings. Pure ESM (only svelte/store) so it imports under
// `node --test` with no compiler.

import { writable, derived, get } from "svelte/store";

const BUILTIN = new Set(["home", "library", "settings", "services", "activity", "account"]);

/** "plugin:bacnet-manager" -> { name: "tool", params: { toolId } }; "home" -> { name:"home", params:{} }. */
export function viewToRoute(view) {
  if (typeof view === "string" && view.startsWith("plugin:")) {
    return { name: "tool", params: { toolId: view.slice("plugin:".length) } };
  }
  if (BUILTIN.has(view)) return { name: view, params: {} };
  return { name: "home", params: {} };
}

/** Inverse of viewToRoute — back to the legacy string for persistence/shims. */
export function routeToView(route) {
  if (!route) return "home";
  if (route.name === "tool") return `plugin:${route.params?.toolId ?? ""}`;
  if (BUILTIN.has(route.name)) return route.name;
  return "home";
}

export const route = writable(viewToRoute("home"));

/** Tool id when on a tool route, else null. Replaces currentPluginId(). */
export const activeToolId = derived(route, ($r) => ($r.name === "tool" ? $r.params.toolId : null));

/** Which sidebar nav entry is active. Tool routes light up "library". */
export const activeNav = derived(route, ($r) => ($r.name === "tool" ? "library" : $r.name));

/**
 * Crumb descriptors for the header. Tool name is resolved by the component from
 * the catalog (router stays catalog-agnostic). `view` is the legacy target for a
 * clickable crumb.
 */
export const breadcrumbModel = derived(route, ($r) => {
  if ($r.name === "tool") {
    return [
      { label: "Library", view: "library" },
      { toolId: $r.params.toolId, current: true },
    ];
  }
  const labels = {
    home: "Home", library: "Library", settings: "Settings",
    account: "Account", services: "Services & Capabilities", activity: "Activity",
  };
  return [{ label: labels[$r.name] || "Home", current: true }];
});

/** Push a legacy view string into the route store (called by user-state.setView). */
export function setRouteFromView(view) {
  route.set(viewToRoute(view));
}

/** Read the current route as a legacy view string (backs currentView shim). */
export function currentRouteView() {
  return routeToView(get(route));
}
