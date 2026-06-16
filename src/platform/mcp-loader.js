// MCP tool loader — lets third-party tools (kind: "mcp") plug into the platform.
//
// A capability provided by an MCP tool is backed by the server's MCP tools: each
// method call on the capability proxies to `client.callTool("<prefix>.<method>",
// args)`. The MCP client is injected (the app wires a real one; tests pass a
// mock), so this whole module is unit-testable with no live server.
//
// This reuses the same manifest + capability contract as native tools, so a
// consumer can `host.use("niagara.points.v1")` without caring whether the
// provider is compiled-in Rust or an out-of-process MCP server.

import { validateManifest } from "./manifest.js";

/**
 * A capability implementation whose every method proxies to an MCP tool named
 * `<prefix>.<method>`. Guards against the thenable trap so the proxy can be
 * returned from async code without being mistaken for a Promise.
 */
// Property names that must NOT be treated as MCP tool methods, or the proxy would
// fire spurious tools/call RPCs (or throw) during JSON.stringify, string coercion,
// promise-resolution, or runtime introspection of the capability object.
const RESERVED_PROXY_KEYS = new Set([
  "then", "catch", "finally", "toJSON", "toString", "valueOf", "constructor", "inspect", "prototype", "__proto__",
]);

export function mcpCapabilityProxy(client, prefix) {
  const cache = new Map();
  return new Proxy(Object.create(null), {
    get(_target, method) {
      if (typeof method !== "string" || RESERVED_PROXY_KEYS.has(method)) return undefined;
      if (!cache.has(method)) {
        cache.set(method, (args) => client.callTool(`${prefix}.${method}`, args ?? {}));
      }
      return cache.get(method);
    },
  });
}

/**
 * Validate an MCP tool manifest. Returns { ok, errors }. Adds MCP-specific checks
 * on top of the shared manifest validation.
 */
export function prepareMcpTool(manifest) {
  const { valid, errors } = validateManifest(manifest);
  const errs = [...errors];
  if (valid && manifest.kind !== "mcp") {
    errs.push(`prepareMcpTool: expected kind "mcp", got "${manifest.kind}"`);
  }
  return { ok: errs.length === 0, errors: errs };
}

/**
 * Build the kernel factory for an MCP tool: registers each provided capability as
 * a proxy to the server's tools. `client` is an MCP client with callTool(name, args).
 * Per-capability tool-name prefixes may be overridden via manifest.entry.toolPrefixes.
 */
export function buildMcpFactory(manifest, client) {
  if (!client || typeof client.callTool !== "function") {
    throw new Error("buildMcpFactory requires an MCP client with callTool()");
  }
  const prefixes = (manifest.entry && manifest.entry.toolPrefixes) || {};
  return async (host) => {
    for (const p of manifest.provides || []) {
      const prefix = prefixes[p.capability] || p.capability;
      host.provide(p.capability, p.version, mcpCapabilityProxy(client, prefix));
    }
  };
}

/**
 * Permission approval flow for installing a (third-party) tool. Calls `prompt`
 * with the tool's requested permissions and returns the granted subset.
 *  - prompt may return an array of approved permission strings,
 *  - or `true` to grant all / `false` to deny all.
 */
export async function approveInstall(manifest, prompt) {
  const requested = manifest.permissions || [];
  if (requested.length === 0) return new Set();
  const decision = await prompt({ id: manifest.id, name: manifest.name, permissions: requested });
  if (decision === true) return new Set(requested);
  if (!decision) return new Set();
  // array of approved permissions — intersect with requested for safety
  const approved = new Set(decision);
  return new Set(requested.filter((p) => approved.has(p)));
}

/**
 * Build a kernel `grant` callback from a map of toolId -> granted permission Set
 * (e.g. produced by approveInstall and persisted). Native first-party tools fall
 * back to all-declared (they aren't in the map).
 */
export function grantsFromInstall(installGrants) {
  return (toolId, declared) => {
    if (installGrants && installGrants.has(toolId)) {
      const granted = installGrants.get(toolId);
      return declared.filter((p) => granted.has(p));
    }
    return declared; // first-party default
  };
}
