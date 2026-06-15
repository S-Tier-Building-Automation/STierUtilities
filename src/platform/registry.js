// Capability registry + dependency resolver.
//
// Given a set of tool manifests, this builds the provider index, resolves every
// tool's `requires` against the providers (by semver), detects missing required
// capabilities and dependency cycles, and computes a topological init order so
// the kernel starts providers before the tools that consume them.

import { validateManifest, normalizeManifest } from "./manifest.js";
import { satisfies, compareVersions } from "./semver.js";

/**
 * @param {object[]} manifests
 * @returns {{
 *   tools: Map<string, object>,
 *   providers: Map<string, Array<{toolId: string, version: string}>>,
 *   resolutions: Map<string, Array<object>>,
 *   initOrder: string[],
 *   errors: string[],
 *   ok: boolean,
 * }}
 */
export function buildRegistry(manifests) {
  const errors = [];
  const tools = new Map();

  // 1. Validate + dedupe ids.
  for (const raw of manifests) {
    const { valid, errors: errs } = validateManifest(raw);
    if (!valid) {
      const id = raw && raw.id ? raw.id : "<unknown>";
      for (const msg of errs) errors.push(`[${id}] ${msg}`);
      continue;
    }
    if (tools.has(raw.id)) {
      errors.push(`[${raw.id}] duplicate tool id`);
      continue;
    }
    tools.set(raw.id, normalizeManifest(raw));
  }

  // 2. Provider index: capability name -> list of {toolId, version}.
  const providers = new Map();
  for (const [id, m] of tools) {
    for (const p of m.provides) {
      if (!providers.has(p.capability)) providers.set(p.capability, []);
      providers.get(p.capability).push({ toolId: id, version: p.version });
    }
  }

  // 3. Resolve each tool's requires.
  const resolutions = new Map();
  const edges = new Map(); // toolId -> Set<dependencyToolId>
  for (const id of tools.keys()) edges.set(id, new Set());

  for (const [id, m] of tools) {
    const resolved = [];
    for (const req of m.requires) {
      const candidates = (providers.get(req.capability) || [])
        .filter((c) => satisfies(c.version, req.version))
        .sort((a, b) => compareVersions(b.version, a.version)); // highest first
      const chosen = candidates[0] || null;

      if (!chosen && !req.optional) {
        const avail = (providers.get(req.capability) || []).map((c) => c.version);
        errors.push(
          `[${id}] unmet dependency: ${req.capability}@${req.version}` +
            (avail.length ? ` (available: ${avail.join(", ")})` : " (no providers)"),
        );
      }
      if (chosen && chosen.toolId !== id) {
        edges.get(id).add(chosen.toolId);
      }
      resolved.push({
        capability: req.capability,
        range: req.version,
        optional: Boolean(req.optional),
        providerId: chosen ? chosen.toolId : null,
        providerVersion: chosen ? chosen.version : null,
      });
    }
    resolutions.set(id, resolved);
  }

  // 4. Topological sort (Kahn) over the dependency edges. Edge a->b means
  //    "a depends on b", so b must init before a.
  const initOrder = topoSort(tools, edges, errors);

  return { tools, providers, resolutions, initOrder, errors, ok: errors.length === 0 };
}

function topoSort(tools, edges, errors) {
  // indegree counts how many *dependencies* each tool still has unresolved.
  const indegree = new Map();
  for (const id of tools.keys()) indegree.set(id, edges.get(id).size);

  // Ready = no outstanding dependencies. Sort for deterministic output.
  const ready = [...indegree].filter(([, d]) => d === 0).map(([id]) => id).sort();
  const order = [];

  // reverse adjacency: dependency -> [dependents]
  const dependents = new Map();
  for (const id of tools.keys()) dependents.set(id, []);
  for (const [id, deps] of edges) {
    for (const dep of deps) dependents.get(dep).push(id);
  }

  while (ready.length) {
    const id = ready.shift();
    order.push(id);
    for (const dep of dependents.get(id).sort()) {
      indegree.set(dep, indegree.get(dep) - 1);
      if (indegree.get(dep) === 0) {
        ready.push(dep);
        ready.sort();
      }
    }
  }

  if (order.length !== tools.size) {
    const stuck = [...tools.keys()].filter((id) => !order.includes(id));
    errors.push(`dependency cycle detected among: ${stuck.sort().join(", ")}`);
  }
  return order;
}
