// Pure helpers for identifying and selecting BACnet objects in the manager UI.
// Kept DOM-free so the selection contract (shared by the browse table, the COV
// stream, the property cache, and the detail pane) can be unit-tested.

/** Stable per-device object key: "objectType:instance" (e.g. "0:4"). */
export function bacnetObjectKey(o) {
  return `${o.objectType}:${o.instance}`;
}

/** Find the object matching a key in a list, or null when absent/empty. */
export function resolveBacnetObject(objects, key) {
  if (!key) return null;
  return (objects || []).find((o) => bacnetObjectKey(o) === key) || null;
}
