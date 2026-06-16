import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bwDeviceInboxCandidates,
  bwImportPlanItems,
  bwModelQueuedDevices,
  bwQueueInboxDevices,
  exportCommissioningCsv,
  exportCommissioningMarkdown,
  generateBuildingDashboard,
  historianPointFromEntity,
  pointEntityFromBacnet,
  runCommissioning,
  suggestEquipmentName,
} from "./building-workspace.js";
import { createInventory, createMemoryInventoryStorage } from "./inventory.js";

test("BACnet point imports create stable source refs and historian tags", () => {
  const inv = createInventory({ storage: createMemoryInventoryStorage(), now: () => 1, idFactory: (type) => `${type}:uuid-1` });
  const point = inv.upsertEntity(pointEntityFromBacnet({
    siteId: "site:main",
    buildingId: "building:main",
    floorId: "floor:1",
    equipId: "equip:vav-1",
    device: { instance: 555 },
    object: { objectType: 0, instance: 4, typeName: "analog-input", name: "VAV-1 RAT" },
  }));
  assert.equal(point.id, "point:uuid-1");
  assert.equal(point.sourceRefs[0], "bacnet:555:0:4");
  assert.deepEqual(historianPointFromEntity(point, {
    site: { name: "Main" },
    building: { name: "HQ" },
    floor: { name: "Level 1" },
    equip: { name: "VAV-1" },
  }), {
    device: { deviceInstance: 555 },
    objectType: 0,
    instance: 4,
    label: "VAV-1 RAT",
    site: "Main",
    building: "HQ",
    floor: "Level 1",
    equip: "VAV-1",
    pointId: "point:uuid-1",
  });
});

test("historian tags do not fall back to model ids", () => {
  const point = pointEntityFromBacnet({
    siteId: "site:861",
    buildingId: "building:main",
    floorId: "floor:1",
    equipId: "equip:vav-1",
    device: { instance: 555 },
    object: { objectType: 0, instance: 4, typeName: "analog-input", name: "VAV-1 RAT" },
  });
  const record = historianPointFromEntity(point);
  assert.equal(record.site, "");
  assert.equal(record.building, "");
  assert.equal(record.floor, "");
  assert.equal(record.equip, "");
});

test("device inbox classifies new queued modeled and changed devices", () => {
  const devices = [
    { key: "d1", instance: 1001, address: "192.168.1.10", name: "New" },
    { key: "d2", instance: 1002, address: "192.168.1.11", name: "Modeled" },
    { key: "d3", instance: 1003, address: "192.168.1.12", name: "Queued" },
    { key: "d4", instance: 1004, address: "192.168.1.99", vendorId: 12, modelName: "B", name: "Changed" },
  ];
  const modeledDevices = [
    { id: "equip:d2", type: "equip", tags: { device: true }, deviceInstance: 1002, address: "192.168.1.11" },
    { id: "equip:d4", type: "equip", tags: { device: true }, deviceInstance: 1004, address: "192.168.1.44", vendorId: 12, modelName: "A" },
  ];
  const candidates = { d3: { key: "d3", status: "queued" } };
  const byKey = new Map(bwDeviceInboxCandidates({ devices, modeledDevices, candidates }).map((c) => [c.key, c]));
  assert.equal(byKey.get("d1").status, "new");
  assert.equal(byKey.get("d2").status, "modeled");
  assert.equal(byKey.get("d3").status, "queued");
  assert.equal(byKey.get("d4").status, "changed");
  assert.equal(byKey.get("d2").queueable, false);
});

test("device inbox queueing excludes already-modeled devices", () => {
  const devices = [
    { key: "d1", instance: 1001, address: "192.168.1.10" },
    { key: "d2", instance: 1002, address: "192.168.1.11" },
  ];
  const modeledDevices = [
    { id: "equip:d2", type: "equip", tags: { device: true }, deviceInstance: 1002, address: "192.168.1.11" },
  ];
  const candidates = bwQueueInboxDevices({
    candidates: {},
    keys: ["d1", "d2"],
    devices,
    modeledDevices,
    targetFloorId: "floor:1",
    now: () => 1,
  });
  assert.equal(candidates.d1.status, "queued");
  assert.equal(candidates.d1.targetFloorId, "floor:1");
  assert.equal(candidates.d2, undefined);
});

test("device inbox import plan preserves proposed names and skips modeled devices", () => {
  const devices = [
    { key: "d1", instance: 1001, address: "192.168.1.10", name: "VAV-101" },
    { key: "d2", instance: 1002, address: "192.168.1.11", name: "VAV-102" },
  ];
  const modeledDevices = [
    { id: "equip:d2", type: "equip", tags: { device: true }, deviceInstance: 1002, address: "192.168.1.11" },
  ];
  const candidates = {
    d1: { key: "d1", status: "queued", targetFloorId: "floor:1", proposedName: "Zone VAV 101" },
    d2: { key: "d2", status: "queued", targetFloorId: "floor:1" },
  };
  const plan = bwImportPlanItems({ devices, modeledDevices, candidates, targetFloorName: "Level 1" });
  assert.equal(plan.length, 2);
  assert.equal(plan[0].action, "add");
  assert.equal(plan[0].proposedName, "Zone VAV 101");
  assert.equal(plan[0].targetFloorId, "floor:1");
  assert.equal(plan[1].action, "skip");
  assert.equal(plan[1].status, "modeled");
  assert.equal(plan[1].modeledEntityId, "equip:d2");
});

test("device inbox modeling creates equipment and marks queued candidates modeled", () => {
  const inv = createInventory({ storage: createMemoryInventoryStorage(), now: () => 1 });
  const site = inv.upsertEntity({ id: "site:main", type: "site", name: "Main" });
  const building = inv.upsertEntity({ id: "building:main", type: "building", siteId: site.id, parentId: site.id, name: "HQ" });
  const floor = inv.upsertEntity({ id: "floor:1", type: "floor", siteId: site.id, buildingId: building.id, parentId: building.id, name: "Level 1" });
  const devices = [{ key: "d1", instance: 1001, address: "192.168.1.10", name: "VAV-101" }];
  const candidates = { d1: { key: "d1", status: "queued", targetFloorId: floor.id } };
  const result = bwModelQueuedDevices({
    inventory: inv,
    devices,
    candidates,
    site,
    building,
    floor,
    keys: ["d1"],
    makeEntity: ({ site, building, floor, device }) => ({
      type: "equip",
      siteId: site.id,
      buildingId: building.id,
      floorId: floor.id,
      parentId: floor.id,
      name: device.name,
      deviceInstance: device.instance,
      deviceRef: { address: device.address, deviceInstance: device.instance },
      address: device.address,
      tags: { equip: true, device: true, bacnet: true },
    }),
  });
  assert.equal(result.imported.length, 1);
  assert.equal(result.candidates.d1.status, "modeled");
  assert.equal(result.candidates.d1.modeledEntityId, result.imported[0].id);
  assert.equal(inv.listEntities({ type: "equip", floorId: floor.id })[0].name, "VAV-101");
});

test("device inbox detects address conflicts", () => {
  const devices = [{ key: "d1", instance: 2002, address: "192.168.1.50", name: "Duplicate address" }];
  const modeledDevices = [
    { id: "equip:different", type: "equip", tags: { device: true }, deviceInstance: 2001, address: "192.168.1.50" },
  ];
  const [candidate] = bwDeviceInboxCandidates({ devices, modeledDevices, candidates: {} });
  assert.equal(candidate.status, "conflict");
  assert.match(candidate.conflict, /Address already modeled/);
  assert.equal(candidate.queueable, false);
});

test("equipment names are suggested from common object naming", () => {
  assert.equal(suggestEquipmentName("VAV-101 - Zone Temp"), "VAV-101");
  assert.equal(suggestEquipmentName("AHU_1_SAT"), "AHU");
});

test("dashboard generation is stable and includes building panels", () => {
  const inv = createInventory({ storage: createMemoryInventoryStorage(), now: () => 1 });
  inv.upsertEntity({ id: "site:main", type: "site", name: "Main" });
  inv.upsertEntity({ id: "building:main", type: "building", siteId: "site:main", name: "HQ" });
  inv.upsertEntity({ id: "floor:1", type: "floor", siteId: "site:main", buildingId: "building:main", name: "Level 1" });
  inv.upsertEntity({ id: "equip:vav-1", type: "equip", siteId: "site:main", buildingId: "building:main", floorId: "floor:1", name: "VAV-1" });
  inv.upsertEntity({ id: "point:rat", type: "point", siteId: "site:main", buildingId: "building:main", floorId: "floor:1", equipId: "equip:vav-1", name: "RAT" });
  const dash = generateBuildingDashboard(inv.exportSnapshot(), { siteId: "site:main", buildingId: "building:main", floorId: "floor:1", equipId: "equip:vav-1" });
  assert.equal(dash.uid, "stier-main-main-1-vav-1");
  assert.ok(dash.panels.some((p) => p.title === "Present value trend"));
  assert.ok(dash.panels.some((p) => p.title === "Polling errors"));
});

test("commissioning runner records pass/fail/skip deterministically", async () => {
  let reads = 0;
  const bacnet = {
    readPoint: async () => {
      reads++;
      if (reads === 2) throw new Error("offline");
      return [{ id: 85, name: "present-value", values: [{ kind: "real", value: 72 }] }];
    },
  };
  const points = [
    { id: "point:ok", name: "OK", min: 60, max: 80, sourceRefs: ["bacnet:1:0:1"] },
    { id: "point:bad", name: "Bad", sourceRefs: ["bacnet:1:0:2"] },
    { id: "point:skip", name: "Skip", sourceRefs: [] },
  ];
  const run = await runCommissioning({ points, bacnet, now: () => 1 });
  assert.equal(run.status, "fail");
  assert.deepEqual(run.steps.map((s) => s.status), ["pass", "pass", "fail", "skip"]);
});

test("commissioning reports export markdown and csv", () => {
  const run = {
    name: "Cx",
    status: "fail",
    startedAt: "a",
    finishedAt: "b",
    steps: [{ pointId: "p", pointName: "RAT", check: "range", status: "fail", value: 90, error: "" }],
  };
  const snapshot = { entities: [{ type: "site" }, { type: "building" }, { type: "floor" }, { type: "equip" }, { type: "point" }] };
  assert.match(exportCommissioningMarkdown(snapshot, run), /# Cx/);
  assert.match(exportCommissioningMarkdown(snapshot, run), /Floors: 1/);
  assert.match(exportCommissioningMarkdown(snapshot, run), /RAT/);
  assert.match(exportCommissioningCsv(run), /pointId,pointName,check,status,value,error,at/);
});
