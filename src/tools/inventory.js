// Building inventory / lightweight Haystack model service.
// Local-first, pure, and storage-injected so tests can run without Tauri.

const ENTITY_TYPES = new Set(["site", "building", "floor", "equip", "point", "sourceRef", "tag", "template", "commissioningRun"]);
const BACNET_REF_RE = /^bacnet:(\d+):(\d+):(\d+)$/;
const NIAGARA_REF_RE = /^niagara:([^:]+):(.+)$/;

export const DEFAULT_TEMPLATES = [
  { id: "template:vav", type: "template", name: "VAV", tags: { equip: true, vav: true, hvac: true } },
  { id: "template:ahu", type: "template", name: "AHU", tags: { equip: true, ahu: true, hvac: true } },
  { id: "template:zone", type: "template", name: "Zone", tags: { equip: true, zone: true } },
  { id: "template:meter", type: "template", name: "Meter", tags: { equip: true, meter: true } },
];

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function nowIso(now) {
  return new Date(now()).toISOString();
}

function normalizeTags(tags) {
  if (!tags || typeof tags !== "object" || Array.isArray(tags)) return {};
  const out = {};
  for (const [k, v] of Object.entries(tags)) {
    const key = String(k || "").trim();
    // Skip prototype-polluting keys so a malicious/garbled tag can't alter the
    // object's behavior or skew tag/filter semantics.
    if (!key || key === "__proto__" || key === "constructor" || key === "prototype") continue;
    out[key] = v === "" ? true : v;
  }
  return out;
}

export function parseSourceRef(ref) {
  const s = String(ref || "").trim();
  let m = BACNET_REF_RE.exec(s);
  if (m) {
    return {
      kind: "bacnet",
      deviceInstance: Number(m[1]),
      objectType: Number(m[2]),
      instance: Number(m[3]),
    };
  }
  m = NIAGARA_REF_RE.exec(s);
  if (m) return { kind: "niagara", station: m[1], ord: m[2] };
  return null;
}

export function bacnetSourceRef(deviceInstance, objectType, instance) {
  return `bacnet:${Number(deviceInstance)}:${Number(objectType)}:${Number(instance)}`;
}

function normalizeSourceRefs(sourceRefs) {
  const refs = Array.isArray(sourceRefs) ? sourceRefs : sourceRefs ? [sourceRefs] : [];
  return [...new Set(refs.map((r) => String(r || "").trim()).filter((r) => r && parseSourceRef(r)))];
}

function defaultState() {
  return { version: 1, entities: DEFAULT_TEMPLATES.map(clone) };
}

export function createMemoryInventoryStorage(initial) {
  let state = clone(initial || defaultState());
  return {
    load: () => clone(state),
    save: (next) => { state = clone(next); },
  };
}

export function createBrowserInventoryStorage(key = "building_workspace.inventory.v1") {
  return {
    load() {
      if (!globalThis.localStorage) return null;
      try { return JSON.parse(globalThis.localStorage.getItem(key) || "null"); }
      catch (_) { return null; }
    },
    save(next) {
      if (globalThis.localStorage) globalThis.localStorage.setItem(key, JSON.stringify(next));
    },
    remove() {
      if (globalThis.localStorage) globalThis.localStorage.removeItem(key);
    },
  };
}

export function createUserStateInventoryStorage({
  getState,
  setInventory,
  legacyStorage = createBrowserInventoryStorage(),
} = {}) {
  if (typeof getState !== "function") throw new Error("inventory storage requires getState");
  if (typeof setInventory !== "function") throw new Error("inventory storage requires setInventory");
  return {
    load() {
      const scoped = getState() || {};
      if (scoped.inventory) return clone(scoped.inventory);
      if (scoped.inventoryLegacyMigrated) return null;

      const legacy = legacyStorage?.load?.();
      if (legacy) {
        setInventory(clone(legacy), { legacyMigrated: true });
        legacyStorage?.remove?.();
      }
      return clone(legacy);
    },
    save(next) {
      setInventory(clone(next), { legacyMigrated: true });
    },
  };
}

export function createInventory({ storage = createMemoryInventoryStorage(), now = () => Date.now(), idFactory } = {}) {
  let state = storage.load() || defaultState();
  if (!Array.isArray(state.entities)) state = defaultState();
  let ids = new Map(state.entities.map((e) => [e.id, e]));

  function persist() {
    state.entities = [...ids.values()].map(clone);
    storage.save(state);
  }

  function loadFromStorage() {
    state = storage.load() || defaultState();
    if (!Array.isArray(state.entities)) state = defaultState();
    ids = new Map(state.entities.map((e) => [e.id, e]));
    for (const t of DEFAULT_TEMPLATES) if (!ids.has(t.id)) ids.set(t.id, clone(t));
    persist();
  }

  function nextId(type) {
    if (idFactory) return idFactory(type);
    const uuid = globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    return `${type}:${uuid}`;
  }

  function entityWithSourceRefs(type, sourceRefs) {
    if (!sourceRefs.length) return null;
    return [...ids.values()].find((e) =>
      e.type === type && (e.sourceRefs || []).some((ref) => sourceRefs.includes(ref))) || null;
  }

  function normalizeEntity(entity) {
    if (!entity || typeof entity !== "object") throw new Error("inventory entity must be an object");
    const type = String(entity.type || "").trim();
    if (!ENTITY_TYPES.has(type)) throw new Error(`unsupported inventory entity type "${type}"`);
    const sourceRefs = normalizeSourceRefs(entity.sourceRefs);
    const existing = entity.id ? ids.get(entity.id) : entityWithSourceRefs(type, sourceRefs);
    const ts = nowIso(now);
    const normalized = {
      ...clone(existing || {}),
      ...clone(entity),
      type,
      id: entity.id || existing?.id || nextId(type),
      name: String(entity.name || existing?.name || entity.id || type).trim(),
      tags: normalizeTags(entity.tags ?? existing?.tags),
      sourceRefs: normalizeSourceRefs(entity.sourceRefs ?? existing?.sourceRefs),
      updatedAt: ts,
      createdAt: existing?.createdAt || entity.createdAt || ts,
    };
    if (!normalized.name) normalized.name = normalized.id;
    return normalized;
  }

  function templateById(templateId) {
    return ids.get(templateId) || DEFAULT_TEMPLATES.find((t) => t.id === templateId || t.id === `template:${templateId}`);
  }

  const api = {
    upsertEntity(entity) {
      const normalized = normalizeEntity(entity);
      ids.set(normalized.id, normalized);
      persist();
      return clone(normalized);
    },

    removeEntity(id) {
      const ok = ids.delete(id);
      if (ok) persist();
      return ok;
    },

    listEntities(filter = {}) {
      let rows = [...ids.values()];
      if (filter.type) rows = rows.filter((e) => e.type === filter.type);
      if (filter.siteId) rows = rows.filter((e) => e.siteId === filter.siteId || e.id === filter.siteId);
      if (filter.buildingId) rows = rows.filter((e) => e.buildingId === filter.buildingId || e.parentId === filter.buildingId || e.id === filter.buildingId);
      if (filter.floorId) rows = rows.filter((e) => e.floorId === filter.floorId || e.parentId === filter.floorId || e.id === filter.floorId);
      if (filter.equipId) rows = rows.filter((e) => e.equipId === filter.equipId || e.parentId === filter.equipId);
      if (filter.sourceRef) rows = rows.filter((e) => (e.sourceRefs || []).includes(filter.sourceRef));
      if (filter.sourceKind) rows = rows.filter((e) => (e.sourceRefs || []).some((r) => parseSourceRef(r)?.kind === filter.sourceKind));
      if (filter.tag) {
        const tag = filter.tag;
        rows = rows.filter((e) => typeof tag === "string"
          ? Object.prototype.hasOwnProperty.call(e.tags || {}, tag)
          : Object.entries(tag).every(([k, v]) => (e.tags || {})[k] === v));
      }
      const q = String(filter.q || "").trim().toLowerCase();
      if (q) {
        rows = rows.filter((e) =>
          [e.id, e.name, e.type, e.siteId, e.buildingId, e.floorId, e.equipId, e.parentId, ...(e.sourceRefs || []), ...Object.keys(e.tags || {})]
            .filter(Boolean)
            .some((v) => String(v).toLowerCase().includes(q)));
      }
      rows.sort((a, b) =>
        String(a.type || "").localeCompare(String(b.type || "")) ||
        String(a.name || "").localeCompare(String(b.name || "")));
      return rows.map(clone);
    },

    getEntity(id) {
      return clone(ids.get(id) || null);
    },

    linkSource(entityId, sourceRef) {
      const entity = ids.get(entityId);
      if (!entity) throw new Error(`inventory entity "${entityId}" not found`);
      if (!parseSourceRef(sourceRef)) throw new Error(`unsupported source ref "${sourceRef}"`);
      return api.upsertEntity({ ...entity, sourceRefs: [...(entity.sourceRefs || []), sourceRef] });
    },

    setTags(entityId, tags) {
      const entity = ids.get(entityId);
      if (!entity) throw new Error(`inventory entity "${entityId}" not found`);
      return api.upsertEntity({ ...entity, tags: normalizeTags(tags) });
    },

    applyTemplate(entityId, templateId) {
      const entity = ids.get(entityId);
      if (!entity) throw new Error(`inventory entity "${entityId}" not found`);
      const template = templateById(templateId);
      if (!template) throw new Error(`inventory template "${templateId}" not found`);
      return api.upsertEntity({
        ...entity,
        templateId: template.id,
        tags: { ...(entity.tags || {}), ...(template.tags || {}) },
      });
    },

    recordCommissioningRun(run) {
      return api.upsertEntity({
        ...run,
        type: "commissioningRun",
        id: run.id || nextId("commissioningRun"),
        name: run.name || `Commissioning ${nowIso(now)}`,
      });
    },

    exportSnapshot() {
      return {
        version: state.version || 1,
        exportedAt: nowIso(now),
        entities: [...ids.values()].map(clone),
      };
    },

    reload() {
      loadFromStorage();
      return api.exportSnapshot();
    },
  };

  // Ensure bundled templates exist after old snapshots load.
  loadFromStorage();
  return api;
}
