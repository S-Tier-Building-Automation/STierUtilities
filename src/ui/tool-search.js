// Shared tool search/filter helpers for the library and header search.

/**
 * @param {Array<object>} tools
 * @param {string} query
 * @param {{ includeHidden?: boolean, isHidden?: (id: string) => boolean }} [opts]
 */
export function filterTools(tools, query, { includeHidden = false, isHidden = () => false } = {}) {
  const q = String(query || "").trim().toLowerCase();
  let list = includeHidden ? tools : tools.filter((t) => !isHidden(t.id));
  if (!q) return list;
  return list.filter((t) => {
    const hay = [
      t.name,
      t.tagline,
      t.description,
      t.manifest?.category,
      ...(t.manifest?.provides || []).map((p) => p.capability),
    ].filter(Boolean).join(" ").toLowerCase();
    return hay.includes(q);
  });
}

export function toolCategoryLabel(category) {
  if (category === "service") return "Services";
  if (category === "app") return "Apps";
  return "Other";
}

/**
 * @param {Array<object>} tools
 * @param {(id: string) => boolean} isHidden
 */
export function groupToolsByCategory(tools, isHidden) {
  const visible = tools.filter((t) => !isHidden(t.id));
  const groups = new Map();
  for (const tool of visible) {
    const key = tool.manifest?.category || "other";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(tool);
  }
  const order = ["app", "service", "other"];
  return order
    .filter((k) => groups.has(k))
    .map((k) => ({ key: k, label: toolCategoryLabel(k), tools: groups.get(k) }));
}
