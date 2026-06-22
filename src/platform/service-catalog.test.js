import { test } from "node:test";
import assert from "node:assert/strict";
import { buildServiceCatalog, CAPABILITY_DOCS } from "./service-catalog.js";
import { TOOL_MANIFESTS } from "../tools/manifests.js";

const catalog = () => buildServiceCatalog(TOOL_MANIFESTS);
const find = (cap) => catalog().entries.find((e) => e.capability === cap);

test("the catalog builds cleanly from the real manifests", () => {
  const { entries, ok } = catalog();
  assert.ok(ok);
  assert.ok(entries.length >= 7, `expected ≥7 capabilities, got ${entries.length}`);
});

test("every provided capability is documented (no silent drift)", () => {
  for (const e of catalog().entries) {
    assert.ok(e.documented, `capability "${e.capability}" (from ${e.provider.id}) has no CAPABILITY_DOCS entry`);
    assert.ok(e.doc.summary && e.doc.methods.length > 0, `"${e.capability}" doc is empty`);
  }
});

test("bacnet.read is attributed to the bacnet-core service and its consumers", () => {
  const e = find("bacnet.read");
  assert.equal(e.provider.id, "bacnet-core");
  assert.equal(e.provider.category, "service");
  assert.equal(e.ref, "bacnet.read.v1");
  const consumerIds = e.consumers.map((c) => c.id).sort();
  assert.deepEqual(consumerIds, ["alarm-console", "bacnet-historian", "bacnet-manager", "building-alerts", "building-rules", "building-workspace", "device-graphics", "graphics-builder", "schedules"]);
  assert.ok(e.doc.methods.some((m) => m.name === "listDevices"));
  assert.ok(e.doc.methods.some((m) => m.name === "readPoint"));
  assert.ok(e.doc.methods.some((m) => m.name === "listObjects"));
  assert.ok(e.doc.methods.some((m) => m.name === "writeProperty"));
  assert.ok(e.doc.methods.some((m) => m.name === "readTrend"));
  assert.ok(e.doc.methods.some((m) => m.name === "subscribeCov"));
});

test("an optional consumer edge is flagged as optional", () => {
  // bacnet-core consumes netscan optionally (for suggestTargets).
  const e = find("netscan");
  const core = e.consumers.find((c) => c.id === "bacnet-core");
  assert.ok(core, "bacnet-core should consume netscan");
  assert.equal(core.optional, true);
});

test("timeseries is provided by observability and widely consumed", () => {
  const e = find("timeseries");
  assert.equal(e.provider.id, "observability");
  assert.ok(e.consumers.length >= 3, `expected several timeseries consumers, got ${e.consumers.length}`);
});

test("each entry carries a copy-pasteable usage snippet", () => {
  const e = find("bacnet.read");
  assert.match(e.usage, /requires: \[\{ capability: "bacnet\.read", version: "\^1\.0" \}\]/);
  assert.match(e.usage, /host\.use\("bacnet\.read\.v1"\)/);
});

test("CAPABILITY_DOCS does not document capabilities that no tool provides", () => {
  const provided = new Set(catalog().entries.map((e) => e.capability));
  for (const cap of Object.keys(CAPABILITY_DOCS)) {
    assert.ok(provided.has(cap), `CAPABILITY_DOCS has "${cap}" but no manifest provides it (stale doc?)`);
  }
});
