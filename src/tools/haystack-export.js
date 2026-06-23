// Open Haystack/Brick export — turns the internal model into a Project
// Haystack JSON grid so the platform is interoperable rather than a walled
// garden (a deliberate contrast to Niagara's closed Fox/Niagara stack). Pure and
// unit-tested; the REST surface just serves what this produces.

const HAYSTACK_VER = "3.0";

/** Map an internal entity type to its Haystack marker tag. */
function markerForType(type) {
  switch (type) {
    case "site": return "site";
    case "building": return "building";
    case "floor": return "floor";
    case "equip": return "equip";
    case "point": return "point";
    default: return null;
  }
}

/** Convert one inventory entity into a Haystack dict (row). */
export function entityToDict(entity) {
  const dict = { id: entity.id, dis: entity.name || entity.id };
  const marker = markerForType(entity.type);
  if (marker) dict[marker] = "m"; // Haystack JSON marker encoding
  // Hierarchy refs.
  if (entity.siteId) dict.siteRef = entity.siteId;
  if (entity.equipId) dict.equipRef = entity.equipId;
  // Carry through marker/value tags.
  for (const [k, v] of Object.entries(entity.tags || {})) {
    dict[k] = v === true ? "m" : v;
  }
  if (Array.isArray(entity.sourceRefs) && entity.sourceRefs.length) {
    dict.sourceRef = entity.sourceRefs[0];
  }
  if (entity.unit) dict.unit = entity.unit;
  return dict;
}

/**
 * Build a Project Haystack JSON grid from an inventory snapshot. Columns are the
 * union of keys present across rows (Haystack grids are column-sparse-friendly).
 */
export function toHaystackGrid(snapshot = {}) {
  const entities = Array.isArray(snapshot.entities) ? snapshot.entities : [];
  const rows = entities
    .filter((e) => markerForType(e.type))
    .map(entityToDict);
  const colNames = new Set(["id", "dis"]);
  for (const r of rows) for (const k of Object.keys(r)) colNames.add(k);
  return {
    meta: { ver: HAYSTACK_VER },
    cols: [...colNames].map((name) => ({ name })),
    rows,
  };
}

/** Minimal Zinc serialization of a grid (header + rows) for Haystack clients. */
export function toZinc(grid) {
  const cols = grid.cols.map((c) => c.name);
  const header = `ver:"${grid.meta.ver}"`;
  const colLine = cols.join(",");
  const rowLines = grid.rows.map((r) =>
    cols
      .map((c) => {
        const v = r[c];
        if (v == null) return "";
        if (v === "m") return "M";
        if (typeof v === "number") return String(v);
        if (c === "id" || c === "siteRef" || c === "equipRef") return `@${v}`;
        return `"${String(v).replace(/"/g, '\\"')}"`;
      })
      .join(","),
  );
  return [header, colLine, ...rowLines].join("\n");
}

const DEFAULT_BRAND = { name: "S-Tier Utilities", color: "#14b8a6", logoText: null };

/** Normalize a white-label branding config (used by reports + the served UI). */
export function normalizeBranding(input = {}) {
  return {
    name: typeof input.name === "string" && input.name.trim() ? input.name.trim() : DEFAULT_BRAND.name,
    color: /^#[0-9a-fA-F]{3,8}$/.test(input.color || "") ? input.color : DEFAULT_BRAND.color,
    logoText: typeof input.logoText === "string" && input.logoText.trim() ? input.logoText.trim() : null,
  };
}
