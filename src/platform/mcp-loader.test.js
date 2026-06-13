import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mcpCapabilityProxy,
  prepareMcpTool,
  buildMcpFactory,
  approveInstall,
  grantsFromInstall,
} from "./mcp-loader.js";
import { createKernel } from "./host.js";

// An example third-party tool: wraps the S-Tier Niagara MCP server as a platform
// tool that provides the niagara.points capability.
const NIAGARA = {
  id: "niagara",
  name: "Niagara Points",
  version: "0.1.0",
  apiVersion: "1",
  kind: "mcp",
  entry: { transport: "stdio", command: "stier-niagara-mcp" },
  provides: [{ capability: "niagara.points", version: "1.0" }],
  permissions: ["timeseries.write"],
};

function mockMcpClient() {
  const calls = [];
  return {
    calls,
    callTool: async (name, args) => {
      calls.push({ name, args });
      return { name, args };
    },
  };
}

test("an mcp manifest validates and prepareMcpTool accepts it", () => {
  assert.ok(prepareMcpTool(NIAGARA).ok);
  // a native manifest is rejected by prepareMcpTool
  const r = prepareMcpTool({ ...NIAGARA, kind: "native", entry: undefined });
  assert.ok(!r.ok);
});

test("mcpCapabilityProxy proxies method calls to MCP tool names", async () => {
  const client = mockMcpClient();
  const cap = mcpCapabilityProxy(client, "niagara.points");
  await cap.readHistory({ pointId: "abc", range: "1h" });
  assert.deepEqual(client.calls[0], {
    name: "niagara.points.readHistory",
    args: { pointId: "abc", range: "1h" },
  });
});

test("the proxy is not mistaken for a Promise (no thenable trap)", () => {
  const cap = mcpCapabilityProxy(mockMcpClient(), "x");
  assert.equal(cap.then, undefined);
});

test("the proxy does not fire RPCs on JSON.stringify / coercion / introspection", () => {
  const client = mockMcpClient();
  const cap = mcpCapabilityProxy(client, "x");
  for (const k of ["toJSON", "toString", "valueOf", "constructor", "inspect", "catch", "finally"]) {
    assert.equal(cap[k], undefined, `${k} must not be a method`);
  }
  JSON.stringify(cap);          // would throw / RPC if toJSON were proxied
  assert.equal(client.calls.length, 0, "no tools/call should have fired");
});

test("an MCP tool registers its capability through the kernel like a native one", async () => {
  const client = mockMcpClient();
  const consumer = {
    id: "dash",
    name: "dash",
    version: "1.0.0",
    apiVersion: "1",
    kind: "native",
    requires: [{ capability: "niagara.points", version: "^1.0" }],
  };
  let result = null;
  const factories = new Map([
    ["niagara", buildMcpFactory(NIAGARA, client)],
    ["dash", async (host) => { result = await host.use("niagara.points.v1").listStations({}); }],
  ]);
  const kernel = createKernel({ manifests: [NIAGARA, consumer], factories });
  const res = await kernel.boot();
  assert.ok(res.ok, res.errors.join("; "));
  assert.equal(result.name, "niagara.points.listStations");
  // the consumer reached an out-of-process MCP tool through the same capability contract
  assert.equal(client.calls.at(-1).name, "niagara.points.listStations");
});

test("buildMcpFactory honors per-capability tool prefixes", async () => {
  const client = mockMcpClient();
  const manifest = {
    ...NIAGARA,
    entry: { transport: "stdio", command: "x", toolPrefixes: { "niagara.points": "stier" } },
  };
  const factories = new Map([["niagara", buildMcpFactory(manifest, client)]]);
  const kernel = createKernel({ manifests: [manifest], factories });
  await kernel.boot();
  await kernel.capability("niagara.points.v1").getHistory({});
  assert.equal(client.calls.at(-1).name, "stier.getHistory");
});

test("buildMcpFactory requires a real client", () => {
  assert.throws(() => buildMcpFactory(NIAGARA, {}), /requires an MCP client/);
});

test("approveInstall returns the granted permission subset", async () => {
  assert.deepEqual([...await approveInstall(NIAGARA, () => true)], ["timeseries.write"]);
  assert.deepEqual([...await approveInstall(NIAGARA, () => false)], []);
  assert.deepEqual([...await approveInstall(NIAGARA, () => ["timeseries.write"])], ["timeseries.write"]);
  // an over-broad approval is intersected back to what was requested
  assert.deepEqual([...await approveInstall(NIAGARA, () => ["timeseries.write", "input.inject"])], ["timeseries.write"]);
  // a tool requesting nothing needs no prompt
  assert.deepEqual([...await approveInstall({ ...NIAGARA, permissions: [] }, () => true)], []);
});

test("grantsFromInstall gates an mcp tool's permissions per the install decision", async () => {
  const installGrants = new Map([["niagara", new Set([])]]); // user denied timeseries.write
  let granted = null;
  const kernel = createKernel({
    manifests: [NIAGARA],
    factories: new Map([["niagara", async (host) => {
      granted = host.can("timeseries.write");
      buildMcpFactory(NIAGARA, mockMcpClient())(host);
    }]]),
    grant: grantsFromInstall(installGrants),
  });
  await kernel.boot();
  assert.equal(granted, false); // permission withheld by the install decision
});
