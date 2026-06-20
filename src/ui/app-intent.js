// Cross-app navigation intent. Building Workspace (and others) can set a scoped
// target before navigating to another app via pluginView(); the destination app
// reads (and clears) the intent on its first render to focus the same equipment
// or site. Kept tiny and module-global since navigation is single-threaded.

/** @type {Map<string, object>} */
const intents = new Map();

/** Stash a scope intent for a destination tool id. */
export function setAppIntent(toolId, data = {}) {
  intents.set(toolId, { ...data });
}

/** Read and clear the pending intent for a tool id (null if none). */
export function takeAppIntent(toolId) {
  const data = intents.get(toolId) || null;
  intents.delete(toolId);
  return data;
}
