// End-to-end platform integration: boot the REAL tool manifests + capability
// factories with a mock Tauri invoke and the degraded (no-backend) services, and
// verify the whole graph wires up and inter-tool flows work without a live
// backend — the "degrades gracefully" guarantee.

import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOL_MANIFESTS } from "./tools/manifests.js";
import { buildFactories } from "./tools/capabilities.js";
import { createKernel } from "./platform/host.js";
import { createTimeseries } from "./platform/services/timeseries.js";
import { createScheduler } from "./platform/services/scheduler.js";
import { createMemoryInventoryStorage } from "./tools/inventory.js";
import { generateBuildingDashboard, historianPointFromEntity, pointEntityFromBacnet, exportCommissioningCsv, exportCommissioningMarkdown } from "./tools/building-workspace.js";

function mockInvoke(returns = {}) {
  return async (cmd, args) => (cmd in returns ? returns[cmd](args) : null);
}

async function bootRealPlatform(invoke, telemetry, scheduler) {
  const kernel = createKernel({
    manifests: TOOL_MANIFESTS,
    factories: buildFactories(invoke, { timeseries: telemetry, scheduler, inventoryStorage: createMemoryInventoryStorage() }),
  });
  const res = await kernel.boot();
  assert.ok(res.ok, res.errors.join("; "));
  return kernel;
}

test("the whole tool catalog boots with a clean capability graph", async () => {
  const kernel = await bootRealPlatform(mockInvoke(), createTimeseries(), createScheduler());
  for (const id of ["observability", "clipboardtyper", "heicmov", "networkmanager", "bacnet-core", "bacnet", "bacnet-historian", "building-workspace"]) {
    assert.ok(kernel.isBooted(id), `${id} should be booted`);
  }
  for (const cap of [
    "timeseries.v1", "scheduler.v1", "network.adapters.v1", "netscan.v1",
    "media.convert.v1", "bacnet.read.v1", "bacnet.historian.v1", "inventory.v1",
  ]) {
    assert.ok(kernel.capability(cap), `${cap} should resolve`);
  }
});

test("building workflow imports, historizes, charts, and exports reports", async () => {
  const telemetry = createTimeseries({ now: () => 1 });
  const invoke = mockInvoke({
    bacnet_read_properties: () => [{ id: 85, name: "present-value", values: [{ kind: "real", value: 73.1 }] }],
  });
  const kernel = await bootRealPlatform(invoke, telemetry, createScheduler());
  const inventory = kernel.capability("inventory.v1");
  const historian = kernel.capability("bacnet.historian.v1");

  const site = inventory.upsertEntity({ id: "site:main", type: "site", name: "Main" });
  const building = inventory.upsertEntity({ id: "building:hq", type: "building", siteId: site.id, parentId: site.id, name: "HQ" });
  const floor = inventory.upsertEntity({ id: "floor:1", type: "floor", siteId: site.id, buildingId: building.id, parentId: building.id, name: "Level 1" });
  const equip = inventory.applyTemplate(inventory.upsertEntity({
    id: "equip:vav-1",
    type: "equip",
    siteId: site.id,
    buildingId: building.id,
    floorId: floor.id,
    parentId: floor.id,
    name: "VAV-1",
  }).id, "vav");
  const point = inventory.upsertEntity(pointEntityFromBacnet({
    siteId: site.id,
    buildingId: building.id,
    floorId: floor.id,
    equipId: equip.id,
    device: { instance: 12 },
    object: { objectType: 0, instance: 0, typeName: "analog-input", name: "RAT" },
  }));
  historian.addPoint(historianPointFromEntity(point, { site, building, floor, equip }));
  await historian.pollOnce();

  assert.equal(telemetry.recent().at(-1).tags.site, "Main");
  assert.equal(telemetry.recent().at(-1).tags.floor, "Level 1");
  const dashboard = generateBuildingDashboard(inventory.exportSnapshot(), { siteId: site.id, buildingId: building.id, floorId: floor.id, equipId: equip.id });
  assert.equal(dashboard.uid, "stier-main-hq-1-vav-1");

  const run = inventory.recordCommissioningRun({
    status: "fail",
    steps: [{ pointId: point.id, pointName: point.name, check: "range", status: "fail", value: 99 }],
  });
  assert.match(exportCommissioningMarkdown(inventory.exportSnapshot(), run), /RAT/);
  assert.match(exportCommissioningCsv(run), /range/);
});

test("a netscan sweep flows into the degraded telemetry without a backend", async () => {
  const telemetry = createTimeseries({ now: () => 1 });
  const invoke = mockInvoke({ netscan_scan: () => ({ total: 10, hosts: [{ ip: "10.0.0.2" }] }) });
  const kernel = await bootRealPlatform(invoke, telemetry, createScheduler());

  await kernel.capability("netscan.v1").scan("10.0.0.0/24"); // must not throw despite no backend
  const point = telemetry.recent().at(-1);
  assert.equal(point.measurement, "netscan_sweep");
  assert.equal(telemetry.stats().backend, false); // degraded — ring only
});

test("the historian composes bacnet.read + scheduler + timeseries end-to-end", async () => {
  const telemetry = createTimeseries({ now: () => 1 });
  const invoke = mockInvoke({
    bacnet_read_properties: () => [{ id: 85, name: "present-value", values: [{ kind: "real", value: 73.1 }] }],
  });
  const kernel = await bootRealPlatform(invoke, telemetry, createScheduler());

  const historian = kernel.capability("bacnet.historian.v1");
  historian.addPoint({ device: { deviceInstance: 12 }, objectType: 0, instance: 0, label: "RAT" });
  const summary = await historian.pollOnce();

  assert.equal(summary.written, 1);
  const point = telemetry.recent().at(-1);
  assert.equal(point.measurement, "bacnet_point");
  assert.equal(point.fields.present_value, 73.1);
});

test("bacnet can reach netscan (inter-tool dependency) through the booted kernel", async () => {
  const invoke = mockInvoke({ netscan_scan: () => ({ total: 2, hosts: [{ ip: "10.0.0.9" }] }) });
  const kernel = await bootRealPlatform(invoke, createTimeseries(), createScheduler());
  const bacnet = kernel.capability("bacnet.read.v1");
  assert.equal(bacnet.canSuggestTargets(), true);
  const r = await bacnet.suggestTargets("10.0.0.0/30");
  assert.equal(r.hosts[0].ip, "10.0.0.9");
});
