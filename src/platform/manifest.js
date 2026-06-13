// Runtime validation of tool manifests. Mirrors docs/schemas/tool-manifest.schema.json
// so the kernel can reject malformed first- or third-party tools at load time
// (we can't rely on a JSON-schema validator being bundled in the webview).

import { parseVersion, parseRange } from "./semver.js";

export const API_VERSION = "1";

export const KINDS = ["native", "mcp", "webview"];

export const PERMISSIONS = new Set([
  "network.udp",
  "network.tcp",
  "network.raw",
  "timeseries.write",
  "timeseries.read",
  "scheduler.register",
  "inventory.write",
  "inventory.read",
  "fs.appdata",
  "fs.userpick",
  "process.spawn",
  "input.inject",
  "elevation.request",
]);

const ID_RE = /^[a-z][a-z0-9-]*$/;
const CAP_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+].*)?$/;

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Validate a manifest object. Returns { valid: boolean, errors: string[] }.
 * Does not throw — the kernel decides what to do with an invalid manifest.
 */
export function validateManifest(manifest) {
  const errors = [];
  const e = (msg) => errors.push(msg);

  if (!isPlainObject(manifest)) {
    return { valid: false, errors: ["manifest must be an object"] };
  }

  // --- required scalars ---
  if (typeof manifest.id !== "string" || !ID_RE.test(manifest.id)) {
    e(`id must be kebab-case matching ${ID_RE} (got ${JSON.stringify(manifest.id)})`);
  }
  if (typeof manifest.name !== "string" || manifest.name.length === 0) {
    e("name is required and must be a non-empty string");
  }
  if (typeof manifest.version !== "string" || !SEMVER_RE.test(manifest.version)) {
    e(`version must be semver (got ${JSON.stringify(manifest.version)})`);
  }
  if (manifest.apiVersion !== API_VERSION) {
    e(`apiVersion must be "${API_VERSION}" (got ${JSON.stringify(manifest.apiVersion)})`);
  }
  if (!KINDS.includes(manifest.kind)) {
    e(`kind must be one of ${KINDS.join(", ")} (got ${JSON.stringify(manifest.kind)})`);
  }

  // --- provides ---
  if (manifest.provides != null) {
    if (!Array.isArray(manifest.provides)) {
      e("provides must be an array");
    } else {
      manifest.provides.forEach((p, i) => {
        if (!isPlainObject(p)) return e(`provides[${i}] must be an object`);
        if (!CAP_RE.test(p.capability ?? "")) e(`provides[${i}].capability invalid: ${JSON.stringify(p.capability)}`);
        try {
          parseVersion(p.version);
        } catch {
          e(`provides[${i}].version invalid: ${JSON.stringify(p.version)}`);
        }
      });
    }
  }

  // --- requires ---
  if (manifest.requires != null) {
    if (!Array.isArray(manifest.requires)) {
      e("requires must be an array");
    } else {
      manifest.requires.forEach((r, i) => {
        if (!isPlainObject(r)) return e(`requires[${i}] must be an object`);
        if (!CAP_RE.test(r.capability ?? "")) e(`requires[${i}].capability invalid: ${JSON.stringify(r.capability)}`);
        try {
          parseRange(r.version);
        } catch {
          e(`requires[${i}].version invalid range: ${JSON.stringify(r.version)}`);
        }
        if (r.optional != null && typeof r.optional !== "boolean") {
          e(`requires[${i}].optional must be a boolean`);
        }
      });
    }
  }

  // --- permissions ---
  if (manifest.permissions != null) {
    if (!Array.isArray(manifest.permissions)) {
      e("permissions must be an array");
    } else {
      manifest.permissions.forEach((p, i) => {
        if (!PERMISSIONS.has(p)) e(`permissions[${i}] unknown: ${JSON.stringify(p)}`);
      });
    }
  }

  // --- kind-specific entry ---
  if (manifest.kind === "mcp") {
    const entry = manifest.entry;
    if (!isPlainObject(entry)) {
      e("mcp tools require an entry object");
    } else {
      if (!["stdio", "http", "sse"].includes(entry.transport)) {
        e(`mcp entry.transport must be stdio|http|sse (got ${JSON.stringify(entry.transport)})`);
      }
      if (entry.transport === "stdio" && typeof entry.command !== "string") {
        e("mcp stdio entry requires a command");
      }
      if ((entry.transport === "http" || entry.transport === "sse") && typeof entry.url !== "string") {
        e("mcp http/sse entry requires a url");
      }
    }
  }
  if (manifest.kind === "webview") {
    if (!isPlainObject(manifest.entry) || typeof manifest.entry.page !== "string") {
      e("webview tools require an entry.page");
    }
  }

  return { valid: errors.length === 0, errors };
}

/** Convenience: normalize a manifest, filling array defaults. Assumes it's already valid. */
export function normalizeManifest(manifest) {
  return {
    ...manifest,
    provides: manifest.provides ?? [],
    requires: manifest.requires ?? [],
    permissions: manifest.permissions ?? [],
    dashboards: manifest.dashboards ?? [],
    ui: manifest.ui ?? {},
  };
}
