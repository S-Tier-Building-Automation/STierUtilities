import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGridColumns, clampPaneWidth } from "./split-pane.js";

test("clampPaneWidth respects min and max", () => {
  assert.equal(clampPaneWidth(100, { min: 200, max: 480 }), 200);
  assert.equal(clampPaneWidth(600, { min: 200, max: 480 }), 480);
  assert.equal(clampPaneWidth(320, { min: 200, max: 480 }), 320);
  assert.equal(clampPaneWidth("310.7", { min: 200, max: 480 }), 311);
  assert.equal(clampPaneWidth(NaN, { min: 200, max: 480 }), 200);
});

test("buildGridColumns produces 2-pane layout", () => {
  assert.equal(buildGridColumns({ left: 280 }), "280px 8px minmax(0, 1fr)");
});

test("buildGridColumns produces 3-pane layout", () => {
  assert.equal(
    buildGridColumns({ left: 280, right: 360, threePane: true }),
    "280px 8px minmax(0, 1fr) 8px 360px",
  );
});
