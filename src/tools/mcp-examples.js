// Example third-party (MCP) tool manifests. These are NOT added to the live
// TOOL_MANIFESTS catalog — they document how an out-of-process MCP server plugs
// into the platform via kind: "mcp". The app wires a real MCP client and calls
// buildMcpFactory(manifest, client) (see src/platform/mcp-loader.js); these
// manifests are also exercised by mcp-loader.test.js.

// Wraps the S-Tier Niagara/Tridium MCP server (components, tags, histories,
// BQL/NEQL, alarms) as a platform tool. The historian or a dashboard tool can
// then `requires: [{ capability: "niagara.points", version: "^1.0" }]` and pull
// Niagara station histories into the same timeseries service as BACnet — without
// knowing the provider is an MCP server rather than compiled-in Rust.
export const NIAGARA_TOOL = {
  id: "niagara",
  name: "Niagara Points",
  version: "0.1.0",
  apiVersion: "1",
  kind: "mcp",
  entry: {
    transport: "stdio",
    command: "stier-niagara-mcp",
    // Optional: map a capability to a different MCP tool-name prefix.
    toolPrefixes: { "niagara.points": "niagara.points" },
  },
  provides: [{ capability: "niagara.points", version: "1.0" }],
  requires: [{ capability: "timeseries", version: "^1.0", optional: true }],
  permissions: ["timeseries.write"],
  ui: {
    emoji: "🏗️",
    tagline: "Read Niagara/Tridium points and histories via the S-Tier MCP server.",
    description:
      "An example third-party tool: it provides the niagara.points capability by " +
      "proxying to the S-Tier Niagara MCP server's tools. Installed tools approve " +
      "their declared permissions before they can run.",
  },
};

export const EXAMPLE_MCP_TOOLS = [NIAGARA_TOOL];
