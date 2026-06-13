import { test } from "node:test";
import assert from "node:assert/strict";
import { createScheduler } from "./scheduler.js";

// A fake timer that records registrations but never auto-fires; tests drive jobs
// with runNow() for determinism.
function fakeTimer() {
  const registered = [];
  return {
    registered,
    every: (fn, ms) => {
      registered.push({ fn, ms });
      return registered.length - 1;
    },
    cancel: (token) => {
      registered[token] = null;
    },
  };
}

test("register validates its inputs", () => {
  const s = createScheduler({ timer: fakeTimer() });
  assert.throws(() => s.register("j", { intervalMs: 1000 }), /run\(\) function/);
  assert.throws(() => s.register("j", { intervalMs: 0, run: () => {} }), /positive intervalMs/);
});

test("runNow executes the job and counts runs", async () => {
  const s = createScheduler({ timer: fakeTimer() });
  let calls = 0;
  s.register("poll", { intervalMs: 1000, run: () => { calls++; } });
  await s.runNow("poll");
  await s.runNow("poll");
  assert.equal(calls, 2);
  assert.equal(s.list()[0].runs, 2);
});

test("immediate runs the job once at registration", async () => {
  const s = createScheduler({ timer: fakeTimer() });
  let calls = 0;
  s.register("p", { intervalMs: 1000, run: () => { calls++; }, immediate: true });
  // immediate tick is async; allow microtasks to settle
  await Promise.resolve();
  assert.equal(calls, 1);
});

test("errors are captured per job, not thrown", async () => {
  const s = createScheduler({ timer: fakeTimer() });
  s.register("bad", { intervalMs: 1000, run: () => { throw new Error("boom"); } });
  await s.runNow("bad");
  assert.match(s.list()[0].lastError, /boom/);
  assert.equal(s.list()[0].runs, 0);
});

test("a slow job does not overlap itself", async () => {
  const s = createScheduler({ timer: fakeTimer() });
  let active = 0;
  let maxActive = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  s.register("slow", {
    intervalMs: 1000,
    run: async () => { active++; maxActive = Math.max(maxActive, active); await gate; active--; },
  });
  const a = s.runNow("slow");
  const b = s.runNow("slow"); // should be skipped because the first is still running
  release();
  await Promise.all([a, b]);
  assert.equal(maxActive, 1);
});

test("register replaces an existing job and cancels the old timer", () => {
  const timer = fakeTimer();
  const s = createScheduler({ timer });
  s.register("j", { intervalMs: 1000, run: () => {} });
  s.register("j", { intervalMs: 2000, run: () => {} });
  assert.equal(timer.registered[0], null); // first token cancelled
  assert.equal(s.list().length, 1);
  assert.equal(s.list()[0].intervalMs, 2000);
});

test("unregister and stopAll remove jobs", () => {
  const s = createScheduler({ timer: fakeTimer() });
  s.register("a", { intervalMs: 1000, run: () => {} });
  s.register("b", { intervalMs: 1000, run: () => {} });
  assert.ok(s.unregister("a"));
  assert.ok(!s.unregister("a")); // already gone
  assert.equal(s.list().length, 1);
  s.stopAll();
  assert.equal(s.list().length, 0);
});

test("runNow on an unknown job throws", async () => {
  const s = createScheduler({ timer: fakeTimer() });
  await assert.rejects(() => s.runNow("nope"), /no such job/);
});
