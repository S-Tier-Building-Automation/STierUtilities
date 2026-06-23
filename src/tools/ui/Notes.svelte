<script module>
  // Status pill is read synchronously by the shell (plugin-page header) and by
  // getSystemStatus (home/services cards), so it stays a plain exported function.
  import { createNotesService } from "../notes-service.js";

  function scopeFor(inv, scopeId) {
    if (!scopeId || !inv) return {};
    const e = inv.getEntity(scopeId);
    return e ? { [`${e.type}Id`]: scopeId } : {};
  }

  export function statusPill(getInventory, userState) {
    const inv = getInventory();
    if (!inv) return { label: "—", cls: "pill-muted" };
    const svc = createNotesService({ inventory: inv });
    const sv = userState.notesView || {};
    const open = svc.openCount(scopeFor(inv, sv.scopeId));
    return open ? { label: `${open} open`, cls: "pill-warn" } : { label: "Clear", cls: "pill-idle" };
  }
</script>

<script>
  // Notes — CRUD over the tested notes-service (notes are inventory entities).
  // Reactive on inventoryVersion so notes added/resolved anywhere refresh here.
  import { toast } from "../../ui/toast.js";
  import { inventoryVersion } from "../../platform/store.js";

  let { getInventory, userState, saveUserState, logTo } = $props();

  const STATUS_FILTERS = [
    { id: "all", label: "All" },
    { id: "open", label: "Open" },
    { id: "resolved", label: "Resolved" },
  ];

  if (!userState.notesView || typeof userState.notesView !== "object") {
    userState.notesView = { scopeId: "", filterStatus: "open" };
  }

  let draft = $state({ title: "", body: "", assignee: "", linkId: "" });
  let scopeId = $state(userState.notesView.scopeId || "");
  let filterStatus = $state(userState.notesView.filterStatus || "open");

  function patchView(patch) {
    Object.assign(userState.notesView, patch);
    saveUserState();
  }

  // The inventory instance is identity-stable, so downstream $derived keyed off
  // it would short-circuit on a bump. Read $inventoryVersion DIRECTLY inside each
  // data derived (and fetch a fresh service per call) so any model write refreshes.
  const svcNow = () => {
    const i = getInventory();
    return i ? createNotesService({ inventory: i }) : null;
  };
  const hasInventory = $derived(($inventoryVersion, !!getInventory()));
  const targets = $derived.by(() => {
    $inventoryVersion;
    const i = getInventory();
    return i ? i.listEntities({}).filter((e) => ["site", "building", "floor", "equip"].includes(e.type)) : [];
  });
  const rows = $derived.by(() => {
    $inventoryVersion;
    const i = getInventory();
    if (!i) return [];
    const scope = scopeFor(i, scopeId);
    const status = filterStatus === "all" ? undefined : filterStatus;
    return createNotesService({ inventory: i }).listNotes({ ...scope, status });
  });

  function noteLinks(linkId) {
    const i = getInventory();
    const e = linkId && i ? i.getEntity(linkId) : null;
    return e ? { [`${e.type}Id`]: linkId } : {};
  }

  function create() {
    const svc = svcNow();
    if (!svc) return;
    if (!draft.title.trim()) { toast("A title is required.", "warn"); return; }
    try {
      svc.createNote({ title: draft.title, body: draft.body, assignee: draft.assignee || null, ...noteLinks(draft.linkId) });
      draft = { title: "", body: "", assignee: "", linkId: "" };
      logTo("notes", "Note created.", "ok");
      toast("Note created.", "ok");
    } catch (err) {
      toast(String(err), "error");
    }
  }

  function resolve(id) { svcNow()?.resolveNote(id, { by: "me" }); toast("Resolved.", "ok"); }
  function reopen(id) { svcNow()?.reopenNote(id); }
  function assign(note) {
    const who = window.prompt("Assign to:", note.assignee || "");
    if (who != null) svcNow()?.assignNote(note.id, who.trim() || null);
  }
</script>

{#if !hasInventory}
  <div class="plugin-controls">
    <section class="plugin-section"><p class="empty-state">Building model is not available.</p></section>
  </div>
{:else}
  <div class="plugin-controls">
    <section class="plugin-section">
      <h3 class="note-h3">New note</h3>
      <label class="nm-field"><span class="nm-field-label">Title</span>
        <input class="nm-input" type="text" bind:value={draft.title} /></label>
      <label class="nm-field"><span class="nm-field-label">Details</span>
        <textarea class="nm-input note-textarea" rows="3" bind:value={draft.body}></textarea></label>
      <div class="note-row">
        <label class="nm-field"><span class="nm-field-label">Assignee</span>
          <input class="nm-input" type="text" bind:value={draft.assignee} placeholder="tech@site" /></label>
        <label class="nm-field"><span class="nm-field-label">Attach to</span>
          <select class="nm-input" bind:value={draft.linkId}>
            <option value="">— unattached —</option>
            {#each targets as t}<option value={t.id}>{t.type}: {t.name || t.id}</option>{/each}
          </select></label>
      </div>
      <div class="tool-actions"><button class="btn btn-primary btn-sm" onclick={create}>Add note</button></div>
    </section>

    <section class="plugin-section">
      <div class="note-filters">
        <label class="nm-field"><span class="nm-field-label">Scope</span>
          <select class="nm-input" bind:value={scopeId} onchange={() => patchView({ scopeId })}>
            <option value="">Whole model</option>
            {#each targets as t}<option value={t.id}>{t.type}: {t.name || t.id}</option>{/each}
          </select></label>
        <div class="note-status-tabs">
          {#each STATUS_FILTERS as f}
            <button class="btn btn-sm {filterStatus === f.id ? 'btn-primary' : 'btn-ghost'}"
              onclick={() => { filterStatus = f.id; patchView({ filterStatus: f.id }); }}>{f.label}</button>
          {/each}
        </div>
      </div>

      {#if rows.length}
        <div class="note-list">
          {#each rows as note (note.id)}
            <div class="note-card {note.status === 'resolved' ? 'is-resolved' : ''}">
              <div class="note-card-head">
                <span class="note-title">{note.name}</span>
                <span class="pill pill-sm {note.status === 'resolved' ? 'pill-muted' : 'pill-warn'}">{note.status || "open"}</span>
              </div>
              {#if note.body}<p class="note-body">{note.body}</p>{/if}
              <div class="note-meta muted small">
                {note.assignee ? `Assigned: ${note.assignee}` : "Unassigned"}{note.equipId ? ` · equip ${note.equipId}` : note.floorId ? ` · floor ${note.floorId}` : ""}
              </div>
              <div class="tool-actions">
                {#if note.status === "resolved"}
                  <button class="btn btn-ghost btn-sm" onclick={() => reopen(note.id)}>Reopen</button>
                {:else}
                  <button class="btn btn-ghost btn-sm" onclick={() => resolve(note.id)}>Resolve</button>
                {/if}
                <button class="btn btn-ghost btn-sm" onclick={() => assign(note)}>Assign</button>
              </div>
            </div>
          {/each}
        </div>
      {:else}
        <p class="empty-state">No notes for this scope yet.</p>
      {/if}
    </section>
  </div>
{/if}
