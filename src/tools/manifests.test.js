import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOL_MANIFESTS, manifestById } from "./manifests.js";
import { validateManifest } from "../platform/manifest.js";
import { buildRegistry } from "../platform/registry.js";

test("every tool manifest is individually valid", () => {
  for (const m of TOOL_MANIFESTS) {
    const { valid, errors } = validateManifest(m);
    assert.ok(valid, `${m.id}: ${errors.join("; ")}`);
  }
});

test("the full manifest set builds a clean registry", () => {
  const reg = buildRegistry(TOOL_MANIFESTS);
  assert.ok(reg.ok, reg.errors.join("; "));
});

test("networkmanager provides the network primitives", () => {
  const reg = buildRegistry(TOOL_MANIFESTS);
  assert.ok(reg.providers.get("network.adapters").some((p) => p.toolId === "networkmanager"));
  assert.ok(reg.providers.get("netscan").some((p) => p.toolId === "networkmanager"));
});

test("bacnet-manager resolves its optional netscan dependency to networkmanager", () => {
  const reg = buildRegistry(TOOL_MANIFESTS);
  const res = reg.resolutions.get("bacnet-manager").find((r) => r.capability === "netscan");
  assert.equal(res.providerId, "networkmanager");
  assert.ok(reg.initOrder.indexOf("networkmanager") < reg.initOrder.indexOf("bacnet-manager"));
});

test("bacnet.read is extracted into the headless bacnet-core service", () => {
  const reg = buildRegistry(TOOL_MANIFESTS);
  // The service owns the capability...
  assert.ok(reg.providers.get("bacnet.read").some((p) => p.toolId === "bacnet-core"));
  assert.equal(manifestById("bacnet-core").category, "service");
  // ...and BACnet Manager consumes it rather than providing it.
  assert.deepEqual(manifestById("bacnet-manager").provides, []);
  const res = reg.resolutions.get("bacnet-manager").find((r) => r.capability === "bacnet.read");
  assert.equal(res.providerId, "bacnet-core");
  assert.ok(reg.initOrder.indexOf("bacnet-core") < reg.initOrder.indexOf("bacnet-manager"));
});

test("the observability service provides timeseries, resolving consumers' optional dep", () => {
  const reg = buildRegistry(TOOL_MANIFESTS);
  assert.ok(reg.providers.get("timeseries").some((p) => p.toolId === "observability"));
  const ts = reg.resolutions.get("networkmanager").find((r) => r.capability === "timeseries");
  assert.equal(ts.providerId, "observability");
  // observability has no deps, so it must boot before networkmanager, which
  // consumes timeseries. (bacnet doesn't consume timeseries, so its relative
  // order isn't contractual and isn't asserted here.)
  assert.ok(reg.initOrder.indexOf("observability") < reg.initOrder.indexOf("networkmanager"));
});

test("observability also provides the scheduler capability", () => {
  const reg = buildRegistry(TOOL_MANIFESTS);
  assert.ok(reg.providers.get("scheduler").some((p) => p.toolId === "observability"));
  const sched = reg.resolutions.get("networkmanager").find((r) => r.capability === "scheduler");
  assert.equal(sched.providerId, "observability");
});

test("bacnet-historian composes bacnet.read + scheduler + timeseries", () => {
  const reg = buildRegistry(TOOL_MANIFESTS);
  assert.ok(reg.ok, reg.errors.join("; "));
  const res = reg.resolutions.get("bacnet-historian");
  const by = (cap) => res.find((r) => r.capability === cap);
  assert.equal(by("bacnet.read").providerId, "bacnet-core");
  assert.equal(by("scheduler").providerId, "observability");
  assert.equal(by("timeseries").providerId, "observability");
  // must boot after all three providers
  const order = reg.initOrder;
  for (const dep of ["bacnet-core", "observability"]) {
    assert.ok(order.indexOf(dep) < order.indexOf("bacnet-historian"), `${dep} before historian`);
  }
});

test("the building-model service owns inventory; building-workspace consumes it", () => {
  const reg = buildRegistry(TOOL_MANIFESTS);
  assert.ok(reg.ok, reg.errors.join("; "));
  // The headless building-model service is the sole inventory provider.
  const inventoryProviders = reg.providers.get("inventory").map((p) => p.toolId);
  assert.deepEqual(inventoryProviders, ["building-model"]);
  assert.equal(manifestById("building-model").category, "service");
  // building-workspace now consumes inventory + graphics rather than providing.
  assert.deepEqual(manifestById("building-workspace").provides, []);
  const res = reg.resolutions.get("building-workspace");
  const by = (cap) => res.find((r) => r.capability === cap);
  assert.equal(by("inventory").providerId, "building-model");
  assert.equal(by("graphics").providerId, "building-graphics");
  assert.equal(by("bacnet.read").providerId, "bacnet-core");
  assert.equal(by("bacnet.historian").providerId, "bacnet-historian");
  assert.equal(by("scheduler").providerId, "observability");
  assert.equal(by("timeseries").providerId, "observability");
  const order = reg.initOrder;
  for (const dep of ["bacnet-core", "bacnet-historian", "observability", "building-model", "building-graphics"]) {
    assert.ok(order.indexOf(dep) < order.indexOf("building-workspace"), `${dep} before building-workspace`);
  }
});

test("the analytics, graphics, and alerts services own their capabilities", () => {
  const reg = buildRegistry(TOOL_MANIFESTS);
  assert.ok(reg.ok, reg.errors.join("; "));
  assert.deepEqual(reg.providers.get("rules").map((p) => p.toolId), ["building-rules"]);
  assert.deepEqual(reg.providers.get("graphics").map((p) => p.toolId), ["building-graphics"]);
  assert.deepEqual(reg.providers.get("alerts").map((p) => p.toolId), ["building-alerts"]);
  for (const id of ["building-rules", "building-graphics", "building-alerts"]) {
    assert.equal(manifestById(id).category, "service");
  }
  // building-alerts composes rules + inventory and boots after both.
  const alertsRes = reg.resolutions.get("building-alerts");
  assert.equal(alertsRes.find((r) => r.capability === "rules").providerId, "building-rules");
  assert.equal(alertsRes.find((r) => r.capability === "inventory").providerId, "building-model");
  const order = reg.initOrder;
  for (const dep of ["building-model", "building-rules"]) {
    assert.ok(order.indexOf(dep) < order.indexOf("building-alerts"), `${dep} before building-alerts`);
  }
});

test("manifestById looks tools up", () => {
  assert.equal(manifestById("bacnet-manager").name, "BACnet Manager");
  assert.equal(manifestById("nope"), null);
});

test("every manifest carries UI metadata for the catalog", () => {
  for (const m of TOOL_MANIFESTS) {
    assert.ok(m.ui && m.ui.emoji && m.ui.tagline && m.ui.description, `${m.id} missing ui`);
  }
});
