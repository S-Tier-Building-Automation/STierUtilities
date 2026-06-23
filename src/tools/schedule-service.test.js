import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTime,
  formatTime,
  createWeeklySchedule,
  addEntry,
  removeEntry,
  valueAt,
  findConflicts,
  createScheduleService,
} from "./schedule-service.js";

test("time parsing and formatting round-trip and reject garbage", () => {
  assert.equal(parseTime("08:30"), 510);
  assert.equal(parseTime("24:00"), null);
  assert.equal(parseTime("nope"), null);
  assert.equal(formatTime(510), "08:30");
});

test("weekly schedule entries stay sorted and immutable", () => {
  let w = createWeeklySchedule({ scheduleDefault: 65 });
  w = addEntry(w, "Mon", "18:00", 60);
  const before = JSON.parse(JSON.stringify(w));
  const w2 = addEntry(w, "Mon", "06:00", 70);
  assert.deepEqual(w, before, "addEntry does not mutate input");
  assert.deepEqual(w2.days[0].map((e) => e.time), ["06:00", "18:00"]);
});

test("valueAt applies BACnet step semantics with the schedule default", () => {
  let w = createWeeklySchedule({ scheduleDefault: 65 });
  w = addEntry(w, "Mon", "06:00", 70);
  w = addEntry(w, "Mon", "18:00", 60);
  assert.equal(valueAt(w, "Mon", "05:00"), 65, "before first entry -> default");
  assert.equal(valueAt(w, "Mon", "07:00"), 70, "after 06:00 -> 70");
  assert.equal(valueAt(w, "Mon", "20:00"), 60, "after 18:00 -> 60");
  assert.equal(valueAt(w, "Tue", "12:00"), 65, "empty day -> default");
});

test("removeEntry and conflict detection work", () => {
  let w = createWeeklySchedule();
  w = addEntry(w, "Wed", "09:00", 1);
  w.days[2].push({ time: "09:00", value: 2 }); // force a duplicate
  assert.deepEqual(findConflicts(w), [{ day: "Wed", time: "09:00" }]);
  w = removeEntry(w, "Wed", "09:00");
  assert.equal(w.days[2].length, 0);
});

test("service passes through to the bacnet schedule commands", async () => {
  const calls = [];
  const bacnet = {
    readSchedule: async (a) => { calls.push(["read", a]); return [{ name: "present-value" }]; },
    writeSchedule: async (a) => { calls.push(["write", a]); },
  };
  const svc = createScheduleService({ bacnet });
  await svc.read({ device: { address: "10.0.0.1" }, instance: 1 });
  await svc.command({ device: { address: "10.0.0.1" }, instance: 1, value: { kind: "real", value: 72 }, priority: 8 });
  assert.equal(calls[0][0], "read");
  assert.equal(calls[1][1].priority, 8);
});
