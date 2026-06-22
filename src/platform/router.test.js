import { test } from "node:test";
import assert from "node:assert/strict";
import { get } from "svelte/store";
import {
  viewToRoute,
  routeToView,
  route,
  activeToolId,
  activeNav,
  breadcrumbModel,
  setRouteFromView,
  currentRouteView,
} from "./router.js";

test("viewToRoute maps built-in views and plugin views", () => {
  assert.deepEqual(viewToRoute("home"), { name: "home", params: {} });
  assert.deepEqual(viewToRoute("activity"), { name: "activity", params: {} });
  assert.deepEqual(viewToRoute("plugin:bacnet-manager"), {
    name: "tool",
    params: { toolId: "bacnet-manager" },
  });
});

test("viewToRoute falls back to home for unknown/garbage views", () => {
  assert.deepEqual(viewToRoute("nonsense"), { name: "home", params: {} });
  assert.deepEqual(viewToRoute(undefined), { name: "home", params: {} });
});

test("routeToView is the inverse of viewToRoute", () => {
  for (const v of ["home", "library", "settings", "activity", "plugin:notes"]) {
    assert.equal(routeToView(viewToRoute(v)), v);
  }
  assert.equal(routeToView(null), "home");
});

test("setRouteFromView drives the route store and derived stores", () => {
  setRouteFromView("plugin:notes");
  assert.deepEqual(get(route), { name: "tool", params: { toolId: "notes" } });
  assert.equal(get(activeToolId), "notes");
  assert.equal(get(activeNav), "library");
  assert.equal(currentRouteView(), "plugin:notes");

  setRouteFromView("settings");
  assert.equal(get(activeToolId), null);
  assert.equal(get(activeNav), "settings");
  assert.equal(currentRouteView(), "settings");
});

test("breadcrumbModel describes built-in and tool routes", () => {
  setRouteFromView("home");
  assert.deepEqual(get(breadcrumbModel), [{ label: "Home", current: true }]);

  setRouteFromView("plugin:heicmov");
  const crumbs = get(breadcrumbModel);
  assert.equal(crumbs[0].view, "library");
  assert.equal(crumbs[1].toolId, "heicmov");
  assert.equal(crumbs[1].current, true);
});
