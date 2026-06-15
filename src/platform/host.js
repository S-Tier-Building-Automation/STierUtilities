// The platform kernel: boots tools in dependency order and brokers the service
// bus. Each tool receives a *scoped* host that can only resolve the capabilities
// it declared in `requires` (least privilege) and only assert permissions it
// declared in `permissions` (and that were granted).

import { buildRegistry } from "./registry.js";
import { parseVersion } from "./semver.js";

const REF_RE = /^([a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*)\.v(\d+)$/;

/** Parse a capability ref like "netscan.v1" -> { name, major }, or "netscan" -> { name, major: null }. */
export function parseCapabilityRef(ref) {
  if (typeof ref !== "string") throw new TypeError("capability ref must be a string");
  const m = REF_RE.exec(ref);
  if (m) return { name: m[1], major: Number(m[2]) };
  return { name: ref, major: null };
}

/**
 * @param {object} opts
 * @param {object[]} opts.manifests
 * @param {Map<string, Function>} opts.factories  toolId -> async setup({ host }) (native tools)
 * @param {(toolId: string, permissions: string[]) => Set<string>} [opts.grant]
 *        Returns the granted subset of a tool's declared permissions. Default: grant all.
 * @param {(entry: object) => void} [opts.onLog]  optional sink for kernel/tool logs
 */
export function createKernel({ manifests, factories = new Map(), grant, onLog }) {
  const registry = buildRegistry(manifests);

  // capability name -> Map<major, { version, impl, providerId }>
  const impls = new Map();
  // toolId -> Set<granted permission>
  const grants = new Map();
  const booted = new Set();
  const logs = [];

  const log = (toolId, level, msg) => {
    const entry = { toolId, level, msg, ts: Date.now() };
    logs.push(entry);
    if (onLog) onLog(entry);
  };

  function grantsFor(m) {
    if (grant) return new Set(grant(m.id, m.permissions));
    return new Set(m.permissions); // default: native tools get everything they declare
  }

  function registerImpl(providerId, capability, version, impl) {
    const { major } = parseVersion(version);
    if (!impls.has(capability)) impls.set(capability, new Map());
    impls.get(capability).set(major, { version, impl, providerId });
  }

  // Build the scoped host handed to a single tool's setup().
  function scopedHost(m) {
    const resolutions = registry.resolutions.get(m.id) || [];
    const provided = new Set(m.provides.map((p) => p.capability));

    const resolutionFor = (name, major) =>
      resolutions.find(
        (r) =>
          r.capability === name &&
          r.providerId != null &&
          (major == null || parseVersion(r.providerVersion).major === major),
      );

    const lookup = (ref) => {
      const { name, major } = parseCapabilityRef(ref);
      const res = resolutionFor(name, major);
      if (!res) return { error: `tool "${m.id}" did not declare a (resolved) dependency on "${ref}"` };
      const byMajor = impls.get(name);
      const wantMajor = major != null ? major : parseVersion(res.providerVersion).major;
      const slot = byMajor && byMajor.get(wantMajor);
      if (!slot) return { error: `capability "${ref}" is not available yet (provider not booted)` };
      return { value: slot.impl };
    };

    return {
      manifest: m,

      /** Register a capability implementation this tool provides. */
      provide(capability, version, impl) {
        if (!provided.has(capability)) {
          throw new Error(`tool "${m.id}" tried to provide "${capability}" which is not in its manifest.provides`);
        }
        registerImpl(m.id, capability, version, impl);
        log(m.id, "info", `provides ${capability}@${version}`);
      },

      /** Resolve a required capability. Throws if undeclared/unavailable. */
      use(ref) {
        const r = lookup(ref);
        if (r.error) throw new Error(r.error);
        return r.value;
      },

      /** Resolve an optional capability. Returns null instead of throwing. */
      tryUse(ref) {
        const r = lookup(ref);
        return r.error ? null : r.value;
      },

      /** Is `ref` available to this tool right now? */
      has(ref) {
        return !lookup(ref).error;
      },

      /** Does this tool hold `permission` (declared AND granted)? */
      can(permission) {
        return (grants.get(m.id) || new Set()).has(permission);
      },

      /** Assert a permission; throws if not held. */
      requirePermission(permission) {
        if (!this.can(permission)) {
          throw new Error(`tool "${m.id}" lacks required permission "${permission}"`);
        }
      },

      log: (msg, level = "info") => log(m.id, level, msg),
    };
  }

  async function boot() {
    for (const id of registry.initOrder) {
      const m = registry.tools.get(id);
      grants.set(id, grantsFor(m));
      const factory = factories.get(id);
      if (!factory) {
        // A manifest with no factory is fine for non-native kinds (loaded elsewhere)
        // or pure metadata tools; just record it.
        log(id, "info", `no native factory (kind=${m.kind}); skipping setup`);
        booted.add(id);
        continue;
      }
      try {
        await factory(scopedHost(m));
        booted.add(id);
        log(id, "info", "booted");
      } catch (err) {
        log(id, "error", `setup failed: ${err && err.message ? err.message : err}`);
      }
    }
    return { booted: [...booted], errors: registry.errors, ok: registry.ok };
  }

  return {
    registry,
    boot,
    isBooted: (id) => booted.has(id),
    logs: () => logs,
    /** Get the scoped host for a booted tool (used by that tool's UI page). */
    hostFor(toolId) {
      const m = registry.tools.get(toolId);
      return m ? scopedHost(m) : null;
    },
    // Test/introspection helper: resolve a capability slot ({version,impl,providerId}) without a tool scope.
    _peek: peek,
    /**
     * Resolve a capability implementation without a tool scope — for first-party
     * UI pages that need a capability their tool *provides* (and so can't reach
     * via the scoped use(), which only resolves declared `requires`). Returns the
     * impl or null.
     */
    capability(ref) {
      const slot = peek(ref);
      return slot ? slot.impl : null;
    },
  };

  function peek(ref) {
    const { name, major } = parseCapabilityRef(ref);
    const byMajor = impls.get(name);
    if (!byMajor) return null;
    if (major != null) return byMajor.get(major) || null;
    const majors = [...byMajor.keys()].sort((a, b) => b - a);
    return majors.length ? byMajor.get(majors[0]) : null;
  }
}
