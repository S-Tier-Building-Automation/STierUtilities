import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bwClassifyDiscovery,
  bwDeviceInboxCandidates,
  bwImportPlanItems,
  bwModelObjectsBatch,
  bwModelQueuedDevices,
  bwPlanDeviceObjects,
  bwQueueInboxDevices,
  bwResolveDeviceConflict,
  bwSetQueuedTargetFloor,
  commissioningValueMatches,
  exportCommissioningCsv,
  exportCommissioningMarkdown,
  generateBuildingDashboard,
  historianPointFromEntity,
  interpretStatusFlags,
  parsePriorityArray,
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

test("bwSetQueuedTargetFloor assigns floor to queued candidates", () => {
  const candidates = {
    d1: { key: "d1", status: "queued" },
    d2: { key: "d2", status: "queued" },
    d3: { key: "d3", status: "new" },
  };
  const next = bwSetQueuedTargetFloor(candidates, ["d1"], "floor:2");
  assert.equal(next.d1.targetFloorId, "floor:2");
  assert.equal(next.d2.targetFloorId, undefined);
});

test("device inbox modeling respects per-row target floors", () => {
  const inv = createInventory({ storage: createMemoryInventoryStorage(), now: () => 2 });
  const site = inv.upsertEntity({ id: "site:main", type: "site", name: "Main" });
  const building = inv.upsertEntity({ id: "building:main", type: "building", siteId: site.id, parentId: site.id, name: "HQ" });
  const floorA = inv.upsertEntity({ id: "floor:a", type: "floor", siteId: site.id, buildingId: building.id, parentId: building.id, name: "Level A" });
  const floorB = inv.upsertEntity({ id: "floor:b", type: "floor", siteId: site.id, buildingId: building.id, parentId: building.id, name: "Level B" });
  const devices = [
    { key: "d1", instance: 1001, address: "192.168.1.10", name: "VAV-A" },
    { key: "d2", instance: 1002, address: "192.168.1.11", name: "VAV-B" },
  ];
  const candidates = {
    d1: { key: "d1", status: "queued", targetFloorId: floorA.id },
    d2: { key: "d2", status: "queued", targetFloorId: floorB.id },
  };
  const result = bwModelQueuedDevices({
    inventory: inv,
    devices,
    candidates,
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
  assert.equal(result.imported.length, 2);
  assert.equal(result.imported[0].floorId, floorA.id);
  assert.equal(result.imported[1].floorId, floorB.id);
});

test("changed modeled devices remain selectable for binding updates", () => {
  const devices = [{ key: "d1", instance: 100, address: "10.0.0.9", vendorId: 2, modelName: "NewModel" }];
  const modeledDevices = [{
    id: "equip:1", type: "equip", tags: { device: true }, deviceInstance: 100,
    address: "10.0.0.5", vendorId: 1, modelName: "OldModel",
  }];
  const [candidate] = bwDeviceInboxCandidates({ devices, modeledDevices, candidates: {} });
  assert.equal(candidate.status, "changed");
  assert.equal(candidate.selectable, true);
  assert.equal(candidate.queueable, false);
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

test("bwPlanDeviceObjects groups objects by inferred equipment and applies a name template", () => {
  const device = { instance: 100, name: "Controller 100" };
  const objects = [
    { objectType: 0, instance: 1, typeName: "AI", name: "VAV-101 Zone Temp" },
    { objectType: 0, instance: 2, typeName: "AI", name: "VAV-101 Zone Setpoint" },
    { objectType: 0, instance: 3, typeName: "AI", name: "AHU_1_SAT" },
  ];
  const { items, equips } = bwPlanDeviceObjects({ device, objects, template: "{equip}-{type}{instance}" });
  assert.deepEqual(equips, ["VAV-101", "AHU"]);
  assert.equal(items[0].equipName, "VAV-101");
  assert.equal(items[0].pointName, "VAV-101-AI1");
  assert.equal(items[1].equipName, "VAV-101");
  assert.equal(items[2].equipName, "AHU");
});

test("bwPlanDeviceObjects keeps the object's own name when no template is given", () => {
  const { items } = bwPlanDeviceObjects({ device: { instance: 5 }, objects: [{ objectType: 0, instance: 9, name: "Outside Air Temp" }] });
  assert.equal(items[0].pointName, "Outside Air Temp");
});

test("bwModelObjectsBatch builds point entities with resolved equip ids and templated names", () => {
  const device = { instance: 100, address: "10.0.0.5" };
  const items = [
    { object: { objectType: 0, instance: 1, typeName: "AI", name: "Zone Temp" }, equipName: "VAV-101", pointName: "VAV-101-AI1" },
  ];
  const points = bwModelObjectsBatch({
    siteId: "site:1", buildingId: "b:1", floorId: "f:1", device, items,
    equipIdByName: { "VAV-101": "equip:vav-101" },
  });
  assert.equal(points.length, 1);
  assert.equal(points[0].equipId, "equip:vav-101");
  assert.equal(points[0].name, "VAV-101-AI1");
  assert.equal(points[0].sourceRefs[0], "bacnet:100:0:1");
});

test("bwResolveDeviceConflict replace re-points the equip and its points to the new instance", () => {
  const modeledDevice = {
    id: "equip:old", type: "equip", name: "RTU-1", deviceInstance: 100, address: "10.0.0.5",
    deviceRef: { address: "10.0.0.5", deviceInstance: 100 }, tags: { equip: true, device: true },
  };
  const points = [
    { id: "point:1", type: "point", deviceInstance: 100, sourceRefs: ["bacnet:100:0:1"], deviceRef: { address: "10.0.0.5", deviceInstance: 100 } },
    { id: "point:other", type: "point", deviceInstance: 200, sourceRefs: ["bacnet:200:0:1"] },
  ];
  const device = { instance: 250, address: "10.0.0.9" };
  const { action, updated } = bwResolveDeviceConflict({ action: "replace", modeledDevice, device, points });
  assert.equal(action, "replace");
  assert.equal(updated.length, 2); // the equip plus only the matching point
  assert.equal(updated[0].deviceInstance, 250);
  assert.equal(updated[0].address, "10.0.0.9");
  assert.equal(updated[1].id, "point:1");
  assert.equal(updated[1].sourceRefs[0], "bacnet:250:0:1");
  assert.equal(updated[1].deviceInstance, 250);
});

test("bwResolveDeviceConflict with a non-replace action makes no changes", () => {
  const r = bwResolveDeviceConflict({ action: "both", modeledDevice: { deviceInstance: 1 }, device: { instance: 2 }, points: [] });
  assert.deepEqual(r, { action: "both", updated: [] });
});

test("bwClassifyDiscovery flags new, returning, changed, and missing devices", () => {
  const prev = [
    { instance: 1, address: "10.0.0.1", modelName: "A" },
    { instance: 2, address: "10.0.0.2" },
    { instance: 3, address: "10.0.0.3" },
  ];
  const current = [
    { instance: 1, address: "10.0.0.1", modelName: "A" },
    { instance: 2, address: "10.0.0.99" },
    { instance: 4, address: "10.0.0.4" },
  ];
  const { devices, missing, summary } = bwClassifyDiscovery(prev, current);
  const byInst = Object.fromEntries(devices.map((d) => [d.device.instance, d]));
  assert.equal(byInst[1].status, "returning");
  assert.equal(byInst[2].status, "changed");
  assert.deepEqual(byInst[2].changes, ["address"]);
  assert.equal(byInst[4].status, "new");
  assert.equal(missing.length, 1);
  assert.equal(missing[0].instance, 3);
  assert.deepEqual(summary, { new: 1, returning: 1, changed: 1, missing: 1 });
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

  // The telemetry panels must be scoped to the in-scope point ids (via the
  // `point` tag the historian writes), not fetch global bacnet_point data.
  const trendQ = dash.panels.find((p) => p.title === "Present value trend").targets[0].query;
  assert.match(trendQ, /contains\(value: r\.point, set: \["point:rat"\]\)/);
  assert.match(trendQ, /exists r\.point/);
  const latestQ = dash.panels.find((p) => p.title === "Latest values").targets[0].query;
  assert.match(latestQ, /contains\(value: r\.point, set: \["point:rat"\]\)/);

  // A scope with no modeled points must NOT fall back to global telemetry.
  const empty = generateBuildingDashboard(inv.exportSnapshot(), { equipId: "equip:does-not-exist" });
  const emptyQ = empty.panels.find((p) => p.title === "Present value trend").targets[0].query;
  assert.doesNotMatch(emptyQ, /"point:rat"/);
  assert.match(emptyQ, /__no_modeled_points__/);
});

test("parsePriorityArray maps 16 slots and finds the commanding level", () => {
  const values = Array.from({ length: 16 }, () => ({ kind: "null" }));
  values[7] = { kind: "real", value: 72 };   // priority 8
  values[15] = { kind: "real", value: 68 };  // priority 16 (relinquish default-ish)
  const { slots, activeLevel, activeValue } = parsePriorityArray(values);
  assert.equal(slots.length, 16);
  assert.equal(slots[7].active, true);
  assert.equal(slots[7].value, 72);
  assert.equal(slots[0].active, false);
  assert.equal(activeLevel, 8); // lowest-numbered (highest-priority) non-null slot
  assert.equal(activeValue, 72);
});

test("interpretStatusFlags names the raised bits", () => {
  const f = interpretStatusFlags({ kind: "bitstring", bits: "1010" });
  assert.equal(f.inAlarm, true);
  assert.equal(f.fault, false);
  assert.equal(f.overridden, true);
  assert.equal(f.outOfService, false);
  assert.deepEqual(f.raised, ["in-alarm", "overridden"]);
  // also accepts a property entry and a raw string
  assert.equal(interpretStatusFlags("0100").fault, true);
  assert.equal(interpretStatusFlags({ values: [{ bits: "0001" }] }).outOfService, true);
});

test("commissioningValueMatches uses tolerance for numbers and exact for non-numeric", () => {
  assert.equal(commissioningValueMatches(72.2, 72, 0.5), true);
  assert.equal(commissioningValueMatches(75, 72, 0.5), false);
  assert.equal(commissioningValueMatches(null, 72), false);
  assert.equal(commissioningValueMatches(1, 1), true);
});

test("commissioning verify reads back and flags a stuck output", async () => {
  // Writable point; readback returns the commanded value -> verify pass.
  const okBacnet = {
    readPoint: async () => [{ id: 85, name: "present-value", values: [{ kind: "real", value: 70 }] }],
  };
  const writes = [];
  const writeProperty = async (w) => { writes.push(w); };
  const points = [{ id: "p1", name: "AO-1", tags: { writable: true }, sourceRefs: ["bacnet:1:1:5"] }];
  let run = await runCommissioning({
    points, bacnet: okBacnet, writeProperty,
    options: { commandValue: 70, verify: true, priority: 8 }, now: () => 1,
  });
  assert.deepEqual(run.steps.map((s) => s.status), ["pass", "pass", "pass", "pass"]); // read, command, verify, relinquish

  // Readback never moves -> verify fail (stuck), and the run is marked failed.
  const stuckBacnet = {
    readPoint: async () => [{ id: 85, name: "present-value", values: [{ kind: "real", value: 0 }] }],
  };
  run = await runCommissioning({
    points, bacnet: stuckBacnet, writeProperty,
    options: { commandValue: 70, verify: true }, now: () => 1,
  });
  const verifyStep = run.steps.find((s) => s.check === "verify");
  assert.equal(verifyStep.status, "fail");
  assert.match(verifyStep.error, /stuck|override/i);
  assert.equal(run.status, "fail");
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
