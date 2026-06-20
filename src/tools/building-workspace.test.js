import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bacnetUnitSymbol,
  bwClassifyDiscovery,
  bwDeviceInboxCandidates,
  bwImportDevicesToFloor,
  bwImportPlanItems,
  bwModelObjectsBatch,
  bwModelQueuedDevices,
  bwPlanDeviceObjects,
  bwQueueInboxDevices,
  bwRegroupPointsUnderDevices,
  bwRemoveQueuedDevices,
  bwResolveDeviceConflict,
  bwSetQueuedTargetFloor,
  commissioningValueMatches,
  exportCommissioningCsv,
  exportCommissioningMarkdown,
  formatModeledValue,
  generateBuildingDashboard,
  groupObjectProperties,
  historianPointFromEntity,
  humanizePropName,
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

test("bwImportDevicesToFloor imports selected devices without a queue step", () => {
  const inv = createInventory({ storage: createMemoryInventoryStorage(), now: () => 1 });
  const site = inv.upsertEntity({ id: "site:main", type: "site", name: "Main" });
  const building = inv.upsertEntity({ id: "building:main", type: "building", siteId: site.id, parentId: site.id, name: "HQ" });
  const floor = inv.upsertEntity({ id: "floor:1", type: "floor", siteId: site.id, buildingId: building.id, parentId: building.id, name: "Level 1" });
  const devices = [{ key: "d1", instance: 1001, address: "192.168.1.10", name: "VAV-101" }];
  const result = bwImportDevicesToFloor({
    inventory: inv,
    devices,
    keys: ["d1"],
    candidates: {},
    site,
    building,
    floor,
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
  assert.equal(result.skipped, 0);
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

test("device inbox surfaces ignored devices as a non-selectable status", () => {
  const devices = [{ key: "d1", instance: 1001, address: "192.168.1.10", name: "Ignored" }];
  const candidates = { d1: { key: "d1", status: "ignored" } };
  const [item] = bwDeviceInboxCandidates({ devices, modeledDevices: [], candidates });
  assert.equal(item.status, "ignored");
  assert.equal(item.selectable, false);
  assert.equal(item.queueable, false);
});

test("bwRemoveQueuedDevices drops only queued entries and leaves others intact", () => {
  const candidates = {
    d1: { key: "d1", status: "queued" },
    d2: { key: "d2", status: "ignored" },
    d3: { key: "d3", status: "queued" },
  };
  const next = bwRemoveQueuedDevices(candidates, ["d1", "d2", "missing"]);
  assert.equal(next.d1, undefined);          // queued -> removed
  assert.deepEqual(next.d2, { key: "d2", status: "ignored" }); // non-queued -> kept
  assert.deepEqual(next.d3, { key: "d3", status: "queued" });  // not in keys -> kept
  // Pure: the input object is not mutated.
  assert.ok(candidates.d1);
});

test("commissioning commands then relinquishes a writable analog output", async () => {
  const bacnet = {
    readPoint: async () => [{ id: 85, name: "present-value", values: [{ kind: "real", value: 70 }] }],
  };
  const writes = [];
  const writeProperty = async (w) => { writes.push(w); };
  const points = [{ id: "p1", name: "AO-1", tags: { writable: true }, sourceRefs: ["bacnet:1:1:5"] }];
  const run = await runCommissioning({
    points, bacnet, writeProperty,
    options: { commandValue: 55, priority: 8 }, now: () => 1,
  });
  // The command write lands first, then a Null relinquish releases the slot.
  assert.equal(writes.length, 2);
  assert.deepEqual({ value: writes[0].value, priority: writes[0].priority, relinquish: writes[0].relinquish || false },
    { value: 55, priority: 8, relinquish: false });
  assert.equal(writes[1].relinquish, true);
  assert.equal(writes[1].value, null);
  assert.equal(writes[1].priority, 8);
  assert.deepEqual(run.steps.map((s) => s.check), ["read-present-value", "command", "relinquish"]);
  assert.equal(run.status, "pass");
});

test("commissioning toggle-verify drives a binary output both ways then releases", async () => {
  const bacnet = {
    readPoint: async () => [{ id: 85, name: "present-value", values: [{ kind: "binary", value: 1 }] }],
  };
  const writes = [];
  const writeProperty = async (w) => { writes.push(w); };
  // Binary output (objectType 4) so the toggle-verify branch engages.
  const points = [{ id: "p1", name: "BO-1", tags: { writable: true }, sourceRefs: ["bacnet:1:4:2"] }];
  const run = await runCommissioning({
    points, bacnet, writeProperty,
    options: { toggleVerify: true, priority: 8 }, now: () => 1,
  });
  // Drives active (1) then inactive (0), then a single relinquish.
  assert.deepEqual(writes.map((w) => (w.relinquish ? "rel" : w.value)), [1, 0, "rel"]);
  const commandSteps = run.steps.filter((s) => s.check === "command");
  assert.equal(commandSteps.length, 2);
  assert.equal(run.steps.filter((s) => s.check === "relinquish").length, 1);
});

test("pointEntityFromBacnet captures bacnetName plus optional config (precision/unit/min/max/historize)", () => {
  const base = { siteId: "s", buildingId: "b", floorId: "f", equipId: "e", device: { instance: 555 } };
  const obj = { objectType: 0, instance: 4, typeName: "analog-input", name: "AI-4" };

  // No config: name = BACnet name, bacnetName preserved, no optional fields.
  const plain = pointEntityFromBacnet({ ...base, object: obj });
  assert.equal(plain.name, "AI-4");
  assert.equal(plain.bacnetName, "AI-4");
  assert.equal("precision" in plain, false); // compacted away when unset
  assert.equal("historize" in plain, false);

  // With config: friendly name, precision clamped, unit override, min/max, trend.
  const configured = pointEntityFromBacnet({
    ...base,
    object: { ...obj, bacnetName: "AI-4" },
    config: { displayName: "Discharge Air Temp", precision: 1, unit: "°F", min: 40, max: 90, historize: true },
  });
  assert.equal(configured.name, "Discharge Air Temp");
  assert.equal(configured.bacnetName, "AI-4");
  assert.equal(configured.precision, 1);
  assert.equal(configured.unit, "°F");
  assert.equal(configured.min, 40);
  assert.equal(configured.max, 90);
  assert.equal(configured.historize, true);

  // Precision is clamped to 0..10 and ignored when non-integer.
  assert.equal(pointEntityFromBacnet({ ...base, object: obj, config: { precision: 99 } }).precision, 10);
  assert.equal("precision" in pointEntityFromBacnet({ ...base, object: obj, config: { precision: "x" } }), false);
});

test("bwModelObjectsBatch carries per-item display name, config, and units", () => {
  const device = { instance: 555 };
  const plan = bwPlanDeviceObjects({
    device,
    objects: [{ objectType: 0, instance: 4, typeName: "analog-input", name: "AHU-1 DAT" }],
  });
  // Attach per-row config + props (as the review modal does).
  plan.items[0].config = { displayName: "Discharge Air Temp", precision: 2, historize: true };
  plan.items[0].props = [{ id: 117, name: "units", display: "degrees-fahrenheit" }];
  const points = bwModelObjectsBatch({
    siteId: "s", buildingId: "b", floorId: "f", device, items: plan.items, equipIdByName: { [plan.items[0].equipName]: "equip:1" },
  });
  assert.equal(points.length, 1);
  assert.equal(points[0].name, "Discharge Air Temp");
  assert.equal(points[0].bacnetName, "AHU-1 DAT");
  assert.equal(points[0].precision, 2);
  assert.equal(points[0].historize, true);
  assert.equal(points[0].unit, "degrees-fahrenheit"); // units no longer dropped on bulk
  assert.equal(points[0].equipId, "equip:1");
});

test("formatModeledValue rounds numeric displays to precision and passes through the rest", () => {
  assert.equal(formatModeledValue({ precision: 1 }, "23.94"), "23.9");
  assert.equal(formatModeledValue({ precision: 0 }, 23.6), "24");
  assert.equal(formatModeledValue({ precision: 2 }, "7"), "7.00");
  assert.equal(formatModeledValue({}, "23.94"), "23.94"); // no precision -> unchanged
  assert.equal(formatModeledValue({ precision: 1 }, "active"), "active"); // non-numeric passes through
  assert.equal(formatModeledValue({ precision: 1 }, "—"), "—");
  assert.equal(formatModeledValue({ precision: 1 }, null), null);
});

test("bacnetUnitSymbol strips the raw enum suffix and passes through the rest", () => {
  assert.equal(bacnetUnitSymbol("°F (66)"), "°F");
  assert.equal(bacnetUnitSymbol("ppm (96)"), "ppm");
  assert.equal(bacnetUnitSymbol("%"), "%");
  assert.equal(bacnetUnitSymbol(""), "");
  assert.equal(bacnetUnitSymbol("96"), "96"); // no parens -> unchanged
  assert.equal(bacnetUnitSymbol(null), null);
});

test("bwRegroupPointsUnderDevices drops the device object (object-type 8) point", () => {
  let n = 0;
  const inv = createInventory({ storage: createMemoryInventoryStorage(), now: () => 1, idFactory: (type) => `${type}:${type}-${++n}` });
  inv.upsertEntity({ type: "equip", floorId: "floor:1", siteId: "s", buildingId: "b", name: "N-TB-0102", deviceInstance: 555, tags: { equip: true, device: true } });
  const devObjPoint = inv.upsertEntity(pointEntityFromBacnet({
    siteId: "s", buildingId: "b", floorId: "floor:1", equipId: "",
    device: { instance: 555 }, object: { objectType: 8, instance: 555, typeName: "device", name: "N-TB-0102" },
  }));
  const realPoint = inv.upsertEntity(pointEntityFromBacnet({
    siteId: "s", buildingId: "b", floorId: "floor:1", equipId: "",
    device: { instance: 555 }, object: { objectType: 0, instance: 4, typeName: "analog-input", name: "RAT" },
  }));
  const res = bwRegroupPointsUnderDevices(inv);
  assert.equal(res.removedDeviceObjects, 1);
  assert.ok(!inv.getEntity(devObjPoint.id));           // device-object point removed
  assert.ok(inv.getEntity(realPoint.id));              // real point kept (and re-parented)
});

test("bwRegroupPointsUnderDevices re-parents points onto their device and removes empty shells", () => {
  let n = 0;
  const inv = createInventory({ storage: createMemoryInventoryStorage(), now: () => 1, idFactory: (type) => `${type}:${type}-${++n}` });
  // Modeled device equipment (from the device inbox) on a floor.
  const dev = inv.upsertEntity({ type: "equip", floorId: "floor:1", siteId: "s", buildingId: "b", name: "N-TB-0102", deviceInstance: 555, tags: { equip: true, device: true } });
  // A name-inferred grouping shell (from an older object import) on the floor.
  const shell = inv.upsertEntity({ type: "equip", floorId: "floor:1", siteId: "s", buildingId: "b", name: "CO2", tags: { equip: true } });
  // A point from device 555 wrongly parented to the shell.
  const pt = inv.upsertEntity(pointEntityFromBacnet({
    siteId: "s", buildingId: "b", floorId: "floor:1", equipId: shell.id,
    device: { instance: 555 }, object: { objectType: 0, instance: 4, typeName: "analog-input", name: "CO2" },
  }));
  // A user-created empty equip that must NOT be touched.
  const userEquip = inv.upsertEntity({ type: "equip", floorId: "floor:1", siteId: "s", buildingId: "b", name: "Spare VAV", tags: { equip: true } });

  const res = bwRegroupPointsUnderDevices(inv);
  assert.equal(res.reparented, 1);
  assert.equal(res.removed, 1);
  assert.equal(inv.getEntity(pt.id).equipId, dev.id);      // point now under the device
  assert.ok(!inv.getEntity(shell.id));                      // emptied shell removed
  assert.ok(inv.getEntity(userEquip.id));                   // untouched empty user equip survives
  assert.ok(inv.getEntity(dev.id));                         // device equip survives

  // Idempotent: a second pass changes nothing.
  assert.deepEqual(bwRegroupPointsUnderDevices(inv), { reparented: 0, removed: 0, removedDeviceObjects: 0 });
});

test("bwRegroupPointsUnderDevices creates a device equip when none is modeled", () => {
  let n = 0;
  const inv = createInventory({ storage: createMemoryInventoryStorage(), now: () => 1, idFactory: (type) => `${type}:${type}-${++n}` });
  const shell = inv.upsertEntity({ type: "equip", floorId: "floor:1", siteId: "s", buildingId: "b", name: "CO2", tags: { equip: true } });
  const pt = inv.upsertEntity(pointEntityFromBacnet({
    siteId: "s", buildingId: "b", floorId: "floor:1", equipId: shell.id,
    device: { instance: 777, address: "192.168.1.5" }, object: { objectType: 0, instance: 1, typeName: "analog-input", name: "X" },
  }));
  const res = bwRegroupPointsUnderDevices(inv);
  assert.equal(res.reparented, 1);
  const repointed = inv.getEntity(pt.id);
  const devEquip = inv.getEntity(repointed.equipId);
  assert.equal(devEquip.type, "equip");
  assert.equal(devEquip.deviceInstance, 777);
  assert.equal(devEquip.tags.device, true);
});

test("re-import preserves a user's custom display name when the review prefills it", () => {
  const inv = createInventory({ storage: createMemoryInventoryStorage(), now: () => 1, idFactory: (type) => `${type}:uuid-1` });
  const device = { instance: 555 };
  const object = { objectType: 0, instance: 4, typeName: "analog-input", name: "AI-4" };
  // First import with a friendly name.
  const first = inv.upsertEntity(pointEntityFromBacnet({
    siteId: "s", buildingId: "b", floorId: "f", equipId: "e", device, object,
    config: { displayName: "Discharge Air Temp", precision: 1 },
  }));
  assert.equal(first.name, "Discharge Air Temp");
  // Re-import: the modal prefills displayName from the existing entity, so the
  // custom name is retained (same id via sourceRef dedup) rather than reverting.
  const existing = inv.listEntities({ type: "point", sourceRef: "bacnet:555:0:4" })[0];
  const again = inv.upsertEntity(pointEntityFromBacnet({
    siteId: "s", buildingId: "b", floorId: "f", equipId: "e", device, object,
    config: { displayName: existing.name, precision: existing.precision },
  }));
  assert.equal(again.id, first.id);
  assert.equal(again.name, "Discharge Air Temp");
  assert.equal(again.precision, 1);
});

test("humanizePropName title-cases kebab names and unknown ids", () => {
  assert.equal(humanizePropName("present-value"), "Present Value");
  assert.equal(humanizePropName("property-9999"), "Property 9999");
  assert.equal(humanizePropName(""), "Property");
});

test("groupObjectProperties buckets BACnet properties into labeled sections", () => {
  const props = [
    { id: 77, name: "object-name", display: "VAV-1 RAT", values: [], error: null },
    { id: 85, name: "present-value", display: "72.4", values: [], error: null },
    { id: 111, name: "status-flags", display: "normal", values: [], error: null },
    { id: 44, name: "firmware-revision", display: "1.2.3", values: [], error: null },
    { id: 9999, name: "property-9999", display: "custom", values: [], error: null },
    { id: 8, name: "all", display: "", values: [], error: null },
  ];
  const groups = groupObjectProperties(props);
  assert.deepEqual(groups.map((g) => g.key), ["identity", "value", "status", "device", "other"]);
  assert.equal(groups.find((g) => g.key === "identity")?.rows.some((r) => r.id === 77), true);
  assert.equal(groups.find((g) => g.key === "value")?.rows.some((r) => r.id === 85), true);
  assert.equal(groups.find((g) => g.key === "status")?.rows.some((r) => r.id === 111), true);
  assert.equal(groups.find((g) => g.key === "device")?.rows.some((r) => r.id === 44), true);
  assert.equal(groups.find((g) => g.key === "other")?.rows.some((r) => r.id === 9999), true);
  assert.equal(groups.some((g) => g.rows.some((r) => r.id === 8)), false);
});
