import { test } from "node:test";
import assert from "node:assert/strict";
import { createPackController } from "./pack-controller.js";
import { createTimeseries } from "./timeseries.js";

const PORTS = { influxPort: 18086, grafanaPort: 13000, telegrafListenerPort: 18186, org: "stier", bucket: "utilities", token: "" };

function mockInvoke(handlers = {}) {
  const calls = [];
  const fn = async (cmd, args) => {
    calls.push({ cmd, args });
    return handlers[cmd] ? handlers[cmd](args) : null;
  };
  fn.calls = calls;
  fn.commands = () => calls.map((c) => c.cmd);
  return fn;
}

const noSleep = () => Promise.resolve();

test("ensureConfig prefers persisted config, fills the token, and persists", async () => {
  const persisted = { ...PORTS, token: "saved-token" };
  const invoke = mockInvoke({ observability_load_config: () => persisted });
  const ctl = createPackController({ invoke, timeseries: createTimeseries(), sleep: noSleep });
  const cfg = await ctl.ensureConfig();
  assert.equal(cfg.token, "saved-token");
  assert.ok(invoke.commands().includes("observability_save_config"));
  assert.ok(!invoke.commands().includes("observability_pick_ports")); // didn't need to pick
});

test("ensureConfig picks ports + resolves a token when nothing persisted", async () => {
  const invoke = mockInvoke({
    observability_load_config: () => null,
    observability_pick_ports: () => PORTS,
    secrets_influx_token: () => "generated-token",
  });
  const ctl = createPackController({ invoke, timeseries: createTimeseries(), sleep: noSleep });
  const cfg = await ctl.ensureConfig();
  assert.equal(cfg.influxPort, 18086);
  assert.equal(cfg.token, "generated-token");
});

test("connect attaches the transport and flushes buffered points", async () => {
  const written = [];
  const invoke = mockInvoke({
    observability_load_config: () => ({ ...PORTS, token: "t" }),
    timeseries_write: (a) => written.push(...a.points),
  });
  const ts = createTimeseries();
  const ctl = createPackController({ invoke, timeseries: ts, sleep: noSleep });
  await ctl.connect();
  assert.ok(ctl.isConnected());
  ts.write({ measurement: "m", fields: { v: 1 } });
  await ctl.flush();
  assert.equal(written.length, 1);
});

test("bringUp runs install -> configs -> start -> wait -> onboard -> connect in order", async () => {
  const invoke = mockInvoke({
    observability_load_config: () => ({ ...PORTS, token: "t" }),
    observability_status: () => ({ installed: false }),
    observability_install: () => ({ installed: true }),
    observability_health: () => ({ influxUp: true, influxReady: true, grafanaUp: true }),
    observability_onboard: () => true,
  });
  const ctl = createPackController({ invoke, timeseries: createTimeseries(), sleep: noSleep });
  const steps = [];
  await ctl.bringUp((s) => steps.push(s));

  const cmds = invoke.commands();
  const order = ["observability_install", "observability_write_configs", "observability_start", "observability_health", "observability_onboard"];
  let last = -1;
  for (const c of order) {
    const at = cmds.indexOf(c);
    assert.ok(at > last, `${c} should come after the previous step (cmds: ${cmds.join(",")})`);
    last = at;
  }
  assert.ok(ctl.isConnected());
  assert.ok(steps.includes("done"));
});

test("bringUp always runs the (version-aware) install, which fast-skips up-to-date components", async () => {
  const invoke = mockInvoke({
    observability_load_config: () => ({ ...PORTS, token: "t" }),
    observability_install: () => ({ installed: true }),
    observability_health: () => ({ influxUp: true, influxReady: true, grafanaUp: true }),
    observability_onboard: () => true,
  });
  const ctl = createPackController({ invoke, timeseries: createTimeseries(), sleep: noSleep });
  await ctl.bringUp();
  // install is always invoked; the skip-if-up-to-date decision lives in Rust.
  assert.ok(invoke.commands().includes("observability_install"));
});

test("bringUp throws if InfluxDB never comes up", async () => {
  const invoke = mockInvoke({
    observability_load_config: () => ({ ...PORTS, token: "t" }),
    observability_status: () => ({ installed: true }),
    observability_health: () => ({ influxUp: false, influxReady: false, grafanaUp: false }),
  });
  const ctl = createPackController({ invoke, timeseries: createTimeseries(), sleep: noSleep });
  await assert.rejects(() => ctl.bringUp(), /did not become reachable/);
});

test("install/stop/health/onboard proxy the backend commands", async () => {
  const invoke = mockInvoke({
    observability_load_config: () => ({ ...PORTS, token: "t" }),
    observability_status: () => ({ installed: false }),
    observability_install: () => ({ installed: true }),
    observability_health: () => ({ influxUp: true, influxReady: false, grafanaUp: true }),
    observability_onboard: () => true,
  });
  const ctl = createPackController({ invoke, timeseries: createTimeseries(), sleep: noSleep });
  assert.deepEqual(await ctl.install(), { installed: true });
  assert.equal((await ctl.health()).influxUp, true);
  assert.equal(await ctl.onboard(), true);
  await ctl.stop();
  assert.ok(invoke.commands().includes("observability_stop"));
});
