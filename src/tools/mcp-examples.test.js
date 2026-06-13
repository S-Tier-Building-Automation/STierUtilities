import { test } from "node:test";
import assert from "node:assert/strict";
import { EXAMPLE_MCP_TOOLS, NIAGARA_TOOL } from "./mcp-examples.js";
import { prepareMcpTool, buildMcpFactory } from "../platform/mcp-loader.js";
import { createKernel } from "../platform/host.js";

test("example MCP tools are valid mcp manifests", () => {
  for (const m of EXAMPLE_MCP_TOOLS) {
    assert.ok(prepareMcpTool(m).ok, `${m.id} should be a valid mcp tool`);
  }
});

test("the Niagara example boots and serves its capability through a mock client", async () => {
  const calls = [];
  const client = { callTool: async (name, args) => (calls.push({ name, args }), { name }) };
  const kernel = createKernel({
    manifests: [NIAGARA_TOOL],
    factories: new Map([["niagara", buildMcpFactory(NIAGARA_TOOL, client)]]),
  });
  await kernel.boot();
  await kernel.capability("niagara.points.v1").listStations({});
  assert.equal(calls.at(-1).name, "niagara.points.listStations");
});
