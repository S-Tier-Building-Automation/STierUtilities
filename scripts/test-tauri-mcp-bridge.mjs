#!/usr/bin/env node
/** One-shot MCP stdio client: driver_session status against localhost bridge. */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const proc = spawn("npx", ["-y", "@hypothesi/tauri-mcp-server"], {
  stdio: ["pipe", "pipe", "inherit"],
  shell: true,
});

const rl = createInterface({ input: proc.stdout });
let buf = "";
let nextId = 1;
const pending = new Map();

function send(method, params = {}) {
  const id = nextId++;
  const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  proc.stdin.write(msg + "\n");
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => reject(new Error(`timeout: ${method}`)), 15000);
  });
}

rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
});

(async () => {
  await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "bridge-test", version: "1.0" },
  });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const result = await send("tools/call", {
    name: "driver_session",
    arguments: { action: "start", host: "127.0.0.1", port: 9223 },
  });
  console.log("DRIVER_SESSION_START:", JSON.stringify(result, null, 2));
  const status = await send("tools/call", {
    name: "driver_session",
    arguments: { action: "status" },
  });
  console.log("DRIVER_SESSION_STATUS:", JSON.stringify(status, null, 2));
  proc.kill();
  process.exit(0);
})().catch((err) => {
  console.error("MCP_TEST_FAILED:", err.message);
  proc.kill();
  process.exit(1);
});
