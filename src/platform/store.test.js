import { test } from "node:test";
import assert from "node:assert/strict";
import { get } from "svelte/store";
import {
  favorites,
  hidden,
  recents,
  sidebarWidth,
  theme,
  tools,
  favoriteTools,
  recentTools,
  isToolHidden,
  isFavorite,
  isHidden,
  syncFromUserState,
} from "./store.js";

const CATALOG = [
  { id: "notes", manifest: { ui: {} } },
  { id: "bacnet-manager", manifest: { ui: {} } },
  { id: "secret", manifest: { ui: { defaultHidden: true } } },
];

test("syncFromUserState mirrors the userState blob into stores", () => {
  syncFromUserState({
    favorites: { notes: true },
    hidden: { "bacnet-manager": true },
    recentTools: ["notes", "secret"],
    sidebarWidth: 280,
    sidebarCollapsed: true,
    theme: "light",
  });
  assert.deepEqual(get(favorites), { notes: true });
  assert.deepEqual(get(hidden), { "bacnet-manager": true });
  assert.deepEqual(get(recents), ["notes", "secret"]);
  assert.equal(get(sidebarWidth), 280);
  assert.equal(get(theme), "light");
});

test("isToolHidden: explicit flag wins over manifest default", () => {
  assert.equal(isToolHidden(CATALOG[2], {}), true); // defaultHidden
  assert.equal(isToolHidden(CATALOG[2], { secret: false }), false); // explicit override
  assert.equal(isToolHidden(CATALOG[0], {}), false);
});

test("favoriteTools and recentTools derive from the catalog + flags", () => {
  tools.set(CATALOG);
  favorites.set({ notes: true });
  hidden.set({});
  recents.set(["secret", "bacnet-manager", "notes"]);

  assert.deepEqual(get(favoriteTools).map((t) => t.id), ["notes"]);
  // secret is defaultHidden -> excluded; notes is a favorite -> excluded from recents
  assert.deepEqual(get(recentTools).map((t) => t.id), ["bacnet-manager"]);
});

test("imperative isFavorite/isHidden read current store state", () => {
  tools.set(CATALOG);
  favorites.set({ notes: true });
  hidden.set({ "bacnet-manager": true });
  assert.equal(isFavorite("notes"), true);
  assert.equal(isFavorite("secret"), false);
  assert.equal(isHidden("bacnet-manager"), true);
  assert.equal(isHidden("secret"), true); // manifest defaultHidden
  assert.equal(isHidden("notes"), false);
});
