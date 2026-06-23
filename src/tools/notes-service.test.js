import { test } from "node:test";
import assert from "node:assert/strict";
import { createNotesService } from "./notes-service.js";
import { createInventory, createMemoryInventoryStorage } from "./inventory.js";

function svc() {
  const inventory = createInventory({ storage: createMemoryInventoryStorage(), now: () => 1 });
  return { inventory, notes: createNotesService({ inventory, now: () => 1 }) };
}

test("notes are inventory entities scoped to equipment", () => {
  const { notes } = svc();
  const n = notes.createNote({ title: "Stuck damper", body: "VAV-1 damper not moving", equipId: "equip:vav-1", assignee: "tech@site" });
  assert.equal(n.type, "note");
  assert.equal(n.status, "open");
  assert.equal(n.equipId, "equip:vav-1");
  const list = notes.listNotes({ equipId: "equip:vav-1" });
  assert.equal(list.length, 1);
  assert.equal(notes.openCount({ equipId: "equip:vav-1" }), 1);
});

test("notes resolve, reopen, and assign", () => {
  const { notes } = svc();
  const n = notes.createNote({ title: "Check sensor", floorId: "floor:2" });
  const resolved = notes.resolveNote(n.id, { by: "lead" });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.resolvedBy, "lead");
  assert.equal(notes.openCount({ floorId: "floor:2" }), 0);
  const reopened = notes.reopenNote(n.id);
  assert.equal(reopened.status, "open");
  const assigned = notes.assignNote(n.id, "tenant@suite-200");
  assert.equal(assigned.assignee, "tenant@suite-200");
});

test("createNote requires a title", () => {
  const { notes } = svc();
  assert.throws(() => notes.createNote({ title: "  " }));
});
