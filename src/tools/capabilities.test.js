import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFactories, maskToPrefix, parseCidr, subnetFromState } from "./capabilities.js";
import { TOOL_MANIFESTS } from "./manifests.js";
import { createKernel } from "../platform/host.js";
import { createTimeseries } from "../platform/services/timeseries.js";
import { createMemoryInventoryStorage } from "./inventory.js";

// A recording mock for Tauri's invoke.
function mockInvoke(returns = {}) {
  const calls = [];
  const fn = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd in returns) return typeof returns[cmd] === "function" ? returns[cmd](args) : returns[cmd];
    return null;
  };
  fn.calls = calls;
  return fn;
}

// ---- pure helpers ----

test("maskToPrefix converts dotted masks", () => {
  assert.equal(maskToPrefix("255.255.255.0"), 24);
  assert.equal(maskToPrefix("255.255.0.0"), 16);
  assert.equal(maskToPrefix("255.255.255.252"), 30);
  assert.equal(maskToPrefix("garbage"), null);
});

test("parseCidr parses and validates", () => {
  assert.deepEqual(parseCidr("192.168.1.0/24"), { ip: "192.168.1.0", prefix: 24 });
  assert.throws(() => parseCidr("192.168.1.0"));
  assert.throws(() => parseCidr("999.1.1.1/24"));
});

test("subnetFromState derives the sweep subnet", () => {
  const s = subnetFromState({ ipAddress: "192.168.1.50", subnetMask: "255.255.255.0" });
  assert.equal(s.ip, "192.168.1.50");
  assert.equal(s.prefix, 24);
  assert.equal(s.network, "192.168.1.0");
  assert.equal(s.hostCount, 254);
  assert.equal(subnetFromState({}), null);
});

// ---- factory wiring through the real kernel ----

async function bootKernel(invoke, factoryOpts) {
  const kernel = createKernel({ manifests: TOOL_MANIFESTS, factories: buildFactories(invoke, factoryOpts) });
  const res = await kernel.boot();
  assert.ok(res.ok, res.errors.join("; "));
  return kernel;
}

test("networkmanager registers network.adapters and netscan", async () => {
  const kernel = await bootKernel(mockInvoke());
  assert.ok(kernel._peek("network.adapters.v1"));
  assert.ok(kernel._peek("netscan.v1"));
});

test("netscan.scan parses CIDR and invokes the backend correctly", async () => {
  const invoke = mockInvoke({ netscan_scan: { total: 254, hosts: [] } });
  const kernel = await bootKernel(invoke);
  const netscan = kernel._peek("netscan.v1").impl;
  const result = await netscan.scan("10.0.0.0/24");
  assert.deepEqual(result, { total: 254, hosts: [] });
  assert.deepEqual(invoke.calls.at(-1), { cmd: "netscan_scan", args: { ip: "10.0.0.0", prefix: 24 } });
});

test("netscan.isReachable maps a ping rtt to a verdict", async () => {
  const up = await (await bootKernel(mockInvoke({ netscan_ping: 4 })))._peek("netscan.v1").impl.isReachable("1.1.1.1");
  assert.deepEqual(up, { reachable: true, rttMs: 4 });
  const down = await (await bootKernel(mockInvoke({ netscan_ping: null })))._peek("netscan.v1").impl.isReachable("1.1.1.1");
  assert.deepEqual(down, { reachable: false, rttMs: null });
});

test("netscan.localSubnetFor reads adapter state and derives the subnet", async () => {
  const invoke = mockInvoke({
    networkmanager_read_state: { ipAddress: "172.16.4.9", subnetMask: "255.255.255.0" },
  });
  const kernel = await bootKernel(invoke);
  const sub = await kernel._peek("netscan.v1").impl.localSubnetFor("Ethernet");
  assert.equal(sub.network, "172.16.4.0");
  assert.equal(sub.prefix, 24);
});

test("bacnet.read provides reads and resolves the netscan dependency", async () => {
  const invoke = mockInvoke({ bacnet_read_properties: [{ property: "present-value", value: 72 }] });
  const kernel = await bootKernel(invoke);
  const bacnet = kernel._peek("bacnet.read.v1").impl;

  // dependency edge resolved: bacnet can suggest targets via netscan
  assert.equal(bacnet.canSuggestTargets(), true);

  const props = await bacnet.readPoint({ deviceInstance: 12345 }, 0, 3);
  assert.deepEqual(props, [{ property: "present-value", value: 72 }]);
  assert.deepEqual(invoke.calls.at(-1), {
    cmd: "bacnet_read_properties",
    args: { device: { deviceInstance: 12345 }, objectType: 0, instance: 3 },
  });
});

test("bacnet.suggestTargets reuses netscan rather than reimplementing discovery", async () => {
  const invoke = mockInvoke({ netscan_scan: { total: 2, hosts: [{ ip: "10.0.0.5" }] } });
  const kernel = await bootKernel(invoke);
  const bacnet = kernel._peek("bacnet.read.v1").impl;
  const hosts = await bacnet.suggestTargets("10.0.0.0/30");
  assert.equal(hosts.hosts[0].ip, "10.0.0.5");
  assert.equal(invoke.calls.at(-1).cmd, "netscan_scan"); // delegated to the netscan capability
});

test("bacnet.read exposes advanced service operations through bacnet-core", async () => {
  const invoke = mockInvoke({
    bacnet_read_objects: [{ objectType: 0, instance: 1 }],
    bacnet_write_property: { ok: true },
    bacnet_read_trend: { records: [], recordCount: 0, truncated: false },
    bacnet_subscribe_cov: 42,
    bacnet_unsubscribe_cov: { ok: true },
  });
  const kernel = await bootKernel(invoke);
  const bacnet = kernel._peek("bacnet.read.v1").impl;
  const device = { address: "192.168.1.10:47808", deviceInstance: 1001 };

  assert.deepEqual(await bacnet.listObjects(device, 1001), [{ objectType: 0, instance: 1 }]);
  assert.deepEqual(invoke.calls.at(-1), { cmd: "bacnet_read_objects", args: { device, deviceInstance: 1001 } });

  await bacnet.writeProperty({ device, objectType: 2, instance: 3, property: 85, value: { kind: "real", value: 72 }, priority: 8 });
  assert.deepEqual(invoke.calls.at(-1), {
    cmd: "bacnet_write_property",
    args: { device, objectType: 2, instance: 3, property: 85, value: { kind: "real", value: 72 }, priority: 8, arrayIndex: null },
  });

  await bacnet.readTrend({ device, objectType: 20, instance: 1, maxRecords: 25 });
  assert.deepEqual(invoke.calls.at(-1), { cmd: "bacnet_read_trend", args: { device, objectType: 20, instance: 1, maxRecords: 25 } });

  assert.equal(await bacnet.subscribeCov({ device, deviceInstance: 1001, objectType: 0, instance: 1 }), 42);
  assert.deepEqual(invoke.calls.at(-1), { cmd: "bacnet_subscribe_cov", args: { device, deviceInstance: 1001, objectType: 0, instance: 1, confirmed: false } });

  await bacnet.unsubscribeCov({ device, objectType: 0, instance: 1, processId: 42 });
  assert.deepEqual(invoke.calls.at(-1), { cmd: "bacnet_unsubscribe_cov", args: { device, objectType: 0, instance: 1, processId: 42 } });
});

test("observability provides the timeseries and scheduler capabilities", async () => {
  const kernel = await bootKernel(mockInvoke());
  assert.ok(kernel._peek("timeseries.v1"));
  assert.ok(kernel._peek("scheduler.v1"));
});

test("bacnet-historian is wired and polls through bacnet.read into timeseries", async () => {
  const ts = createTimeseries({ now: () => 7 });
  const invoke = mockInvoke({
    bacnet_read_properties: [{ id: 85, name: "present-value", values: [{ kind: "real", value: 71.2 }] }],
  });
  const kernel = await bootKernel(invoke, { timeseries: ts });
  const historian = kernel._peek("bacnet.historian.v1").impl;
  historian.addPoint({ device: { deviceInstance: 555 }, objectType: 0, instance: 4, label: "RAT" });
  const summary = await historian.pollOnce();
  assert.equal(summary.written, 1);
  const pt = ts.recent().at(-1);
  assert.equal(pt.measurement, "bacnet_point");
  assert.equal(pt.fields.present_value, 71.2);
  assert.deepEqual(pt.tags, { device: "555", object: "0:4", label: "RAT" });
});

test("building-workspace registers inventory", async () => {
  const kernel = await bootKernel(mockInvoke(), { inventoryStorage: createMemoryInventoryStorage() });
  const inventory = kernel._peek("inventory.v1").impl;
  const site = inventory.upsertEntity({ id: "site:test", type: "site", name: "Test" });
  assert.equal(site.name, "Test");
  assert.equal(inventory.listEntities({ type: "site" }).some((e) => e.id === "site:test"), true);
});

test("historian points can carry building model tags", async () => {
  const ts = createTimeseries({ now: () => 7 });
  const invoke = mockInvoke({
    bacnet_read_properties: [{ id: 85, name: "present-value", values: [{ kind: "real", value: 70 }] }],
  });
  const kernel = await bootKernel(invoke, { timeseries: ts });
  const historian = kernel._peek("bacnet.historian.v1").impl;
  historian.addPoint({
    device: { deviceInstance: 555 },
    objectType: 0,
    instance: 4,
    label: "RAT",
    site: "Main",
    building: "HQ",
    floor: "Level 1",
    equip: "VAV-1",
    pointId: "point:bacnet:555:0:4",
  });
  await historian.pollOnce();
  assert.deepEqual(ts.recent().at(-1).tags, {
    site: "Main",
    building: "HQ",
    floor: "Level 1",
    equip: "VAV-1",
    point: "point:bacnet:555:0:4",
    device: "555",
    object: "0:4",
    label: "RAT",
  });
});

test("a netscan sweep records a telemetry point (instrumentation)", async () => {
  const ts = createTimeseries({ now: () => 42 });
  const invoke = mockInvoke({ netscan_scan: { total: 254, hosts: [{ ip: "10.0.0.5" }, { ip: "10.0.0.9" }] } });
  const kernel = await bootKernel(invoke, { timeseries: ts });
  await kernel._peek("netscan.v1").impl.scan("10.0.0.0/24");
  const recent = ts.recent();
  assert.equal(recent.length, 1);
  assert.equal(recent[0].measurement, "netscan_sweep");
  assert.deepEqual(recent[0].tags, { subnet: "10.0.0.0/24" });
  assert.deepEqual(recent[0].fields, { hosts: 2, total: 254 });
});

test("heicmov registers media.convert", async () => {
  const invoke = mockInvoke({ heicmov_probe: { kind: "image" } });
  const kernel = await bootKernel(invoke);
  const media = kernel._peek("media.convert.v1").impl;
  assert.deepEqual(await media.probe("/x.heic"), { kind: "image" });
  assert.deepEqual(invoke.calls.at(-1), { cmd: "heicmov_probe", args: { path: "/x.heic" } });
});
