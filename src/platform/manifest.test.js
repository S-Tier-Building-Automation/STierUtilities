import { test } from "node:test";
import assert from "node:assert/strict";
import { validateManifest, normalizeManifest } from "./manifest.js";

const base = {
  id: "bacnet",
  name: "BACnet Explorer",
  version: "1.2.0",
  apiVersion: "1",
  kind: "native",
};

test("valid minimal native manifest passes", () => {
  const { valid, errors } = validateManifest(base);
  assert.ok(valid, errors.join("; "));
});

test("valid full manifest passes", () => {
  const m = {
    ...base,
    provides: [{ capability: "bacnet.read", version: "1.0" }],
    requires: [
      { capability: "netscan", version: "^1.0", optional: true },
      { capability: "timeseries", version: "^1.0", optional: true },
    ],
    permissions: ["network.udp", "timeseries.write", "fs.appdata"],
    dashboards: ["dashboards/bacnet.json"],
    ui: { emoji: "🏢", tagline: "x" },
  };
  const { valid, errors } = validateManifest(m);
  assert.ok(valid, errors.join("; "));
});

test("bad id is rejected", () => {
  const { valid, errors } = validateManifest({ ...base, id: "BACnet_Explorer" });
  assert.ok(!valid);
  assert.match(errors.join(" "), /id must be kebab-case/);
});

test("wrong apiVersion is rejected", () => {
  const { valid, errors } = validateManifest({ ...base, apiVersion: "2" });
  assert.ok(!valid);
  assert.match(errors.join(" "), /apiVersion/);
});

test("unknown kind is rejected", () => {
  const { valid } = validateManifest({ ...base, kind: "wasm" });
  assert.ok(!valid);
});

test("bad version is rejected", () => {
  const { valid } = validateManifest({ ...base, version: "1.2" });
  assert.ok(!valid);
});

test("invalid capability name in provides is rejected", () => {
  const { valid, errors } = validateManifest({
    ...base,
    provides: [{ capability: "Bad.Cap", version: "1.0" }],
  });
  assert.ok(!valid);
  assert.match(errors.join(" "), /provides\[0\]\.capability/);
});

test("invalid require range is rejected", () => {
  const { valid, errors } = validateManifest({
    ...base,
    requires: [{ capability: "netscan", version: "not-a-range" }],
  });
  assert.ok(!valid);
  assert.match(errors.join(" "), /requires\[0\]\.version/);
});

test("unknown permission is rejected", () => {
  const { valid, errors } = validateManifest({ ...base, permissions: ["network.udp", "do.anything"] });
  assert.ok(!valid);
  assert.match(errors.join(" "), /permissions\[1\] unknown/);
});

test("mcp tool requires a valid entry", () => {
  assert.ok(!validateManifest({ ...base, kind: "mcp" }).valid);
  assert.ok(
    validateManifest({
      ...base,
      kind: "mcp",
      entry: { transport: "stdio", command: "my-tool.exe" },
    }).valid,
  );
  assert.ok(
    !validateManifest({ ...base, kind: "mcp", entry: { transport: "http" } }).valid, // missing url
  );
  assert.ok(
    validateManifest({ ...base, kind: "mcp", entry: { transport: "http", url: "http://x" } }).valid,
  );
});

test("webview tool requires entry.page", () => {
  assert.ok(!validateManifest({ ...base, kind: "webview" }).valid);
  assert.ok(validateManifest({ ...base, kind: "webview", entry: { page: "panel.html" } }).valid);
});

test("non-object manifest fails cleanly", () => {
  assert.ok(!validateManifest(null).valid);
  assert.ok(!validateManifest("nope").valid);
});

test("normalizeManifest fills array defaults", () => {
  const n = normalizeManifest(base);
  assert.deepEqual(n.provides, []);
  assert.deepEqual(n.requires, []);
  assert.deepEqual(n.permissions, []);
  assert.deepEqual(n.dashboards, []);
  assert.deepEqual(n.ui, {});
});
