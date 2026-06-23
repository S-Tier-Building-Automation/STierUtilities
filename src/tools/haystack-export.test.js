import { test } from "node:test";
import assert from "node:assert/strict";
import { toHaystackGrid, toZinc, entityToDict, normalizeBranding } from "./haystack-export.js";

const snapshot = {
  version: 1,
  entities: [
    { id: "site:1", type: "site", name: "HQ", tags: { site: true } },
    { id: "equip:1", type: "equip", name: "AHU-1", siteId: "site:1", tags: { equip: true, ahu: true } },
    { id: "point:1", type: "point", name: "RAT", siteId: "site:1", equipId: "equip:1", unit: "°F",
      sourceRefs: ["bacnet:1:0:4"], tags: { point: true, sensor: true } },
    { id: "template:vav", type: "template", name: "VAV" }, // non-haystack type, excluded
  ],
};

test("entityToDict encodes markers, refs, and tags Haystack-style", () => {
  const d = entityToDict(snapshot.entities[2]);
  assert.equal(d.id, "point:1");
  assert.equal(d.point, "m");
  assert.equal(d.sensor, "m");
  assert.equal(d.equipRef, "equip:1");
  assert.equal(d.unit, "°F");
  assert.equal(d.sourceRef, "bacnet:1:0:4");
});

test("toHaystackGrid emits a versioned grid of site/equip/point rows only", () => {
  const grid = toHaystackGrid(snapshot);
  assert.equal(grid.meta.ver, "3.0");
  assert.equal(grid.rows.length, 3, "template entity is excluded");
  const colNames = grid.cols.map((c) => c.name);
  assert.ok(colNames.includes("id"));
  assert.ok(colNames.includes("equipRef"));
});

test("toZinc renders refs, markers, and strings", () => {
  const zinc = toZinc(toHaystackGrid(snapshot));
  assert.match(zinc, /ver:"3\.0"/);
  assert.match(zinc, /@site:1/);
  assert.match(zinc, /"HQ"/);
});

test("branding normalizes name and validates color", () => {
  assert.deepEqual(normalizeBranding({ name: " Acme ", color: "#abc" }), { name: "Acme", color: "#abc", logoText: null });
  const def = normalizeBranding({ color: "not-a-color" });
  assert.equal(def.color, "#14b8a6");
  assert.equal(def.name, "S-Tier Utilities");
});
