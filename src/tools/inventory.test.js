import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bacnetSourceRef,
  createInventory,
  createMemoryInventoryStorage,
  createUserStateInventoryStorage,
  parseSourceRef,
} from "./inventory.js";

test("inventory validates/upserts/removes entities and preserves source refs", () => {
  let next = 1;
  const inv = createInventory({ storage: createMemoryInventoryStorage(), now: () => 1, idFactory: (type) => `${type}:uuid-${next++}` });
  const site = inv.upsertEntity({ type: "site", name: "Main" });
  assert.equal(site.id, "site:uuid-1");
  const point = inv.upsertEntity({
    type: "point",
    name: "RAT",
    sourceRefs: [bacnetSourceRef(123, 0, 4), "bad"],
    tags: { sensor: true },
  });
  assert.equal(point.id, "point:uuid-2");
  assert.deepEqual(point.sourceRefs, ["bacnet:123:0:4"]);
  assert.deepEqual(parseSourceRef(point.sourceRefs[0]), { kind: "bacnet", deviceInstance: 123, objectType: 0, instance: 4 });
  assert.equal(inv.removeEntity(point.id), true);
  assert.equal(inv.getEntity(point.id), null);
});

test("source refs de-dupe generated point ids on repeated imports", () => {
  let next = 1;
  const inv = createInventory({ storage: createMemoryInventoryStorage(), now: () => 1, idFactory: (type) => `${type}:uuid-${next++}` });
  const first = inv.upsertEntity({ type: "point", name: "RAT", sourceRefs: [bacnetSourceRef(123, 0, 4)] });
  const second = inv.upsertEntity({ type: "point", name: "Return Air Temp", sourceRefs: [bacnetSourceRef(123, 0, 4)] });
  assert.equal(second.id, first.id);
  assert.equal(second.name, "Return Air Temp");
  assert.equal(inv.listEntities({ type: "point" }).length, 1);
});

test("tag filters and template application work for VAV/AHU examples", () => {
  const inv = createInventory({ storage: createMemoryInventoryStorage(), now: () => 1 });
  inv.upsertEntity({ id: "equip:vav-1", type: "equip", name: "VAV-1" });
  inv.upsertEntity({ id: "equip:ahu-1", type: "equip", name: "AHU-1" });
  inv.applyTemplate("equip:vav-1", "vav");
  inv.applyTemplate("equip:ahu-1", "ahu");
  assert.deepEqual(inv.listEntities({ type: "equip", tag: "vav" }).map((e) => e.id), ["equip:vav-1"]);
  assert.deepEqual(inv.listEntities({ type: "equip", tag: "ahu" }).map((e) => e.id), ["equip:ahu-1"]);
});

test("building and floor entities support hierarchy filters", () => {
  const inv = createInventory({ storage: createMemoryInventoryStorage(), now: () => 1 });
  inv.upsertEntity({ id: "site:main", type: "site", name: "Main", tags: { site: true, haystack: "4" } });
  inv.upsertEntity({ id: "building:hq", type: "building", siteId: "site:main", parentId: "site:main", name: "HQ", tags: { building: true } });
  inv.upsertEntity({ id: "floor:2", type: "floor", siteId: "site:main", buildingId: "building:hq", parentId: "building:hq", name: "Level 2", tags: { floor: true } });
  inv.upsertEntity({ id: "equip:vav-2", type: "equip", siteId: "site:main", buildingId: "building:hq", floorId: "floor:2", parentId: "floor:2", name: "VAV-2" });
  assert.deepEqual(inv.listEntities({ type: "building", siteId: "site:main" }).map((e) => e.id), ["building:hq"]);
  assert.deepEqual(inv.listEntities({ type: "floor", buildingId: "building:hq" }).map((e) => e.id), ["floor:2"]);
  assert.deepEqual(inv.listEntities({ type: "equip", floorId: "floor:2" }).map((e) => e.id), ["equip:vav-2"]);
  assert.deepEqual(inv.listEntities({ type: "equip", q: "floor:2" }).map((e) => e.id), ["equip:vav-2"]);
});

test("commissioning runs are recorded as inventory entities", () => {
  const inv = createInventory({ storage: createMemoryInventoryStorage(), now: () => 1 });
  const run = inv.recordCommissioningRun({ id: "run:1", steps: [{ status: "pass" }] });
  assert.equal(run.type, "commissioningRun");
  assert.equal(inv.listEntities({ type: "commissioningRun" }).length, 1);
});

test("user-state inventory storage persists model tree data and reloads scoped state", () => {
  let userState = {};
  const storage = createUserStateInventoryStorage({
    getState: () => userState,
    setInventory: (next, meta) => {
      userState = { ...userState, inventory: next, inventoryLegacyMigrated: Boolean(meta?.legacyMigrated) };
    },
  });
  const inv = createInventory({ storage, now: () => 1 });
  inv.upsertEntity({ id: "site:a", type: "site", name: "A" });
  assert.equal(userState.inventory.entities.some((e) => e.id === "site:a"), true);

  userState = {
    inventory: { version: 1, entities: [{ id: "site:b", type: "site", name: "B" }] },
    inventoryLegacyMigrated: true,
  };
  inv.reload();
  assert.equal(inv.getEntity("site:a"), null);
  assert.equal(inv.getEntity("site:b").name, "B");
});

test("user-state inventory storage migrates old browser inventory once", () => {
  let removed = false;
  let userState = {};
  const legacy = {
    load: () => ({ version: 1, entities: [{ id: "site:legacy", type: "site", name: "Legacy" }] }),
    remove: () => { removed = true; },
  };
  const storage = createUserStateInventoryStorage({
    getState: () => userState,
    setInventory: (next, meta) => {
      userState = { ...userState, inventory: next, inventoryLegacyMigrated: Boolean(meta?.legacyMigrated) };
    },
    legacyStorage: legacy,
  });
  const inv = createInventory({ storage, now: () => 1 });
  assert.equal(inv.getEntity("site:legacy").name, "Legacy");
  assert.equal(userState.inventoryLegacyMigrated, true);
  assert.equal(removed, true);
});
