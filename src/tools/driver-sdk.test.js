import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDriverManifest, isDriverManifest, listDrivers, driverCapabilities } from "./driver-sdk.js";
import { TOOL_MANIFESTS } from "./manifests.js";

const goodDriver = {
  id: "snmp-core",
  name: "SNMP Service",
  version: "1.0.0",
  apiVersion: "1",
  kind: "native",
  provides: [{ capability: "snmp.read", version: "1.0" }],
  permissions: ["network.udp"],
};

test("a well-formed driver manifest validates", () => {
  const res = validateDriverManifest(goodDriver);
  assert.ok(res.valid, res.errors.join("; "));
  assert.deepEqual(driverCapabilities(goodDriver), ["snmp.read"]);
});

test("non-drivers are rejected with reasons", () => {
  const noNet = { ...goodDriver, permissions: [] };
  assert.equal(validateDriverManifest(noNet).valid, false);
  const noCap = { ...goodDriver, provides: [{ capability: "snmp.write", version: "1.0" }] };
  assert.equal(validateDriverManifest(noCap).valid, false);
});

test("the built-in BACnet and Modbus services are recognized as drivers", () => {
  const drivers = listDrivers(TOOL_MANIFESTS);
  const ids = drivers.map((d) => d.id).sort();
  assert.ok(ids.includes("bacnet-core"), "bacnet-core is a driver");
  assert.ok(ids.includes("modbus-core"), "modbus-core is a driver");
  // The headless model/graphics/rules services are NOT drivers.
  assert.equal(isDriverManifest(TOOL_MANIFESTS.find((m) => m.id === "building-model")), false);
});
