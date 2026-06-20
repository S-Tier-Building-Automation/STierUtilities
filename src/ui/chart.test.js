import { test } from "node:test";
import assert from "node:assert/strict";
import { niceExtent, projectSamples } from "./chart.js";

test("niceExtent pads flat lines symmetrically", () => {
  const e = niceExtent([42, 42, 42]);
  assert.ok(e.min < 42);
  assert.ok(e.max > 42);
  assert.equal(e.max - 42, 42 - e.min);
});

test("niceExtent adds margin on varying values", () => {
  const e = niceExtent([10, 20]);
  assert.ok(e.min < 10);
  assert.ok(e.max > 20);
});

test("projectSamples maps time and value to plot coordinates", () => {
  const samples = [
    { ts: 1000, value: 0 },
    { ts: 2000, value: 10 },
  ];
  const extent = niceExtent([0, 10]);
  const pts = projectSamples(samples, 200, 100, extent);
  assert.equal(pts.length, 2);
  assert.equal(pts[0].x, pts[0].x);
  assert.ok(pts[0].x < pts[1].x);
  assert.ok(pts[0].y > pts[1].y);
  assert.equal(pts[0].value, 0);
  assert.equal(pts[1].value, 10);
});

test("projectSamples handles a single sample time range", () => {
  const samples = [{ ts: 5000, value: 3 }];
  const extent = niceExtent([3]);
  const pts = projectSamples(samples, 120, 80, extent);
  assert.equal(pts.length, 1);
  assert.ok(Number.isFinite(pts[0].x));
  assert.ok(Number.isFinite(pts[0].y));
});

test("projectSamples returns empty for zero-sized plot", () => {
  assert.deepEqual(projectSamples([{ ts: 1, value: 1 }], 0, 0, { min: 0, max: 1 }), []);
});
