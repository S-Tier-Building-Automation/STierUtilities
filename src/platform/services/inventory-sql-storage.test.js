import { test } from "node:test";
import assert from "node:assert/strict";
import { createSqlInventoryStorage } from "./inventory-sql-storage.js";

function makeInvoke(handlers) {
  const calls = [];
  const invoke = async (cmd, args) => {
    calls.push({ cmd, args });
    const h = handlers[cmd];
    if (typeof h === "function") return h(args);
    if (h instanceof Error) throw h;
    return h;
  };
  invoke.calls = calls;
  return invoke;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("falls back to user-state storage when the SQL commands are unavailable", async () => {
  const userState = {
    inventory: { version: 1, entities: [{ id: "site:1", type: "site", name: "A" }] },
  };
  const invoke = makeInvoke({
    inventory_load_snapshot: () => {
      throw new Error("no active auth session");
    },
  });
  const storage = createSqlInventoryStorage({
    invoke,
    getState: () => userState,
    setInventory: () => {},
    saveUserState: () => {},
  });

  const ok = await storage.hydrate();
  assert.equal(ok, false);
  assert.equal(storage.isActive(), false);
  // load() delegates to the legacy user-state blob.
  assert.ok(storage.load().entities.some((e) => e.id === "site:1"));
});

test("hydrate migrates the legacy inventory blob into SQLite when the DB is empty", async () => {
  const userState = {
    inventory: { version: 1, entities: [{ id: "equip:1", type: "equip", name: "Device" }] },
  };
  const saved = [];
  const invoke = makeInvoke({
    inventory_load_snapshot: () => ({ version: 1, entities: [] }),
    inventory_save_snapshot: (args) => saved.push(args.snapshot),
    bacnet_cache_load: () => [],
  });
  const storage = createSqlInventoryStorage({
    invoke,
    getState: () => userState,
    setInventory: () => {},
    saveUserState: () => {},
  });

  const ok = await storage.hydrate();
  assert.equal(ok, true);
  assert.equal(storage.isActive(), true);
  assert.equal(saved.length, 1, "legacy blob should be seeded once");
  assert.ok(saved[0].entities.some((e) => e.id === "equip:1"));
  assert.ok(storage.load().entities.some((e) => e.id === "equip:1"));
});

test("when active, load serves the DB mirror and save pushes a debounced snapshot", async () => {
  const userState = {};
  const pushes = [];
  const invoke = makeInvoke({
    inventory_load_snapshot: () => ({
      version: 1,
      entities: [{ id: "site:1", type: "site", name: "A" }],
    }),
    inventory_save_snapshot: (args) => pushes.push(args.snapshot),
    bacnet_cache_load: () => [],
  });
  const storage = createSqlInventoryStorage({
    invoke,
    getState: () => userState,
    setInventory: () => {},
    saveUserState: () => {},
  });

  await storage.hydrate();
  assert.ok(storage.load().entities.some((e) => e.id === "site:1"));

  storage.save({
    version: 1,
    entities: [
      { id: "site:1", type: "site", name: "A" },
      { id: "equip:9", type: "equip", name: "New" },
    ],
  });
  // Mirror updates synchronously so the next load reflects the write.
  assert.ok(storage.load().entities.some((e) => e.id === "equip:9"));

  await sleep(260);
  assert.ok(
    pushes.some((s) => s.entities.some((e) => e.id === "equip:9")),
    "debounced snapshot should be pushed to SQLite",
  );
});

test("bacnet discovery cache migrates and persists through the adapter", async () => {
  const userState = { bacnetDiscoveryCache: [{ key: "d1", instance: 1 }] };
  const bacSaves = [];
  const invoke = makeInvoke({
    inventory_load_snapshot: () => ({ version: 1, entities: [] }),
    inventory_save_snapshot: () => {},
    bacnet_cache_load: () => [],
    bacnet_cache_save: (args) => bacSaves.push(args.devices),
  });
  const storage = createSqlInventoryStorage({
    invoke,
    getState: () => userState,
    setInventory: () => {},
    saveUserState: () => {},
  });

  await storage.hydrate();
  // Legacy cache seeded into SQLite during hydration.
  assert.ok(bacSaves.length >= 1);
  assert.deepEqual(userState.bacnetDiscoveryCache, [{ key: "d1", instance: 1 }]);

  storage.saveBacnetCache([{ key: "d2", instance: 2 }]);
  assert.deepEqual(userState.bacnetDiscoveryCache, [{ key: "d2", instance: 2 }]);
  await sleep(260);
  assert.ok(bacSaves.some((list) => list.some((d) => d.key === "d2")));
});
