import { test } from "node:test";
import assert from "node:assert/strict";
import { createFleetService } from "./fleet-service.js";
import { createInventory, createMemoryInventoryStorage } from "./inventory.js";

function seedTwoSites() {
  const inventory = createInventory({ storage: createMemoryInventoryStorage(), now: () => 1 });
  inventory.upsertEntity({ id: "site:a", type: "site", name: "Alpha" });
  inventory.upsertEntity({ id: "building:a", type: "building", siteId: "site:a", name: "A1" });
  inventory.upsertEntity({ id: "equip:a1", type: "equip", siteId: "site:a", name: "AHU" });
  inventory.upsertEntity({ id: "point:a1", type: "point", siteId: "site:a", name: "RAT", tags: { overridden: true } });
  inventory.upsertEntity({ id: "site:b", type: "site", name: "Bravo" });
  inventory.upsertEntity({ id: "equip:b1", type: "equip", siteId: "site:b", name: "VAV" });
  return inventory;
}

test("site summaries count structure and overrides", () => {
  const inventory = seedTwoSites();
  const fleet = createFleetService({ inventory });
  const summaries = fleet.siteSummaries();
  const alpha = summaries.find((s) => s.siteId === "site:a");
  assert.equal(alpha.equip, 1);
  assert.equal(alpha.points, 1);
  assert.equal(alpha.overrides, 1, "overridden point counts as an override");
});

test("fleet totals roll up across sites and flag healthy sites", () => {
  const inventory = seedTwoSites();
  const fleet = createFleetService({
    inventory,
    openNotes: (scope) => (scope.siteId === "site:a" ? 2 : 0),
    openAlarms: () => 0,
  });
  const totals = fleet.fleetTotals();
  assert.equal(totals.sites, 2);
  assert.equal(totals.equip, 2);
  assert.equal(totals.openNotes, 2);
  // Bravo has no overrides/alarms -> healthy; Alpha has an override -> not.
  assert.equal(totals.healthySites, 1);
});
