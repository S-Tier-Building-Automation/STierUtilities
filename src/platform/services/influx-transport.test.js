import { test } from "node:test";
import assert from "node:assert/strict";
import { createInfluxTransport, buildGrafanaPanelUrl } from "./influx-transport.js";
import { createTimeseries } from "./timeseries.js";

const config = {
  influxPort: 8086,
  grafanaPort: 3000,
  telegrafListenerPort: 8186,
  org: "stier",
  bucket: "utilities",
  token: "tok",
};

test("buildGrafanaPanelUrl builds a full-dashboard kiosk embed", () => {
  const url = buildGrafanaPanelUrl(config, { dashboard: "site-trends", vars: { device: "12345" } });
  assert.ok(url.startsWith("http://127.0.0.1:3000/d/site-trends?"));
  assert.ok(url.includes("orgId=1"));
  assert.ok(url.includes("var-device=12345"));
  assert.ok(url.endsWith("&kiosk"));
});

test("buildGrafanaPanelUrl builds a single-panel d-solo embed", () => {
  const url = buildGrafanaPanelUrl(config, { dashboard: "bacnet", panelId: 4, from: "now-6h", to: "now" });
  assert.ok(url.startsWith("http://127.0.0.1:3000/d-solo/bacnet?"));
  assert.ok(url.includes("panelId=4"));
  assert.ok(url.includes("from=now-6h"));
  assert.ok(url.includes("to=now"));
});

test("transport validates its inputs", () => {
  assert.throws(() => createInfluxTransport({ invoke: null, config }), /requires an invoke/);
  assert.throws(() => createInfluxTransport({ invoke: () => {}, config: {} }), /requires a PackConfig/);
});

test("transport.write delegates points to the timeseries_write command", async () => {
  const calls = [];
  const invoke = async (cmd, args) => { calls.push({ cmd, args }); };
  const tx = createInfluxTransport({ invoke, config });
  const points = [{ measurement: "m", tags: {}, fields: { v: 1 }, ts: 5 }];
  await tx.write(points);
  assert.deepEqual(calls[0], { cmd: "timeseries_write", args: { config, points } });
});

test("attaching the transport upgrades a degraded timeseries service to live", async () => {
  const sent = [];
  const invoke = async (_cmd, args) => { sent.push(...args.points); };
  const ts = createTimeseries(); // degraded
  ts.write({ measurement: "m", fields: { v: 1 } }); // dropped (no backend yet, ring only)

  ts.setTransport(createInfluxTransport({ invoke, config }));
  ts.write({ measurement: "m", fields: { v: 2 } });
  const r = await ts.flushAll();

  assert.equal(r.sent, 1); // only the post-upgrade point was delivered
  assert.equal(sent.length, 1);
  assert.equal(sent[0].fields.v, 2);
  assert.equal(ts.panelUrl({ dashboard: "x" }), "http://127.0.0.1:3000/d/x?orgId=1&kiosk");
});

test("write failure leaves the service degraded and re-queued", async () => {
  const invoke = async () => { throw new Error("connect failed"); };
  const ts = createTimeseries({ transport: createInfluxTransport({ invoke, config }) });
  ts.write({ measurement: "m", fields: { v: 1 } });
  const r = await ts.flush();
  assert.equal(r.sent, 0);
  assert.equal(ts.stats().degraded, true);
  assert.equal(ts.stats().buffered, 1); // not lost — will retry when the pack is up
});
