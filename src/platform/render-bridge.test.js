import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { configureRenderBridge, renderAll, renderScoped, resetRenderBridge } from "./render-bridge.js";
import { registerScopedRenderer, clearScopedRenderers } from "./scope-registry.js";

beforeEach(() => {
  resetRenderBridge();
  clearScopedRenderers();
});

test("renderAll pushes status, then renders chrome and page", () => {
  const calls = [];
  configureRenderBridge({
    pushStatus: () => calls.push("status"),
    renderChrome: () => calls.push("chrome"),
    renderPage: () => calls.push("page"),
  });
  renderAll();
  assert.deepEqual(calls, ["status", "chrome", "page"]);
});

test('renderScoped("chrome") renders status+chrome but not the page', () => {
  const calls = [];
  configureRenderBridge({
    pushStatus: () => calls.push("status"),
    renderChrome: () => calls.push("chrome"),
    renderPage: () => calls.push("page"),
  });
  renderScoped("chrome");
  assert.deepEqual(calls, ["status", "chrome"]);
});

test('renderScoped("page") and default re-render only the page', () => {
  const calls = [];
  configureRenderBridge({ renderPage: () => calls.push("page") });
  renderScoped("page");
  renderScoped();
  assert.deepEqual(calls, ["page", "page"]);
});

test("renderScoped dispatches a registered scope to its renderer", () => {
  const calls = [];
  configureRenderBridge({ renderPage: () => calls.push("page") });
  registerScopedRenderer("building-workspace:model", () => calls.push("bw-model"));
  renderScoped("building-workspace:model");
  assert.deepEqual(calls, ["bw-model"]);
});

test("unknown scope falls back to a page re-render (not a silent no-op)", () => {
  const calls = [];
  configureRenderBridge({ renderPage: () => calls.push("page") });
  renderScoped("does-not-exist");
  assert.deepEqual(calls, ["page"]);
});

test('renderScoped("all") is renderAll', () => {
  const calls = [];
  configureRenderBridge({
    pushStatus: () => calls.push("status"),
    renderChrome: () => calls.push("chrome"),
    renderPage: () => calls.push("page"),
  });
  renderScoped("all");
  assert.deepEqual(calls, ["status", "chrome", "page"]);
});
