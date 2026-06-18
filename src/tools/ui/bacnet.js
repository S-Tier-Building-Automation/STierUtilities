// Advanced BACnet Inspector — discovery, browse, COV, alarms.

import {
  bwClassifyDiscovery,
  bwModelObjectsBatch,
  bwPlanDeviceObjects,
} from "../building-workspace.js";
import { confirmAction } from "../../ui/modal.js";
import { toast } from "../../ui/toast.js";

/**
 * @param {object} deps
 * @param {typeof import("../../platform/tauri.js").invoke} deps.invoke
 * @param {typeof import("../../platform/tauri.js").listen} deps.listen
 * @param {import("../../ui/dom.js").el} deps.el
 * @param {(toolId: string, msg: string, kind?: string) => void} deps.logTo
 * @param {() => void} deps.renderAll
 * @param {ReturnType<typeof import("./networkmanager.js").createNetworkManagerUi>} deps.networkManager
 * @param {(toolId: string) => object|null} deps.platformHost
 * @param {object} deps.userState
 * @param {() => void} deps.saveUserState
 * @param {() => string|null} deps.currentPluginId
 * @param {() => object|null} deps.getInventory
 * @param {() => object|null} deps.getBuildingWorkspace
 * @param {() => number} [deps.getInboxQueuedCount]
 */
export function createBacnetUi({
  invoke, listen, el, logTo, renderAll, networkManager, platformHost,
  userState, saveUserState, currentPluginId, getInventory, getBuildingWorkspace,
  getInboxQueuedCount = () => 0,
}) {

function inventoryInstance() {
  return getInventory ? getInventory() : null;
}

// ============================================================================

let bac = {
  discovering: false,
  discoveryStartedAt: 0,
  discoveryDurationMs: 5000,
  discoveryTimer: null,
  devices: [],            // BacnetDevice[] from the backend (key, address, instance, …)
  deviceFilter: "",       // free-text over instance/name/address/vendor/model
  deviceSortKey: "instance", // "instance" | "name" | "address" | "vendor" | "model"
  deviceSortDir: "asc",
  selectedDeviceKey: null,
  objects: [],            // BacnetObject[] for the selected device
  objectsLoading: false,
  objectsProgress: null,  // { done, total } during index-by-index walks
  objectFilter: "",
  objectTypeFilter: new Set(), // selected typeName strings; empty = all types
  objectInstanceMin: "",
  objectInstanceMax: "",
  objectSelection: new Set(),  // "type:instance" keys chosen for bulk import
  objectNameTemplate: "",      // optional naming template for bulk import
  objectTypesOpen: false,      // is the type-filter <details> popover open
  selectedObjectKey: null, // "type:instance"
  props: [],              // PropertyEntry[] for the selected object
  propsLoading: false,
  cov: { processId: null, objectKey: null, busy: false, updates: 0, lastAt: null },
  trend: { loading: false, records: [], recordCount: 0, truncated: false, objectKey: null, max: "200" },
  alarms: { loading: false, entries: [], deviceKey: null, error: null, ran: false },
  write: { propertyId: "85", kind: "real", value: "", priority: "", arrayIndex: "" },
  target: "255.255.255.255",
  lowLimit: "",
  highLimit: "",
  // Foreign-device (BBMD) registration: reach broadcast discovery across subnets.
  bbmd: { address: "", ttl: "60", status: null, busy: false },
  listenersReady: false,
  discoveryRan: false,
  lastDiscoveryCount: null,
  driftSummary: null,          // { new, returning, changed, missing } vs the last scan
  deviceStatusByKey: {},       // device key -> "new" | "returning" | "changed"
};

function bacStatusPill() {
  if (bac.discovering) return { label: "Discovering…", cls: "pill-running" };
  const n = bac.devices.length;
  if (n === 0) return { label: "Idle", cls: "pill-idle" };
  return { label: `${n} device${n === 1 ? "" : "s"}`, cls: "pill-muted" };
}

function bacSelectedDevice() {
  return bac.devices.find((d) => d.key === bac.selectedDeviceKey) || null;
}

// The DeviceRef the backend needs to reach a device (router addressing included).
// maxApdu + segmentation let the backend segment an outbound request that won't
// fit the device's APDU (e.g. a large WriteProperty), or reject it up front when
// the device can't receive segments.
function bacDeviceRef(d) {
  return {
    address: d.address,
    network: d.network ?? null,
    mac: d.mac ?? null,
    maxApdu: d.maxApdu ?? null,
    segmentation: d.segmentation ?? null,
  };
}

function bacObjectKey(o) { return `${o.objectType}:${o.instance}`; }

function bacSelectedObject() {
  return bac.objects.find((o) => bacObjectKey(o) === bac.selectedObjectKey) || null;
}

function bacDeviceLabel(d) {
  const route = d.network != null ? ` · net ${d.network}` : "";
  return `${d.name || `device ${d.instance}`} (${d.instance})${route}`;
}

function bacDiscoveryProgressState() {
  if (!bac.discovering || !bac.discoveryStartedAt) return null;
  const elapsed = Math.max(0, Date.now() - bac.discoveryStartedAt);
  const duration = Math.max(500, bac.discoveryDurationMs || 5000);
  const listening = elapsed < duration;
  const pct = listening ? Math.min(92, Math.round((elapsed / duration) * 92)) : 96;
  const remainingMs = Math.max(0, duration - elapsed);
  return {
    pct,
    finalizing: !listening,
    phase: listening ? "Listening for I-Am replies" : "Finalizing device details",
    remainingText: listening ? `~${Math.max(1, Math.ceil(remainingMs / 1000))}s left` : "almost done",
    found: bac.devices.length,
  };
}

function bacDiscoveryProgressEl(id = "bac-discovery-progress") {
  const state = bacDiscoveryProgressState();
  if (!state) return null;
  return el("div", { id, class: "bac-discovery-progress" },
    el("div", { class: "bac-discovery-progress-head" },
      el("span", {}, state.phase),
      el("span", { class: "muted small" }, `${state.found} found · ${state.remainingText}`)),
    el("div", { class: "bac-discovery-bar" },
      el("div", {
        class: `bac-discovery-fill ${state.finalizing ? "bac-discovery-finalizing" : ""}`,
        style: `width:${state.pct}%`,
      })));
}

function bacRenderDiscoveryProgressLive() {
  for (const id of ["bac-discovery-progress", "bw-discovery-progress"]) {
    const node = document.getElementById(id);
    if (!node) continue;
    const next = bacDiscoveryProgressEl(id);
    if (next) node.replaceWith(next);
    else node.remove();
  }
  const count = document.getElementById("bw-device-inbox-count");
  if (count) {
    const queued = getInboxQueuedCount();
    count.textContent = bac.discovering ? "Discovering..." : `${bac.devices.length} discovered · ${queued} queued`;
  }
  const bacCount = document.getElementById("bac-device-count");
  if (bacCount) bacCount.textContent = bacDeviceCountText();
}

function bacStartDiscoveryClock(durationMs = 5000) {
  if (bac.discoveryTimer) clearInterval(bac.discoveryTimer);
  bac.discoveryDurationMs = durationMs;
  bac.discoveryStartedAt = Date.now();
  bac.discoveryTimer = setInterval(bacRenderDiscoveryProgressLive, 250);
}

function bacStopDiscoveryClock() {
  if (bac.discoveryTimer) clearInterval(bac.discoveryTimer);
  bac.discoveryTimer = null;
  bacRenderDiscoveryProgressLive();
}

// ---- events ----

function bacEnsureListeners() {
  if (bac.listenersReady) return;
  bac.listenersReady = true;
  listen("bacnet:device", (e) => {
    const d = e.payload;
    if (!bac.devices.some((x) => x.key === d.key)) bac.devices.push(d);
    bacScheduleDevicesRender();
  }).catch((e) => console.warn("listen bacnet:device failed:", e));
  listen("bacnet:device_update", (e) => {
    const d = e.payload;
    const i = bac.devices.findIndex((x) => x.key === d.key);
    if (i >= 0) bac.devices[i] = d;
    else bac.devices.push(d);
    bacScheduleDevicesRender();
  }).catch((e) => console.warn("listen bacnet:device_update failed:", e));
  listen("bacnet:objects_progress", (e) => {
    bac.objectsProgress = e.payload;
    const node = document.getElementById("bac-objects-status");
    if (node) node.textContent = `Walking object-list… ${e.payload.done}/${e.payload.total}`;
  }).catch((e) => console.warn("listen bacnet:objects_progress failed:", e));
  listen("bacnet:object_names", (e) => {
    // Names stream from a detached pass; ignore batches for a device we've
    // already navigated away from.
    if (!e.payload || e.payload.deviceKey !== bac.selectedDeviceKey) return;
    const map = new Map((e.payload.names || []).map((x) => [x.key, x.name]));
    for (const o of bac.objects) {
      const n = map.get(bacObjectKey(o));
      if (n) o.name = n;
    }
    bacApplyObjectFilter();
  }).catch((e) => console.warn("listen bacnet:object_names failed:", e));
  listen("bacnet:cov", (e) => {
    const p = e.payload;
    if (!p) return;
    // Only apply notifications for the subscription we're currently showing.
    if (p.processId !== bac.cov.processId) return;
    if (`${p.objectType}:${p.instance}` !== bac.cov.objectKey) return;
    // Skip while the property grid is mid-rebuild (a re-read cleared bac.props);
    // applying now would bump the counter against rows that aren't there yet.
    if (bac.propsLoading || bac.props.length === 0) return;
    bac.cov.updates += 1;
    bac.cov.lastAt = Date.now();
    bacApplyCovUpdate(p.values || []);
  }).catch((e) => console.warn("listen bacnet:cov failed:", e));
}

// ---- actions ----

// Inter-tool dependency in action: BACnet Inspector borrows Network Manager's
// subnet scanner (the `netscan` capability) to find live hosts to aim discovery
// at — instead of reimplementing an ICMP sweep. Only offered when the kernel
// resolved the optional dependency, so it degrades cleanly if Network Manager
// is unavailable.
async function bacSuggestTargets() {
  const netscan = platformHost("bacnet")?.tryUse("netscan.v1");
  if (!netscan) { logTo("bacnet", "Network scan capability unavailable.", "warn"); return; }
  const snap = networkManager.getAdapterSnapshot();
  if (!snap.loaded) {
    try { await networkManager.refreshAdapters(); } catch (_) {}
  }
  const { adapters } = networkManager.getAdapterSnapshot();
  let subnet = null;
  for (const a of adapters) {
    const s = networkManager.scanSubnetFor(a.name);
    if (s) { subnet = s; break; }
  }
  if (!subnet) { logTo("bacnet", "No adapter with a scannable IPv4 subnet to search.", "warn"); return; }
  logTo("bacnet", `Scanning ${subnet.network}/${subnet.prefix} for live hosts (via Network Manager)…`, "info");
  try {
    const result = await netscan.scan(`${subnet.ip}/${subnet.prefix}`);
    const hosts = result?.hosts || [];
    if (hosts.length === 0) { logTo("bacnet", "No live hosts found on the subnet.", "warn"); return; }
    const preview = hosts.slice(0, 12).map((h) => h.ip).join(", ");
    logTo("bacnet", `Found ${hosts.length} live host${hosts.length === 1 ? "" : "s"}: ${preview}${hosts.length > 12 ? "…" : ""}`, "ok");
  } catch (err) {
    logTo("bacnet", `Host scan failed: ${err}`, "error");
  }
}

// The Inspector consumes the extracted bacnet-core service. If the kernel
// didn't boot, it falls back to direct backend calls so the advanced tool still
// works — the platform must never take the UI down.
function bacnetRead() {
  const cap = platformHost("bacnet")?.tryUse("bacnet.read.v1");
  if (cap) return cap;
  return {
    listDevices: (o = {}) => invoke("bacnet_discover", {
      target: o.target ?? null, lowLimit: o.lowLimit ?? null,
      highLimit: o.highLimit ?? null, durationMs: o.durationMs ?? null,
    }),
    readPoint: (device, objectType, instance) =>
      invoke("bacnet_read_properties", { device, objectType, instance }),
    listObjects: (device, deviceInstance) =>
      invoke("bacnet_read_objects", { device, deviceInstance }),
    writeProperty: ({ device, objectType, instance, property, value, priority = null, arrayIndex = null }) =>
      invoke("bacnet_write_property", { device, objectType, instance, property, value, priority, arrayIndex }),
    readTrend: ({ device, objectType, instance, maxRecords }) =>
      invoke("bacnet_read_trend", { device, objectType, instance, maxRecords }),
    subscribeCov: ({ device, deviceInstance, objectType, instance, confirmed = false }) =>
      invoke("bacnet_subscribe_cov", { device, deviceInstance, objectType, instance, confirmed }),
    unsubscribeCov: ({ device, objectType, instance, processId }) =>
      invoke("bacnet_unsubscribe_cov", { device, objectType, instance, processId }),
    registerForeignDevice: ({ bbmd, ttlSeconds = null }) =>
      invoke("bacnet_register_foreign_device", { bbmd, ttlSeconds }),
    unregisterForeignDevice: () => invoke("bacnet_unregister_foreign_device"),
    foreignDeviceStatus: () => invoke("bacnet_foreign_device_status"),
    getAlarms: (device) => invoke("bacnet_get_alarms", { device }),
    acknowledgeAlarm: ({ device, objectType, instance }) =>
      invoke("bacnet_acknowledge_alarm", { device, objectType, instance }),
  };
}

async function bacDiscover() {
  if (bac.discovering) return;
  bacEnsureListeners();
  if (bac.cov.processId != null) await bacCovStop();
  const durationMs = 5000;
  bac.discovering = true;
  bac.discoveryRan = true;
  bac.lastDiscoveryCount = null;
  bacStartDiscoveryClock(durationMs);
  bac.devices = [];
  bac.selectedDeviceKey = null;
  bac.objects = [];
  bac.selectedObjectKey = null;
  bac.props = [];
  renderAll();
  const low = parseInt(bac.lowLimit, 10);
  const high = parseInt(bac.highLimit, 10);
  try {
    const devices = await bacnetRead().listDevices({
      target: bac.target.trim() || null,
      lowLimit: Number.isFinite(low) ? low : null,
      highLimit: Number.isFinite(high) ? high : null,
      durationMs,
    });
    bac.devices = devices;
    bac.lastDiscoveryCount = devices.length;
    bacRecordDiscoveryDrift(devices);
    logTo("bacnet", `Discovery finished — ${devices.length} device${devices.length === 1 ? "" : "s"}.`, devices.length ? "ok" : "warn");
  } catch (err) {
    bac.lastDiscoveryCount = null;
    logTo("bacnet", `Discovery failed: ${err}`, "error");
  } finally {
    bac.discovering = false;
    bacStopDiscoveryClock();
    renderAll();
  }
}

// Register/unregister with a BBMD as a foreign device, so a subsequent Who-Is is
// distributed across IP subnets (the host needn't be on the BACnet LAN). A
// background keep-alive in the backend holds the registration open.
async function bacToggleForeignDevice() {
  if (bac.bbmd.busy) return;
  const api = bacnetRead();
  bac.bbmd.busy = true;
  renderAll();
  try {
    if (bac.bbmd.status) {
      await api.unregisterForeignDevice();
      bac.bbmd.status = null;
      logTo("bacnet", "Unregistered from BBMD (will expire at TTL).", "info");
    } else {
      const addr = bac.bbmd.address.trim();
      if (!addr) { logTo("bacnet", "Enter the BBMD's IP address to register.", "warn"); return; }
      const ttl = parseInt(bac.bbmd.ttl, 10);
      const status = await api.registerForeignDevice({
        bbmd: addr,
        ttlSeconds: Number.isFinite(ttl) ? ttl : null,
      });
      bac.bbmd.status = status;
      logTo("bacnet", `Registered as foreign device with ${status.bbmd} (TTL ${status.ttlSeconds}s). Broadcasts now route through the BBMD.`, "ok");
    }
  } catch (err) {
    logTo("bacnet", `Foreign-device registration failed: ${err}`, "error");
  } finally {
    bac.bbmd.busy = false;
    renderAll();
  }
}

// Classify a fresh discovery against the persisted baseline (new/returning/changed +
// missing) and store the new baseline for next time. Local-only; never blocks discovery.
function bacRecordDiscoveryDrift(devices) {
  try {
    const prev = Array.isArray(userState.bacnetDiscoveryCache) ? userState.bacnetDiscoveryCache : [];
    const drift = bwClassifyDiscovery(prev, devices);
    bac.driftSummary = drift.summary;
    bac.deviceStatusByKey = Object.fromEntries(drift.devices.map((d) => [d.key, d.status]));
    userState.bacnetDiscoveryCache = devices.map((d) => ({
      key: d.key, instance: d.instance, address: d.address,
      network: d.network ?? null, mac: d.mac ?? null,
      vendorId: d.vendorId ?? null, modelName: d.modelName ?? null, name: d.name ?? null,
    }));
    saveUserState();
  } catch (_) {
    bac.driftSummary = null;
    bac.deviceStatusByKey = {};
  }
}

function bacDriftSummaryEl() {
  const s = bac.driftSummary;
  if (!s) return null;
  const parts = [];
  if (s.new) parts.push(`${s.new} new`);
  if (s.returning) parts.push(`${s.returning} returning`);
  if (s.changed) parts.push(`${s.changed} changed`);
  if (s.missing) parts.push(`${s.missing} missing`);
  if (!parts.length) return null;
  return el("span", {
    class: "muted small bac-drift-summary",
    title: "Compared to the previous discovery on this machine",
  }, `· ${parts.join(" · ")} since last scan`);
}

function bacDeviceStatusBadge(d) {
  const status = bac.deviceStatusByKey[d.key];
  if (!status || status === "returning") return null;
  return el("span", {
    class: `bac-badge bac-badge-${status}`,
    title: status === "new" ? "Not seen in the previous scan" : "Address/vendor/model changed since the previous scan",
  }, status);
}

async function bacSelectDevice(key) {
  if (bac.selectedDeviceKey === key) return;
  if (bac.cov.processId != null) await bacCovStop();
  bac.selectedDeviceKey = key;
  bac.objects = [];
  bac.selectedObjectKey = null;
  bac.props = [];
  bac.objectFilter = "";
  bac.objectTypeFilter.clear();
  bac.objectInstanceMin = "";
  bac.objectInstanceMax = "";
  bac.objectSelection.clear();
  const dev = bacSelectedDevice();
  if (!dev) { renderAll(); return; }
  bac.objectsLoading = true;
  bac.objectsProgress = null;
  renderAll();
  try {
    const objects = await bacnetRead().listObjects(bacDeviceRef(dev), dev.instance);
    // A faster click may have switched devices while this was in flight; don't
    // overwrite the newer selection with stale results.
    if (bac.selectedDeviceKey !== key) return;
    bac.objects = objects;
    logTo("bacnet", `Read ${bac.objects.length} objects from ${bacDeviceLabel(dev)}.`, "ok");
  } catch (err) {
    if (bac.selectedDeviceKey !== key) return;
    logTo("bacnet", `Object list failed for ${bacDeviceLabel(dev)}: ${err}`, "error");
  } finally {
    if (bac.selectedDeviceKey === key) {
      bac.objectsLoading = false;
      bac.objectsProgress = null;
      renderAll();
    }
  }
}

async function bacSelectObject(key) {
  // Drop any live subscription tied to the previously-viewed object.
  if (bac.cov.processId != null && bac.cov.objectKey !== key) await bacCovStop();
  if (bac.trend.objectKey !== key) {
    bac.trend = { loading: false, records: [], recordCount: 0, truncated: false, objectKey: null, max: bac.trend.max };
  }
  bac.selectedObjectKey = key;
  bac.props = [];
  const dev = bacSelectedDevice();
  const obj = bacSelectedObject();
  if (!dev || !obj) { renderAll(); return; }
  bac.propsLoading = true;
  renderAll();
  try {
    const props = await bacnetRead().readPoint(
      bacDeviceRef(dev), obj.objectType, obj.instance,
    );
    // Guard against a newer object selection resolving first.
    if (bac.selectedObjectKey !== key) return;
    bac.props = props;
  } catch (err) {
    if (bac.selectedObjectKey !== key) return;
    logTo("bacnet", `Property read failed for ${obj.typeName}:${obj.instance}: ${err}`, "error");
  } finally {
    if (bac.selectedObjectKey === key) {
      bac.propsLoading = false;
      renderAll();
    }
  }
}

async function bacRefreshProps() {
  const key = bac.selectedObjectKey;
  bac.selectedObjectKey = null; // force re-select to re-read
  await bacSelectObject(key);
}

// ---- COV (live values) ----

function bacCovActive() {
  return bac.cov.processId != null && bac.cov.objectKey === bac.selectedObjectKey;
}

// Tear down any live subscription (fire-and-forget the cancel to the device).
async function bacCovStop() {
  const { processId, objectKey } = bac.cov;
  if (processId == null) return;
  const dev = bacSelectedDevice();
  bac.cov = { processId: null, objectKey: null, busy: false, updates: 0, lastAt: null };
  if (dev && objectKey) {
    const [t, i] = objectKey.split(":").map((n) => parseInt(n, 10));
    try {
      await bacnetRead().unsubscribeCov({ device: bacDeviceRef(dev), objectType: t, instance: i, processId });
    } catch (_) { /* device drops us at lifetime expiry anyway */ }
  }
}

async function bacToggleCov() {
  if (bacCovActive()) {
    await bacCovStop();
    logTo("bacnet", "Stopped COV subscription.", "info");
    renderAll();
    return;
  }
  const dev = bacSelectedDevice();
  const obj = bacSelectedObject();
  if (!dev || !obj) return;
  // Replace any subscription on a previous object.
  if (bac.cov.processId != null) await bacCovStop();
  bac.cov.busy = true;
  renderAll();
  try {
    const processId = await bacnetRead().subscribeCov({
      device: bacDeviceRef(dev),
      deviceInstance: dev.instance,
      objectType: obj.objectType,
      instance: obj.instance,
      confirmed: false,
    });
    bac.cov = { processId, objectKey: bacObjectKey(obj), busy: false, updates: 0, lastAt: null };
    logTo("bacnet", `Subscribed to COV on ${obj.typeName}:${obj.instance} (live values).`, "ok");
  } catch (err) {
    bac.cov.busy = false;
    logTo("bacnet", `COV subscribe failed for ${obj.typeName}:${obj.instance}: ${err}`, "error");
  }
  renderAll();
}

// Patch the property rows a COV notification touched, in place, and flash them.
function bacApplyCovUpdate(values) {
  if (currentPluginId() !== "bacnet") return;
  for (const v of values) {
    const row = bac.props.find((p) => p.id === v.id);
    if (row) { row.display = v.display; row.values = v.values; row.error = v.error; }
  }
  const body = document.getElementById("bac-props-body");
  if (body) body.replaceChildren(...bacPropRows(new Set(values.map((v) => v.id))));
  const badge = document.getElementById("bac-cov-badge");
  if (badge) badge.textContent = `live · ${bac.cov.updates} update${bac.cov.updates === 1 ? "" : "s"}`;
}

// Builds the typed value payload the backend expects ({ kind, ... }).
// Integer kinds use Number.isSafeInteger so a value past 2^53 is rejected
// rather than silently rounded to a different integer before it's written.
function bacBuildWriteValue() {
  const kind = bac.write.kind;
  const raw = bac.write.value.trim();
  // An empty field must never silently become 0 — writing 0 to a live setpoint
  // is dangerous. Only Null (no value) and an intentional empty string are ok.
  if (raw === "" && kind !== "null" && kind !== "characterString") {
    throw new Error("Enter a value to write.");
  }
  const safeInt = (allowNegative) => {
    const v = Number(raw);
    if (!Number.isInteger(v) || (!allowNegative && v < 0)) {
      throw new Error(`"${raw}" is not ${allowNegative ? "an integer" : "a non-negative integer"}`);
    }
    if (!Number.isSafeInteger(v)) {
      throw new Error(`"${raw}" is too large to enter precisely (max ${Number.MAX_SAFE_INTEGER})`);
    }
    return v;
  };
  switch (kind) {
    case "null": return { kind: "null" };
    case "real": {
      const v = Number(raw);
      if (!Number.isFinite(v)) throw new Error(`"${raw}" is not a number`);
      return { kind: "real", value: v };
    }
    case "unsigned": return { kind: "unsigned", value: safeInt(false) };
    case "signed": return { kind: "signed", value: safeInt(true) };
    case "enumerated": return { kind: "enumerated", value: safeInt(false) };
    case "boolean": {
      const t = raw.toLowerCase();
      if (!["true", "false", "1", "0", "active", "inactive"].includes(t)) {
        throw new Error(`"${raw}" is not a boolean (use true/false)`);
      }
      return { kind: "boolean", value: t === "true" || t === "1" || t === "active" };
    }
    case "characterString": return { kind: "characterString", value: bac.write.value };
    default: throw new Error(`unsupported type ${kind}`);
  }
}

async function bacWrite(relinquish = false) {
  const dev = bacSelectedDevice();
  const obj = bacSelectedObject();
  if (!dev || !obj) return;
  const propertyId = parseInt(bac.write.propertyId, 10);
  if (!Number.isInteger(propertyId)) {
    logTo("bacnet", "Pick a property number to write.", "warn");
    return;
  }
  const priority = bac.write.priority === "" ? null : parseInt(bac.write.priority, 10);
  if (relinquish && priority == null) {
    logTo("bacnet", "Relinquish needs a priority (the slot to release).", "warn");
    return;
  }
  const arrayIndex = bac.write.arrayIndex === "" ? null : parseInt(bac.write.arrayIndex, 10);
  let value;
  try {
    value = relinquish ? { kind: "null" } : bacBuildWriteValue();
  } catch (err) {
    logTo("bacnet", `Invalid value: ${err.message}`, "warn");
    return;
  }
  const what = relinquish
    ? `relinquish p${priority}`
    : `write ${JSON.stringify(value)}${priority != null ? ` @ p${priority}` : ""}`;
  try {
    await bacnetRead().writeProperty({
      device: bacDeviceRef(dev),
      objectType: obj.objectType,
      instance: obj.instance,
      property: propertyId,
      value,
      priority,
      arrayIndex,
    });
    logTo("bacnet", `OK — ${what} on ${obj.typeName}:${obj.instance}.`, "ok");
    await bacRefreshProps();
  } catch (err) {
    logTo("bacnet", `Write failed on ${obj.typeName}:${obj.instance}: ${err}`, "error");
  }
}

// ---- live render helpers (in-place, no focus stealing) ----

// Coalesce bursts of device events (hundreds can arrive in one discovery
// window) into at most ~7 table rebuilds per second.
let bacDevicesRenderTimer = null;
function bacScheduleDevicesRender() {
  if (bacDevicesRenderTimer) return;
  bacDevicesRenderTimer = setTimeout(() => {
    bacDevicesRenderTimer = null;
    bacRenderDevicesLive();
  }, 150);
}

function bacRenderDevicesLive() {
  const bw = getBuildingWorkspace?.();
  if (currentPluginId() === "building-workspace" && bw?.renderDeviceInboxLive) {
    bw.renderDeviceInboxLive();
    return;
  }
  if (currentPluginId() !== "bacnet") return;
  const body = document.getElementById("bac-device-rows");
  if (body) body.replaceChildren(...bacDeviceRows());
  const count = document.getElementById("bac-device-count");
  if (count) count.textContent = bacDeviceCountText();
}

// Vendor/model display string, matching the table cells (so filter + export
// see the same text the user sees).
function bacVendorText(d) { return d.vendorName || (d.vendorId ? `vendor ${d.vendorId}` : ""); }
function bacAddressText(d) {
  return d.network != null ? `${d.address} → net ${d.network}/${d.mac || "?"}` : d.address;
}

// Hosts narrowed by the free-text filter (case-insensitive substring over
// instance, name, address, vendor, model). Empty filter returns all devices.
function bacFilteredDevices() {
  const q = bac.deviceFilter.trim().toLowerCase();
  if (!q) return bac.devices;
  return bac.devices.filter((d) =>
    String(d.instance).includes(q) ||
    (d.name || "").toLowerCase().includes(q) ||
    bacAddressText(d).toLowerCase().includes(q) ||
    bacVendorText(d).toLowerCase().includes(q) ||
    (d.modelName || "").toLowerCase().includes(q));
}

// Sort devices by the active column/direction. instance/maxApdu compare
// numerically; text columns compare case-insensitively with blanks pinned
// last; instance is the stable tiebreaker.
function bacSortedDevices(devices) {
  const { deviceSortKey: key, deviceSortDir: dir } = bac;
  const sign = dir === "desc" ? -1 : 1;
  const byInst = (a, b) => (a.instance || 0) - (b.instance || 0);
  const textOf = (d) =>
    key === "name" ? (d.name || "")
    : key === "address" ? bacAddressText(d)
    : key === "vendor" ? bacVendorText(d)
    : key === "model" ? (d.modelName || "")
    : "";
  return devices.slice().sort((a, b) => {
    if (key === "instance") return byInst(a, b) * sign;
    const av = textOf(a).toLowerCase();
    const bv = textOf(b).toLowerCase();
    if (!av && !bv) return byInst(a, b);
    if (!av) return 1;
    if (!bv) return -1;
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return (cmp || byInst(a, b)) * sign;
  });
}

function bacVisibleDevices() { return bacSortedDevices(bacFilteredDevices()); }

function bacDeviceCountText() {
  const total = bac.devices.length;
  if (bac.discovering) return `Listening… ${total} device${total === 1 ? "" : "s"} so far`;
  if (bac.deviceFilter.trim()) return `${bacFilteredDevices().length} of ${total} shown`;
  return `${total} device${total === 1 ? "" : "s"}`;
}

// Re-render just the device rows + count in place (so typing in the filter
// or clicking a sort header never rebuilds the page and steals input focus).
function bacApplyDeviceView() {
  if (currentPluginId() !== "bacnet") return;
  const tbl = document.getElementById("bac-device-table");
  if (tbl) tbl.replaceWith(bacDeviceTableEl());
  const count = document.getElementById("bac-device-count");
  if (count) count.textContent = bacDeviceCountText();
}

function bacSetDeviceSort(key) {
  if (bac.deviceSortKey === key) bac.deviceSortDir = bac.deviceSortDir === "asc" ? "desc" : "asc";
  else { bac.deviceSortKey = key; bac.deviceSortDir = "asc"; }
  bacApplyDeviceView();
}

// CSV of the currently-visible (filtered + sorted) devices.
function bacDevicesToCsv() {
  const rows = bacVisibleDevices();
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ["instance", "name", "address", "network", "mac", "vendorId", "vendorName", "model", "maxApdu", "segmentation"];
  const lines = [header.join(",")];
  for (const d of rows) {
    lines.push([
      d.instance, d.name, d.address, d.network ?? "", d.mac ?? "",
      d.vendorId, d.vendorName, d.modelName, d.maxApdu, d.segmentation,
    ].map(esc).join(","));
  }
  return lines.join("\r\n");
}

async function bacCopyDevices() {
  const csv = bacDevicesToCsv();
  try {
    await navigator.clipboard.writeText(csv);
    logTo("bacnet", `Copied ${bacVisibleDevices().length} devices to clipboard (CSV).`, "ok");
  } catch (err) {
    logTo("bacnet", `Clipboard copy failed: ${err}`, "error");
  }
}

function bacExportDevices() {
  const csv = bacDevicesToCsv();
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: `bacnet-devices-${bacTimestamp()}.csv` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  logTo("bacnet", `Exported ${bacVisibleDevices().length} devices to CSV.`, "ok");
}

function bacTimestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

// Shared object-filter predicate (free text + type set + instance range). Used by the
// Advanced Inspector object browser and the Building Workspace point-import modal so both
// filter identically.
function bacObjectMatches(o, { q = "", types = null, min = "", max = "" } = {}) {
  if (types && types.size && !types.has(o.typeName)) return false;
  const mn = parseInt(min, 10);
  if (Number.isFinite(mn) && Number(o.instance) < mn) return false;
  const mx = parseInt(max, 10);
  if (Number.isFinite(mx) && Number(o.instance) > mx) return false;
  const qq = String(q).trim().toLowerCase();
  if (qq && !(
    String(o.name || "").toLowerCase().includes(qq) ||
    String(o.typeName || "").toLowerCase().includes(qq) ||
    String(o.instance).includes(qq)
  )) return false;
  return true;
}

function bacFilteredObjects() {
  return bac.objects.filter((o) => bacObjectMatches(o, {
    q: bac.objectFilter, types: bac.objectTypeFilter,
    min: bac.objectInstanceMin, max: bac.objectInstanceMax,
  }));
}

function bacApplyObjectFilter() {
  if (currentPluginId() !== "bacnet") return;
  const list = document.getElementById("bac-object-list");
  if (list) list.replaceChildren(...bacObjectRows());
  const count = document.getElementById("bac-object-count");
  if (count) count.textContent = bacObjectCountText();
  const bulkbar = document.getElementById("bac-object-bulkbar");
  if (bulkbar) bulkbar.replaceWith(bacObjectBulkBar());
}

function bacObjectFiltersActive() {
  return Boolean(
    bac.objectFilter.trim() ||
    bac.objectTypeFilter.size ||
    String(bac.objectInstanceMin).trim() ||
    String(bac.objectInstanceMax).trim(),
  );
}

function bacObjectCountText() {
  const total = bac.objects.length;
  if (!bacObjectFiltersActive()) return `${total} object${total === 1 ? "" : "s"}`;
  return `${bacFilteredObjects().length} of ${total} shown`;
}

// ---- render ----

function bacDeviceRows() {
  if (bac.devices.length === 0) {
    const msg = bac.discovering ? "Listening for I-Am replies…" : "No devices yet — run Discover.";
    return [el("tr", {}, el("td", { class: "muted small", colspan: "6" }, msg))];
  }
  const devices = bacVisibleDevices();
  if (devices.length === 0) {
    return [el("tr", {}, el("td", { class: "muted small", colspan: "6" }, "No devices match the filter."))];
  }
  return devices.map((d) => {
    const active = d.key === bac.selectedDeviceKey;
    return el("tr", {
      class: `bac-device-row ${active ? "bac-row-active" : ""}`,
      onclick: () => bacSelectDevice(d.key),
    },
      el("td", { class: "bac-num" }, String(d.instance)),
      el("td", {}, d.name || el("span", { class: "muted" }, "—"), bacDeviceStatusBadge(d)),
      el("td", { class: "bac-mono" }, bacAddressText(d)),
      el("td", {}, bacVendorText(d) || el("span", { class: "muted" }, "—")),
      el("td", {}, d.modelName || el("span", { class: "muted" }, "—")),
      el("td", { class: "bac-num" }, `${d.maxApdu} · ${d.segmentation}`),
    );
  });
}

function bacDeviceHeaderCell(key, label, cls) {
  const active = bac.deviceSortKey === key;
  const arrow = active ? (bac.deviceSortDir === "asc" ? "▲" : "▼") : "";
  return el("th", {
    class: `bac-th${active ? " bac-th-active" : ""}${cls ? " " + cls : ""}`,
    role: "button",
    tabindex: "0",
    "aria-sort": active ? (bac.deviceSortDir === "asc" ? "ascending" : "descending") : "none",
    onclick: () => bacSetDeviceSort(key),
    onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); bacSetDeviceSort(key); } },
  }, label, el("span", { class: "bac-sort-ind" }, arrow));
}

function bacDeviceTableEl() {
  return el("table", { id: "bac-device-table", class: "bac-table" },
    el("thead", {}, el("tr", {},
      bacDeviceHeaderCell("instance", "Instance"),
      bacDeviceHeaderCell("name", "Name"),
      bacDeviceHeaderCell("address", "Address"),
      bacDeviceHeaderCell("vendor", "Vendor"),
      bacDeviceHeaderCell("model", "Model"),
      el("th", {}, "Max APDU · seg"),
    )),
    el("tbody", { id: "bac-device-rows" }, ...bacDeviceRows()),
  );
}

function bacObjectRows() {
  const objects = bacFilteredObjects();
  if (objects.length === 0) {
    let msg;
    if (bac.objects.length > 0) msg = "No objects match the filter.";
    else if (bac.objectsLoading) msg = "Reading object list…";
    else msg = "Select a device to list its objects.";
    return [el("li", { class: "muted small bac-object-empty" }, msg)];
  }
  // Group by object type so a large device reads like Niagara's point folders.
  const sorted = [...objects].sort((a, b) =>
    String(a.typeName).localeCompare(String(b.typeName)) || Number(a.instance) - Number(b.instance));
  const countByType = sorted.reduce((m, o) => m.set(o.typeName, (m.get(o.typeName) || 0) + 1), new Map());
  const rows = [];
  let lastType = null;
  for (const o of sorted) {
    if (o.typeName !== lastType) {
      lastType = o.typeName;
      rows.push(el("li", { class: "bac-object-group", role: "presentation" },
        el("span", {}, lastType),
        el("span", { class: "muted small" }, String(countByType.get(lastType))),
      ));
    }
    const key = bacObjectKey(o);
    const active = key === bac.selectedObjectKey;
    const checked = bac.objectSelection.has(key);
    rows.push(el("li", {
      class: `bac-object-row ${active ? "bac-row-active" : ""}${checked ? " bac-object-checked" : ""}`,
      role: "button",
      tabindex: "0",
      onclick: () => bacSelectObject(key),
      onkeydown: (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); bacSelectObject(key); }
      },
    },
      el("input", {
        type: "checkbox", class: "bac-object-check",
        checked: checked ? "checked" : undefined,
        "aria-label": `Select ${o.typeName}:${o.instance} for import`,
        onclick: (e) => { e.stopPropagation(); bacToggleObjectSelect(key); },
      }),
      el("span", { class: "bac-object-type" }, `${o.typeName}:${o.instance}`),
      el("span", { class: "bac-object-name" }, o.name || ""),
      el("button", {
        class: "btn-ghost bac-object-action",
        title: "Import this object into Building Workspace and historize it",
        onclick: (e) => { e.stopPropagation(); getBuildingWorkspace()?.historizeObject?.(o); },
      }, "Historize"),
    ));
  }
  return rows;
}

// ---- object browser: type/instance filters, multi-select, bulk import, export ----

function bacObjectTypeNames() {
  return [...new Set(bac.objects.map((o) => o.typeName))].sort((a, b) => String(a).localeCompare(String(b)));
}

function bacToggleObjectType(typeName) {
  if (bac.objectTypeFilter.has(typeName)) bac.objectTypeFilter.delete(typeName);
  else bac.objectTypeFilter.add(typeName);
  // A row that just became hidden shouldn't stay selected for import.
  for (const key of [...bac.objectSelection]) {
    const obj = bac.objects.find((o) => bacObjectKey(o) === key);
    if (obj && bac.objectTypeFilter.size && !bac.objectTypeFilter.has(obj.typeName)) bac.objectSelection.delete(key);
  }
  renderAll();
}

function bacToggleObjectSelect(key) {
  if (bac.objectSelection.has(key)) bac.objectSelection.delete(key);
  else bac.objectSelection.add(key);
  bacApplyObjectFilter();
}

function bacSelectAllFiltered() {
  for (const o of bacFilteredObjects()) bac.objectSelection.add(bacObjectKey(o));
  bacApplyObjectFilter();
}

function bacClearObjectSelection() {
  bac.objectSelection.clear();
  bacApplyObjectFilter();
}

function bacSelectedObjectsForBulk() {
  return bac.objects.filter((o) => bac.objectSelection.has(bacObjectKey(o)));
}

function bacObjectsToCsv(objects) {
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [["objectType", "typeName", "instance", "name"].join(",")];
  for (const o of objects) lines.push([o.objectType, o.typeName, o.instance, o.name].map(esc).join(","));
  return lines.join("\r\n");
}

function bacExportObjects() {
  const dev = bacSelectedDevice();
  const objects = bacFilteredObjects();
  if (!objects.length) { toast("No objects to export.", "warn"); return; }
  const csv = bacObjectsToCsv(objects);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: `bacnet-objects-${dev ? dev.instance : "device"}-${bacTimestamp()}.csv` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Exported ${objects.length} object${objects.length === 1 ? "" : "s"} to CSV.`, "ok");
}

// Bulk-model the checked objects into the active site/building/floor: group them by
// inferred equipment, create/reuse one equip per group, then upsert all points in a
// single inventory write (inventory.upsertMany). Reuses the same equip/point helpers
// as the single-object Historize path.
function bacBulkImportSelected() {
  const inv = inventoryInstance();
  const bw = getBuildingWorkspace?.();
  const dev = bacSelectedDevice();
  const objects = bacSelectedObjectsForBulk();
  if (!inv || !bw) { toast("Building model is not ready.", "error"); return; }
  if (!dev || !objects.length) { toast("Select one or more objects first.", "warn"); return; }
  const { site, building, floor } = bw.ensureLocation(inv);
  const plan = bwPlanDeviceObjects({ device: dev, objects, template: bac.objectNameTemplate });
  const equipIdByName = new Map();
  for (const name of plan.equips) {
    let equip = bw.entityByName(inv, { type: "equip", floorId: floor.id }, name)
      || inv.upsertEntity({
        type: "equip", siteId: site.id, buildingId: building.id, floorId: floor.id, parentId: floor.id,
        name, tags: { equip: true },
      });
    equip = inv.applyTemplate(equip.id, bw.templateForName(name));
    equipIdByName.set(name, equip.id);
  }
  const points = bwModelObjectsBatch({
    siteId: site.id, buildingId: building.id, floorId: floor.id, device: dev, items: plan.items, equipIdByName,
  });
  const saved = inv.upsertMany(points);
  bw.saveState();
  bac.objectSelection.clear();
  logTo("building-workspace", `Imported ${saved.length} point${saved.length === 1 ? "" : "s"} from device ${dev.instance} into ${floor.name}.`, "ok");
  toast(`Imported ${saved.length} point${saved.length === 1 ? "" : "s"} into ${floor.name}. Open Building Workspace to model further.`, "ok");
  renderAll();
}

// Saved object-filter presets (persisted in user state).
function bacObjectPresets() {
  if (!userState.bacnetObjectPresets || typeof userState.bacnetObjectPresets !== "object") userState.bacnetObjectPresets = {};
  return userState.bacnetObjectPresets;
}

function bacSaveObjectPreset() {
  const name = (prompt("Save the current object filter as a preset named:", "") || "").trim();
  if (!name) return;
  bacObjectPresets()[name] = {
    q: bac.objectFilter,
    types: [...bac.objectTypeFilter],
    min: bac.objectInstanceMin,
    max: bac.objectInstanceMax,
  };
  saveUserState();
  toast(`Saved filter preset "${name}".`, "ok");
  renderAll();
}

function bacApplyObjectPreset(name) {
  const preset = bacObjectPresets()[name];
  if (!preset) return;
  bac.objectFilter = preset.q || "";
  bac.objectTypeFilter = new Set(Array.isArray(preset.types) ? preset.types : []);
  bac.objectInstanceMin = preset.min || "";
  bac.objectInstanceMax = preset.max || "";
  renderAll();
}

// The filter toolbar (type chips + instance range + presets + CSV export) above the list.
function bacObjectToolbar() {
  const typeNames = bacObjectTypeNames();
  const presets = Object.keys(bacObjectPresets());
  const typeChips = typeNames.map((t) => {
    const on = bac.objectTypeFilter.has(t);
    return el("button", {
      type: "button",
      class: `bac-type-chip${on ? " bac-type-chip-on" : ""}`,
      "aria-pressed": on ? "true" : "false",
      onclick: () => bacToggleObjectType(t),
    }, t);
  });
  return el("div", { class: "bac-object-toolbar" },
    el("input", {
      type: "search", class: "nm-input bac-object-filter",
      placeholder: "Filter objects…",
      "aria-label": "Filter objects",
      value: bac.objectFilter,
      oninput: (e) => { bac.objectFilter = e.target.value; bacApplyObjectFilter(); },
    }),
    el("div", { class: "bac-object-range" },
      el("span", { class: "muted small" }, "Instance"),
      el("input", {
        type: "number", class: "nm-input bac-range-input", placeholder: "min",
        "aria-label": "Minimum instance", value: bac.objectInstanceMin,
        oninput: (e) => { bac.objectInstanceMin = e.target.value; bacApplyObjectFilter(); },
      }),
      el("span", { class: "muted small" }, "–"),
      el("input", {
        type: "number", class: "nm-input bac-range-input", placeholder: "max",
        "aria-label": "Maximum instance", value: bac.objectInstanceMax,
        oninput: (e) => { bac.objectInstanceMax = e.target.value; bacApplyObjectFilter(); },
      }),
    ),
    typeNames.length
      ? el("details", {
          class: "bac-type-filter",
          open: bac.objectTypesOpen ? "open" : undefined,
          ontoggle: (e) => { bac.objectTypesOpen = e.target.open; },
        },
          el("summary", {}, `Types${bac.objectTypeFilter.size ? ` (${bac.objectTypeFilter.size})` : ""}`),
          el("div", { class: "bac-type-chips" },
            ...typeChips,
            bac.objectTypeFilter.size
              ? el("button", { type: "button", class: "btn-ghost bac-type-clear", onclick: () => { bac.objectTypeFilter.clear(); renderAll(); } }, "Clear types")
              : null,
          ),
        )
      : null,
    el("div", { class: "bac-object-presets" },
      presets.length
        ? el("select", {
            class: "nm-input bac-preset-select", "aria-label": "Apply a saved filter preset",
            onchange: (e) => { if (e.target.value) bacApplyObjectPreset(e.target.value); },
          },
            el("option", { value: "" }, "Presets…"),
            ...presets.map((p) => el("option", { value: p }, p)),
          )
        : null,
      el("button", { type: "button", class: "btn-ghost", title: "Save the current filter as a preset", onclick: bacSaveObjectPreset }, "Save filter"),
      el("button", { type: "button", class: "btn-ghost", title: "Download the filtered object list as CSV", onclick: bacExportObjects }, "Export CSV"),
    ),
  );
}

// The bulk-action bar: shown once a device's objects are loaded so "Select all" and
// the name template are reachable; the import button enables when rows are checked.
function bacObjectBulkBar() {
  const n = bac.objectSelection.size;
  const visible = bacFilteredObjects().length;
  if (!bac.objects.length) return el("div", { id: "bac-object-bulkbar", class: "bac-object-bulkbar" });
  return el("div", { id: "bac-object-bulkbar", class: "bac-object-bulkbar bac-object-bulkbar-on" },
    el("span", { class: "muted small" }, n ? `${n} selected` : ""),
    el("input", {
      type: "text", class: "nm-input bac-name-template",
      placeholder: "Name template, e.g. {equip}-{type}{instance}",
      title: "Optional. Tokens: {equip} {type} {instance} {name}. Blank keeps each object's own name.",
      "aria-label": "Point name template",
      value: bac.objectNameTemplate,
      oninput: (e) => { bac.objectNameTemplate = e.target.value; },
    }),
    el("button", { type: "button", class: "btn-ghost", onclick: bacSelectAllFiltered }, `Select all${visible ? ` (${visible})` : ""}`),
    n ? el("button", { type: "button", class: "btn-ghost", onclick: bacClearObjectSelection }, "Clear") : null,
    el("button", {
      type: "button", class: "btn bac-bulk-import",
      disabled: n ? undefined : "disabled",
      title: "Model the selected objects as points under the active floor",
      onclick: bacBulkImportSelected,
    }, n ? `Import ${n} point${n === 1 ? "" : "s"}` : "Import points"),
  );
}

function bacAdapterTarget(adapterName = networkManager.selectedAdapterName()) {
  return adapterName ? bacSweepTargetFor(adapterName) : null;
}

function bacPropRows(flashIds) {
  if (bac.props.length === 0) {
    const msg = bac.propsLoading
      ? "Reading properties…"
      : "Select an object to read its properties.";
    return [el("tr", {}, el("td", { class: "muted small", colspan: "2" }, msg))];
  }
  return bac.props.map((p) => {
    const flash = flashIds && flashIds.has(p.id);
    return el("tr", { class: `${p.error ? "bac-prop-error" : ""}${flash ? " bac-prop-flash" : ""}` },
      el("td", { class: "bac-prop-name", title: `property ${p.id}` }, p.name),
      el("td", { class: "bac-prop-value" }, p.display),
    );
  });
}

// ---- alarms (GetEventInformation / GetAlarmSummary) ----

async function bacReadAlarms() {
  const dev = bacSelectedDevice();
  if (!dev || bac.alarms.loading) return;
  bac.alarms.loading = true;
  bac.alarms.deviceKey = dev.key;
  bac.alarms.error = null;
  renderAll();
  try {
    const entries = await bacnetRead().getAlarms(bacDeviceRef(dev));
    // Ignore if the user switched devices mid-read.
    if (bac.selectedDeviceKey !== dev.key) return;
    bac.alarms.entries = entries;
    bac.alarms.ran = true;
    const active = entries.filter((e) => e.eventState !== "normal").length;
    logTo("bacnet", `Read ${entries.length} alarm record${entries.length === 1 ? "" : "s"} from ${bacDeviceLabel(dev)} (${active} not normal).`, entries.length ? "ok" : "info");
  } catch (err) {
    if (bac.selectedDeviceKey !== dev.key) return;
    bac.alarms.entries = [];
    bac.alarms.error = String(err);
    bac.alarms.ran = true;
    logTo("bacnet", `Alarm read failed for ${bacDeviceLabel(dev)}: ${err}`, "error");
  } finally {
    // Clear loading whenever this read still owns the alarms slot, even if the
    // user switched devices mid-read — otherwise the button stays disabled.
    if (bac.alarms.deviceKey === dev.key) {
      bac.alarms.loading = false;
      renderAll();
    }
  }
}

async function bacAcknowledgeAlarm(alarm) {
  const dev = bacSelectedDevice();
  if (!dev) return;
  const label = `${alarm.typeName}:${alarm.instance}${alarm.name ? ` (${alarm.name})` : ""}`;
  const ok = await confirmAction({
    title: "Acknowledge alarm",
    message: `Acknowledge the "${alarm.eventState}" alarm on ${label} at ${bacDeviceLabel(dev)}? ` +
      `This writes an acknowledgment to the device and is logged.`,
    confirmLabel: "Acknowledge",
  });
  if (!ok) return;
  // Audit trail: record intent and outcome in the activity log.
  logTo("bacnet", `ACK requested — ${label} (${alarm.eventState}) on ${bacDeviceLabel(dev)}.`, "warn");
  try {
    await bacnetRead().acknowledgeAlarm({
      device: bacDeviceRef(dev),
      objectType: alarm.objectType,
      instance: alarm.instance,
    });
    logTo("bacnet", `ACK accepted by device — ${label}.`, "ok");
    toast(`Acknowledged ${label}`, "ok");
    await bacReadAlarms(); // refresh so the ack state reflects reality
  } catch (err) {
    logTo("bacnet", `ACK failed — ${label}: ${err}`, "error");
    toast(`Acknowledge failed: ${err}`, "error");
  }
}

function bacAlarmRows() {
  const fresh = bac.alarms.deviceKey === bac.selectedDeviceKey;
  const entries = fresh ? bac.alarms.entries : [];
  if (!entries.length) return [];
  return entries.map((a) => {
    const stateCls = a.eventState === "normal" ? "" : "bac-alarm-active";
    const action = a.acknowledged
      ? el("span", { class: "muted small" }, "ack'd")
      : el("button", {
          class: "btn-ghost",
          title: "Acknowledge this alarm on the device (writes)",
          onclick: () => bacAcknowledgeAlarm(a),
        }, "Ack");
    return el("tr", { class: stateCls },
      el("td", {}, `${a.typeName}:${a.instance}`),
      el("td", {}, a.name || "—"),
      el("td", {}, a.eventState),
      el("td", {}, a.acknowledged ? "yes" : "no"),
      el("td", {}, a.priority != null ? String(a.priority) : "—"),
      el("td", {}, a.timestamp || "—"),
      el("td", {}, action),
    );
  });
}

function bacAlarmsSection() {
  const dev = bacSelectedDevice();
  if (!dev) return null;
  const fresh = bac.alarms.deviceKey === dev.key;
  const rows = bacAlarmRows();
  let status = "";
  if (bac.alarms.loading && fresh) status = "Reading alarms…";
  else if (fresh && bac.alarms.error) status = `Error: ${bac.alarms.error}`;
  else if (fresh && bac.alarms.ran && rows.length === 0) status = "No active or unacknowledged alarms.";
  return el("section", { class: "plugin-section" },
    el("div", { class: "section-head" },
      el("h3", {}, `Alarms — ${bacDeviceLabel(dev)}`),
      el("button", {
        class: "btn-ghost",
        disabled: bac.alarms.loading ? "disabled" : undefined,
        title: "List active and unacknowledged alarms (GetEventInformation / GetAlarmSummary)",
        onclick: bacReadAlarms,
      }, bac.alarms.loading && fresh ? "…" : "Read alarms"),
    ),
    status ? el("p", { class: "muted small" }, status) : null,
    rows.length
      ? el("div", { class: "table-scroll" },
          el("table", { class: "bac-table" },
            el("thead", {}, el("tr", {},
              el("th", {}, "Object"),
              el("th", {}, "Name"),
              el("th", {}, "State"),
              el("th", {}, "Ack'd"),
              el("th", {}, "Priority"),
              el("th", {}, "Since"),
              el("th", {}, "Action"),
            )),
            el("tbody", {}, ...rows),
          ))
      : null,
  );
}

// ---- trend logs (ReadRange) ----

function bacObjectIsTrendLog(obj) {
  return obj && (obj.objectType === 20 || obj.objectType === 27); // trend-log / trend-log-multiple
}

async function bacReadTrend() {
  const dev = bacSelectedDevice();
  const obj = bacSelectedObject();
  if (!dev || !obj) return;
  const max = Math.max(1, Math.min(2000, parseInt(bac.trend.max, 10) || 200));
  bac.trend.loading = true;
  bac.trend.objectKey = bacObjectKey(obj);
  renderAll();
  try {
    const result = await bacnetRead().readTrend({
      device: bacDeviceRef(dev),
      objectType: obj.objectType,
      instance: obj.instance,
      maxRecords: max,
    });
    // Ignore if the user navigated away mid-read.
    if (bac.selectedObjectKey !== bacObjectKey(obj)) return;
    bac.trend.records = result.records;
    bac.trend.recordCount = result.recordCount;
    bac.trend.truncated = result.truncated;
    logTo("bacnet", `Read ${result.records.length} trend record${result.records.length === 1 ? "" : "s"} from ${obj.typeName}:${obj.instance}.`, "ok");
  } catch (err) {
    if (bac.selectedObjectKey !== bacObjectKey(obj)) return;
    logTo("bacnet", `Trend read failed for ${obj.typeName}:${obj.instance}: ${err}`, "error");
  } finally {
    if (bac.selectedObjectKey === bacObjectKey(obj)) {
      bac.trend.loading = false;
      renderAll();
    }
  }
}

function bacTrendToCsv() {
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = ["timestamp,value,status"];
  for (const r of bac.trend.records) {
    lines.push([r.timestamp, r.value, r.status].map(esc).join(","));
  }
  return lines.join("\r\n");
}

function bacExportTrend() {
  const obj = bacSelectedObject();
  const csv = bacTrendToCsv();
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: `trend-${obj ? `${obj.typeName}-${obj.instance}` : "log"}-${bacTimestamp()}.csv` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  logTo("bacnet", `Exported ${bac.trend.records.length} trend records to CSV.`, "ok");
}

function bacTrendPanel() {
  const recs = bac.trend.records;
  const rows = recs.length === 0
    ? [el("tr", {}, el("td", { class: "muted small", colspan: "3" },
        bac.trend.loading ? "Reading trend log…" : "No records read yet — click Read trend."))]
    : recs.map((r) => el("tr", {},
        el("td", { class: "bac-mono" }, r.timestamp),
        el("td", { class: "bac-prop-value" }, r.value),
        el("td", {}, r.status || el("span", { class: "muted" }, "—")),
      ));

  const maxInput = el("input", {
    type: "text", class: "nm-input bac-trend-max",
    title: "Max records to read",
    value: bac.trend.max,
    oninput: (e) => { bac.trend.max = e.target.value; },
  });

  return el("div", { class: "bac-trend" },
    el("div", { class: "section-head" },
      el("h4", {}, "Trend log"),
      bac.trend.recordCount
        ? el("span", { class: "muted small" }, `${bac.trend.recordCount} records on device${bac.trend.truncated ? ` · showing ${recs.length}` : ""}`)
        : null,
    ),
    el("div", { class: "action-row bac-trend-controls" },
      el("label", { class: "nm-field bac-trend-field" },
        el("span", { class: "nm-field-label" }, "Max records"), maxInput),
      el("button", {
        class: "btn btn-primary",
        disabled: bac.trend.loading ? "disabled" : undefined,
        onclick: bacReadTrend,
      }, bac.trend.loading ? "Reading…" : "Read trend"),
      el("button", {
        class: "btn-ghost",
        disabled: recs.length === 0 ? "disabled" : undefined,
        onclick: bacExportTrend,
      }, "Export CSV"),
    ),
    el("table", { class: "bac-table bac-trend-table" },
      el("thead", {}, el("tr", {},
        el("th", {}, "Timestamp"),
        el("th", {}, "Value"),
        el("th", {}, "Status"),
      )),
      el("tbody", {}, ...rows),
    ),
  );
}

function bacWritePanel() {
  const dev = bacSelectedDevice();
  const obj = bacSelectedObject();
  const disabled = !dev || !obj ? "disabled" : undefined;

  const propInput = el("input", {
    type: "text", class: "nm-input bac-write-prop", disabled,
    title: "Property number (85 = present-value)",
    value: bac.write.propertyId,
    oninput: (e) => { bac.write.propertyId = e.target.value; },
  });
  const kindSelect = el("select", {
    class: "nm-input bac-write-kind", disabled,
    onchange: (e) => { bac.write.kind = e.target.value; },
  },
    ...[
      ["real", "Real"],
      ["unsigned", "Unsigned"],
      ["signed", "Signed"],
      ["enumerated", "Enumerated"],
      ["boolean", "Boolean"],
      ["characterString", "Text"],
      ["null", "Null"],
    ].map(([v, label]) => el("option", {
      value: v,
      selected: bac.write.kind === v ? "selected" : undefined,
    }, label)),
  );
  const valueInput = el("input", {
    type: "text", class: "nm-input bac-write-value", disabled,
    placeholder: "value (e.g. 72.5)",
    value: bac.write.value,
    oninput: (e) => { bac.write.value = e.target.value; },
  });
  const prioritySelect = el("select", {
    class: "nm-input bac-write-priority", disabled,
    title: "Command priority (8 = manual operator)",
    onchange: (e) => { bac.write.priority = e.target.value; },
  },
    el("option", { value: "" }, "no priority"),
    ...Array.from({ length: 16 }, (_, i) => el("option", {
      value: String(i + 1),
      selected: bac.write.priority === String(i + 1) ? "selected" : undefined,
    }, `priority ${i + 1}`)),
  );

  return el("div", { class: "bac-write" },
    el("div", { class: "bac-write-row" },
      el("label", { class: "nm-field bac-write-field" },
        el("span", { class: "nm-field-label" }, "Property #"), propInput),
      el("label", { class: "nm-field bac-write-field" },
        el("span", { class: "nm-field-label" }, "Type"), kindSelect),
      el("label", { class: "nm-field bac-write-field bac-write-grow" },
        el("span", { class: "nm-field-label" }, "Value"), valueInput),
      el("label", { class: "nm-field bac-write-field" },
        el("span", { class: "nm-field-label" }, "Priority"), prioritySelect),
    ),
    el("div", { class: "action-row" },
      el("button", { class: "btn btn-primary", disabled, onclick: () => bacWrite(false) }, "Write"),
      el("button", {
        class: "btn-ghost", disabled,
        title: "Write Null at the selected priority to release the slot",
        onclick: () => bacWrite(true),
      }, "Relinquish"),
      el("button", { class: "btn-ghost", disabled, onclick: bacRefreshProps }, "Refresh"),
    ),
  );
}

// Directed-broadcast address for an adapter (e.g. 192.168.7.255 for a /21),
// derived from the Network Manager's live adapter state. Null when unusable.
function bacDirectedBroadcastFor(adapterName) {
  const { stateByAdapter } = networkManager.getAdapterSnapshot();
  const st = stateByAdapter[adapterName];
  if (!st || !st.ipAddress) return null;
  const prefix = networkManager.maskToPrefix(st.subnetMask);
  if (prefix == null || prefix < 8 || prefix > 30) return null;
  const p = st.ipAddress.split(".").map((n) => parseInt(n, 10));
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return null;
  const ip = ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const bcast = (ip | ~mask) >>> 0;
  return [(bcast >>> 24) & 255, (bcast >>> 16) & 255, (bcast >>> 8) & 255, bcast & 255].join(".");
}

// Discovery target(s) for an adapter. For subnets wider than /24 this also
// sweeps every /24 directed broadcast inside the range — flat BAS networks
// often mix masks, and a /24-configured controller ignores the /21 broadcast.
function bacSweepTargetFor(adapterName) {
  const { stateByAdapter } = networkManager.getAdapterSnapshot();
  const st = stateByAdapter[adapterName];
  if (!st || !st.ipAddress) return null;
  const prefix = networkManager.maskToPrefix(st.subnetMask);
  if (prefix == null || prefix < 16 || prefix > 30) return null;
  const bcast = bacDirectedBroadcastFor(adapterName);
  if (!bcast) return null;
  if (prefix >= 24) return { value: bcast, label: bcast };
  const p = st.ipAddress.split(".").map((n) => parseInt(n, 10));
  const ip = ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  const net = (ip & mask) >>> 0;
  const count = Math.min(Math.pow(2, 24 - prefix), 32); // cap the sweep at 32 /24s
  const targets = [bcast];
  for (let i = 0; i < count; i++) {
    const sub = (net + i * 256) >>> 0;
    targets.push([(sub >>> 24) & 255, (sub >>> 16) & 255, (sub >>> 8) & 255, 255].join("."));
  }
  const netStr = [(net >>> 24) & 255, (net >>> 16) & 255, (net >>> 8) & 255, net & 255].join(".");
  return { value: targets.join(","), label: `${netStr}/${prefix} sweep` };
}

// One clickable chip per adapter subnet, so multi-NIC machines (VPN, WSL,
// Hyper-V) can aim the Who-Is at the right network in one click.
function bacTargetChips() {
  const chips = [];
  const seen = new Set();
  const { loaded, adapters } = networkManager.getAdapterSnapshot();
  for (const a of adapters) {
    const t = bacSweepTargetFor(a.name);
    if (!t || seen.has(t.value)) continue;
    seen.add(t.value);
    chips.push(el("button", {
      class: `bac-chip ${bac.target === t.value ? "bac-chip-on" : ""}`,
      title: `Who-Is target(s) for ${a.name}`,
      disabled: bac.discovering ? "disabled" : undefined,
      onclick: () => { bac.target = t.value; renderAll(); },
    }, `${a.name} · ${t.label}`));
  }
  if (chips.length === 0) {
    return el("p", { class: "muted small bac-chip-row" },
      loaded ? "" : "Reading adapters for subnet suggestions…");
  }
  return el("div", { class: "bac-chip-row" }, ...chips);
}

function renderBacnetPage() {
  bacEnsureListeners();
  networkManager.ensureLoaded(); // adapter state feeds the target suggestions

  const targetInput = el("input", {
    type: "text", class: "nm-input",
    placeholder: "255.255.255.255 or 192.168.1.255 or a device IP",
    disabled: bac.discovering ? "disabled" : undefined,
    value: bac.target,
    oninput: (e) => { bac.target = e.target.value; },
  });
  const lowInput = el("input", {
    type: "text", class: "nm-input bac-range-input", placeholder: "low",
    disabled: bac.discovering ? "disabled" : undefined,
    value: bac.lowLimit,
    oninput: (e) => { bac.lowLimit = e.target.value; },
  });
  const highInput = el("input", {
    type: "text", class: "nm-input bac-range-input", placeholder: "high",
    disabled: bac.discovering ? "disabled" : undefined,
    value: bac.highLimit,
    oninput: (e) => { bac.highLimit = e.target.value; },
  });
  const discoverBtn = el("button", {
    class: "btn btn-primary",
    disabled: bac.discovering ? "disabled" : undefined,
    onclick: bacDiscover,
  }, bac.discovering ? "Discovering…" : "Discover");

  // Offered only when the platform kernel resolved BACnet's optional dependency
  // on the netscan capability (i.e. Network Manager is present).
  const scanBtn = platformHost("bacnet")?.has("netscan.v1")
    ? el("button", {
        class: "btn btn-ghost",
        disabled: bac.discovering ? "disabled" : undefined,
        title: "Use Network Manager's scanner to list live hosts on your subnet",
        onclick: bacSuggestTargets,
      }, "Find live hosts")
    : null;

  const fdrRegistered = !!bac.bbmd.status;
  const bbmdInput = el("input", {
    type: "text", class: "nm-input",
    placeholder: "BBMD IP (e.g. 10.0.5.1)",
    disabled: (fdrRegistered || bac.bbmd.busy) ? "disabled" : undefined,
    value: bac.bbmd.address,
    oninput: (e) => { bac.bbmd.address = e.target.value; },
  });
  const bbmdTtlInput = el("input", {
    type: "text", class: "nm-input bac-range-input", placeholder: "TTL s",
    disabled: (fdrRegistered || bac.bbmd.busy) ? "disabled" : undefined,
    value: bac.bbmd.ttl,
    oninput: (e) => { bac.bbmd.ttl = e.target.value; },
  });
  const bbmdBtn = el("button", {
    class: fdrRegistered ? "btn btn-ghost" : "btn",
    disabled: bac.bbmd.busy ? "disabled" : undefined,
    onclick: bacToggleForeignDevice,
  }, bac.bbmd.busy ? "…" : (fdrRegistered ? "Unregister" : "Register"));

  const discoverSection = el("section", { class: "plugin-section" },
    el("div", { class: "nm-pane-head" },
      el("div", { class: "nm-pane-head-text" },
        el("h3", {}, "Discover devices"),
        el("p", { class: "muted small nm-section-sub" },
          "Broadcasts a Who-Is on UDP 47808. Use a directed broadcast (x.x.x.255) for a ",
          "specific subnet, or a device's IP to probe it directly across subnets."),
      ),
    ),
    el("div", { class: "bac-discover-controls" },
      el("label", { class: "nm-field bac-target-field" },
        el("span", { class: "nm-field-label" }, "Target"), targetInput),
      el("label", { class: "nm-field" },
        el("span", { class: "nm-field-label" }, "Instance range (optional)"),
        el("div", { class: "bac-range-pair" }, lowInput, el("span", { class: "muted" }, "–"), highInput),
      ),
      discoverBtn,
      scanBtn,
    ),
    el("div", { class: "bac-discover-controls bac-fdr-controls" },
      el("label", { class: "nm-field bac-target-field" },
        el("span", { class: "nm-field-label" }, "BBMD (foreign device)"), bbmdInput),
      el("label", { class: "nm-field" },
        el("span", { class: "nm-field-label" }, "TTL"), bbmdTtlInput),
      bbmdBtn,
      fdrRegistered
        ? el("span", { class: "muted small" },
            `Registered with ${bac.bbmd.status.bbmd} — broadcasts route through the BBMD.`)
        : el("span", { class: "muted small" },
            "Optional: reach devices on other IP subnets via a BBMD."),
    ),
    bac.discovering ? bacDiscoveryProgressEl("bac-discovery-progress") : null,
    bacTargetChips(),
  );

  const hasDevices = bac.devices.length > 0;
  const devicesSection = el("section", { class: "plugin-section plugin-section-fill" },
    el("div", { class: "section-head" },
      el("h3", {}, "Devices"),
      el("span", { id: "bac-device-count", class: "muted small" }, bacDeviceCountText()),
      bacDriftSummaryEl(),
    ),
    hasDevices
      ? el("div", { class: "bac-device-toolbar" },
          el("input", {
            type: "search",
            class: "nm-input bac-device-filter",
            placeholder: "Filter by instance, name, address, vendor, model…",
            "aria-label": "Filter devices",
            value: bac.deviceFilter,
            oninput: (e) => { bac.deviceFilter = e.target.value; bacApplyDeviceView(); },
          }),
          el("button", {
            class: "btn-ghost", title: "Copy visible devices as CSV", onclick: bacCopyDevices,
          }, "Copy"),
          el("button", {
            class: "btn-ghost", title: "Download visible devices as a CSV file", onclick: bacExportDevices,
          }, "Export CSV"),
        )
      : null,
    // Static scroll wrapper; bacApplyDeviceView swaps the inner <table> in place (no re-nesting).
    el("div", { class: "table-scroll table-scroll-fill" }, bacDeviceTableEl()),
  );

  const dev = bacSelectedDevice();
  const obj = bacSelectedObject();

  const objectsPane = el("div", { class: "bac-objects-pane" },
    el("div", { class: "section-head" },
      el("h3", {}, dev ? `Objects — ${bacDeviceLabel(dev)}` : "Objects"),
      el("span", { id: "bac-object-count", class: "muted small" }, bacObjectCountText()),
    ),
    bacObjectToolbar(),
    bacObjectBulkBar(),
    el("p", { id: "bac-objects-status", class: "muted small" },
      bac.objectsLoading
        ? (bac.objectsProgress
            ? `Walking object-list… ${bac.objectsProgress.done}/${bac.objectsProgress.total}`
            : "Reading object list…")
        : ""),
    el("ul", { id: "bac-object-list", class: "bac-object-list" }, ...bacObjectRows()),
  );

  const covOn = bacCovActive();
  const covBtn = el("button", {
    class: `btn-ghost bac-cov-btn ${covOn ? "bac-cov-on" : ""}`,
    disabled: !obj || bac.cov.busy ? "disabled" : undefined,
    title: "Subscribe to Change-of-Value notifications for live updates",
    onclick: bacToggleCov,
  }, bac.cov.busy ? "…" : covOn ? "Stop live" : "Subscribe live (COV)");

  const propsPane = el("div", { class: "bac-props-pane" },
    el("div", { class: "section-head" },
      el("h3", {}, obj ? `Properties — ${obj.typeName}:${obj.instance}` : "Properties"),
      el("div", { class: "bac-props-head-right" },
        covOn ? el("span", { id: "bac-cov-badge", class: "pill pill-running bac-cov-badge" },
          `live · ${bac.cov.updates} update${bac.cov.updates === 1 ? "" : "s"}`) : null,
        obj && obj.name ? el("span", { class: "muted small" }, obj.name) : null,
        covBtn,
      ),
    ),
    el("table", { class: "bac-table bac-props-table" },
      el("thead", {}, el("tr", {},
        el("th", {}, "Property"),
        el("th", {}, "Value"),
      )),
      el("tbody", { id: "bac-props-body" }, ...bacPropRows()),
    ),
    bacObjectIsTrendLog(obj) ? bacTrendPanel() : null,
    bacWritePanel(),
  );

  const browseSection = el("section", { class: "plugin-section plugin-section-fill" },
    el("div", { class: "bac-browse" }, objectsPane, propsPane),
  );

  return el("div", { class: "plugin-controls plugin-controls-fill bac-root" },
    discoverSection,
    devicesSection,
    browseSection,
    bacAlarmsSection(),
  );
}

// ============================================================================

function flushOnPageHide() {
  if (bac.cov.processId != null && bac.cov.objectKey) {
    const dev = bacSelectedDevice();
    const [t, i] = bac.cov.objectKey.split(":").map((n) => parseInt(n, 10));
    if (dev) {
      bacnetRead().unsubscribeCov({
        device: bacDeviceRef(dev), objectType: t, instance: i, processId: bac.cov.processId,
      }).catch(() => {});
    }
  }
}

return {
  renderStatusPill: bacStatusPill,
  renderPage: renderBacnetPage,
  ensureListeners: bacEnsureListeners,
  adapterTarget: bacAdapterTarget,
  discover: bacDiscover,
  setTarget: (value) => { bac.target = value; },
  getDevices: () => bac.devices,
  clearDevices: () => { bac.devices = []; },
  getDiscoveryRan: () => bac.discoveryRan,
  getLastDiscoveryCount: () => bac.lastDiscoveryCount,
  clearDiscovery: () => {
    bac.devices = [];
    bac.discoveryRan = false;
    bac.lastDiscoveryCount = null;
  },
  isDiscovering: () => bac.discovering,
  addressText: bacAddressText,
  vendorText: bacVendorText,
  deviceLabel: bacDeviceLabel,
  deviceRef: bacDeviceRef,
  discoveryProgressEl: bacDiscoveryProgressEl,
  getPropsForObject: (obj) => (bacObjectKey(obj) === bac.selectedObjectKey ? bac.props : []),
  getTarget: () => bac.target,
  getSelectedDevice: bacSelectedDevice,
  bacnetRead,
  flushOnPageHide,
};
}
