// Driver SDK — formalizes what makes a tool a "protocol driver" on top of the
// existing capability/manifest/grants kernel, so integrators and third parties
// can add protocols (SNMP, M-Bus, KNX, OPC-UA) the same way bacnet-core and
// modbus-core do, without us writing every driver. This is the contract a driver
// marketplace validates against.

import { validateManifest } from "../platform/manifest.js";

/** A driver provides a read capability and holds a network permission. */
const READ_CAP_RE = /\.read$/;

function isNetworkPermission(p) {
  return typeof p === "string" && p.startsWith("network.");
}

/** The capabilities a manifest provides that qualify as driver capabilities. */
export function driverCapabilities(manifest) {
  const provides = Array.isArray(manifest?.provides) ? manifest.provides : [];
  return provides.map((p) => p.capability).filter((c) => READ_CAP_RE.test(c || ""));
}

/** Is this manifest a protocol driver? */
export function isDriverManifest(manifest) {
  const perms = Array.isArray(manifest?.permissions) ? manifest.permissions : [];
  return driverCapabilities(manifest).length > 0 && perms.some(isNetworkPermission);
}

/**
 * Validate a driver manifest: it must be a valid manifest, be native or mcp,
 * provide at least one read capability, and request a network permission.
 * Returns { valid, errors }.
 */
export function validateDriverManifest(manifest) {
  const base = validateManifest(manifest);
  const errors = [...base.errors];
  if (manifest && manifest.kind !== "native" && manifest.kind !== "mcp") {
    errors.push(`driver kind must be native or mcp (got ${JSON.stringify(manifest.kind)})`);
  }
  if (manifest && driverCapabilities(manifest).length === 0) {
    errors.push('a driver must provide at least one read capability (e.g. "<protocol>.read")');
  }
  const perms = Array.isArray(manifest?.permissions) ? manifest.permissions : [];
  if (manifest && !perms.some(isNetworkPermission)) {
    errors.push("a driver must request a network.* permission");
  }
  return { valid: errors.length === 0, errors };
}

/** List the installed drivers from a manifest set, with a short descriptor. */
export function listDrivers(manifests = []) {
  return manifests.filter(isDriverManifest).map(describeDriver);
}

/** A marketplace/catalog descriptor for one driver. */
export function describeDriver(manifest) {
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    kind: manifest.kind,
    capabilities: driverCapabilities(manifest),
    transports: (manifest.permissions || []).filter(isNetworkPermission),
    emoji: manifest.ui?.emoji || "🔌",
    tagline: manifest.ui?.tagline || "",
  };
}
