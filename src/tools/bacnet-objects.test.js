import { test } from "node:test";
import assert from "node:assert/strict";
import { bacnetObjectKey, resolveBacnetObject } from "./bacnet-objects.js";

const objects = [
  { objectType: 0, instance: 4, typeName: "analog-input" },
  { objectType: 2, instance: 3, typeName: "analog-value" },
  { objectType: 20, instance: 1, typeName: "trend-log" },
];

test("bacnetObjectKey is the device-scoped type:instance identity", () => {
  assert.equal(bacnetObjectKey({ objectType: 0, instance: 4 }), "0:4");
  assert.equal(bacnetObjectKey({ objectType: 2, instance: 3 }), "2:3");
});

test("resolveBacnetObject finds the object matching a key", () => {
  assert.deepEqual(resolveBacnetObject(objects, "2:3"), objects[1]);
  assert.deepEqual(resolveBacnetObject(objects, "20:1"), objects[2]);
});

test("resolveBacnetObject returns null for missing, empty, or absent keys", () => {
  assert.equal(resolveBacnetObject(objects, "9:9"), null);
  assert.equal(resolveBacnetObject(objects, null), null);
  assert.equal(resolveBacnetObject(objects, ""), null);
  assert.equal(resolveBacnetObject([], "0:4"), null);
  assert.equal(resolveBacnetObject(undefined, "0:4"), null);
});

test("a stale active key (object dropped from the list) resolves to null", () => {
  // Mirrors switching devices: the key lingers but the new object list lacks it.
  const next = [{ objectType: 1, instance: 7 }];
  assert.equal(resolveBacnetObject(next, "0:4"), null);
});
