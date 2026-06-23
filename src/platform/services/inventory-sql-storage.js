// SQLite-backed inventory storage adapter.
//
// Implements the same `{ load(), save(), remove() }` contract that
// `createInventory()` consumes, but persists to the embedded SQLite database via
// the `inventory_*` / `bacnet_cache_*` Tauri commands instead of the
// `microtools.user_state.v2` JSON blob.
//
// The inventory service loads synchronously in its constructor, while the DB is
// async — so the adapter keeps an in-memory `mirror` that is hydrated once at
// bootstrap (and again on org switch). Until a successful hydration it stays
// "inactive" and transparently delegates to the legacy user-state storage, which
// keeps the app working before sign-in and on platforms without the native
// commands (e.g. non-Windows dev builds).

import { createUserStateInventoryStorage } from "../../tools/inventory.js";

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

const MAX_PERSIST_DEVICES = 1500;

/**
 * @param {object} deps
 * @param {(cmd: string, args?: object) => Promise<any>} deps.invoke
 * @param {() => object} deps.getState                returns the live userState
 * @param {(inventory: object, meta?: object) => void} deps.setInventory
 * @param {() => void} deps.saveUserState
 */
export function createSqlInventoryStorage({ invoke, getState, setInventory, saveUserState }) {
  const fallback = createUserStateInventoryStorage({ getState, setInventory });

  let active = false;
  let mirror = null; // { version, entities: [...] }
  let saveTimer = null;
  let bacnetTimer = null;

  function load() {
    if (active && mirror) return clone(mirror);
    return fallback.load();
  }

  function save(next) {
    if (!active) {
      fallback.save(next);
      return;
    }
    mirror = clone(next);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      invoke("inventory_save_snapshot", { userId: null, orgId: null, snapshot: mirror })
        .catch((err) => console.warn("[inventory-sql] snapshot save failed:", err));
    }, 200);
  }

  function remove() {
    if (active) {
      mirror = { version: 1, entities: [] };
      invoke("inventory_save_snapshot", { userId: null, orgId: null, snapshot: mirror })
        .catch((err) => console.warn("[inventory-sql] clear failed:", err));
      return;
    }
    fallback.remove?.();
  }

  // Persist the BACnet discovery cache for the active scope. Keeps the in-memory
  // userState mirror in sync (the drift classifier reads it synchronously) and
  // pushes the durable copy to SQLite when active, or to the user-state blob
  // otherwise.
  function saveBacnetCache(devices) {
    const list = Array.isArray(devices) ? devices.slice(0, MAX_PERSIST_DEVICES) : [];
    const state = getState();
    if (state) state.bacnetDiscoveryCache = list;
    if (!active) {
      saveUserState?.();
      return;
    }
    clearTimeout(bacnetTimer);
    bacnetTimer = setTimeout(() => {
      invoke("bacnet_cache_save", { userId: null, orgId: null, devices: list })
        .catch((err) => console.warn("[inventory-sql] bacnet cache save failed:", err));
    }, 200);
  }

  // Flush any debounced writes immediately. Called on app suspend/close so a
  // change made right before exit isn't lost in the 200ms save window.
  function flush() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      invoke("inventory_save_snapshot", { userId: null, orgId: null, snapshot: mirror })
        .catch((err) => console.warn("[inventory-sql] snapshot flush failed:", err));
    }
    if (bacnetTimer) {
      clearTimeout(bacnetTimer);
      bacnetTimer = null;
      const state = getState();
      const list = Array.isArray(state?.bacnetDiscoveryCache)
        ? state.bacnetDiscoveryCache.slice(0, MAX_PERSIST_DEVICES)
        : [];
      invoke("bacnet_cache_save", { userId: null, orgId: null, devices: list })
        .catch((err) => console.warn("[inventory-sql] bacnet cache flush failed:", err));
    }
  }

  async function hydrateBacnetCache() {
    const rows = await invoke("bacnet_cache_load", { userId: null, orgId: null });
    let list = Array.isArray(rows) ? rows : [];
    const state = getState();
    const legacy = Array.isArray(state?.bacnetDiscoveryCache) ? state.bacnetDiscoveryCache : [];
    // One-time migration: seed SQLite from the legacy blob cache if empty.
    if (list.length === 0 && legacy.length > 0) {
      const seed = legacy.slice(0, MAX_PERSIST_DEVICES);
      await invoke("bacnet_cache_save", { userId: null, orgId: null, devices: seed });
      list = seed;
    }
    if (state) state.bacnetDiscoveryCache = list;
  }

  /**
   * Load the snapshot (and BACnet cache) for the active scope into the mirror.
   * On success the adapter becomes active and `load()` serves the DB snapshot.
   * Returns true when the SQLite backend is available, false when we fell back.
   */
  async function hydrate() {
    try {
      const snap = await invoke("inventory_load_snapshot", { userId: null, orgId: null });
      let entities = Array.isArray(snap?.entities) ? snap.entities : [];
      // One-time migration: seed SQLite from the legacy user-state inventory.
      if (entities.length === 0) {
        const legacy = getState()?.inventory;
        const legacyEntities = Array.isArray(legacy?.entities) ? legacy.entities : [];
        if (legacyEntities.length > 0) {
          const seed = { version: legacy.version || 1, entities: legacyEntities };
          await invoke("inventory_save_snapshot", { userId: null, orgId: null, snapshot: seed });
          entities = legacyEntities;
        }
      }
      mirror = { version: Number(snap?.version) || 1, entities: entities.map(clone) };
      await hydrateBacnetCache();
      active = true;
      return true;
    } catch (err) {
      // No active session / commands unavailable -> keep using the fallback.
      active = false;
      return false;
    }
  }

  return {
    load,
    save,
    remove,
    hydrate,
    saveBacnetCache,
    flush,
    isActive: () => active,
  };
}
