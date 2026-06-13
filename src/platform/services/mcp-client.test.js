import { test } from "node:test";
import assert from "node:assert/strict";
import { createMcpClient, startMcpServer, buildMcpFactories } from "./mcp-client.js";
import { createKernel } from "../host.js";

const MANIFEST = {
  id: "niagara",
  name: "Niagara",
  version: "0.1.0",
  apiVersion: "1",
  kind: "mcp",
  entry: { transport: "stdio", command: "niagara-mcp.exe", args: ["--stdio"] },
  provides: [{ capability: "niagara.points", version: "1.0" }],
};

function mockInvoke(handlers = {}) {
  const calls = [];
  const fn = async (cmd, args) => {
    calls.push({ cmd, args });
    return handlers[cmd] ? handlers[cmd](args) : null;
  };
  fn.calls = calls;
  return fn;
}

test("createMcpClient routes callTool to the mcp_call command", async () => {
  const invoke = mockInvoke();
  await createMcpClient(invoke, "niagara").callTool("listStations", { x: 1 });
  assert.deepEqual(invoke.calls.at(-1), {
    cmd: "mcp_call",
    args: { id: "niagara", name: "listStations", arguments: { x: 1 } },
  });
});

test("startMcpServer passes the stdio entry to mcp_start", async () => {
  const invoke = mockInvoke({ mcp_start: () => ({ toolCount: 3, tools: [] }) });
  const info = await startMcpServer(invoke, MANIFEST);
  assert.equal(info.toolCount, 3);
  assert.deepEqual(invoke.calls.at(-1), {
    cmd: "mcp_start",
    args: { id: "niagara", command: "niagara-mcp.exe", args: ["--stdio"], env: null },
  });
});

test("startMcpServer rejects non-stdio transports and missing command", async () => {
  await assert.rejects(() => startMcpServer(mockInvoke(), { ...MANIFEST, entry: { transport: "http", url: "x" } }), /unsupported MCP transport/);
  await assert.rejects(() => startMcpServer(mockInvoke(), { ...MANIFEST, entry: { transport: "stdio" } }), /missing a command/);
});

test("buildMcpFactories boots a server and serves its capability through the kernel", async () => {
  const invoke = mockInvoke({
    mcp_start: () => ({ toolCount: 1, tools: [] }),
    mcp_call: (a) => ({ echoed: a.name }),
  });
  const factories = buildMcpFactories(invoke, [MANIFEST]);
  const kernel = createKernel({ manifests: [MANIFEST], factories });
  const res = await kernel.boot();
  assert.ok(res.ok, res.errors.join("; "));
  // the server was started during boot
  assert.ok(invoke.calls.some((c) => c.cmd === "mcp_start"));
  // and the capability proxies method calls to tools/call (mcp_call)
  const out = await kernel.capability("niagara.points.v1").listStations({});
  assert.equal(out.echoed, "niagara.points.listStations");
});

test("a server that fails to start does not abort the whole boot", async () => {
  const invoke = mockInvoke({ mcp_start: () => { throw new Error("ENOENT"); } });
  const factories = buildMcpFactories(invoke, [MANIFEST]);
  const kernel = createKernel({ manifests: [MANIFEST], factories });
  await kernel.boot();
  assert.ok(!kernel.isBooted("niagara")); // setup failed, but boot() returned
  assert.equal(kernel.capability("niagara.points.v1"), null);
});
