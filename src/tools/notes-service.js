// Collaborative notes — a task/issue tracker tied to floors and equipment, one
// of FIN's stickiest features. Notes are first-class inventory entities
// (type "note"), so they ride the same SQLite + Supabase sync as the model and
// are shareable across users in an org with no extra plumbing.

const OPEN = "open";
const RESOLVED = "resolved";

/** @param {{ inventory: object, now?: () => number }} deps */
export function createNotesService({ inventory, now = () => Date.now() } = {}) {
  if (!inventory) throw new Error("notes service requires an inventory capability");

  function nowIso() {
    return new Date(now()).toISOString();
  }

  return {
    /** Create a note attached to an equip/floor/site (any subset of links). */
    createNote({ title, body = "", siteId, buildingId, floorId, equipId, assignee = null, author = null } = {}) {
      if (!title || !String(title).trim()) throw new Error("note requires a title");
      return inventory.upsertEntity({
        type: "note",
        name: String(title).trim(),
        body: String(body),
        status: OPEN,
        assignee,
        author,
        siteId, buildingId, floorId, equipId,
        tags: { note: true },
        postedAt: nowIso(),
      });
    },

    /** List notes, optionally scoped to an equip/floor/site and/or status. */
    listNotes({ equipId, floorId, siteId, buildingId, status } = {}) {
      let rows = inventory.listEntities({ type: "note", equipId, floorId, siteId, buildingId });
      if (status) rows = rows.filter((n) => (n.status || OPEN) === status);
      return rows.sort((a, b) => String(b.postedAt || "").localeCompare(String(a.postedAt || "")));
    },

    /** Mark a note resolved (records who/when). */
    resolveNote(id, { by = null } = {}) {
      const note = inventory.getEntity(id);
      if (!note || note.type !== "note") throw new Error(`note "${id}" not found`);
      return inventory.upsertEntity({ ...note, status: RESOLVED, resolvedBy: by, resolvedAt: nowIso() });
    },

    /** Reopen a resolved note. */
    reopenNote(id) {
      const note = inventory.getEntity(id);
      if (!note || note.type !== "note") throw new Error(`note "${id}" not found`);
      return inventory.upsertEntity({ ...note, status: OPEN, resolvedBy: null, resolvedAt: null });
    },

    /** Assign a note to a person (maintenance/tenant). */
    assignNote(id, assignee) {
      const note = inventory.getEntity(id);
      if (!note || note.type !== "note") throw new Error(`note "${id}" not found`);
      return inventory.upsertEntity({ ...note, assignee: assignee || null });
    },

    /** Count of open notes, for badges/rollups. */
    openCount(scope = {}) {
      return this.listNotes({ ...scope, status: OPEN }).length;
    },
  };
}
