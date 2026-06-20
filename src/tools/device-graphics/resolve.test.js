import { test } from "node:test";
import assert from "node:assert/strict";
import { createInventory, createMemoryInventoryStorage } from "../inventory.js";
import {
  applyGraphicAutoTags,
  formatGraphicDisplay,
  graphicForEquip,
  graphicForTemplate,
  resolveGraphicBindings,
  suggestGraphicAutoTags,
  effectiveDeviceView,
} from "./resolve.js";
import { VAV_REHEAT_SERIES } from "./definitions/vav-reheat-series.js";

function samplePoints() {
  const mk = (id, name, graphicRole = "") => ({
    id,
    type: "point",
    name,
    equipId: "equip:vav-1",
    tags: graphicRole ? { graphicRole } : {},
    objectType: 0,
    instance: Number(id.split(":").pop()),
    deviceInstance: 2801,
  });
  return [
    mk("point:1", "VAV-2801 RAT"),
    mk("point:2", "VAV-2801 DAT"),
    mk("point:3", "VAV-2801 DAMPER CMD"),
    mk("point:4", "VAV-2801 CFM"),
    mk("point:5", "VAV-2801 FAN CMD"),
    mk("point:6", "VAV-2801 REHEAT CMD"),
    mk("point:7", "VAV-2801 ZONE-T"),
    mk("point:8", "VAV-2801 OCC MODE"),
    mk("point:9", "VAV-2801 CLG-SP"),
  ];
}

test("graphicForTemplate resolves VAV template to vav-reheat-series", () => {
  const g = graphicForTemplate({ id: "template:vav", type: "template", name: "VAV" });
  assert.equal(g?.id, "vav-reheat-series");
});

test("resolveGraphicBindings auto-matches BACnet point names to graphic slots", () => {
  const points = samplePoints();
  const live = new Map([
    ["point:1", { value: 78.7, display: "78.7" }],
    ["point:3", { value: 85, display: "85" }],
    ["point:7", { value: 71.4, display: "71.4" }],
  ]);
  const bindings = resolveGraphicBindings({ graphic: VAV_REHEAT_SERIES, points, liveValues: live });
  const byId = Object.fromEntries(bindings.callouts.map((b) => [b.slotId, b]));
  assert.equal(byId["entering-air-temp"].pointId, "point:1");
  assert.equal(byId["damper-signal"].pointId, "point:3");
  assert.match(byId["damper-signal"].display, /85\s*%/);
  assert.ok(bindings.boundCount >= 3);
  assert.equal(bindings.status.find((s) => s.slotId === "space-temperature")?.pointId, "point:7");
});

test("explicit graphicRole tags win over name inference", () => {
  const points = [{
    id: "point:x",
    type: "point",
    name: "Something RAT",
    equipId: "equip:1",
    tags: { graphicRole: "airflow" },
    objectType: 0,
    instance: 1,
    deviceInstance: 1,
  }];
  const bindings = resolveGraphicBindings({ graphic: VAV_REHEAT_SERIES, points, liveValues: new Map([["point:x", { value: 120, display: "120" }]]) });
  const airflow = bindings.callouts.find((b) => b.slotId === "airflow");
  assert.equal(airflow?.pointId, "point:x");
  const rat = bindings.callouts.find((b) => b.slotId === "entering-air-temp");
  assert.equal(rat?.pointId, null);
});

test("formatGraphicDisplay adds units for temperature and percent", () => {
  assert.match(formatGraphicDisplay({ format: "temperature", display: "71.4" }), /71\.4\s*°F/);
  assert.equal(formatGraphicDisplay({ format: "percent", display: "85" }), "85 %");
  assert.equal(formatGraphicDisplay({ format: "onoff", display: "1" }), "ON");
  assert.equal(formatGraphicDisplay({ format: "onoff", display: "0" }), "OFF");
});

test("formatGraphicDisplay rounds raw floats without trailing zeros", () => {
  assert.equal(formatGraphicDisplay({ format: "percent", display: "53.699997" }), "53.7 %");
  assert.equal(formatGraphicDisplay({ format: "cfm", display: "240.0001" }), "240 cfm");
  assert.equal(formatGraphicDisplay({ format: "temperature", value: 17.049999 }), "17.05 °F");
});

test("suggestGraphicAutoTags and applyGraphicAutoTags tag unlabeled points", () => {
  const inv = createInventory({ storage: createMemoryInventoryStorage(), now: () => 1, idFactory: (t) => `${t}:id-1` });
  const equip = inv.upsertEntity({ id: "equip:vav-1", type: "equip", name: "VAV 2801", templateId: "template:vav", tags: { bacnet: true }, deviceInstance: 2801 });
  for (const p of samplePoints()) inv.upsertEntity({ ...p, equipId: equip.id });
  const suggestions = suggestGraphicAutoTags({ graphic: VAV_REHEAT_SERIES, points: inv.listEntities({ type: "point", equipId: equip.id }) });
  assert.ok(suggestions.length >= 4);
  const applied = applyGraphicAutoTags(inv, equip.id, VAV_REHEAT_SERIES);
  assert.ok(applied >= 4);
  const tagged = inv.listEntities({ type: "point", equipId: equip.id }).filter((p) => p.tags?.graphicRole);
  assert.ok(tagged.length >= 4);
});

test("effectiveDeviceView defaults to graphic when callouts are bound", () => {
  const bindings = resolveGraphicBindings({ graphic: VAV_REHEAT_SERIES, points: samplePoints() });
  assert.equal(effectiveDeviceView({ deviceView: "auto", graphic: VAV_REHEAT_SERIES, bindings }), "graphic");
  assert.equal(effectiveDeviceView({ deviceView: "auto", graphic: VAV_REHEAT_SERIES, bindings: { callouts: [], status: [] } }), "table");
  assert.equal(effectiveDeviceView({ deviceView: "table", graphic: VAV_REHEAT_SERIES, bindings }), "table");
});

test("graphicForEquip resolves from equip templateId", () => {
  const g = graphicForEquip({ templateId: "template:vav" });
  assert.equal(g?.id, "vav-reheat-series");
});
