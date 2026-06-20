import { test } from "node:test";
import assert from "node:assert/strict";
import { createGraphicsService } from "./graphics-service.js";
import { createInventory, createMemoryInventoryStorage } from "./inventory.js";

function seedVav() {
  const inv = createInventory({ storage: createMemoryInventoryStorage(), now: () => 1, idFactory: (t) => `${t}:id-${Math.random()}` });
  const equip = inv.upsertEntity({ id: "equip:vav-1", type: "equip", name: "VAV-1", templateId: "template:vav", tags: { bacnet: true }, deviceInstance: 10 });
  const a = inv.upsertEntity({ id: "point:a", type: "point", name: "Box Flow", equipId: equip.id, objectType: 2, instance: 1 });
  const b = inv.upsertEntity({ id: "point:b", type: "point", name: "Spare AV", equipId: equip.id, objectType: 2, instance: 2 });
  return { inv, equip, a, b };
}

test("setSlotBinding assigns a graphic role to a point", () => {
  const { inv } = seedVav();
  const graphics = createGraphicsService({ inventory: inv });
  graphics.setSlotBinding({ equipId: "equip:vav-1", slotId: "airflow", pointId: "point:a" });
  assert.equal(inv.getEntity("point:a").tags.graphicRole, "airflow");
});

test("setSlotBinding rebinds a slot, clearing the previous point's role", () => {
  const { inv } = seedVav();
  const graphics = createGraphicsService({ inventory: inv });
  graphics.setSlotBinding({ equipId: "equip:vav-1", slotId: "airflow", pointId: "point:a" });
  graphics.setSlotBinding({ equipId: "equip:vav-1", slotId: "airflow", pointId: "point:b" });
  assert.equal(inv.getEntity("point:a").tags.graphicRole, undefined);
  assert.equal(inv.getEntity("point:b").tags.graphicRole, "airflow");
});

test("setSlotBinding with no point clears the slot", () => {
  const { inv } = seedVav();
  const graphics = createGraphicsService({ inventory: inv });
  graphics.setSlotBinding({ equipId: "equip:vav-1", slotId: "airflow", pointId: "point:a" });
  graphics.setSlotBinding({ equipId: "equip:vav-1", slotId: "airflow", pointId: null });
  assert.equal(inv.getEntity("point:a").tags.graphicRole, undefined);
});
