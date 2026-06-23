import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createDeviceHealthService, computeHealth, extractSystemStatus, deviceIp, OBJECT_DEVICE,
} from "./device-health.js";
import { createInventory, createMemoryInventoryStorage } from "./inventory.js";
import { createAlertsService } from "./alerts-service.js";
import { createScheduler } from "../platform/services/scheduler.js";
import { createTimeseries } from "../platform/services/timeseries.js";

function fakeTimer() {
  const reg = [];
  return { reg, every: (fn, ms) => (reg.push({ fn, ms }), reg.length - 1), cancel: (t) => (reg[t] = null) };
}

// system-status (prop 112) read result; 0 == operational.
const SYS = (value) => [{ id: 112, name: "system-status", values: [{ kind: "enumerated", value }], error: null }];

function inventoryWith(devices) {
  const inv = createInventory({ storage: createMemoryInventoryStorage(), now: () => 1 });
  for (const d of devices) inv.upsertEntity({ type: "equip", tags: { device: true, equip: true }, ...d });
  return inv;
}

// ---- pure helpers ----

test("deviceIp strips the BACnet port suffix and reads nested refs", () => {
  assert.equal(deviceIp({ address: "192.168.1.10:47808" }), "192.168.1.10");
  assert.equal(deviceIp({ deviceRef: { address: "10.0.0.5" } }), "10.0.0.5");
  assert.equal(deviceIp({}), null);
});

test("extractSystemStatus reads enumerated prop 112 by name or id", () => {
  assert.equal(extractSystemStatus(SYS(0)), 0);
  assert.equal(extractSystemStatus(SYS(4)), 4);
  assert.equal(extractSystemStatus([{ name: "system-status", error: "timeout", values: [] }]), null);
  assert.equal(extractSystemStatus("nope"), null);
});

// ---- computeHealth state machine ----

test("computeHealth: unknown -> online on a reachable, responsive probe", () => {
  const h = computeHealth(null, { reachable: true, rttMs: 3, bacnetResponsive: true, systemStatus: 0, at: 100 });
  assert.equal(h.status, "online");
  assert.equal(h.lastSeenAt, 100);
  assert.equal(h.lastRttMs, 3);
  assert.equal(h.consecutiveMisses, 0);
  assert.equal(h.since, 100);
});

test("computeHealth: reachable but BACnet-unresponsive is degraded", () => {
  const h = computeHealth({ status: "online", since: 1 }, { reachable: true, rttMs: 2, bacnetResponsive: false, systemStatus: null, at: 200 });
  assert.equal(h.status, "degraded");
  assert.equal(h.lastSeenAt, 200); // still reachable -> seen
  assert.equal(h.since, 200); // transitioned
});

test("computeHealth: reachable but non-operational system-status is degraded", () => {
  const h = computeHealth(null, { reachable: true, rttMs: 1, bacnetResponsive: true, systemStatus: 4, at: 5 });
  assert.equal(h.status, "degraded");
  assert.equal(h.systemStatus, 4);
});

test("computeHealth: offline is debounced until the miss threshold", () => {
  const opts = { offlineThreshold: 2 };
  const online = computeHealth(null, { reachable: true, rttMs: 1, bacnetResponsive: true, systemStatus: 0, at: 1 }, opts);
  assert.equal(online.status, "online");
  // first miss holds the prior status (no flap)
  const miss1 = computeHealth(online, { reachable: false, rttMs: null, bacnetResponsive: null, systemStatus: null, at: 2 }, opts);
  assert.equal(miss1.status, "online");
  assert.equal(miss1.consecutiveMisses, 1);
  assert.equal(miss1.lastSeenAt, 1); // unchanged while unreachable
  // second consecutive miss crosses the threshold
  const miss2 = computeHealth(miss1, { reachable: false, rttMs: null, bacnetResponsive: null, systemStatus: null, at: 3 }, opts);
  assert.equal(miss2.status, "offline");
  assert.equal(miss2.consecutiveMisses, 2);
  assert.equal(miss2.since, 3);
});

test("computeHealth: recovery resets misses and last-seen", () => {
  const offline = { status: "offline", since: 3, consecutiveMisses: 2, lastSeenAt: 1, lastRttMs: null };
  const back = computeHealth(offline, { reachable: true, rttMs: 7, bacnetResponsive: true, systemStatus: 0, at: 9 }, { offlineThreshold: 2 });
  assert.equal(back.status, "online");
  assert.equal(back.consecutiveMisses, 0);
  assert.equal(back.lastSeenAt, 9);
  assert.equal(back.since, 9);
});

test("computeHealth returns unknown (no miss) when no probe ran", () => {
  const h = computeHealth({ status: "online", since: 1, lastSeenAt: 1, consecutiveMisses: 0 },
    { reachable: false, probed: false, at: 9 });
  assert.equal(h.status, "unknown");
  assert.equal(h.lastSeenAt, 1); // preserved, not cleared
  assert.equal(h.consecutiveMisses, 0); // an unprobed device is not a miss
});

// ---- service ----

test("device-health requires its core dependencies", () => {
  assert.throws(() => createDeviceHealthService({ scheduler: {} }), /inventory/);
  assert.throws(() => createDeviceHealthService({ inventory: {} }), /scheduler/);
});

test("checkDevice probes reachability + BACnet and persists health", async () => {
  const inv = inventoryWith([{ id: "equip:a", name: "AHU-1", deviceInstance: 1001, address: "10.0.0.5:47808" }]);
  const reads = [];
  const bacnet = { readPoint: async (ref, type, inst) => { reads.push({ ref, type, inst }); return SYS(0); } };
  const netscan = { isReachable: async () => ({ reachable: true, rttMs: 4 }) };
  const scheduler = createScheduler({ timer: fakeTimer() });
  const svc = createDeviceHealthService({ inventory: inv, bacnet, netscan, scheduler, now: () => 500 });

  const equip = inv.getEntity("equip:a");
  const health = await svc.checkDevice(equip);
  assert.equal(health.status, "online");
  assert.equal(health.lastRttMs, 4);
  assert.equal(reads[0].type, OBJECT_DEVICE);
  assert.equal(reads[0].inst, 1001);
  // persisted onto the entity
  assert.equal(inv.getEntity("equip:a").health.status, "online");
});

test("checkDevice marks unreachable devices and skips the BACnet read", async () => {
  const inv = inventoryWith([{ id: "equip:b", name: "VAV-2", deviceInstance: 5, address: "10.0.0.9" }]);
  let bacnetCalls = 0;
  const bacnet = { readPoint: async () => { bacnetCalls++; return SYS(0); } };
  const netscan = { isReachable: async () => ({ reachable: false, rttMs: null }) };
  const scheduler = createScheduler({ timer: fakeTimer() });
  const svc = createDeviceHealthService({ inventory: inv, bacnet, netscan, scheduler, now: () => 1, offlineThreshold: 1 });

  const health = await svc.checkDevice(inv.getEntity("equip:b"));
  assert.equal(health.status, "offline");
  assert.equal(bacnetCalls, 0, "no BACnet read when ping already proved the device down");
});

test("a device with nothing to probe reports unknown, not online", async () => {
  const inv = inventoryWith([{ id: "equip:ghost", name: "Ghost", deviceInstance: 42 }]); // no address
  const scheduler = createScheduler({ timer: fakeTimer() });
  // No netscan and no bacnet capability -> no probe is possible.
  const svc = createDeviceHealthService({ inventory: inv, scheduler, now: () => 1 });
  const health = await svc.checkDevice(inv.getEntity("equip:ghost"));
  assert.equal(health.status, "unknown");
  assert.equal(inv.getEntity("equip:ghost").health.status, "unknown");
});

test("checkAll tallies statuses, writes timeseries, and persists", async () => {
  const inv = inventoryWith([
    { id: "equip:on", name: "On", deviceInstance: 1, address: "10.0.0.1" },
    { id: "equip:off", name: "Off", deviceInstance: 2, address: "10.0.0.2" },
  ]);
  const bacnet = { readPoint: async () => SYS(0) };
  const netscan = { isReachable: async (ip) => ({ reachable: ip === "10.0.0.1", rttMs: ip === "10.0.0.1" ? 2 : null }) };
  const timeseries = createTimeseries({ now: () => 777 });
  const scheduler = createScheduler({ timer: fakeTimer() });
  const svc = createDeviceHealthService({ inventory: inv, bacnet, netscan, scheduler, timeseries, now: () => 777, offlineThreshold: 1 });

  const tally = await svc.checkAll();
  assert.deepEqual(tally, { online: 1, degraded: 0, offline: 1, unknown: 0, total: 2 });

  const recent = timeseries.recent();
  assert.equal(recent.length, 2);
  assert.equal(recent[0].measurement, "bacnet_device");
  const onMetric = recent.find((r) => r.tags.equip === "equip:on");
  assert.equal(onMetric.fields.online, 1);
  assert.equal(onMetric.fields.rtt_ms, 2);
  assert.equal(recent.find((r) => r.tags.equip === "equip:off").fields.online, 0);
});

test("listAlerts surfaces offline/degraded but suppresses maintenance lifecycle", async () => {
  const inv = inventoryWith([
    { id: "equip:down", name: "Down", deviceInstance: 7, address: "10.0.0.7", health: { status: "offline", since: 10, lastSeenAt: 1 } },
    { id: "equip:maint", name: "Maint", deviceInstance: 8, address: "10.0.0.8", health: { status: "offline", since: 10 }, lifecycle: "maintenance" },
    { id: "equip:decom", name: "Decom", deviceInstance: 10, address: "10.0.0.10", health: { status: "offline", since: 10 }, lifecycle: "decommissioned" },
    { id: "equip:ok", name: "Ok", deviceInstance: 9, address: "10.0.0.9", health: { status: "online" } },
  ]);
  const scheduler = createScheduler({ timer: fakeTimer() });
  const svc = createDeviceHealthService({ inventory: inv, scheduler });

  const alerts = svc.listAlerts();
  assert.equal(alerts.length, 1); // both maintenance and decommissioned are suppressed
  assert.equal(alerts[0].equipId, "equip:down");
  assert.equal(alerts[0].status, "offline");
  assert.equal(alerts[0].deviceInstance, 7);
});

test("setLifecycle validates and persists; start/stop toggle the scheduler job", () => {
  const inv = inventoryWith([{ id: "equip:x", name: "X", deviceInstance: 3 }]);
  const scheduler = createScheduler({ timer: fakeTimer() });
  const svc = createDeviceHealthService({ inventory: inv, scheduler });

  assert.throws(() => svc.setLifecycle("equip:x", "bogus"), /invalid lifecycle/);
  assert.throws(() => svc.setLifecycle("equip:ghost", "active"), /unknown device/);
  svc.setLifecycle("equip:x", "decommissioned");
  assert.equal(inv.getEntity("equip:x").lifecycle, "decommissioned");

  assert.equal(svc.isRunning(), false);
  svc.start(60000);
  assert.equal(svc.isRunning(), true);
  svc.stop();
  assert.equal(svc.isRunning(), false);
});

// ---- alerts service integration ----

test("alerts.listUnified merges device-health alerts when the devices cap is present", async () => {
  const inv = inventoryWith([
    { id: "equip:down", name: "RTU-9", deviceInstance: 9, address: "10.0.0.9", health: { status: "offline", since: 5, lastSeenAt: 1 } },
  ]);
  const scheduler = createScheduler({ timer: fakeTimer() });
  const devices = createDeviceHealthService({ inventory: inv, scheduler });
  const rules = { run: async () => ({ findings: [], summary: {} }) };
  const alerts = createAlertsService({ inventory: inv, rules, devices });

  const unified = await alerts.listUnified({ devices: [] });
  const deviceAlert = unified.find((a) => a.source === "device");
  assert.ok(deviceAlert, "device alert present");
  assert.equal(deviceAlert.severity, "high");
  assert.equal(deviceAlert.status, "active");
  assert.equal(deviceAlert.equipName, "RTU-9");
  assert.match(deviceAlert.message, /offline/i);
});

test("alerts service without a devices cap yields no device alerts", async () => {
  const inv = inventoryWith([]);
  const rules = { run: async () => ({ findings: [], summary: {} }) };
  const alerts = createAlertsService({ inventory: inv, rules });
  assert.deepEqual(alerts.listDeviceAlerts(), []);
});
