import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeUserState, clampSidebarWidth } from "./user-state.js";

test("normalizeUserState preserves BACnet keys across a reload round-trip", () => {
  const stored = {
    bacnetManager: {
      discovery: { devices: [{ key: "d1" }], selectedDeviceKey: "d1", discoveryRan: true },
      objectColumnsVisible: [85, 111],
      importFloorId: "floor:1",
    },
    bacnetDiscoveryCache: [{ key: "d1", instance: 1001, address: "192.168.1.10" }],
    bacnetObjectPresets: { "AI present values": { q: "", types: ["analog-input"], min: "", max: "" } },
  };
  const once = normalizeUserState(stored);
  assert.deepEqual(once.bacnetManager, stored.bacnetManager);
  assert.deepEqual(once.bacnetDiscoveryCache, stored.bacnetDiscoveryCache);
  assert.deepEqual(once.bacnetObjectPresets, stored.bacnetObjectPresets);

  // Survive the real persistence cycle: JSON serialize to localStorage, parse, re-normalize.
  const reloaded = normalizeUserState(JSON.parse(JSON.stringify(once)));
  assert.deepEqual(reloaded.bacnetManager, stored.bacnetManager);
  assert.deepEqual(reloaded.bacnetDiscoveryCache, stored.bacnetDiscoveryCache);
  assert.deepEqual(reloaded.bacnetObjectPresets, stored.bacnetObjectPresets);
});

test("normalizeUserState preserves BMS app state across a reload round-trip", () => {
  const stored = {
    deviceGraphics: { selectedEquipId: "equip:vav-1", deviceView: "graphic", showUpdated: true },
    analytics: { datMin: "52", datMax: "118", flowMin: "60", siteId: "site:1", lastRunId: "ruleRun:9" },
    alarmConsole: { siteId: "site:1" },
  };
  const reloaded = normalizeUserState(JSON.parse(JSON.stringify(normalizeUserState(stored))));
  assert.deepEqual(reloaded.deviceGraphics, stored.deviceGraphics);
  assert.deepEqual(reloaded.analytics, stored.analytics);
  assert.deepEqual(reloaded.alarmConsole, stored.alarmConsole);
});

test("normalizeUserState defaults BMS app keys when absent", () => {
  const empty = normalizeUserState({});
  assert.equal(empty.deviceGraphics, null);
  assert.equal(empty.analytics, null);
  assert.equal(empty.alarmConsole, null);
});

test("normalizeUserState defaults BACnet keys when absent or malformed", () => {
  const empty = normalizeUserState({});
  assert.equal(empty.bacnetManager, null);
  assert.equal(empty.bacnetDiscoveryCache, null);
  assert.equal(empty.bacnetObjectPresets, null);

  // A non-array discovery cache is coerced to null rather than passed through,
  // since the drift classifier expects an array.
  assert.equal(normalizeUserState({ bacnetDiscoveryCache: { not: "array" } }).bacnetDiscoveryCache, null);
});

test("normalizeUserState leaves unrelated keys intact alongside the BACnet keys", () => {
  const s = normalizeUserState({ networkManager: { adapter: "Ethernet" }, bacnetManager: { importFloorId: "floor:9" } });
  assert.deepEqual(s.networkManager, { adapter: "Ethernet" });
  assert.deepEqual(s.bacnetManager, { importFloorId: "floor:9" });
});

test("normalizeUserState defaults sidebarWidth when absent", () => {
  assert.equal(normalizeUserState({}).sidebarWidth, 200);
});

test("normalizeUserState preserves sidebarWidth across reload", () => {
  const once = normalizeUserState({ sidebarWidth: 312 });
  assert.equal(once.sidebarWidth, 312);
  const reloaded = normalizeUserState(JSON.parse(JSON.stringify(once)));
  assert.equal(reloaded.sidebarWidth, 312);
});

test("normalizeUserState defaults home view and recent tools", () => {
  const s = normalizeUserState({});
  assert.equal(s.view, "home");
  assert.deepEqual(s.recentTools, []);
  assert.equal(s.librarySearch, "");
});

test("clampSidebarWidth enforces sidebar resizer bounds", () => {
  assert.equal(clampSidebarWidth(200), 200);
  assert.equal(clampSidebarWidth(312), 312);
  assert.equal(clampSidebarWidth(100), 160);
  assert.equal(clampSidebarWidth(500), 360);
  assert.equal(clampSidebarWidth("bad"), 200);
});
