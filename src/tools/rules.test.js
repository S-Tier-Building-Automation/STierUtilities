import { test } from "node:test";
import assert from "node:assert/strict";
import { createInventory, createMemoryInventoryStorage } from "./inventory.js";
import {
  VAV_RULE_PACK,
  aggregateRuleRunStatus,
  equipMatchesRuleScope,
  evaluateRuleOnEquip,
  exportRulesCsv,
  exportRulesMarkdown,
  findPointForRoles,
  runRules,
} from "./rules.js";

function vavFixture() {
  const inv = createInventory({ storage: createMemoryInventoryStorage(), now: () => 1, idFactory: (t) => `${t}:id-1` });
  const site = inv.upsertEntity({ id: "site:main", type: "site", name: "Main" });
  const building = inv.upsertEntity({ id: "building:hq", type: "building", siteId: site.id, parentId: site.id, name: "HQ" });
  const floor = inv.upsertEntity({ id: "floor:1", type: "floor", siteId: site.id, buildingId: building.id, parentId: building.id, name: "Level 1" });
  const equip = inv.upsertEntity({
    id: "equip:vav-1",
    type: "equip",
    siteId: site.id,
    buildingId: building.id,
    floorId: floor.id,
    parentId: floor.id,
    name: "VAV-2801",
    templateId: "template:vav",
    tags: { equip: true, bacnet: true, vav: true, hvac: true },
    deviceInstance: 2801,
  });
  return { inv, equip };
}

test("equipMatchesRuleScope matches VAV tags and templates", () => {
  const rule = VAV_RULE_PACK[0];
  assert.equal(equipMatchesRuleScope({ templateId: "template:vav", tags: { vav: true } }, rule), true);
  assert.equal(equipMatchesRuleScope({ templateId: "template:ahu", tags: { ahu: true } }, rule), false);
});

test("findPointForRoles prefers explicit graphicRole and avoids alarm/delay names for airflow", () => {
  const { equip } = vavFixture();
  const points = [
    { id: "p1", equipId: equip.id, name: "AirflowAlarmDelay", type: "point" },
    { id: "p2", equipId: equip.id, name: "Box Flow", type: "point", tags: { graphicRole: "airflow" } },
    { id: "p3", equipId: equip.id, name: "Temperature_Room Unit Device", type: "point", tags: { graphicRole: "space-temperature" } },
  ];
  const airflow = findPointForRoles(equip, points, ["airflow", "cfm"], null, {
    excludeNamePatterns: ["alarm", "delay"],
    preferNamePatterns: ["box flow"],
  });
  assert.equal(airflow.id, "p2");
});

test("evaluateRuleOnEquip flags missing space temperature", () => {
  const { equip } = vavFixture();
  const rule = VAV_RULE_PACK.find((r) => r.id === "vav-missing-space-temp");
  const finding = evaluateRuleOnEquip(rule, equip, [], { now: () => 1 });
  assert.equal(finding.status, "fail");
  assert.match(finding.message, /Missing space temperature/i);
});

test("evaluateRuleOnEquip flags DAT out of range", () => {
  const { equip } = vavFixture();
  const points = [{
    id: "p-dat",
    equipId: equip.id,
    name: "DischargeTemperature",
    type: "point",
    tags: { graphicRole: "discharge-air-temp" },
    sourceRefs: ["bacnet:2801:0:1"],
    objectType: 0,
    instance: 1,
    deviceInstance: 2801,
  }];
  const rule = { ...VAV_RULE_PACK.find((r) => r.id === "vav-dat-out-of-range"), min: 45, max: 120 };
  const finding = evaluateRuleOnEquip(rule, equip, points, {
    now: () => 1,
    bacnetReads: new Map([["p-dat", { value: 17.5, display: "17.5" }]]),
  });
  assert.equal(finding.status, "fail");
  assert.equal(finding.value, 17.5);
});

test("evaluateRuleOnEquip flags low flow when fan is active", () => {
  const { equip } = vavFixture();
  const points = [
    { id: "p-flow", equipId: equip.id, name: "Box Flow", type: "point", tags: { graphicRole: "airflow" } },
    { id: "p-fan", equipId: equip.id, name: "Fan Operation", type: "point", tags: { graphicRole: "fan" } },
  ];
  const rule = VAV_RULE_PACK.find((r) => r.id === "vav-low-flow");
  const finding = evaluateRuleOnEquip(rule, equip, points, {
    now: () => 1,
    bacnetReads: new Map([
      ["p-flow", { value: 12, display: "12" }],
      ["p-fan", { value: 1, display: "active" }],
    ]),
  });
  assert.equal(finding.status, "fail");
});

test("runRules evaluates scoped VAV equipment with injected live values", async () => {
  const { inv, equip } = vavFixture();
  inv.upsertEntity({ id: "p-space", type: "point", equipId: equip.id, name: "Temperature_Room Unit Device", tags: { graphicRole: "space-temperature" } });
  inv.upsertEntity({ id: "p-dat", type: "point", equipId: equip.id, name: "DischargeTemperature", tags: { graphicRole: "discharge-air-temp" }, sourceRefs: ["bacnet:2801:0:2"], objectType: 0, instance: 2, deviceInstance: 2801 });
  inv.upsertEntity({ id: "p-flow", type: "point", equipId: equip.id, name: "Box Flow", tags: { graphicRole: "airflow" } });
  inv.upsertEntity({ id: "p-fan", type: "point", equipId: equip.id, name: "Fan Operation", tags: { graphicRole: "fan" } });

  const run = await runRules({
    inventory: inv,
    scope: { floorId: "floor:1" },
    liveValues: new Map([
      ["p-dat", { value: 72, display: "72" }],
      ["p-flow", { value: 240, display: "240" }],
      ["p-fan", { value: 0, display: "inactive" }],
    ]),
    now: () => 1,
  });

  assert.equal(run.type, "ruleRun");
  assert.equal(run.summary.equips, 1);
  assert.ok(run.findings.some((f) => f.ruleId === "vav-missing-space-temp" && f.status === "pass"));
  assert.ok(run.findings.some((f) => f.ruleId === "vav-dat-out-of-range" && f.status === "pass"));
  assert.equal(aggregateRuleRunStatus(run.findings), "pass");
});

test("runRules reads BACnet when live values are not provided", async () => {
  const { inv, equip } = vavFixture();
  inv.upsertEntity({
    id: "p-dat",
    type: "point",
    equipId: equip.id,
    name: "DischargeTemperature",
    tags: { graphicRole: "discharge-air-temp" },
    sourceRefs: ["bacnet:2801:0:3"],
    objectType: 0,
    instance: 3,
    deviceInstance: 2801,
  });
  const bacnet = {
    readPoint: async () => [{ id: 85, name: "present-value", values: [{ kind: "real", value: 30 }] }],
  };
  const run = await runRules({
    inventory: inv,
    rules: [VAV_RULE_PACK.find((r) => r.id === "vav-dat-out-of-range")],
    scope: { equipId: equip.id },
    bacnet,
    now: () => 1,
  });
  const dat = run.findings.find((f) => f.ruleId === "vav-dat-out-of-range");
  assert.equal(dat.status, "fail");
  assert.equal(dat.value, 30);
});

test("rule exports produce markdown and csv", async () => {
  const run = {
    name: "Test run",
    status: "fail",
    startedAt: "t0",
    finishedAt: "t1",
    summary: { equips: 1, fail: 1, warn: 0, pass: 2 },
    findings: [{
      equipId: "equip:vav-1",
      equipName: "VAV-2801",
      ruleId: "vav-low-flow",
      ruleName: "Low airflow while fan is active",
      severity: "medium",
      status: "fail",
      message: "Box Flow is 12 cfm (below 50 cfm).",
      value: 12,
      display: "12",
      at: "t1",
    }],
  };
  assert.match(exportRulesMarkdown({ entities: [] }, run), /Low airflow/);
  assert.match(exportRulesCsv(run), /vav-low-flow/);
});
