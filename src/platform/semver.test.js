import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVersion, parseRange, compareVersions, satisfies, maxSatisfying } from "./semver.js";

test("parseVersion normalizes missing components", () => {
  assert.deepEqual(parseVersion("1"), { major: 1, minor: 0, patch: 0 });
  assert.deepEqual(parseVersion("1.2"), { major: 1, minor: 2, patch: 0 });
  assert.deepEqual(parseVersion("1.2.3"), { major: 1, minor: 2, patch: 3 });
  assert.deepEqual(parseVersion("1.2.3-beta"), { major: 1, minor: 2, patch: 3 });
});

test("parseVersion rejects garbage", () => {
  assert.throws(() => parseVersion("x.y"));
  assert.throws(() => parseVersion(""));
  assert.throws(() => parseVersion(1));
});

test("compareVersions orders correctly", () => {
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.2.0", "1.1.9"), 1);
  assert.equal(compareVersions("1.0.0", "2.0.0"), -1);
  assert.equal(compareVersions("1.0", "1.0.1"), -1);
});

test("caret ranges lock major (>=1)", () => {
  assert.ok(satisfies("1.0.0", "^1.0"));
  assert.ok(satisfies("1.9.9", "^1.0"));
  assert.ok(!satisfies("2.0.0", "^1.0"));
  assert.ok(!satisfies("0.9.0", "^1.0")); // below floor
});

test("caret ranges respect 0.x and 0.0.x npm rules", () => {
  assert.ok(satisfies("0.2.5", "^0.2"));
  assert.ok(!satisfies("0.3.0", "^0.2"));
  assert.ok(satisfies("0.0.3", "^0.0.3"));
  assert.ok(!satisfies("0.0.4", "^0.0.3"));
});

test("tilde ranges lock minor", () => {
  assert.ok(satisfies("1.2.0", "~1.2"));
  assert.ok(satisfies("1.2.9", "~1.2"));
  assert.ok(!satisfies("1.3.0", "~1.2"));
  assert.ok(satisfies("1.5.0", "~1")); // ~major == major lock
  assert.ok(!satisfies("2.0.0", "~1"));
});

test("exact ranges require equality", () => {
  assert.ok(satisfies("1.0.0", "1.0.0"));
  assert.ok(satisfies("1.0.0", "1.0")); // normalized triple equality
  assert.ok(!satisfies("1.0.1", "1.0.0"));
  assert.ok(satisfies("1.2.3", "=1.2.3"));
});

test("maxSatisfying picks the highest match", () => {
  assert.equal(maxSatisfying(["1.0.0", "1.4.0", "1.2.0", "2.0.0"], "^1.0"), "1.4.0");
  assert.equal(maxSatisfying(["2.0.0", "3.0.0"], "^1.0"), null);
});
