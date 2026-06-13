import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRegistry } from "./registry.js";

const mk = (id, opts = {}) => ({
  id,
  name: id,
  version: opts.version || "1.0.0",
  apiVersion: "1",
  kind: "native",
  provides: opts.provides || [],
  requires: opts.requires || [],
});

test("resolves a simple provider/consumer pair and orders provider first", () => {
  const reg = buildRegistry([
    mk("bacnet", { requires: [{ capability: "netscan", version: "^1.0" }] }),
    mk("netscan", { provides: [{ capability: "netscan", version: "1.0.0" }] }),
  ]);
  assert.ok(reg.ok, reg.errors.join("; "));
  assert.deepEqual(reg.initOrder, ["netscan", "bacnet"]);
  const res = reg.resolutions.get("bacnet")[0];
  assert.equal(res.providerId, "netscan");
  assert.equal(res.providerVersion, "1.0.0");
});

test("reports unmet required dependency", () => {
  const reg = buildRegistry([
    mk("bacnet", { requires: [{ capability: "netscan", version: "^2.0" }] }),
    mk("netscan", { provides: [{ capability: "netscan", version: "1.0.0" }] }),
  ]);
  assert.ok(!reg.ok);
  assert.match(reg.errors.join(" "), /unmet dependency: netscan@\^2\.0.*available: 1\.0\.0/);
});

test("optional unmet dependency does not fail the build", () => {
  const reg = buildRegistry([
    mk("bacnet", { requires: [{ capability: "timeseries", version: "^1.0", optional: true }] }),
  ]);
  assert.ok(reg.ok, reg.errors.join("; "));
  assert.equal(reg.resolutions.get("bacnet")[0].providerId, null);
});

test("picks the highest satisfying provider version", () => {
  const reg = buildRegistry([
    mk("a", { requires: [{ capability: "cap", version: "^1.0" }] }),
    mk("p1", { provides: [{ capability: "cap", version: "1.1.0" }] }),
    mk("p2", { provides: [{ capability: "cap", version: "1.4.0" }] }),
  ]);
  assert.ok(reg.ok, reg.errors.join("; "));
  assert.equal(reg.resolutions.get("a")[0].providerId, "p2");
});

test("detects a dependency cycle", () => {
  const reg = buildRegistry([
    mk("a", { provides: [{ capability: "ca", version: "1.0.0" }], requires: [{ capability: "cb", version: "^1.0" }] }),
    mk("b", { provides: [{ capability: "cb", version: "1.0.0" }], requires: [{ capability: "ca", version: "^1.0" }] }),
  ]);
  assert.ok(!reg.ok);
  assert.match(reg.errors.join(" "), /dependency cycle detected among: a, b/);
});

test("a tool may depend on a capability it also provides without self-cycling", () => {
  const reg = buildRegistry([
    mk("a", {
      provides: [{ capability: "cap", version: "1.0.0" }],
      requires: [{ capability: "cap", version: "^1.0" }],
    }),
  ]);
  assert.ok(reg.ok, reg.errors.join("; "));
  assert.deepEqual(reg.initOrder, ["a"]);
});

test("duplicate tool ids are rejected", () => {
  const reg = buildRegistry([mk("dup"), mk("dup")]);
  assert.ok(!reg.ok);
  assert.match(reg.errors.join(" "), /duplicate tool id/);
});

test("invalid manifests are excluded but reported", () => {
  const reg = buildRegistry([mk("good"), { id: "bad", kind: "native" }]);
  assert.ok(!reg.ok);
  assert.ok(reg.tools.has("good"));
  assert.ok(!reg.tools.has("bad"));
});

test("deterministic init order across independent tools", () => {
  const reg = buildRegistry([mk("z"), mk("a"), mk("m")]);
  assert.deepEqual(reg.initOrder, ["a", "m", "z"]);
});

test("diamond dependency resolves with a valid topo order", () => {
  const reg = buildRegistry([
    mk("base", { provides: [{ capability: "base", version: "1.0.0" }] }),
    mk("left", {
      provides: [{ capability: "left", version: "1.0.0" }],
      requires: [{ capability: "base", version: "^1.0" }],
    }),
    mk("right", {
      provides: [{ capability: "right", version: "1.0.0" }],
      requires: [{ capability: "base", version: "^1.0" }],
    }),
    mk("top", {
      requires: [
        { capability: "left", version: "^1.0" },
        { capability: "right", version: "^1.0" },
      ],
    }),
  ]);
  assert.ok(reg.ok, reg.errors.join("; "));
  const order = reg.initOrder;
  assert.ok(order.indexOf("base") < order.indexOf("left"));
  assert.ok(order.indexOf("base") < order.indexOf("right"));
  assert.ok(order.indexOf("left") < order.indexOf("top"));
  assert.ok(order.indexOf("right") < order.indexOf("top"));
});
