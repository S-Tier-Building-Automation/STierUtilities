import { test } from "node:test";
import assert from "node:assert/strict";
import { createKernel, parseCapabilityRef } from "./host.js";

const mk = (id, opts = {}) => ({
  id,
  name: id,
  version: opts.version || "1.0.0",
  apiVersion: "1",
  kind: "native",
  provides: opts.provides || [],
  requires: opts.requires || [],
  permissions: opts.permissions || [],
});

test("parseCapabilityRef handles both forms", () => {
  assert.deepEqual(parseCapabilityRef("netscan.v1"), { name: "netscan", major: 1 });
  assert.deepEqual(parseCapabilityRef("bacnet.read.v2"), { name: "bacnet.read", major: 2 });
  assert.deepEqual(parseCapabilityRef("netscan"), { name: "netscan", major: null });
});

test("provider boots first and consumer can use the capability", async () => {
  const manifests = [
    mk("consumer", { requires: [{ capability: "math", version: "^1.0" }] }),
    mk("provider", { provides: [{ capability: "math", version: "1.2.0" }] }),
  ];
  let sum = null;
  const factories = new Map([
    ["provider", (host) => host.provide("math", "1.2.0", { add: (a, b) => a + b })],
    ["consumer", (host) => { sum = host.use("math.v1").add(2, 3); }],
  ]);
  const kernel = createKernel({ manifests, factories });
  const res = await kernel.boot();
  assert.ok(res.ok, res.errors.join("; "));
  assert.equal(sum, 5);
});

test("use() of an undeclared capability throws", async () => {
  const manifests = [
    mk("rogue", {}),
    mk("provider", { provides: [{ capability: "secret", version: "1.0.0" }] }),
  ];
  let threw = false;
  const factories = new Map([
    ["provider", (host) => host.provide("secret", "1.0.0", { x: 1 })],
    ["rogue", (host) => {
      try { host.use("secret.v1"); } catch { threw = true; }
    }],
  ]);
  await createKernel({ manifests, factories }).boot();
  assert.ok(threw, "rogue tool must not reach an undeclared capability");
});

test("tryUse returns null for an absent optional capability", async () => {
  const manifests = [mk("a", { requires: [{ capability: "ts", version: "^1.0", optional: true }] })];
  let got = "unset";
  const factories = new Map([["a", (host) => { got = host.tryUse("ts.v1"); }]]);
  await createKernel({ manifests, factories }).boot();
  assert.equal(got, null);
});

test("provide() of an undeclared capability throws", async () => {
  const manifests = [mk("a", {})];
  let threw = false;
  const factories = new Map([["a", (host) => {
    try { host.provide("nope", "1.0.0", {}); } catch { threw = true; }
  }]]);
  await createKernel({ manifests, factories }).boot();
  assert.ok(threw);
});

test("permissions: declared+granted is allowed; undeclared is denied", async () => {
  const manifests = [mk("a", { permissions: ["timeseries.write"] })];
  let canWrite = null;
  let canInject = null;
  const factories = new Map([["a", (host) => {
    canWrite = host.can("timeseries.write");
    canInject = host.can("input.inject");
  }]]);
  await createKernel({ manifests, factories }).boot();
  assert.equal(canWrite, true);
  assert.equal(canInject, false);
});

test("grant callback can withhold a declared permission", async () => {
  const manifests = [mk("a", { permissions: ["timeseries.write", "input.inject"] })];
  let canInject = null;
  const factories = new Map([["a", (host) => { canInject = host.can("input.inject"); }]]);
  await createKernel({
    manifests,
    factories,
    grant: (_id, perms) => perms.filter((p) => p !== "input.inject"),
  }).boot();
  assert.equal(canInject, false);
});

test("requirePermission throws when missing", async () => {
  const manifests = [mk("a", {})];
  let threw = false;
  const factories = new Map([["a", (host) => {
    try { host.requirePermission("elevation.request"); } catch { threw = true; }
  }]]);
  await createKernel({ manifests, factories }).boot();
  assert.ok(threw);
});

test("a tool with no factory still boots (non-native kinds)", async () => {
  const manifests = [{ ...mk("ui-only"), kind: "webview", entry: { page: "p.html" } }];
  const kernel = createKernel({ manifests, factories: new Map() });
  const res = await kernel.boot();
  assert.ok(res.ok, res.errors.join("; "));
  assert.ok(kernel.isBooted("ui-only"));
});

test("hostFor returns a scoped host a page can use after boot", async () => {
  const manifests = [
    mk("consumer", { requires: [{ capability: "math", version: "^1.0" }] }),
    mk("provider", { provides: [{ capability: "math", version: "1.0.0" }] }),
  ];
  const factories = new Map([
    ["provider", (host) => host.provide("math", "1.0.0", { add: (a, b) => a + b })],
  ]);
  const kernel = createKernel({ manifests, factories });
  await kernel.boot();
  const h = kernel.hostFor("consumer");
  assert.equal(h.use("math.v1").add(4, 5), 9);
  assert.equal(kernel.hostFor("nonexistent"), null);
});

test("kernel.capability() resolves an impl a tool provides (for its own UI page)", async () => {
  const manifests = [mk("p", { provides: [{ capability: "thing", version: "2.1.0" }] })];
  const factories = new Map([["p", (host) => host.provide("thing", "2.1.0", { hi: () => "yo" })]]);
  const kernel = createKernel({ manifests, factories });
  await kernel.boot();
  assert.equal(kernel.capability("thing.v2").hi(), "yo");
  assert.equal(kernel.capability("thing").hi(), "yo"); // highest major
  assert.equal(kernel.capability("absent"), null);
});

test("a failing factory does not abort the whole boot", async () => {
  const manifests = [mk("bad"), mk("good")];
  let goodBooted = false;
  const factories = new Map([
    ["bad", () => { throw new Error("kaboom"); }],
    ["good", () => { goodBooted = true; }],
  ]);
  const kernel = createKernel({ manifests, factories });
  await kernel.boot();
  assert.ok(goodBooted);
  assert.ok(!kernel.isBooted("bad"));
  assert.ok(kernel.isBooted("good"));
  assert.match(kernel.logs().map((l) => l.msg).join(" "), /setup failed: kaboom/);
});
