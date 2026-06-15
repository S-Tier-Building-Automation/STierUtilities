import { test } from "node:test";
import assert from "node:assert/strict";
import { createTimeseries } from "./timeseries.js";

function recordingTransport(opts = {}) {
  const batches = [];
  return {
    batches,
    write: async (points) => {
      if (opts.fail) throw new Error("backend down");
      batches.push(points);
    },
    query: opts.query,
    panelUrl: opts.panelUrl,
  };
}

test("write normalizes and rejects invalid points", () => {
  const ts = createTimeseries({ now: () => 1000 });
  const p = ts.write({ measurement: "m", tags: { a: 1, skip: null }, fields: { v: 2 } });
  assert.equal(p.measurement, "m");
  assert.deepEqual(p.tags, { a: "1" }); // tag values stringified, nulls dropped
  assert.equal(p.ts, 1000); // injected clock

  assert.throws(() => ts.write({ fields: { v: 1 } }), /measurement is required/);
  assert.throws(() => ts.write({ measurement: "m" }), /at least one usable field/);
  assert.throws(() => ts.write({ measurement: "m", fields: { v: {} } }), /must be number\|boolean\|string/);
  assert.throws(() => ts.write({ measurement: "m", fields: { v: Infinity } }), /not finite/);
});

test("degraded mode (no backend) still keeps a ring of recent points", () => {
  const ts = createTimeseries({ ringCapacity: 3 });
  for (let i = 0; i < 5; i++) ts.write({ measurement: "m", fields: { i } });
  const recent = ts.recent();
  assert.equal(recent.length, 3); // ring capped
  assert.deepEqual(recent.map((p) => p.fields.i), [2, 3, 4]);
  assert.equal(ts.stats().backend, false);
  assert.equal(ts.stats().buffered, 0); // nothing buffered without a backend
});

test("query throws and panelUrl is null without a backend", async () => {
  const ts = createTimeseries();
  await assert.rejects(() => ts.query("select 1"), /no query backend/);
  assert.equal(ts.panelUrl({ dashboard: "x" }), null);
});

test("with a backend, points buffer and flush in batches", async () => {
  const tx = recordingTransport();
  const ts = createTimeseries({ transport: tx, batchSize: 2 });
  ts.write({ measurement: "m", fields: { v: 1 } });
  ts.write({ measurement: "m", fields: { v: 2 } });
  ts.write({ measurement: "m", fields: { v: 3 } });
  assert.equal(ts.stats().buffered, 3);

  const r1 = await ts.flush();
  assert.equal(r1.sent, 2);
  const all = await ts.flushAll();
  assert.equal(all.sent, 1);
  assert.equal(ts.stats().buffered, 0);
  assert.equal(ts.stats().written, 3);
  assert.equal(tx.batches.flat().length, 3);
});

test("flush failure re-queues the batch and marks degraded", async () => {
  const tx = recordingTransport({ fail: true });
  const ts = createTimeseries({ transport: tx });
  ts.write({ measurement: "m", fields: { v: 1 } });
  const r = await ts.flush();
  assert.equal(r.sent, 0);
  assert.equal(r.degraded, true);
  assert.equal(ts.stats().buffered, 1); // re-queued, not lost
  assert.equal(ts.stats().degraded, true);
  assert.match(ts.stats().lastError, /backend down/);
});

test("buffer overflow drops oldest and counts the loss", async () => {
  const tx = recordingTransport();
  const ts = createTimeseries({ transport: tx, maxBuffer: 2 });
  for (let i = 0; i < 5; i++) ts.write({ measurement: "m", fields: { i } });
  assert.equal(ts.stats().buffered, 2);
  assert.equal(ts.stats().dropped, 3);
});

test("setTransport upgrades a degraded service to live", async () => {
  const ts = createTimeseries(); // degraded
  ts.write({ measurement: "m", fields: { v: 1 } });
  assert.equal(ts.stats().buffered, 0); // wasn't buffered (no backend at write time)
  const tx = recordingTransport();
  ts.setTransport(tx);
  ts.write({ measurement: "m", fields: { v: 2 } });
  await ts.flushAll();
  assert.equal(tx.batches.flat().length, 1); // only points written after the upgrade
  assert.equal(ts.hasBackend(), true);
});

test("query and panelUrl delegate to the transport when present", async () => {
  const tx = recordingTransport({
    query: async (q) => ({ q, rows: [1, 2] }),
    panelUrl: (spec) => `http://localhost:3000/d/${spec.dashboard}`,
  });
  const ts = createTimeseries({ transport: tx });
  assert.deepEqual(await ts.query("flux"), { q: "flux", rows: [1, 2] });
  assert.equal(ts.panelUrl({ dashboard: "bacnet" }), "http://localhost:3000/d/bacnet");
});
