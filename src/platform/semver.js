// Minimal semver parsing + range satisfaction for the platform capability
// registry. Deliberately tiny — we only need the subset our tool manifests use:
// exact versions ("1.0", "1.2.0") for `provides`, and ranges ("^1.0", "~1.2",
// "1.0") for `requires`. No pre-release/build-metadata range logic.

/**
 * Parse a version string into a normalized {major, minor, patch} triple.
 * Accepts "1", "1.2", "1.2.3" (missing components default to 0).
 * Throws on malformed input.
 */
export function parseVersion(input) {
  if (typeof input !== "string") throw new TypeError(`version must be a string, got ${typeof input}`);
  const core = input.trim().split(/[-+]/, 1)[0]; // drop pre-release/build metadata
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(core);
  if (!m) throw new Error(`invalid version: "${input}"`);
  return { major: Number(m[1]), minor: Number(m[2] ?? 0), patch: Number(m[3] ?? 0) };
}

/**
 * Parse a range string into {op, major, minor, patch, hasMinor, hasPatch}.
 * op is one of "^", "~", "=" (exact). Plain "1.0" is treated as exact.
 */
export function parseRange(input) {
  if (typeof input !== "string") throw new TypeError(`range must be a string, got ${typeof input}`);
  const trimmed = input.trim();
  const opMatch = /^([\^~=])?(.*)$/.exec(trimmed);
  const op = opMatch[1] || "=";
  const core = opMatch[2].split(/[-+]/, 1)[0];
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(core);
  if (!m) throw new Error(`invalid range: "${input}"`);
  return {
    op,
    major: Number(m[1]),
    minor: Number(m[2] ?? 0),
    patch: Number(m[3] ?? 0),
    hasMinor: m[2] != null,
    hasPatch: m[3] != null,
  };
}

function cmp(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/** Compare two version strings: -1, 0, or 1. */
export function compareVersions(a, b) {
  const r = cmp(parseVersion(a), parseVersion(b));
  return r < 0 ? -1 : r > 0 ? 1 : 0;
}

/**
 * Does `version` satisfy `range`?
 *  - "^1.2.3": >=1.2.3 and <2.0.0 (major-locked). 0.x locks minor; 0.0.x locks patch (npm caret rules).
 *  - "~1.2.3": >=1.2.3 and <1.3.0 (minor-locked). "~1": >=1.0.0 and <2.0.0.
 *  - "1.2" / "=1.2": exact equality of the normalized triple.
 */
export function satisfies(version, range) {
  const v = parseVersion(version);
  const r = parseRange(range);
  const lower = { major: r.major, minor: r.minor, patch: r.patch };
  if (cmp(v, lower) < 0) return false; // must be >= the floor for ^ and ~

  if (r.op === "^") {
    if (r.major > 0) return v.major === r.major;
    if (r.minor > 0) return v.major === 0 && v.minor === r.minor;
    return v.major === 0 && v.minor === 0 && v.patch === r.patch;
  }
  if (r.op === "~") {
    if (r.hasMinor) return v.major === r.major && v.minor === r.minor;
    return v.major === r.major; // "~1" == major lock
  }
  // exact — honor the granularity the range actually specified
  if (v.major !== r.major) return false;
  if (r.hasMinor && v.minor !== r.minor) return false;
  if (r.hasPatch && v.patch !== r.patch) return false;
  return true;
}

/**
 * Given provider version strings and a range, return the highest version that
 * satisfies it, or null. Useful when several providers offer a capability.
 */
export function maxSatisfying(versions, range) {
  let best = null;
  for (const ver of versions) {
    if (satisfies(ver, range) && (best === null || compareVersions(ver, best) > 0)) {
      best = ver;
    }
  }
  return best;
}
