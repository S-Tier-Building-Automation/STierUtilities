import { test } from "node:test";
import assert from "node:assert/strict";
import { createRemoteOps, canCommand, canRead, scopeAllowed } from "./remote-ops.js";

function fakeBacnet(log) {
  return {
    readPoint: async (...a) => { log.push(["read", a]); return [{ name: "present-value" }]; },
    writeProperty: async (a) => { log.push(["write", a]); return "ok"; },
  };
}

test("role grants gate read and command", () => {
  assert.ok(canCommand("integrator"));
  assert.ok(canCommand("operator"));
  assert.equal(canCommand("owner"), false);
  assert.equal(canCommand("tenant"), false);
  assert.ok(canRead("owner"));
});

test("operators can command; owners cannot", async () => {
  const log = [];
  const ops = createRemoteOps({ bacnet: fakeBacnet(log), role: "operator" });
  await ops.commandPoint({ device: { address: "1" }, objectType: 1, instance: 1, property: 85, value: { kind: "real", value: 70 } });
  assert.equal(log.at(-1)[0], "write");

  const ownerOps = createRemoteOps({ bacnet: fakeBacnet(log), role: "owner" });
  await assert.rejects(() => ownerOps.commandPoint({ device: { address: "1" }, objectType: 1, instance: 1, property: 85, value: {} }));
});

test("tenant scope restricts reads to the allowed scope", async () => {
  assert.equal(scopeAllowed("tenant", { allowedScopeId: "floor:2", entityScopeId: "floor:2" }), true);
  assert.equal(scopeAllowed("tenant", { allowedScopeId: "floor:2", entityScopeId: "floor:9" }), false);
  assert.equal(scopeAllowed("integrator", {}), true);

  const log = [];
  const ops = createRemoteOps({ bacnet: fakeBacnet(log), role: "tenant", allowedScopeId: "floor:2" });
  await assert.rejects(() => ops.readPoint({ device: {}, objectType: 1, instance: 1, entityScopeId: "floor:9" }));
});

test("commands are audited", async () => {
  const log = [];
  const audits = [];
  const ops = createRemoteOps({ bacnet: fakeBacnet(log), role: "integrator", audit: (e) => audits.push(e) });
  await ops.commandPoint({ device: { address: "1" }, objectType: 1, instance: 1, property: 85, value: { kind: "real", value: 70 }, actor: "eng@si" });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor, "eng@si");
  assert.equal(audits[0].action, "command");
});
