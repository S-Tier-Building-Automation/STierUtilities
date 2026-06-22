import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createGraphicDoc,
  addShape,
  updateShape,
  moveShape,
  removeShape,
  bindShape,
  docBindings,
  renderSvg,
  createGraphicsBuilder,
} from "./graphics-builder.js";
import { createInventory, createMemoryInventoryStorage } from "./inventory.js";

test("shape operations are immutable and normalize defaults", () => {
  const doc0 = createGraphicDoc({ name: "AHU-1" });
  const doc1 = addShape(doc0, { kind: "rect", x: 10, y: 20 });
  assert.equal(doc0.shapes.length, 0, "original doc is untouched");
  assert.equal(doc1.shapes.length, 1);
  const id = doc1.shapes[0].id;
  const doc2 = moveShape(doc1, id, 5, -5);
  assert.deepEqual([doc2.shapes[0].x, doc2.shapes[0].y], [15, 15]);
  const doc3 = updateShape(doc2, id, { props: { fill: "#f00" } });
  assert.equal(doc3.shapes[0].props.fill, "#f00");
  const doc4 = removeShape(doc3, id);
  assert.equal(doc4.shapes.length, 0);
});

test("binding a value shape renders the live value with unit + precision", () => {
  let doc = createGraphicDoc();
  doc = addShape(doc, { kind: "value", x: 0, y: 0, text: "—" });
  const shapeId = doc.shapes[0].id;
  doc = bindShape(doc, shapeId, { pointId: "point:rat", unit: "°F", precision: 1 });
  assert.deepEqual(docBindings(doc), [{ shapeId, pointId: "point:rat", unit: "°F", precision: 1 }]);
  const svg = renderSvg(doc, { values: { "point:rat": 72.349 } });
  assert.match(svg, /72\.3 °F/);
  assert.match(svg, /^<svg/);
});

test("renderSvg escapes text and draws primitive shapes", () => {
  let doc = createGraphicDoc({ width: 100, height: 50 });
  doc = addShape(doc, { kind: "rect", x: 1, y: 2, w: 10, h: 20 });
  doc = addShape(doc, { kind: "text", x: 5, y: 5, text: "A & <B>" });
  const svg = renderSvg(doc);
  assert.match(svg, /<rect x="1" y="2" width="10" height="20"/);
  assert.match(svg, /A &amp; &lt;B&gt;/);
});

test("builder persists docs as tagged template entities synced via inventory", () => {
  const inventory = createInventory({ storage: createMemoryInventoryStorage(), now: () => 1 });
  const builder = createGraphicsBuilder({ inventory });
  let doc = builder.createGraphicDoc({ name: "Custom VAV" });
  doc = builder.addShape(doc, { kind: "value", binding: { pointId: "point:1" } });
  const saved = builder.saveDoc(doc, { equipId: "equip:1" });
  assert.ok(saved.tags.customGraphic);
  const docs = builder.listDocs();
  assert.equal(docs.length, 1);
  assert.equal(docs[0].name, "Custom VAV");
  assert.equal(builder.loadDoc(saved.id).name, "Custom VAV");
});
