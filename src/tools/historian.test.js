import { test } from "node:test";
import assert from "node:assert/strict";
import { createHistorian, extractPresentValue, numericFromValue } from "./historian.js";
import { createScheduler } from "../platform/services/scheduler.js";
import { createTimeseries } from "../platform/services/timeseries.js";

function fakeTimer() {
  const reg = [];
  return { reg, every: (fn, ms) => (reg.push({ fn, ms }), reg.length - 1), cancel: (t) => (reg[t] = null) };
}

const PV = (kind, value) => [{ id: 85, name: "present-value", display: String(value), values: [{ kind, value }], error: null }];

test("numericFromValue handles the BACnet value kinds", () => {
  assert.equal(numericFromValue({ kind: "real", value: 72.4 }), 72.4);
  assert.equal(numericFromValue({ kind: "unsigned", value: 5 }), 5);
  assert.equal(numericFromValue({ kind: "boolean", value: true }), 1);
  assert.equal(numericFromValue({ kind: "enumerated", value: 2 }), 2);
  assert.equal(numericFromValue({ kind: "characterString", value: "x" }), null);
  assert.equal(numericFromValue(null), null);
});

test("extractPresentValue finds present-value by name or id", () => {
  assert.equal(extractPresentValue(PV("real", 70.5)), 70.5);
  assert.equal(extractPresentValue([{ name: "units", values: [{ kind: "enumerated", value: 62 }] }]), null);
  assert.equal(extractPresentValue([{ id: 85, name: "present-value", error: "timeout", values: [] }]), null);
  assert.equal(extractPresentValue("nope"), null);
});

test("historian requires its core dependencies", () => {
  assert.throws(() => createHistorian({ scheduler: {} }), /bacnet\.read/);
  assert.throws(() => createHistorian({ bacnet: {} }), /scheduler/);
});

test("pollOnce reads each point and writes present-value to timeseries", async () => {
  const reads = [];
  const bacnet = {
    readPoint: async (device, objectType, instance) => {
      reads.push({ device, objectType, instance });
      return PV("real", 68 + instance);
    },
  };
  const timeseries = createTimeseries({ now: () => 1234 });
  const scheduler = createScheduler({ timer: fakeTimer() });
  const h = createHistorian({ bacnet, scheduler, timeseries, now: () => 1234 });

  h.addPoint({ device: { deviceInstance: 999 }, objectType: 0, instance: 1, label: "Zone Temp" });
  h.addPoint({ device: { deviceInstance: 999 }, objectType: 0, instance: 2, label: "Supply Temp" });

  const summary = await h.pollOnce();
  assert.equal(summary.written, 2);
  assert.equal(summary.errors, 0);
  assert.equal(reads.length, 2);

  const recent = timeseries.recent();
  assert.equal(recent.length, 2);
  assert.equal(recent[0].measurement, "bacnet_point");
  assert.deepEqual(recent[0].tags, { device: "999", object: "0:1", label: "Zone Temp" });
  assert.equal(recent[0].fields.present_value, 69);
  assert.equal(recent[0].ts, 1234);
});

test("pollOnce records per-point read errors without aborting the rest", async () => {
  const bacnet = {
    readPoint: async (_d, _t, instance) => {
      if (instance === 1) throw new Error("APDU timeout");
      return PV("real", 50);
    },
  };
  const scheduler = createScheduler({ timer: fakeTimer() });
  const ts = createTimeseries();
  const h = createHistorian({ bacnet, scheduler, timeseries: ts });
  h.addPoint({ device: { deviceInstance: 1 }, objectType: 0, instance: 1 });
  h.addPoint({ device: { deviceInstance: 1 }, objectType: 0, instance: 2 });

  const summary = await h.pollOnce();
  assert.equal(summary.errors, 1);
  assert.equal(summary.written, 1);
  assert.match(h.points()[0].lastError, /APDU timeout/);
  assert.equal(h.points()[1].lastValue, 50);
});

test("addPoint dedupes and removePoint works", () => {
  const scheduler = createScheduler({ timer: fakeTimer() });
  const h = createHistorian({ bacnet: { readPoint: async () => [] }, scheduler });
  h.addPoint({ device: { deviceInstance: 1 }, objectType: 0, instance: 1 });
  h.addPoint({ device: { deviceInstance: 1 }, objectType: 0, instance: 1 }); // dupe
  assert.equal(h.points().length, 1);
  assert.ok(h.removePoint({ device: { deviceInstance: 1 }, objectType: 0, instance: 1 }));
  assert.equal(h.points().length, 0);
});

test("clearPoints resets configured historian points", () => {
  const scheduler = createScheduler({ timer: fakeTimer() });
  const h = createHistorian({ bacnet: { readPoint: async () => [] }, scheduler });
  h.addPoint({ device: { deviceInstance: 1 }, objectType: 0, instance: 1 });
  h.addPoint({ device: { deviceInstance: 2 }, objectType: 0, instance: 2 });
  h.clearPoints();
  assert.deepEqual(h.points(), []);
});

test("addPoint refreshes metadata for an existing point key", () => {
  const scheduler = createScheduler({ timer: fakeTimer() });
  const h = createHistorian({ bacnet: { readPoint: async () => [] }, scheduler });
  const first = h.addPoint({ device: { deviceInstance: 1 }, objectType: 0, instance: 1, label: "Old", site: "Old Site" });
  first.reads = 4;
  first.lastValue = 72;

  const updated = h.addPoint({ device: { deviceInstance: 1 }, objectType: 0, instance: 1, label: "New", site: "New Site" });

  assert.equal(updated.label, "New");
  assert.equal(updated.site, "New Site");
  assert.equal(updated.reads, 4);
  assert.equal(updated.lastValue, 72);
  assert.equal(h.points().length, 1);
});

test("start registers a scheduler job and polls immediately; stop removes it", async () => {
  const bacnet = { readPoint: async () => PV("real", 42) };
  const ts = createTimeseries();
  const scheduler = createScheduler({ timer: fakeTimer() });
  const h = createHistorian({ bacnet, scheduler, timeseries: ts });
  h.addPoint({ device: { deviceInstance: 7 }, objectType: 0, instance: 0 });

  h.start(30000);
  assert.ok(h.isRunning());
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(ts.recent().length >= 1);

  h.stop();
  assert.ok(!h.isRunning());
});

test("pollOnce skips unreachable devices when netscan is available", async () => {
  const bacnet = {
    readPoint: async () => PV("real", 50),
  };
  const netscan = {
    isReachable: async (ip) => ({ reachable: ip === "10.0.0.5", rttMs: 1 }),
  };
  const scheduler = createScheduler({ timer: fakeTimer() });
  const ts = createTimeseries();
  const h = createHistorian({ bacnet, scheduler, timeseries: ts, netscan });
  h.addPoint({ device: { deviceInstance: 1, address: "10.0.0.9" }, objectType: 0, instance: 1 });
  h.addPoint({ device: { deviceInstance: 2, address: "10.0.0.5" }, objectType: 0, instance: 2 });

  const summary = await h.pollOnce();
  assert.equal(summary.written, 1);
  assert.equal(summary.skipped, 1);
  assert.match(h.points()[0].lastError, /unreachable/);
});

test("handleCovEvent writes present-value from COV notifications", async () => {
  const bacnet = {
    subscribeCov: async () => 42,
    unsubscribeCov: async () => {},
    readPoint: async () => [],
  };
  const scheduler = createScheduler({ timer: fakeTimer() });
  const ts = createTimeseries({ now: () => 9000 });
  const h = createHistorian({ bacnet, scheduler, timeseries: ts, now: () => 9000 });
  h.addPoint({ device: { deviceInstance: 7 }, objectType: 0, instance: 3, label: "SAT" });
  h.start(60000, { cov: true });
  await new Promise((resolve) => setImmediate(resolve));

  const handled = h.handleCovEvent({
    processId: 42,
    objectType: 0,
    instance: 3,
    values: PV("real", 68.2),
  });
  assert.ok(handled);
  assert.equal(h.points()[0].lastValue, 68.2);
  assert.equal(ts.recent().at(-1).fields.present_value, 68.2);
  h.stop();
});
