// Real MCP client backed by the Rust stdio transport (src-tauri/src/mcp.rs).
// Turns a kind:"mcp" tool manifest into a kernel factory: it starts the server,
// then registers each provided capability as a proxy whose method calls become
// `tools/call` over JSON-RPC. `invoke` is injected for testability.

import { buildMcpFactory } from "../mcp-loader.js";

/** A client whose callTool() routes to a running MCP server via the Rust bridge. */
export function createMcpClient(invoke, serverId) {
  return {
    callTool: (name, args) => invoke("mcp_call", { id: serverId, name, arguments: args ?? {} }),
  };
}

/** Start an MCP server from a manifest's stdio entry. Returns the Rust ServerInfo. */
export function startMcpServer(invoke, manifest) {
  const e = manifest.entry || {};
  if (e.transport && e.transport !== "stdio") {
    return Promise.reject(new Error(`unsupported MCP transport "${e.transport}" (only stdio is wired)`));
  }
  if (!e.command) return Promise.reject(new Error("mcp manifest entry is missing a command"));
  return invoke("mcp_start", { id: manifest.id, command: e.command, args: e.args ?? [], env: e.env ?? null });
}

/**
 * Build kernel factories for a set of kind:"mcp" manifests. Each factory starts
 * its server lazily at boot; if the server can't start, the factory throws and the
 * kernel logs it + continues (the tool shows but its capability stays unavailable).
 */
export function buildMcpFactories(invoke, manifests) {
  const factories = new Map();
  for (const m of manifests || []) {
    if (m.kind !== "mcp") continue;
    factories.set(m.id, async (host) => {
      await startMcpServer(invoke, m);
      const client = createMcpClient(invoke, m.id);
      await buildMcpFactory(m, client)(host);
    });
  }
  return factories;
}
