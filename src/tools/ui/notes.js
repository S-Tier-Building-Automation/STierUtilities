// Notes — a collaborative task/issue tracker tied to floors and equipment.
// Notes are inventory entities (type "note"), so they sync via SQLite + Supabase
// with the rest of the model. This page is CRUD over the tested notes service.

import { toast } from "../../ui/toast.js";
import { confirmAction } from "../../ui/modal.js";
import { createNotesService } from "../notes-service.js";

const STATUS_FILTERS = [
  { id: "all", label: "All" },
  { id: "open", label: "Open" },
  { id: "resolved", label: "Resolved" },
];

export function createNotesUi({
  el, logTo, renderAll, getInventory, userState, saveUserState,
}) {
  // Ephemeral create-form draft.
  let draft = { title: "", body: "", assignee: "", linkId: "" };

  function st() {
    if (!userState.notesView || typeof userState.notesView !== "object") {
      userState.notesView = { scopeId: "", filterStatus: "open" };
    }
    return userState.notesView;
  }
  function patchState(patch) {
    Object.assign(st(), patch);
    saveUserState();
  }

  function notesSvc() {
    const inventory = getInventory();
    return inventory ? createNotesService({ inventory }) : null;
  }

  /** Entities that a note can be attached to / scoped by. */
  function scopeTargets(inv) {
    return inv.listEntities({}).filter((e) => ["site", "building", "floor", "equip"].includes(e.type));
  }

  function scopeFor(scopeId) {
    if (!scopeId) return {};
    const inv = getInventory();
    const e = inv?.getEntity(scopeId);
    if (!e) return {};
    // Map the chosen entity to the matching list filter key.
    return { [`${e.type}Id`]: scopeId };
  }

  function noteLinks(linkId) {
    const inv = getInventory();
    const e = linkId ? inv?.getEntity(linkId) : null;
    if (!e) return {};
    return { [`${e.type}Id`]: linkId };
  }

  async function create() {
    const notes = notesSvc();
    if (!notes) return;
    if (!draft.title.trim()) { toast("A title is required.", "warn"); return; }
    try {
      notes.createNote({ title: draft.title, body: draft.body, assignee: draft.assignee || null, ...noteLinks(draft.linkId) });
      draft = { title: "", body: "", assignee: "", linkId: "" };
      logTo("notes", "Note created.", "ok");
      toast("Note created.", "ok");
      renderAll();
    } catch (err) {
      toast(String(err), "error");
    }
  }

  function createCard(inv) {
    const targets = scopeTargets(inv);
    return el("section", { class: "plugin-section" },
      el("h3", { class: "note-h3" }, "New note"),
      el("label", { class: "nm-field" }, el("span", { class: "nm-field-label" }, "Title"),
        el("input", { class: "nm-input", type: "text", value: draft.title, onchange: (e) => { draft.title = e.target.value; } })),
      el("label", { class: "nm-field" }, el("span", { class: "nm-field-label" }, "Details"),
        el("textarea", { class: "nm-input note-textarea", rows: "3", onchange: (e) => { draft.body = e.target.value; } }, draft.body)),
      el("div", { class: "note-row" },
        el("label", { class: "nm-field" }, el("span", { class: "nm-field-label" }, "Assignee"),
          el("input", { class: "nm-input", type: "text", value: draft.assignee, placeholder: "tech@site", onchange: (e) => { draft.assignee = e.target.value; } })),
        el("label", { class: "nm-field" }, el("span", { class: "nm-field-label" }, "Attach to"),
          el("select", { class: "nm-input", onchange: (e) => { draft.linkId = e.target.value; } },
            el("option", { value: "" }, "— unattached —"),
            ...targets.map((t) => el("option", { value: t.id, selected: draft.linkId === t.id ? "selected" : undefined }, `${t.type}: ${t.name || t.id}`))))),
      el("div", { class: "tool-actions" }, el("button", { class: "btn btn-primary btn-sm", onclick: create }, "Add note")));
  }

  function filterBar(inv) {
    const s = st();
    const targets = scopeTargets(inv);
    return el("div", { class: "note-filters" },
      el("label", { class: "nm-field" }, el("span", { class: "nm-field-label" }, "Scope"),
        el("select", { class: "nm-input", onchange: (e) => { patchState({ scopeId: e.target.value }); renderAll(); } },
          el("option", { value: "" }, "Whole model"),
          ...targets.map((t) => el("option", { value: t.id, selected: s.scopeId === t.id ? "selected" : undefined }, `${t.type}: ${t.name || t.id}`)))),
      el("div", { class: "note-status-tabs" }, ...STATUS_FILTERS.map((f) =>
        el("button", { class: `btn btn-sm${s.filterStatus === f.id ? " btn-primary" : " btn-ghost"}`,
          onclick: () => { patchState({ filterStatus: f.id }); renderAll(); } }, f.label))));
  }

  function noteRow(notes, note) {
    const resolved = note.status === "resolved";
    return el("div", { class: `note-card${resolved ? " is-resolved" : ""}` },
      el("div", { class: "note-card-head" },
        el("span", { class: "note-title" }, note.name),
        el("span", { class: `pill pill-sm ${resolved ? "pill-muted" : "pill-warn"}` }, note.status || "open")),
      note.body ? el("p", { class: "note-body" }, note.body) : null,
      el("div", { class: "note-meta muted small" },
        note.assignee ? `Assigned: ${note.assignee}` : "Unassigned",
        note.equipId ? ` · equip ${note.equipId}` : note.floorId ? ` · floor ${note.floorId}` : ""),
      el("div", { class: "tool-actions" },
        resolved
          ? el("button", { class: "btn btn-ghost btn-sm", onclick: () => { notes.reopenNote(note.id); renderAll(); } }, "Reopen")
          : el("button", { class: "btn btn-ghost btn-sm", onclick: () => { notes.resolveNote(note.id, { by: "me" }); toast("Resolved.", "ok"); renderAll(); } }, "Resolve"),
        el("button", { class: "btn btn-ghost btn-sm", onclick: async () => {
          const who = window.prompt("Assign to:", note.assignee || "");
          if (who != null) { notes.assignNote(note.id, who.trim() || null); renderAll(); }
        } }, "Assign")));
  }

  function listCard(notes, inv) {
    const s = st();
    const scope = scopeFor(s.scopeId);
    const status = s.filterStatus === "all" ? undefined : s.filterStatus;
    const rows = notes.listNotes({ ...scope, status });
    return el("section", { class: "plugin-section" },
      filterBar(inv),
      rows.length
        ? el("div", { class: "note-list" }, ...rows.map((n) => noteRow(notes, n)))
        : el("p", { class: "empty-state" }, "No notes for this scope yet."));
  }

  function renderPage() {
    const inv = getInventory();
    const notes = notesSvc();
    if (!inv || !notes) {
      return el("div", { class: "plugin-controls" },
        el("section", { class: "plugin-section" },
          el("p", { class: "empty-state" }, "Building model is not available.")));
    }
    return el("div", { class: "plugin-controls" }, createCard(inv), listCard(notes, inv));
  }

  function renderStatusPill() {
    const notes = notesSvc();
    if (!notes) return { label: "—", cls: "pill-muted" };
    const open = notes.openCount(scopeFor(st().scopeId));
    return open ? { label: `${open} open`, cls: "pill-warn" } : { label: "Clear", cls: "pill-idle" };
  }

  return { renderPage, renderStatusPill };
}
