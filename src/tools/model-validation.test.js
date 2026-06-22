import { test } from "node:test";
import assert from "node:assert/strict";
import { bacnetSourceRef, createInventory, createMemoryInventoryStorage } from "./inventory.js";
import {
  validateModel,
  exportValidationMarkdown,
  exportValidationCsv,
  VALIDATION_CHECKS,
} from "./model-validation.js";

const NOW = () => 1700000000000;

function findingsOf(run, checkId) {
  return run.findings.filter((f) => f.checkId === checkId);
}

// A small well-formed model: one site/building/floor, one VAV equip (templated,
// tagged) with two clean points. Used as the "no issues" baseline.
function cleanEntities() {
  return [
    { id: "template:vav", type: "template", name: "VAV", tags: { equip: true, vav: true } },
    { id: "site:a", type: "site", name: "Main", tags: { site: true } },
    { id: "bldg:a", type: "building", name: "HQ", siteId: "site:a", parentId: "site:a", tags: { building: true } },
    { id: "floor:1", type: "floor", name: "L1", siteId: "site:a", buildingId: "bldg:a", parentId: "bldg:a", tags: { floor: true } },
    { id: "equip:vav1", type: "equip", name: "VAV-1", siteId: "site:a", buildingId: "bldg:a", floorId: "floor:1", parentId: "floor:1", templateId: "template:vav", tags: { equip: true, vav: true } },
    { id: "point:rat", type: "point", name: "RAT", equipId: "equip:vav1", objectType: 0, unit: "°F", sourceRefs: [bacnetSourceRef(10, 0, 1)], tags: { point: true } },
    { id: "point:cmd", type: "point", name: "Damper Cmd", equipId: "equip:vav1", objectType: 1, unit: "%", sourceRefs: [bacnetSourceRef(10, 1, 1)], tags: { point: true } },
  ];
}

test("a well-formed model passes with full coverage and no findings", () => {
  const run = validateModel({ entities: cleanEntities(), now: NOW });
  assert.equal(run.type, "modelValidation");
  assert.equal(run.status, "pass");
  assert.equal(run.findings.length, 0);
  assert.equal(run.coverage.points, 2);
  assert.equal(run.coverage.pct.pointsWithSourceRef, 100);
  assert.equal(run.coverage.pct.analogWithUnit, 100);
  assert.equal(run.coverage.pct.equipsWithPoints, 100);
  assert.equal(run.coverage.pct.equipsWithTemplate, 100);
});

test("dangling references to missing site/equip/template are flagged as failures", () => {
  const entities = [
    { id: "equip:x", type: "equip", name: "Orphan", siteId: "site:missing", templateId: "template:ghost", tags: { equip: true } },
  ];
  const run = validateModel({ entities, now: NOW });
  const f = findingsOf(run, "dangling-reference");
  const fields = f.map((x) => x.detail.field).sort();
  assert.deepEqual(fields, ["siteId", "templateId"]);
  assert.equal(run.status, "fail");
});

test("two points sharing a source reference are reported once with the full set", () => {
  const ref = bacnetSourceRef(10, 0, 1);
  const entities = [
    { id: "equip:e", type: "equip", name: "E", tags: { equip: true } },
    { id: "point:a", type: "point", name: "A", equipId: "equip:e", objectType: 0, unit: "°F", sourceRefs: [ref], tags: { point: true } },
    { id: "point:b", type: "point", name: "B", equipId: "equip:e", objectType: 0, unit: "°F", sourceRefs: [ref], tags: { point: true } },
  ];
  const run = validateModel({ entities, now: NOW });
  const dup = findingsOf(run, "duplicate-source-ref");
  assert.equal(dup.length, 1);
  assert.deepEqual(dup[0].detail.pointIds.sort(), ["point:a", "point:b"]);
  assert.equal(run.status, "fail");
});

test("a point with no equip and missing markers/units is flagged", () => {
  const entities = [
    // analog point, no equipId, no 'point' tag, no unit, unnamed
    { id: "point:loose", type: "point", objectType: 0, sourceRefs: [bacnetSourceRef(5, 0, 1)] },
  ];
  const run = validateModel({ entities, now: NOW });
  assert.equal(findingsOf(run, "point-without-equip").length, 1);
  assert.equal(findingsOf(run, "point-missing-marker").length, 1);
  assert.equal(findingsOf(run, "analog-point-no-unit").length, 1);
  assert.equal(findingsOf(run, "entity-unnamed").length, 1);
});

test("binary points are not asked for engineering units", () => {
  const entities = [
    { id: "equip:e", type: "equip", name: "E", tags: { equip: true }, templateId: "template:vav" },
    { id: "point:bo", type: "point", name: "Fan", equipId: "equip:e", objectType: 4, sourceRefs: [bacnetSourceRef(5, 4, 1)], tags: { point: true } },
  ];
  const run = validateModel({ entities, now: NOW });
  assert.equal(findingsOf(run, "analog-point-no-unit").length, 0);
});

test("empty equipment and missing templates are info/warn coverage gaps", () => {
  const entities = [
    { id: "equip:empty", type: "equip", name: "Shell", tags: { equip: true } },
  ];
  const run = validateModel({ entities, now: NOW });
  assert.equal(findingsOf(run, "equip-no-points").length, 1);
  assert.equal(findingsOf(run, "equip-no-template").length, 1);
  assert.equal(run.coverage.pct.equipsWithPoints, 0);
});

test("device equipment is exempt from the template-coverage check", () => {
  const entities = [
    { id: "equip:dev", type: "equip", name: "Device 10", deviceInstance: 10, tags: { equip: true, device: true } },
    { id: "point:p", type: "point", name: "P", equipId: "equip:dev", objectType: 0, unit: "°F", sourceRefs: [bacnetSourceRef(10, 0, 1)], tags: { point: true } },
  ];
  const run = validateModel({ entities, now: NOW });
  assert.equal(findingsOf(run, "equip-no-template").length, 0);
});

test("manual points (no source ref) surface as info, not failures", () => {
  const entities = [
    { id: "template:vav", type: "template", name: "VAV", tags: { equip: true, vav: true } },
    { id: "equip:e", type: "equip", name: "E", tags: { equip: true }, templateId: "template:vav" },
    { id: "point:manual", type: "point", name: "Manual setpoint", equipId: "equip:e", tags: { point: true } },
  ];
  const run = validateModel({ entities, now: NOW });
  const info = findingsOf(run, "point-no-source-ref");
  assert.equal(info.length, 1);
  assert.equal(info[0].status, "info");
  // info-only models are not failures or warnings
  assert.equal(run.status, "pass");
});

test("scope restricts findings and coverage to one equip subtree", () => {
  const entities = [
    ...cleanEntities(),
    { id: "equip:vav2", type: "equip", name: "VAV-2", siteId: "site:a", buildingId: "bldg:a", floorId: "floor:1", parentId: "floor:1", tags: { equip: true } },
  ];
  const all = validateModel({ entities, now: NOW });
  assert.equal(findingsOf(all, "equip-no-points").length, 1); // VAV-2 is empty

  const scoped = validateModel({ entities, scope: { equipId: "equip:vav1" }, now: NOW });
  assert.equal(scoped.findings.length, 0); // VAV-2 is out of scope
  assert.equal(scoped.coverage.equips, 1);
});

test("validateModel accepts an inventory instance and reads its snapshot", () => {
  const inv = createInventory({ storage: createMemoryInventoryStorage(), now: NOW });
  inv.upsertEntity({ id: "equip:empty", type: "equip", name: "Shell", tags: { equip: true } });
  const run = validateModel({ inventory: inv, now: NOW });
  assert.equal(findingsOf(run, "equip-no-points").length, 1);
});

test("checkIds restricts which checks run", () => {
  const entities = [{ id: "point:loose", type: "point", objectType: 0 }];
  const run = validateModel({ entities, checkIds: ["analog-point-no-unit"], now: NOW });
  assert.equal(run.summary.checks, 1);
  assert.equal(run.findings.every((f) => f.checkId === "analog-point-no-unit"), true);
});

test("markdown and csv exports include coverage and findings", () => {
  const run = validateModel({ entities: [{ id: "equip:empty", type: "equip", name: "Shell", tags: { equip: true } }], now: NOW });
  const md = exportValidationMarkdown(run);
  assert.match(md, /## Coverage/);
  assert.match(md, /Equipment with points/);
  assert.match(md, /Shell/);
  const csv = exportValidationCsv(run);
  assert.match(csv, /^category,checkId,checkName/);
  assert.match(csv, /equip-no-points/);
});

test("every check descriptor is well-formed", () => {
  for (const c of VALIDATION_CHECKS) {
    assert.ok(c.id && c.name && c.category, `check ${c.id} has metadata`);
    assert.ok(["fail", "warn", "info"].includes(c.status), `check ${c.id} has a valid status`);
    assert.equal(typeof c.run, "function");
  }
});
