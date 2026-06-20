// BACnet Manager — discovery, browse, COV, alarms.

import {
  bacnetUnitSymbol,
  bwClassifyDiscovery,
  bwPlanDeviceObjects,
  pointEntityFromBacnet,
} from "../building-workspace.js";
import { createBacnetInboxUi } from "./bacnet-inbox.js";
import { bacnetObjectKey, resolveBacnetObject } from "../bacnet-objects.js";
import { closeModal, confirmAction, openModal } from "../../ui/modal.js";
import { lineChartCanvas } from "../../ui/chart.js";
import {
  attachPaneDrag,
  attachPaneDragRight,
  buildGridColumns,
  clampPaneWidth,
  createPaneSplitter,
  paneSplitterKeyHandler,
  updateSplitterAria,
} from "../../ui/split-pane.js";
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
 * @param {(scope?: string) => void} deps.renderScoped
 * @param {(view: string) => void} deps.setView
 * @param {(id: string) => string} deps.pluginView
 */
export function createBacnetManagerUi({
  invoke, listen, el, logTo, renderAll, renderScoped, networkManager, platformHost,
  userState, saveUserState, currentPluginId, getInventory, setView, pluginView,
}) {

function inventoryInstance() {
  return getInventory ? getInventory() : null;
}

function discoveryApi() {
  return {
    adapterTarget: bacAdapterTarget,
    discover: bacDiscover,
    setTarget: (value) => { bac.target = value; },
    getDevices: () => bac.devices,
    clearDiscovery: () => {
      bac.devices = [];
      bac.discoveryRan = false;
      bac.lastDiscoveryCount = null;
      bac.driftSummary = null;
      bac.driftMissing = [];
      bac.deviceStatusByKey = {};
      bac.selectedDeviceKey = null;
      bac.objects = [];
      bac.objectPropCache = {};
      bac.objectPropsLoadToken += 1;
      bac.objectPropsLoading = false;
      bac.objectSelection.clear();
      bac.activeObjectKey = null;
      bac.deviceCaps = {};
      bac.alarms = { loading: false, entries: [], deviceKey: null, error: null, ran: false };
      bacClearPersistedDiscovery();
    },
    getDiscoveryRan: () => bac.discoveryRan,
    getLastDiscoveryCount: () => bac.lastDiscoveryCount,
    isDiscovering: () => bac.discovering,
    getDriftSummary: () => bac.driftSummary,
    getDriftMissing: () => bac.driftMissing,
    driftSummaryEl: bacDriftSummaryEl,
    deviceDriftBadge: bacDeviceStatusBadge,
    addressText: bacAddressText,
    vendorText: bacVendorText,
    deviceRef: bacDeviceRef,
    discoveryProgressEl: bacDiscoveryProgressEl,
    getTarget: () => bac.target,
    getDeviceDriftStatus: (key) => bac.deviceStatusByKey[key] || null,
  };
}

function bacModelPathItems(inv, entity) {
  if (!inv || !entity) return [];
  const items = [];
  const site = entity.siteId ? inv.getEntity(entity.siteId) : null;
  const building = entity.buildingId ? inv.getEntity(entity.buildingId) : null;
  const floor = entity.floorId ? inv.getEntity(entity.floorId) : null;
  for (const candidate of [site, building, floor, entity.type === "equip" ? entity : null]) {
    if (candidate && !items.some((item) => item.id === candidate.id)) items.push(candidate);
  }
  if (!items.some((item) => item.id === entity.id)) items.push(entity);
  return items;
}

let _inboxUi = null;
function inboxUi() {
  if (!_inboxUi) {
    _inboxUi = createBacnetInboxUi({
      el, logTo, renderAll, renderScoped, userState, saveUserState,
      getInventory: inventoryInstance, discovery: discoveryApi(), networkManager,
      setView, pluginView, currentPluginId,
      breadcrumbItems: bacModelPathItems,
      selectDeviceForBrowse: (key) => {
        if (key) bacSelectDevice(key);
        else {
          bac.selectedDeviceKey = null;
          bac.objects = [];
          bac.objectPropCache = {};
          bac.objectPropsLoadToken += 1;
          bac.objectPropsLoading = false;
          bac.activeObjectKey = null;
          renderAll();
        }
      },
      getBrowseDeviceKey: () => bac.selectedDeviceKey,
      getDeviceFilter: () => bac.deviceFilter,
      setDeviceFilter: (value) => { bac.deviceFilter = value; },
      onCopyDevices: bacCopyDevices,
      onExportDevices: bacExportDevices,
    });
  }
  return _inboxUi;
}

function bacImportTargetFloor(inv) {
  const floorId = userState.bacnetManager?.importFloorId;
  if (!floorId) return null;
  const floor = inv.getEntity(floorId);
  return floor?.type === "floor" ? floor : null;
}

// ============================================================================

const BAC_BROWSE_PROPERTY_COLUMNS = [
  { id: 85, label: "Present value" },
  { id: 111, label: "Status flags" },
  { id: 117, label: "Units" },
  { id: 28, label: "Description" },
  { id: 103, label: "Event state" },
  { id: 44, label: "Out of service" },
  { id: 81, label: "Min pres value" },
  { id: 69, label: "Max pres value" },
];

let bac = {
  discovering: false,
  discoveryStartedAt: 0,
  discoveryDurationMs: 5000,
  discoveryTimer: null,
  enrichProgress: null,   // { done, total } during the post-discovery name-enrichment phase
  cancelling: false,      // a cancel request is in flight
  diagnostics: null,      // { listenerBound, listenerPort, localAddress, foreignDevice }
  devices: [],            // BacnetDevice[] from the backend (key, address, instance, …)
  deviceFilter: "",       // free-text over instance/name/address/vendor/model
  deviceSortKey: "instance", // "instance" | "name" | "address" | "vendor" | "model"
  deviceSortDir: "asc",
  selectedDeviceKey: null,
  objects: [],            // BacnetObject[] for the selected device
  objectsLoading: false,
  objectsError: null,     // message shown in-table when the object-list read fails
  objectsProgress: null,  // { done, total } during index-by-index walks
  objectFilter: "",
  objectTypeFilter: new Set(), // selected typeName strings; empty = all types
  objectInstanceMin: "",
  objectInstanceMax: "",
  objectSelection: new Set(),  // "type:instance" keys chosen for bulk import
  activeObjectKey: null,       // "type:instance" of the single object open in the detail pane
  objectNameTemplate: "",      // optional naming template for bulk import
  objectTypesOpen: false,      // is the type-filter <details> popover open
  objectColumnsOpen: false,
  objectViewOpen: false,       // is the consolidated "View" popover open
  objectColumnsVisible: new Set([85, 111]),
  objectPropCache: {},         // object key -> { loading, error, props, byId }
  objectPropsLoading: false,
  objectPropsLoadToken: 0,
  pendingObjectNames: new Map(), // deviceKey -> Map<objectKey, name>
  cov: { processId: null, objectKey: null, busy: false, updates: 0, lastAt: null },
  trend: { loading: false, records: [], recordCount: 0, truncated: false, objectKey: null, max: "200" },
  alarms: { loading: false, entries: [], deviceKey: null, error: null, ran: false },
  deviceTab: "objects",   // center pane: "objects" | "alarms"
  write: { propertyId: "85", kind: "real", value: "", priority: "", arrayIndex: "" },
  writeArmed: false,           // safety latch: writes/relinquish stay disabled until armed
  deviceCaps: {},              // deviceKey -> { cov?:false, trend?:false, alarms?:false } learned from rejects
  target: "255.255.255.255",
  lowLimit: "",
  highLimit: "",
  // Foreign-device (BBMD) registration: reach broadcast discovery across subnets.
  bbmd: { address: "", ttl: "60", status: null, busy: false },
  listenersReady: false,
  discoveryRan: false,
  lastDiscoveryCount: null,
  driftSummary: null,          // { new, returning, changed, missing } vs the last scan
  driftMissing: [],            // devices seen previously but absent in the latest scan
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

// Reactive capability memory: many controllers don't implement optional
// services (COV, ReadRange, GetEventInformation/GetAlarmSummary). Once a device
// answers with unrecognized-service we remember it and gray out that action so
// the operator isn't offered a button that will only ever error.
function bacIsUnsupportedError(err) {
  return /unrecognized-service|unsupported|not supported/i.test(String(err || ""));
}

function bacMarkCapUnsupported(deviceKey, cap) {
  if (!deviceKey) return;
  const caps = bac.deviceCaps[deviceKey] || (bac.deviceCaps[deviceKey] = {});
  caps[cap] = false;
}

// True unless the device is known not to support this capability.
function bacCapSupported(deviceKey, cap) {
  return bac.deviceCaps[deviceKey]?.[cap] !== false;
}

// The DeviceRef the backend needs to reach a device (router addressing included).
// maxApdu + segmentation let the backend segment an outbound request that won't
// fit the device's APDU (e.g. a large WriteProperty), or reject it up front when
// the device can't receive segments.
function bacDeviceKey(d) {
  if (!d) return "";
  return `${d.address}|${d.network ?? ""}|${d.mac ?? ""}|${d.instance}`;
}

function bacDeviceRef(d) {
  return {
    address: d.address,
    network: d.network ?? null,
    mac: d.mac ?? null,
    maxApdu: d.maxApdu ?? null,
    segmentation: d.segmentation ?? null,
  };
}

function bacObjectKey(o) { return bacnetObjectKey(o); }

function bacNamesLoading() {
  if (!bac.objects.length || bac.objectsLoading) return false;
  const dev = bacSelectedDevice();
  if (!dev) return false;
  return bac.pendingObjectNames.has(bacDeviceKey(dev));
}

function bacPatchObjectsStatus() {
  const node = document.getElementById("bac-objects-status");
  if (!node) return;
  if (bac.objectsLoading) {
    node.textContent = bac.objectsProgress
      ? `Walking object-list… ${bac.objectsProgress.done}/${bac.objectsProgress.total}`
      : "Reading object list…";
  } else if (bacNamesLoading()) {
    node.textContent = "Loading object names…";
  } else if (bac.objectPropsLoading) {
    node.textContent = "Reading property values…";
  } else {
    node.textContent = "";
  }
}

function bacStageObjectNames(deviceKey, entries) {
  if (!deviceKey || !entries?.length) return;
  let store = bac.pendingObjectNames.get(deviceKey);
  if (!store) {
    store = new Map();
    bac.pendingObjectNames.set(deviceKey, store);
  }
  for (const { key, name } of entries) {
    if (key && name) store.set(key, name);
  }
  bacFlushObjectNames(deviceKey);
}

function bacFlushObjectNames(deviceKey) {
  const store = bac.pendingObjectNames.get(deviceKey);
  if (!store) return;
  const dev = bacSelectedDevice();
  if (!dev || bacDeviceKey(dev) !== deviceKey || !bac.objects.length) return;
  for (const o of bac.objects) {
    const n = store.get(bacObjectKey(o));
    if (n) o.name = n;
  }
  store.clear();
  bac.pendingObjectNames.delete(deviceKey);
  bacApplyObjectFilter();
  bacPatchObjectsStatus();
}

function bacPropsForObject(obj) {
  return bac.objectPropCache[bacObjectKey(obj)]?.props || [];
}

function bacRestoreBrowseColumns() {
  const saved = userState.bacnetManager?.objectColumnsVisible;
  if (Array.isArray(saved) && saved.length) {
    bac.objectColumnsVisible = new Set(
      saved.map((n) => Number(n)).filter(Number.isFinite),
    );
  }
}

function bacColumnPickerLabel() {
  const n = bac.objectColumnsVisible.size;
  return n ? `Columns (${n})` : "Columns";
}

function bacPatchColumnPicker() {
  const summary = document.getElementById("bac-column-picker-summary");
  if (summary) summary.textContent = bacColumnPickerLabel();
  document.querySelectorAll(".bac-column-picker-item input[type=checkbox]").forEach((input) => {
    const id = Number(input.dataset.columnId);
    if (Number.isFinite(id)) input.checked = bac.objectColumnsVisible.has(id);
  });
}

function bacEnsureBacnetManagerState() {
  if (!userState.bacnetManager || typeof userState.bacnetManager !== "object") userState.bacnetManager = {};
}

function bacSerializeDevice(d) {
  return {
    key: d.key,
    address: d.address,
    network: d.network ?? null,
    mac: d.mac ?? null,
    instance: d.instance,
    maxApdu: d.maxApdu,
    segmentation: d.segmentation,
    vendorId: d.vendorId,
    name: d.name ?? "",
    vendorName: d.vendorName ?? "",
    modelName: d.modelName ?? "",
  };
}

// Cap how many devices we serialize to localStorage. A large site can discover
// thousands of devices; persisting them all (plus the drift baseline) can blow
// past the ~5 MB localStorage quota and fail every future save. We keep the
// in-memory list intact and only bound what's written.
const BAC_MAX_PERSIST_DEVICES = 1500;

function bacPersistDiscovery() {
  bacEnsureBacnetManagerState();
  const all = bac.devices;
  const capped = all.length > BAC_MAX_PERSIST_DEVICES;
  const devices = (capped ? all.slice(0, BAC_MAX_PERSIST_DEVICES) : all).map(bacSerializeDevice);
  userState.bacnetManager.discovery = {
    devices,
    discoveredAt: new Date().toISOString(),
    lastDiscoveryCount: bac.lastDiscoveryCount,
    discoveryRan: bac.discoveryRan,
    selectedDeviceKey: bac.selectedDeviceKey,
    truncated: capped ? all.length : undefined,
  };
  if (capped) {
    logTo("bacnet-manager", `Persisting first ${BAC_MAX_PERSIST_DEVICES} of ${all.length} devices (cache cap); the live list is complete.`, "info");
  }
  saveUserState();
}

function bacClearPersistedDiscovery() {
  bacEnsureBacnetManagerState();
  if (userState.bacnetManager.discovery) {
    delete userState.bacnetManager.discovery;
    saveUserState();
  }
}

function bacRestoreDiscovery() {
  if (bac.devices.length > 0) return false;
  const saved = userState.bacnetManager?.discovery;
  if (!Array.isArray(saved?.devices) || saved.devices.length === 0) return false;
  bac.devices = saved.devices.map((d) => ({ ...d }));
  bac.discoveryRan = !!saved.discoveryRan;
  bac.lastDiscoveryCount = saved.lastDiscoveryCount ?? saved.devices.length;
  const pendingKey = saved.selectedDeviceKey || null;
  bac.selectedDeviceKey = null;
  if (pendingKey && bac.devices.some((d) => d.key === pendingKey)) {
    queueMicrotask(() => { bacSelectDevice(pendingKey); });
  }
  return true;
}

function bacDiscoveryAgeLabel() {
  const at = userState.bacnetManager?.discovery?.discoveredAt;
  if (!at) return null;
  const ms = Date.now() - Date.parse(at);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

function bacSaveBrowseColumns() {
  bacEnsureBacnetManagerState();
  userState.bacnetManager.objectColumnsVisible = [...bac.objectColumnsVisible];
  saveUserState();
}

function bacVisibleObjectColumns() {
  return BAC_BROWSE_PROPERTY_COLUMNS.filter((c) => bac.objectColumnsVisible.has(c.id));
}

function bacBrowseColCount() {
  return 4 + bacVisibleObjectColumns().length;
}

function bacToggleObjectColumn(id) {
  const pid = Number(id);
  if (!Number.isFinite(pid)) return;
  if (bac.objectColumnsVisible.has(pid)) bac.objectColumnsVisible.delete(pid);
  else bac.objectColumnsVisible.add(pid);
  bacSaveBrowseColumns();
  bacPatchBrowseTable();
}

function bacPropFromCache(cache, propId) {
  if (!cache?.byId) return null;
  return cache.byId[propId] ?? cache.byId[String(propId)] ?? null;
}

function bacObjectPropertyCell(o, col) {
  const key = bacObjectKey(o);
  const cellId = `${key}:${col.id}`;
  const cache = bac.objectPropCache[key];
  if (!cache) {
    return el("td", { class: "bac-prop-value muted small", "data-bac-cell": cellId });
  }
  if (cache.loading) {
    return el("td", { class: "bac-prop-value muted small", "data-bac-cell": cellId }, "…");
  }
  if (cache.error) {
    return el("td", { class: "bac-prop-value muted small", "data-bac-cell": cellId, title: cache.error }, "—");
  }
  const p = bacPropFromCache(cache, col.id);
  return el("td", {
    class: "bac-prop-value",
    "data-bac-cell": cellId,
    title: p ? `property ${col.id}` : undefined,
  }, p?.display ?? "—");
}

async function bacLoadObjectPropertyValues() {
  const dev = bacSelectedDevice();
  if (!dev || !bac.objects.length || !bacVisibleObjectColumns().length) return;
  const token = ++bac.objectPropsLoadToken;
  bac.objectPropsLoading = true;
  bacPatchBrowseTable();
  const objects = bacFilteredObjects();
  const api = bacnetRead();
  const ref = bacDeviceRef(dev);
  let idx = 0;
  const workers = 4;
  async function readOne() {
    while (idx < objects.length) {
      if (token !== bac.objectPropsLoadToken) return;
      const o = objects[idx++];
      const key = bacObjectKey(o);
      const cached = bac.objectPropCache[key];
      if (cached?.props && !cached.error) continue;
      bac.objectPropCache[key] = { loading: true, props: null, error: null, byId: {} };
      bacPatchObjectPropertyCells(key);
      try {
        const props = await api.readPoint(ref, o.objectType, o.instance);
        if (token !== bac.objectPropsLoadToken) return;
        bac.objectPropCache[key] = {
          loading: false,
          props,
          error: null,
          byId: Object.fromEntries(props.map((p) => [String(p.id), p])),
        };
      } catch (err) {
        if (token !== bac.objectPropsLoadToken) return;
        bac.objectPropCache[key] = { loading: false, props: [], error: String(err), byId: {} };
      }
      bacPatchObjectPropertyCells(key);
    }
  }
  await Promise.all(Array.from({ length: workers }, readOne));
  if (token === bac.objectPropsLoadToken) {
    bac.objectPropsLoading = false;
    bacPatchBrowseTable();
  }
}

function bacPatchObjectPropertyCells(objectKey) {
  const row = document.querySelector(`tr[data-bac-object-key="${objectKey}"]`);
  if (!row) return;
  const obj = bac.objects.find((o) => bacObjectKey(o) === objectKey);
  if (!obj) return;
  for (const col of bacVisibleObjectColumns()) {
    const cell = row.querySelector(`[data-bac-cell="${objectKey}:${col.id}"]`);
    if (!cell) continue;
    const next = bacObjectPropertyCell(obj, col);
    cell.replaceWith(next);
  }
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
  // Once names start enriching we have real per-device progress; map it onto
  // the back half of the bar (60→100%) so the long finalize phase isn't an
  // indeterminate "almost done" on large sites.
  const enrich = bac.enrichProgress;
  if (bac.cancelling) {
    return { pct: 100, finalizing: true, phase: "Cancelling…", remainingText: "", found: bac.devices.length };
  }
  if (enrich && enrich.total > 0) {
    const frac = Math.min(1, enrich.done / enrich.total);
    return {
      pct: 60 + Math.round(frac * 40),
      finalizing: true,
      phase: "Enriching device names",
      remainingText: `${enrich.done} / ${enrich.total}`,
      found: bac.devices.length,
    };
  }
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
  return el("div", { id, class: "bac-discovery-progress", role: "status", "aria-live": "polite" },
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
  const node = document.getElementById("bac-discovery-progress");
  if (node) {
    const next = bacDiscoveryProgressEl("bac-discovery-progress");
    if (next) node.replaceWith(next);
    else node.remove();
  }
  inboxUi().patchDevicePanelLive?.();
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

// After a webview reload the Rust foreign-device keep-alive may still be
// holding a BBMD registration open; query it once so the UI reflects reality
// instead of showing "not registered" until the user reopens Settings.
let bacForeignStatusQueried = false;
function bacEnsureForeignDeviceStatus() {
  if (bacForeignStatusQueried) return;
  bacForeignStatusQueried = true;
  Promise.resolve()
    .then(() => bacnetRead().foreignDeviceStatus())
    .then((status) => {
      if (status) {
        bac.bbmd.status = status;
        if (!bac.bbmd.address) bac.bbmd.address = status.bbmd || "";
        renderAll();
      }
    })
    .catch((err) => console.warn("bacnet foreignDeviceStatus failed:", err));
}

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
  listen("bacnet:enrich_progress", (e) => {
    if (!bac.discovering) return;
    bac.enrichProgress = e.payload;
    bacRenderDiscoveryProgressLive();
  }).catch((e) => console.warn("listen bacnet:enrich_progress failed:", e));
  listen("bacnet:object_names", (e) => {
    // Names stream from a detached pass; ignore batches for a device we've
    // already navigated away from. Events can beat listObjects() returning,
    // so stage names and flush once bac.objects is populated.
    const payload = e.payload;
    if (!payload?.deviceKey) return;
    const dev = bacSelectedDevice();
    if (!dev || payload.deviceKey !== bacDeviceKey(dev)) return;
    bacStageObjectNames(payload.deviceKey, payload.names || []);
  }).catch((e) => console.warn("listen bacnet:object_names failed:", e));
  listen("bacnet:cov", (e) => {
    const p = e.payload;
    if (!p) return;
    // Only apply notifications for the subscription we're currently showing.
    if (p.processId !== bac.cov.processId) return;
    if (`${p.objectType}:${p.instance}` !== bac.cov.objectKey) return;
    // Skip while property values are mid-load for the subscribed object.
    const cache = bac.objectPropCache[`${p.objectType}:${p.instance}`];
    if (!cache?.byId || cache.loading) return;
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
  const netscan = platformHost("bacnet-manager")?.tryUse("netscan.v1");
  if (!netscan) { logTo("bacnet-manager", "Network scan capability unavailable.", "warn"); return; }
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
  if (!subnet) { logTo("bacnet-manager", "No adapter with a scannable IPv4 subnet to search.", "warn"); return; }
  logTo("bacnet-manager", `Scanning ${subnet.network}/${subnet.prefix} for live hosts (via Network Manager)…`, "info");
  try {
    const result = await netscan.scan(`${subnet.ip}/${subnet.prefix}`);
    const hosts = result?.hosts || [];
    if (hosts.length === 0) { logTo("bacnet-manager", "No live hosts found on the subnet.", "warn"); return; }
    const preview = hosts.slice(0, 12).map((h) => h.ip).join(", ");
    logTo("bacnet-manager", `Found ${hosts.length} live host${hosts.length === 1 ? "" : "s"}: ${preview}${hosts.length > 12 ? "…" : ""}`, "ok");
  } catch (err) {
    logTo("bacnet-manager", `Host scan failed: ${err}`, "error");
  }
}

// The Inspector consumes the extracted bacnet-core service. If the kernel
// didn't boot, it falls back to direct backend calls so the advanced tool still
// works — the platform must never take the UI down.
function bacnetRead() {
  const cap = platformHost("bacnet-manager")?.tryUse("bacnet.read.v1");
  if (cap) return cap;
  return {
    listDevices: (o = {}) => invoke("bacnet_discover", {
      target: o.target ?? null, lowLimit: o.lowLimit ?? null,
      highLimit: o.highLimit ?? null, durationMs: o.durationMs ?? null,
    }),
    cancelDiscovery: () => invoke("bacnet_cancel_discovery"),
    diagnostics: () => invoke("bacnet_diagnostics"),
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
  bac.cancelling = false;
  bac.enrichProgress = null;
  bac.discoveryRan = true;
  bac.lastDiscoveryCount = null;
  bacStartDiscoveryClock(durationMs);
  // Keep the current device list, selection, and browse pane in place while the
  // re-scan runs: live bacnet:device events merge in and the final result
  // replaces the list, so rows don't blank-then-reappear (flicker). COV was
  // already torn down above.
  renderAll();
  const low = parseInt(bac.lowLimit, 10);
  const high = parseInt(bac.highLimit, 10);
  const target = bacDiscoverTarget();
  try {
    const devices = await bacnetRead().listDevices({
      target,
      lowLimit: Number.isFinite(low) ? low : null,
      highLimit: Number.isFinite(high) ? high : null,
      durationMs,
    });
    bac.devices = devices;
    bac.lastDiscoveryCount = devices.length;
    bacRecordDiscoveryDrift(devices);
    bacPersistDiscovery();
    logTo("bacnet-manager", `Discovery finished — ${devices.length} device${devices.length === 1 ? "" : "s"}.`, devices.length ? "ok" : "warn");
  } catch (err) {
    bac.lastDiscoveryCount = null;
    logTo("bacnet-manager", `Discovery failed: ${err}`, "error");
  } finally {
    bac.discovering = false;
    bac.cancelling = false;
    bac.enrichProgress = null;
    bacStopDiscoveryClock();
    renderAll();
  }
}

// Ask the backend to stop the in-flight discovery. It returns the devices found
// so far (the awaited listDevices in bacDiscover then resolves normally).
async function bacCancelDiscovery() {
  if (!bac.discovering || bac.cancelling) return;
  bac.cancelling = true;
  bacRenderDiscoveryProgressLive();
  renderAll();
  try {
    await bacnetRead().cancelDiscovery();
    logTo("bacnet-manager", "Cancelling discovery…", "info");
  } catch (err) {
    logTo("bacnet-manager", `Could not cancel discovery: ${err}`, "warn");
  }
}

// Register/unregister with a BBMD as a foreign device, so a subsequent Who-Is is
// distributed across IP subnets (the host needn't be on the BACnet LAN). A
// background keep-alive in the backend holds the registration open.
async function bacToggleForeignDevice() {
  if (bac.bbmd.busy) return;
  const api = bacnetRead();
  const addr = bac.bbmd.address.trim();
  if (!bac.bbmd.status && !addr) {
    logTo("bacnet-manager", "Enter the BBMD's IP address to register.", "warn");
    return;
  }
  bac.bbmd.busy = true;
  renderAll();
  try {
    if (bac.bbmd.status) {
      await api.unregisterForeignDevice();
      bac.bbmd.status = null;
      logTo("bacnet-manager", "Unregistered from BBMD (will expire at TTL).", "info");
    } else {
      const ttl = parseInt(bac.bbmd.ttl, 10);
      const status = await api.registerForeignDevice({
        bbmd: addr,
        ttlSeconds: Number.isFinite(ttl) ? ttl : null,
      });
      bac.bbmd.status = status;
      logTo("bacnet-manager", `Registered as foreign device with ${status.bbmd} (TTL ${status.ttlSeconds}s). Broadcasts now route through the BBMD.`, "ok");
    }
  } catch (err) {
    logTo("bacnet-manager", `Foreign-device registration failed: ${err}`, "error");
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
    bac.driftMissing = drift.missing || [];
    bac.deviceStatusByKey = Object.fromEntries(drift.devices.map((d) => [d.key, d.status]));
    userState.bacnetDiscoveryCache = devices.slice(0, BAC_MAX_PERSIST_DEVICES).map((d) => ({
      key: d.key, instance: d.instance, address: d.address,
      network: d.network ?? null, mac: d.mac ?? null,
      vendorId: d.vendorId ?? null, modelName: d.modelName ?? null, name: d.name ?? null,
    }));
    saveUserState();
  } catch (_) {
    bac.driftSummary = null;
    bac.driftMissing = [];
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
  bac.objectPropCache = {};
  bac.objectPropsLoadToken += 1;
  bac.objectPropsLoading = false;
  bac.objectFilter = "";
  bac.objectTypeFilter.clear();
  bac.objectInstanceMin = "";
  bac.objectInstanceMax = "";
  bac.objectSelection.clear();
  bac.activeObjectKey = null;
  bac.writeArmed = false;
  const dev = bacSelectedDevice();
  if (!dev) { renderAll(); return; }
  bac.objectsLoading = true;
  bac.objectsError = null;
  bac.objectsProgress = null;
  renderAll();
  try {
    const objects = await bacnetRead().listObjects(bacDeviceRef(dev), dev.instance);
    if (bac.selectedDeviceKey !== key) return;
    bac.objects = objects;
    bac.objectsError = null;
    bacFlushObjectNames(bacDeviceKey(dev));
    logTo("bacnet-manager", `Read ${bac.objects.length} objects from ${bacDeviceLabel(dev)}.`, "ok");
  } catch (err) {
    if (bac.selectedDeviceKey !== key) return;
    bac.objects = [];
    bac.objectsError = String(err);
    logTo("bacnet-manager", `Object list failed for ${bacDeviceLabel(dev)}: ${err}`, "error");
  } finally {
    if (bac.selectedDeviceKey === key) {
      bac.objectsLoading = false;
      bac.objectsProgress = null;
      bacPersistDiscovery();
      renderAll();
      bacLoadObjectPropertyValues();
    }
  }
}

// Re-run the object-list read for the current device (used by the in-table
// Retry after a failure). Clearing the key first bypasses the no-op guard.
async function bacRetryObjects() {
  const key = bac.selectedDeviceKey;
  if (!key) return;
  bac.selectedDeviceKey = null;
  await bacSelectDevice(key);
}

// ---- COV (live values) ----

function bacCovActive() {
  return bac.cov.processId != null && !!bac.cov.objectKey;
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

// The single object currently open in the detail pane (write / COV / trend),
// resolved live against the loaded object list so a stale key can't leak.
function bacSelectedObject() {
  return resolveBacnetObject(bac.objects, bac.activeObjectKey);
}

// Open an object in the detail pane. Switching objects tears down any live COV
// subscription on the previous one and resets the write form to that object's
// present-value, so the operator isn't left pointed at the wrong point.
async function bacSetActiveObject(key) {
  if (bac.activeObjectKey === key) return;
  if (bac.cov.processId != null) await bacCovStop();
  bac.activeObjectKey = key;
  bac.trend = { loading: false, records: [], recordCount: 0, truncated: false, objectKey: null, max: bac.trend.max };
  bac.write = { propertyId: "85", kind: "real", value: "", priority: "", arrayIndex: "" };
  bac.writeArmed = false; // re-arm per object so a latch can't carry across points
  renderAll();
}

async function bacRefreshProps() {
  bac.objectPropCache = {};
  bac.objectPropsLoadToken += 1;
  await bacLoadObjectPropertyValues();
}

async function bacToggleCov() {
  if (bacCovActive()) {
    await bacCovStop();
    logTo("bacnet-manager", "Stopped COV subscription.", "info");
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
    logTo("bacnet-manager", `Subscribed to COV on ${obj.typeName}:${obj.instance} (live values).`, "ok");
  } catch (err) {
    bac.cov.busy = false;
    if (bacIsUnsupportedError(err)) bacMarkCapUnsupported(dev.key, "cov");
    logTo("bacnet-manager", `COV subscribe failed for ${obj.typeName}:${obj.instance}: ${err}`, "error");
  }
  renderAll();
}

// Patch the property rows a COV notification touched, in place, and flash them.
function bacApplyCovUpdate(values) {
  if (currentPluginId() !== "bacnet-manager") return;
  const key = bac.cov.objectKey;
  const cache = key ? bac.objectPropCache[key] : null;
  if (!cache?.byId) return;
  for (const v of values) {
    const row = cache.byId[String(v.id)] ?? cache.byId[v.id];
    if (row) { row.display = v.display; row.values = v.values; row.error = v.error; }
  }
  bacPatchObjectPropertyCells(key);
  // Refresh the right-pane present-value/status readout in place — it reads from
  // the same cache we just updated, but isn't a grid cell so the cell patch
  // above doesn't touch it.
  const obj = bacSelectedObject();
  if (obj && bacObjectKey(obj) === key) {
    const readout = document.querySelector(".bm-detail-readout");
    if (readout) readout.replaceWith(bacObjectReadout(obj));
  }
  const badge = document.getElementById("bac-cov-badge");
  if (badge) badge.textContent = `live · ${bac.cov.updates} update${bac.cov.updates === 1 ? "" : "s"}`;
}

function bacWriteValueLabel(value) {
  if (!value || value.kind === "null") return "Null (relinquish)";
  return `${value.value} (${value.kind})`;
}

// The last-read present-value (property 85) for an object, used to preview what
// a write is changing. Null when not yet read.
function bacCurrentPresentValue(obj) {
  const cache = obj ? bac.objectPropCache[bacObjectKey(obj)] : null;
  const row = bacPropFromCache(cache, 85);
  const d = row ? row.display : null;
  return (d != null && d !== "") ? d : null;
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
    logTo("bacnet-manager", "Pick a property number to write.", "warn");
    return;
  }
  const priority = bac.write.priority === "" ? null : parseInt(bac.write.priority, 10);
  if (relinquish && priority == null) {
    logTo("bacnet-manager", "Relinquish needs a priority (the slot to release).", "warn");
    return;
  }
  const arrayIndex = bac.write.arrayIndex === "" ? null : parseInt(bac.write.arrayIndex, 10);
  let value;
  try {
    value = relinquish ? { kind: "null" } : bacBuildWriteValue();
  } catch (err) {
    logTo("bacnet-manager", `Invalid value: ${err.message}`, "warn");
    return;
  }
  if (!bac.writeArmed) {
    logTo("bacnet-manager", "Writes are disarmed. Toggle \"Arm writes\" before commanding a point.", "warn");
    return;
  }
  const what = relinquish
    ? `relinquish p${priority}`
    : `write ${bacWriteValueLabel(value)}${priority != null ? ` @ p${priority}` : ""}`;
  // Every write to a live point goes through a confirmation that shows the
  // current present-value next to the target, so the operator can see what is
  // changing on real equipment. Priorities 1-2 are life-safety (they override
  // all lower-priority control) and get a danger-styled prompt.
  const lifeSafety = !relinquish && priority != null && priority <= 2;
  const current = bacCurrentPresentValue(obj);
  const currentText = current != null ? `Current present-value: ${current}\n` : "";
  const ok = await confirmAction({
    title: lifeSafety ? "Confirm life-safety write" : "Confirm write to live point",
    message: `${currentText}You're about to ${what} on ${obj.typeName}:${obj.instance} (${obj.name?.trim() || "unnamed"}) ` +
      `at ${bacDeviceLabel(dev)}.` +
      (lifeSafety ? ` Priority ${priority} is reserved for life-safety and overrides all lower-priority control.` : "") +
      " This changes a real output. Continue?",
    confirmLabel: lifeSafety ? "Write anyway" : "Write",
    danger: lifeSafety,
  });
  if (!ok) {
    logTo("bacnet-manager", `Write cancelled — ${obj.typeName}:${obj.instance}${priority != null ? ` @ p${priority}` : ""}.`, "info");
    return;
  }
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
    logTo("bacnet-manager", `OK — ${what} on ${obj.typeName}:${obj.instance}.`, "ok");
    await bacRefreshProps();
  } catch (err) {
    logTo("bacnet-manager", `Write failed on ${obj.typeName}:${obj.instance}: ${err}`, "error");
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
  if (currentPluginId() !== "bacnet-manager") return;
  inboxUi().patchDevicePanelLive?.();
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
    logTo("bacnet-manager", `Copied ${bacVisibleDevices().length} devices to clipboard (CSV).`, "ok");
  } catch (err) {
    logTo("bacnet-manager", `Clipboard copy failed: ${err}`, "error");
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
  logTo("bacnet-manager", `Exported ${bacVisibleDevices().length} devices to CSV.`, "ok");
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
  bacPatchBrowseTable();
}

function bacPatchBrowseTable() {
  if (currentPluginId() !== "bacnet-manager") return;
  const table = document.getElementById("bac-browse-table");
  if (table) {
    const head = table.querySelector("thead");
    const nextHead = bacBrowseTableHead();
    if (head) head.replaceWith(nextHead);
    else table.prepend(nextHead);
  }
  const body = document.getElementById("bac-browse-body");
  if (body) body.replaceChildren(...bacBrowseTableRows());
  const count = document.getElementById("bac-object-count");
  if (count) count.textContent = bacObjectCountText();
  const bulkbar = document.getElementById("bac-object-bulkbar");
  if (bulkbar) bulkbar.replaceWith(bacObjectBulkBar());
  const readBtn = document.getElementById("bac-read-values-btn");
  if (readBtn) {
    readBtn.disabled = bac.objectPropsLoading || !bac.objects.length ? "disabled" : undefined;
    readBtn.textContent = bac.objectPropsLoading ? "Reading…" : "Read values";
  }
  bacPatchColumnPicker();
  bacPatchObjectsStatus();
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

function bacBrowseTableHead() {
  const cols = bacVisibleObjectColumns();
  const filtered = bacFilteredObjects();
  const allSel = filtered.length > 0 && filtered.every((o) => bac.objectSelection.has(bacObjectKey(o)));
  const someSel = filtered.some((o) => bac.objectSelection.has(bacObjectKey(o)));
  const selectAll = el("input", {
    type: "checkbox",
    class: "bac-object-check-all",
    "aria-label": allSel ? "Clear selection" : "Select all objects",
    title: allSel ? "Clear selection" : "Select all shown objects",
    checked: allSel ? "checked" : undefined,
    disabled: filtered.length ? undefined : "disabled",
    onclick: (e) => { e.stopPropagation(); if (allSel) bacClearObjectSelection(); else bacSelectAllFiltered(); },
  });
  selectAll.indeterminate = someSel && !allSel;
  return el("thead", {}, el("tr", {},
    el("th", { class: "bac-browse-col-check" }, selectAll),
    el("th", {}, "Object"),
    el("th", {}, "Name"),
    ...cols.map((c) => el("th", { class: "bac-browse-col-prop", title: `Property ${c.id}` }, c.label)),
    el("th", { class: "bac-browse-col-action" }),
  ));
}

function bacBrowseTableRows() {
  const objects = bacFilteredObjects();
  const cols = bacVisibleObjectColumns();
  const colCount = bacBrowseColCount();
  if (objects.length === 0) {
    if (bac.objects.length === 0 && bac.objectsError && !bac.objectsLoading) {
      return [el("tr", {}, el("td", { class: "bac-object-empty bac-object-error", colspan: String(colCount) },
        el("span", { class: "bac-object-error-msg" }, `Could not read the object list: ${bac.objectsError}`),
        bac.selectedDeviceKey
          ? el("button", {
              class: "btn-ghost bac-object-retry",
              onclick: () => bacRetryObjects(),
            }, "Retry")
          : null,
      ))];
    }
    let msg;
    if (bac.objects.length > 0) msg = "No objects match the filter.";
    else if (bac.objectsLoading) msg = "Reading object list…";
    else msg = "Select a device to list its objects.";
    return [el("tr", {}, el("td", { class: "muted small bac-object-empty", colspan: String(colCount) }, msg))];
  }
  const sorted = [...objects].sort((a, b) =>
    String(a.typeName).localeCompare(String(b.typeName)) || Number(a.instance) - Number(b.instance));
  const countByType = sorted.reduce((m, o) => m.set(o.typeName, (m.get(o.typeName) || 0) + 1), new Map());
  const rows = [];
  let lastType = null;
  for (const o of sorted) {
    if (o.typeName !== lastType) {
      lastType = o.typeName;
      rows.push(el("tr", { class: "bac-browse-type-group" },
        el("td", { colspan: String(colCount) },
          el("span", {}, lastType),
          el("span", { class: "muted small" }, String(countByType.get(lastType))),
        )));
    }
    const key = bacObjectKey(o);
    const checked = bac.objectSelection.has(key);
    const active = bac.activeObjectKey === key;
    rows.push(el("tr", {
      class: `bac-browse-row${checked ? " bac-object-checked" : ""}${active ? " bac-object-active" : ""}`,
      "data-bac-object-key": key,
      role: "button",
      tabindex: "0",
      "aria-selected": active ? "true" : "false",
      title: "Open this object to read live values, write, or pull trends",
      onclick: () => bacSetActiveObject(key),
      onkeydown: (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); bacSetActiveObject(key); }
      },
    },
      el("td", { class: "bac-browse-col-check" },
        el("input", {
          type: "checkbox", class: "bac-object-check",
          checked: checked ? "checked" : undefined,
          "aria-label": `Select ${o.typeName}:${o.instance} for import`,
          onclick: (e) => { e.stopPropagation(); bacToggleObjectSelect(key); },
        })),
      el("td", { class: "bac-object-type" }, `${o.typeName}:${o.instance}`),
      el("td", { class: "bac-object-name" }, o.name?.trim() || (bacNamesLoading() ? "…" : "—")),
      ...cols.map((c) => bacObjectPropertyCell(o, c)),
      el("td", { class: "bac-browse-col-action" },
        el("button", {
          class: "btn-ghost bac-object-action",
          title: "Import this object into the building model",
          onclick: (e) => { e.stopPropagation(); bacImportSingleObject(o); },
        }, "Import")),
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
// The device object (object-type 8) is the controller itself; it is modeled as
// the device equipment, not as a point under it.
function bacIsModelableObject(obj) {
  return obj && Number(obj.objectType) !== 8;
}

function bacImportSingleObject(obj) {
  const inv = inventoryInstance();
  const dev = bacSelectedDevice();
  const floor = bacImportTargetFloor(inv);
  if (!inv || !dev || !obj) { toast("Select a device and object first.", "warn"); return; }
  if (!bacIsModelableObject(obj)) { toast("The device object represents the controller itself — it's modeled as the device, not a point.", "warn"); return; }
  if (!floor) { toast("Select a target floor in Discovery.", "warn"); return; }
  const building = inv.getEntity(floor.buildingId || floor.parentId);
  const site = building ? inv.getEntity(floor.siteId || building.siteId) : null;
  if (!site || !building) { toast("Import target floor is missing site/building context.", "error"); return; }
  // Nest the point under its device's equipment (a BACnet object lives on its
  // controller), not a loose floor-level grouping shell.
  const devEquip = bacResolveDeviceEquip(inv, dev, site, building, floor);
  inv.upsertEntity(pointEntityFromBacnet({
    siteId: devEquip.siteId, buildingId: devEquip.buildingId, floorId: devEquip.floorId, equipId: devEquip.id,
    device: dev, object: obj, props: bacPropsForObject(obj),
  }));
  saveUserState();
  logTo("bacnet-manager", `Imported ${obj.typeName}:${obj.instance} under ${devEquip.name}.`, "ok");
  toast(`Imported under ${devEquip.name}. Open Building Workspace to model further.`, "ok");
}

// Floor <select> options labelled site / building / floor.
function bacFloorOptions(inv, selectedId) {
  const opts = [el("option", { value: "" }, "Choose floor…")];
  for (const f of inv.listEntities({ type: "floor" })) {
    const b = inv.getEntity(f.buildingId || f.parentId);
    const s = b ? inv.getEntity(f.siteId || b.siteId) : null;
    const label = [s?.name, b?.name, f.name].filter(Boolean).join(" / ") || f.name || f.id;
    opts.push(el("option", { value: f.id, selected: f.id === selectedId ? "selected" : undefined }, label));
  }
  return opts;
}

// The already-modeled point for a BACnet object on a device, if any (so a
// re-import can prefill the user's existing display name / precision / unit).
function bacExistingModeledPoint(inv, dev, obj) {
  const ref = `bacnet:${dev.instance}:${obj.objectType}:${obj.instance}`;
  return inv.listEntities({ type: "point", sourceRef: ref })[0] || null;
}

// Units symbol for an object from the browse cache (property 117), if read.
// Stripped to just the symbol (no raw enum) for use in the building model.
function bacObjectUnit(obj) {
  const row = bacPropFromCache(bac.objectPropCache[bacObjectKey(obj)], 117);
  const raw = row && !row.error && row.display ? row.display : (obj.unit || "");
  return bacnetUnitSymbol(raw);
}

// A BACnet object lives on its controller, so its modeled point belongs under
// the device equipment. Find the device equip by instance (anywhere it's
// already modeled) or create it on the target floor — never as a loose
// floor-level grouping shell.
function bacDeviceEquipEntity(dev, site, building, floor) {
  const ref = bacDeviceRef(dev);
  return {
    type: "equip",
    siteId: site.id, buildingId: building.id, floorId: floor.id, parentId: floor.id,
    name: dev.name || `Device ${dev.instance}`,
    deviceInstance: dev.instance,
    deviceRef: { ...ref, deviceInstance: dev.instance },
    address: dev.address || "",
    network: dev.network ?? null,
    mac: dev.mac ?? null,
    vendorId: dev.vendorId ?? null,
    vendorName: dev.vendorName || "",
    modelName: dev.modelName || "",
    tags: { equip: true, device: true, bacnet: true },
  };
}

function bacResolveDeviceEquip(inv, dev, site, building, floor) {
  const inst = Number(dev.instance);
  const existing = inv.listEntities({ type: "equip" }).find((e) => Number(e.deviceInstance) === inst);
  if (existing) return existing;
  return inv.upsertEntity(bacDeviceEquipEntity(dev, site, building, floor));
}

// Bulk import now opens a Review & model step so names, units, decimal
// precision, and "trend this" can be set before anything is written.
function bacBulkImportSelected() {
  const inv = inventoryInstance();
  const dev = bacSelectedDevice();
  // The device object can't be modeled as a point; drop it from the batch.
  const objects = bacSelectedObjectsForBulk().filter(bacIsModelableObject);
  if (!inv) { toast("Building model is not ready.", "error"); return; }
  if (!dev || !objects.length) { toast("Select one or more objects to model (the device object can't be a point).", "warn"); return; }
  bacOpenReviewImportModal(inv, dev, objects);
}

function bacOpenReviewImportModal(inv, dev, objects) {
  const plan = bwPlanDeviceObjects({ device: dev, objects, template: bac.objectNameTemplate });
  // One editable row per object, prefilled from an existing modeled point on re-import.
  const rows = plan.items.map((item) => {
    const existing = bacExistingModeledPoint(inv, dev, item.object);
    return {
      object: item.object,
      bacnetName: item.object.name || `${item.object.typeName}:${item.object.instance}`,
      displayName: existing?.name || item.pointName,
      unit: existing?.unit || bacObjectUnit(item.object),
      precision: existing && Number.isInteger(existing.precision) ? String(existing.precision) : "",
      trend: existing ? !!existing.historize : false,
    };
  });

  let floorId = userState.bacnetManager?.importFloorId || "";

  const rowEl = (r) => el("tr", {},
    el("td", { class: "bac-mono small", title: r.bacnetName }, `${r.object.typeName}:${r.object.instance}`),
    el("td", {}, el("input", { type: "text", class: "nm-input bac-rev-name", value: r.displayName, "aria-label": "Display name", oninput: (e) => { r.displayName = e.target.value; } })),
    el("td", {}, el("input", { type: "text", class: "nm-input bac-rev-unit", value: r.unit, "aria-label": "Unit", oninput: (e) => { r.unit = e.target.value; } })),
    el("td", {}, el("input", { type: "number", class: "nm-input bac-rev-prec", value: r.precision, min: "0", max: "10", placeholder: "auto", "aria-label": "Decimal precision", oninput: (e) => { r.precision = e.target.value; } })),
    el("td", { class: "bac-rev-trend-cell" }, el("input", { type: "checkbox", class: "bac-rev-trend", checked: r.trend ? "checked" : undefined, "aria-label": "Trend this point", onchange: (e) => { r.trend = e.target.checked; } })),
  );

  const tbody = el("tbody", {}, ...rows.map(rowEl));

  const applyPrecision = el("input", { type: "number", class: "nm-input bac-range-input", min: "0", max: "10", placeholder: "set all" });
  const applyTrend = el("input", { type: "checkbox", "aria-label": "Trend all" });

  const floorSelect = el("select", { class: "nm-input", "aria-label": "Target floor", onchange: (e) => { floorId = e.target.value; } },
    ...bacFloorOptions(inv, floorId));

  const errEl = el("p", { class: "muted small bac-rev-error" });

  const body = el("div", { class: "bac-review-modal" },
    el("p", { class: "muted small" }, `Modeling ${rows.length} object${rows.length === 1 ? "" : "s"} under device ${bacDeviceLabel(dev)}. Set display names, units, decimal precision, and which points to trend.`),
    el("label", { class: "nm-field" },
      el("span", { class: "nm-field-label" }, "Target floor (used if this device isn't modeled yet)"), floorSelect),
    el("div", { class: "action-row bac-rev-applyall" },
      el("span", { class: "muted small" }, "Apply to all:"),
      el("label", { class: "nm-field-inline" }, el("span", { class: "muted small" }, "Precision"), applyPrecision),
      el("button", { type: "button", class: "btn-ghost", onclick: () => { for (const r of rows) r.precision = applyPrecision.value; tbody.replaceChildren(...rows.map(rowEl)); } }, "Set precision"),
      el("label", { class: "nm-field-inline" }, el("span", { class: "muted small" }, "Trend"), applyTrend),
      el("button", { type: "button", class: "btn-ghost", onclick: () => { for (const r of rows) r.trend = applyTrend.checked; tbody.replaceChildren(...rows.map(rowEl)); } }, "Set trend"),
    ),
    errEl,
    el("div", { class: "table-scroll bac-review-scroll" },
      el("table", { class: "bac-table bac-review-table" },
        el("thead", {}, el("tr", {},
          el("th", {}, "Object"),
          el("th", {}, "Display name"),
          el("th", {}, "Unit"),
          el("th", {}, "Decimals"),
          el("th", {}, "Trend"),
        )),
        tbody,
      ),
    ),
    el("div", { class: "confirm-actions" },
      el("button", { class: "btn btn-ghost", onclick: closeModal }, "Cancel"),
      el("button", { class: "btn btn-primary", onclick: () => bacCommitReviewImport(inv, dev, rows, floorId, errEl) }, `Model ${rows.length} point${rows.length === 1 ? "" : "s"}`),
    ),
  );

  openModal({ title: "Review & model points", body: [body] });
}

function bacCommitReviewImport(inv, dev, rows, floorId, errEl) {
  const floor = floorId ? inv.getEntity(floorId) : null;
  if (!floor || floor.type !== "floor") { if (errEl) errEl.textContent = "Choose a target floor."; return; }
  const building = inv.getEntity(floor.buildingId || floor.parentId);
  const site = building ? inv.getEntity(floor.siteId || building.siteId) : null;
  if (!site || !building) { if (errEl) errEl.textContent = "Target floor is missing site/building context."; return; }

  // Persist the chosen floor as the default for next time.
  bacEnsureBacnetManagerState();
  userState.bacnetManager.importFloorId = floor.id;

  // Points belong to the controller: resolve (or create) the device equipment
  // and nest every imported point under it, at the device's own location.
  const devEquip = bacResolveDeviceEquip(inv, dev, site, building, floor);
  const points = rows.map((r) => pointEntityFromBacnet({
    siteId: devEquip.siteId, buildingId: devEquip.buildingId, floorId: devEquip.floorId,
    equipId: devEquip.id,
    device: dev,
    object: { ...r.object, bacnetName: r.bacnetName },
    props: bacPropsForObject(r.object),
    config: { displayName: r.displayName, unit: r.unit, precision: r.precision, historize: r.trend },
  }));
  const saved = inv.upsertMany(points);
  saveUserState();
  bac.objectSelection.clear();
  closeModal();
  const trended = rows.filter((r) => r.trend).length;
  logTo("bacnet-manager", `Modeled ${saved.length} point${saved.length === 1 ? "" : "s"} under ${devEquip.name}${trended ? ` (${trended} flagged to trend)` : ""}.`, "ok");
  toast(`Modeled ${saved.length} point${saved.length === 1 ? "" : "s"} under ${devEquip.name}.${trended ? " Trended points will log when the Historian runs." : ""}`, "ok");
  renderAll();
}

// Saved object-filter presets (persisted in user state).
function bacObjectPresets() {
  if (!userState.bacnetObjectPresets || typeof userState.bacnetObjectPresets !== "object") userState.bacnetObjectPresets = {};
  return userState.bacnetObjectPresets;
}

// Save/manage object-filter presets in a modal (replaces a blocking prompt()).
// Lets the operator name a new preset and delete existing ones inline.
function bacSaveObjectPreset() {
  const presets = bacObjectPresets();

  const nameInput = el("input", {
    type: "text", class: "nm-input", placeholder: "e.g. AI/AO present values",
    "aria-label": "Preset name",
  });
  const errEl = el("p", { class: "muted small bac-preset-error" });

  const listWrap = el("div", { class: "bac-preset-list-wrap" });
  const refreshList = () => {
    const names = Object.keys(presets);
    listWrap.replaceChildren(names.length
      ? el("div", { class: "bac-preset-list" },
          el("p", { class: "nm-field-label" }, "Saved presets"),
          ...names.map((p) => el("div", { class: "bac-preset-row" },
            el("button", {
              type: "button", class: "btn-ghost bac-preset-apply",
              title: `Apply "${p}"`,
              onclick: () => { bacApplyObjectPreset(p); closeModal(); },
            }, p),
            el("button", {
              type: "button", class: "btn-ghost bw-menu-danger",
              title: `Delete "${p}"`, "aria-label": `Delete preset ${p}`,
              onclick: () => { delete presets[p]; saveUserState(); refreshList(); },
            }, "Delete"),
          )))
      : el("p", { class: "muted small" }, "No saved presets yet."));
  };
  refreshList();

  const save = () => {
    const name = nameInput.value.trim();
    if (!name) { errEl.textContent = "Enter a name for this preset."; nameInput.focus(); return; }
    presets[name] = {
      q: bac.objectFilter,
      types: [...bac.objectTypeFilter],
      min: bac.objectInstanceMin,
      max: bac.objectInstanceMax,
    };
    saveUserState();
    toast(`Saved filter preset "${name}".`, "ok");
    closeModal();
  };
  nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); save(); } });

  const body = el("div", { class: "bac-preset-modal" },
    el("label", { class: "nm-field" },
      el("span", { class: "nm-field-label" }, "Save current filter as"),
      nameInput),
    errEl,
    el("div", { class: "confirm-actions" },
      el("button", { class: "btn btn-ghost", onclick: closeModal }, "Cancel"),
      el("button", { class: "btn btn-primary", onclick: save }, "Save preset"),
    ),
    listWrap,
  );
  // Re-render on close so the toolbar's preset dropdown reflects adds/deletes.
  openModal({ title: "Object filter presets", body: [body], onClose: () => renderAll() });
  setTimeout(() => nameInput.focus(), 0);
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

// Consolidated "View" popover: instance range, type filter, and column picker
// — the occasional controls that used to crowd the object toolbar.
function bacObjectViewMenu() {
  const typeNames = bacObjectTypeNames();
  const activeCount = (bac.objectTypeFilter.size ? 1 : 0)
    + (String(bac.objectInstanceMin).trim() || String(bac.objectInstanceMax).trim() ? 1 : 0);
  const typeChips = typeNames.map((t) => {
    const on = bac.objectTypeFilter.has(t);
    return el("button", {
      type: "button",
      class: `bac-type-chip${on ? " bac-type-chip-on" : ""}`,
      "aria-pressed": on ? "true" : "false",
      onclick: () => bacToggleObjectType(t),
    }, t);
  });
  return el("details", {
    class: "bm-pane-menu bac-view-menu",
    open: bac.objectViewOpen ? "open" : undefined,
    ontoggle: (e) => { bac.objectViewOpen = e.target.open; },
  },
    el("summary", { class: "bm-pane-menu-summary bac-view-summary" }, `View${activeCount ? ` (${activeCount})` : ""}`),
    el("div", { class: "bm-pane-menu-list bac-view-list", role: "menu" },
      el("div", { class: "bac-view-section" },
        el("span", { class: "nm-field-label" }, "Instance range"),
        el("div", { class: "bac-object-range" },
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
      ),
      typeNames.length
        ? el("div", { class: "bac-view-section" },
            el("span", { class: "nm-field-label" }, `Types${bac.objectTypeFilter.size ? ` (${bac.objectTypeFilter.size})` : ""}`),
            el("div", { class: "bac-type-chips" },
              ...typeChips,
              bac.objectTypeFilter.size
                ? el("button", { type: "button", class: "btn-ghost bac-type-clear", onclick: () => { bac.objectTypeFilter.clear(); renderAll(); } }, "Clear types")
                : null,
            ),
          )
        : null,
      el("div", { class: "bac-view-section" },
        el("span", { class: "nm-field-label" }, "Columns"),
        el("div", { class: "bac-column-picker-list" },
          ...BAC_BROWSE_PROPERTY_COLUMNS.map((col) => el("label", { class: "bac-column-picker-item" },
            el("input", {
              type: "checkbox",
              "data-column-id": String(col.id),
              checked: bac.objectColumnsVisible.has(col.id) ? "checked" : undefined,
              onchange: () => bacToggleObjectColumn(col.id),
            }),
            `${col.label} (${col.id})`,
          )),
        ),
      ),
    ),
  );
}

// Object actions overflow: re-read values, apply/save presets, export.
function bacObjectActionsMenu() {
  const presets = Object.keys(bacObjectPresets());
  const close = (e) => e.currentTarget.closest("details")?.removeAttribute("open");
  return el("details", { class: "bm-pane-menu" },
    el("summary", { class: "bm-pane-menu-summary", title: "More actions", "aria-label": "More object actions" }, "⋯"),
    el("div", { class: "bm-pane-menu-list", role: "menu" },
      el("button", {
        id: "bac-read-values-btn",
        class: "bw-menu-item", role: "menuitem",
        disabled: bac.objectPropsLoading || !bac.objects.length ? "disabled" : undefined,
        onclick: (e) => {
          close(e);
          bac.objectPropCache = {};
          bac.objectPropsLoadToken += 1;
          bacLoadObjectPropertyValues();
        },
      }, bac.objectPropsLoading ? "Reading…" : "Read values"),
      ...presets.map((p) => el("button", {
        class: "bw-menu-item", role: "menuitem",
        onclick: (e) => { close(e); bacApplyObjectPreset(p); },
      }, `Apply: ${p}`)),
      el("button", { class: "bw-menu-item", role: "menuitem", onclick: (e) => { close(e); bacSaveObjectPreset(); } }, "Save filter as preset…"),
      el("button", { class: "bw-menu-item", role: "menuitem", onclick: (e) => { close(e); bacExportObjects(); } }, "Export CSV"),
    ),
  );
}

// Slim object toolbar: just the everyday filter, plus View and overflow menus.
function bacObjectToolbar() {
  return el("div", { class: "bac-object-toolbar" },
    el("input", {
      type: "search", class: "nm-input bac-object-filter",
      placeholder: "Filter objects…",
      "aria-label": "Filter objects",
      value: bac.objectFilter,
      oninput: (e) => { bac.objectFilter = e.target.value; bacApplyObjectFilter(); },
    }),
    bacObjectViewMenu(),
    bacObjectActionsMenu(),
  );
}

// The bulk-action bar: shown once a device's objects are loaded so "Select all" and
// the name template are reachable; the import button enables when rows are checked.
// Selection-contextual bulk-import bar: hidden until objects are checked (the
// header checkbox does select-all). Stays a stable #bac-object-bulkbar node so
// the in-place table patch can swap it.
function bacObjectBulkBar() {
  const n = bac.objectSelection.size;
  if (!bac.objects.length || n === 0) return el("div", { id: "bac-object-bulkbar", class: "bac-object-bulkbar" });
  return el("div", { id: "bac-object-bulkbar", class: "bac-object-bulkbar bac-object-bulkbar-on" },
    el("span", { class: "muted small bac-bulk-count" }, `${n} selected`),
    el("input", {
      type: "text", class: "nm-input bac-name-template",
      placeholder: "Name template, e.g. {equip}-{type}{instance}",
      title: "Optional. Tokens: {equip} {type} {instance} {name}. Blank keeps each object's own name.",
      "aria-label": "Point name template",
      value: bac.objectNameTemplate,
      oninput: (e) => { bac.objectNameTemplate = e.target.value; },
    }),
    el("button", { type: "button", class: "btn-ghost", onclick: bacClearObjectSelection }, "Clear"),
    el("button", {
      type: "button", class: "btn bac-bulk-import",
      title: "Model the selected objects as points under the active floor",
      onclick: bacBulkImportSelected,
    }, `Import ${n} point${n === 1 ? "" : "s"}`),
  );
}

function bacAdapterTarget(adapterName = networkManager.selectedAdapterName()) {
  return adapterName ? bacSweepTargetFor(adapterName) : null;
}

/** Who-Is target for the next discovery — adapter sweep when no custom target is set. */
function bacDiscoverTarget() {
  const trimmed = bac.target.trim();
  const isGlobalDefault = !trimmed || trimmed === "255.255.255.255";
  if (!isGlobalDefault) return trimmed;
  return bacAdapterTarget()?.value || trimmed || null;
}

function bacDiscoverTargetSummary() {
  const trimmed = bac.target.trim();
  const isGlobalDefault = !trimmed || trimmed === "255.255.255.255";
  const { adapters } = networkManager.getAdapterSnapshot();
  for (const a of adapters) {
    const sweep = bacSweepTargetFor(a.name);
    if (sweep && (!isGlobalDefault ? sweep.value === trimmed : bac.target === sweep.value)) {
      return `${a.name} · ${sweep.label}`;
    }
  }
  if (isGlobalDefault) {
    const selected = networkManager.selectedAdapterName();
    const t = selected ? bacAdapterTarget(selected) : null;
    if (t) return `${selected} · ${t.label}`;
    return "Global broadcast (255.255.255.255)";
  }
  return trimmed.length > 56 ? `${trimmed.slice(0, 53)}…` : trimmed;
}

function bacDiscoverUsesAdvancedSettings() {
  if (bac.lowLimit.trim() || bac.highLimit.trim()) return true;
  if (bac.bbmd.status || bac.bbmd.address.trim()) return true;
  const trimmed = bac.target.trim();
  if (!trimmed || trimmed === "255.255.255.255") return false;
  const { adapters } = networkManager.getAdapterSnapshot();
  for (const a of adapters) {
    const sweep = bacSweepTargetFor(a.name);
    if (sweep?.value === trimmed) return false;
  }
  return true;
}

function bacDiscoverSettingsTitle() {
  const custom = bacDiscoverUsesAdvancedSettings();
  const target = bacDiscoverTargetSummary();
  return custom
    ? `Discovery settings (custom) — Who-Is target: ${target}`
    : `Discovery settings — Who-Is target: ${target}`;
}

function bacPatchDiscoverSummary() {
  const settingsBtn = document.getElementById("bm-discover-settings-btn");
  if (settingsBtn) {
    const custom = bacDiscoverUsesAdvancedSettings();
    settingsBtn.title = bacDiscoverSettingsTitle();
    settingsBtn.classList.toggle("bm-discover-settings-custom", custom);
    let dot = settingsBtn.querySelector(".bm-discover-settings-dot");
    if (custom && !dot) {
      settingsBtn.appendChild(el("span", { class: "bm-discover-settings-dot", "aria-hidden": "true" }));
    } else if (!custom && dot) {
      dot.remove();
    }
  }
}

function bacResetDiscoverTargetToAdapter() {
  const t = bacAdapterTarget();
  bac.target = t?.value || "255.255.255.255";
  bacPatchDiscoverSummary();
  bacSyncTargetChipHighlight();
}

function bacSyncTargetChipHighlight() {
  document.querySelectorAll(".bac-chip[data-target-value]").forEach((btn) => {
    btn.classList.toggle("bac-chip-on", btn.dataset.targetValue === bac.target);
  });
}

function bacOpenDiscoverSettingsModal() {
  networkManager.ensureLoaded();
  const discovering = bac.discovering;
  let fdrRegistered = !!bac.bbmd.status;

  const patch = () => {
    bacPatchDiscoverSummary();
    bacSyncTargetChipHighlight();
  };

  const targetInput = el("input", {
    type: "text", class: "nm-input",
    placeholder: "255.255.255.255 or 192.168.1.255 or a device IP",
    disabled: discovering ? "disabled" : undefined,
    value: bac.target,
    oninput: (e) => { bac.target = e.target.value; patch(); },
  });
  const lowInput = el("input", {
    type: "text", class: "nm-input bac-range-input", placeholder: "low",
    disabled: discovering ? "disabled" : undefined,
    value: bac.lowLimit,
    oninput: (e) => { bac.lowLimit = e.target.value; patch(); },
  });
  const highInput = el("input", {
    type: "text", class: "nm-input bac-range-input", placeholder: "high",
    disabled: discovering ? "disabled" : undefined,
    value: bac.highLimit,
    oninput: (e) => { bac.highLimit = e.target.value; patch(); },
  });

  const scanBtn = platformHost("bacnet-manager")?.has("netscan.v1")
    ? el("button", {
        class: "btn btn-ghost",
        disabled: discovering ? "disabled" : undefined,
        title: "Use Network Manager's scanner to list live hosts on your subnet",
        onclick: bacSuggestTargets,
      }, "Find live hosts")
    : null;

  const bbmdInput = el("input", {
    type: "text", class: "nm-input",
    placeholder: "BBMD IP (e.g. 10.0.5.1)",
    disabled: (fdrRegistered || bac.bbmd.busy) ? "disabled" : undefined,
    value: bac.bbmd.address,
    oninput: (e) => { bac.bbmd.address = e.target.value; patch(); },
  });
  const bbmdTtlInput = el("input", {
    type: "text", class: "nm-input bac-range-input", placeholder: "TTL s",
    disabled: (fdrRegistered || bac.bbmd.busy) ? "disabled" : undefined,
    value: bac.bbmd.ttl,
    oninput: (e) => { bac.bbmd.ttl = e.target.value; },
  });
  const bbmdStatusEl = el("span", { class: "muted small" },
    fdrRegistered
      ? `Registered with ${bac.bbmd.status.bbmd} — broadcasts route through the BBMD.`
      : "Optional: reach devices on other IP subnets via a BBMD.",
  );
  const bbmdBtn = el("button", {
    class: fdrRegistered ? "btn btn-ghost" : "btn",
    disabled: bac.bbmd.busy ? "disabled" : undefined,
    onclick: async () => {
      await bacToggleForeignDevice();
      fdrRegistered = !!bac.bbmd.status;
      bbmdInput.disabled = (fdrRegistered || bac.bbmd.busy) ? "disabled" : undefined;
      bbmdTtlInput.disabled = (fdrRegistered || bac.bbmd.busy) ? "disabled" : undefined;
      bbmdBtn.textContent = bac.bbmd.busy ? "…" : (fdrRegistered ? "Unregister" : "Register");
      bbmdBtn.className = fdrRegistered ? "btn btn-ghost" : "btn";
      bbmdStatusEl.textContent = fdrRegistered
        ? `Registered with ${bac.bbmd.status.bbmd} — broadcasts route through the BBMD.`
        : "Optional: reach devices on other IP subnets via a BBMD.";
      patch();
    },
  }, bac.bbmd.busy ? "…" : (fdrRegistered ? "Unregister" : "Register"));

  const body = el("div", { class: "bm-discover-settings-modal" },
    el("p", { class: "muted small modal-desc" },
      "Directed broadcast, instance range, BBMD routing, or a specific device IP across subnets."),
    el("label", { class: "nm-field bac-target-field" },
      el("span", { class: "nm-field-label" }, "Target"), targetInput),
    el("div", { class: "bm-discover-settings-chips" }, bacTargetChips({ onTargetChange: () => {
      targetInput.value = bac.target;
      patch();
    } })),
    el("div", { class: "bm-discover-settings-actions" },
      el("button", {
        class: "btn btn-ghost",
        disabled: discovering ? "disabled" : undefined,
        onclick: () => { bacResetDiscoverTargetToAdapter(); targetInput.value = bac.target; },
      }, "Use selected adapter"),
    ),
    el("label", { class: "nm-field" },
      el("span", { class: "nm-field-label" }, "Instance range (optional)"),
      el("div", { class: "bac-range-pair" }, lowInput, el("span", { class: "muted" }, "–"), highInput),
    ),
    scanBtn,
    el("div", { class: "bac-discover-controls bac-fdr-controls" },
      el("label", { class: "nm-field bac-target-field" },
        el("span", { class: "nm-field-label" }, "BBMD (foreign device)"), bbmdInput),
      el("label", { class: "nm-field" },
        el("span", { class: "nm-field-label" }, "TTL"), bbmdTtlInput),
      bbmdBtn,
      bbmdStatusEl,
    ),
    el("div", { class: "confirm-actions" },
      el("button", { class: "btn btn-primary", onclick: closeModal }, "Done"),
    ),
  );

  openModal({ title: "Discovery settings", body: [body], onClose: () => renderAll() });
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
    logTo("bacnet-manager", `Read ${entries.length} alarm record${entries.length === 1 ? "" : "s"} from ${bacDeviceLabel(dev)} (${active} not normal).`, entries.length ? "ok" : "info");
  } catch (err) {
    if (bac.selectedDeviceKey !== dev.key) return;
    bac.alarms.entries = [];
    bac.alarms.error = String(err);
    bac.alarms.ran = true;
    if (bacIsUnsupportedError(err)) bacMarkCapUnsupported(dev.key, "alarms");
    logTo("bacnet-manager", `Alarm read failed for ${bacDeviceLabel(dev)}: ${err}`, "error");
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
  logTo("bacnet-manager", `ACK requested — ${label} (${alarm.eventState}) on ${bacDeviceLabel(dev)}.`, "warn");
  try {
    await bacnetRead().acknowledgeAlarm({
      device: bacDeviceRef(dev),
      objectType: alarm.objectType,
      instance: alarm.instance,
    });
    logTo("bacnet-manager", `ACK accepted by device — ${label}.`, "ok");
    toast(`Acknowledged ${label}`, "ok");
    await bacReadAlarms(); // refresh so the ack state reflects reality
  } catch (err) {
    logTo("bacnet-manager", `ACK failed — ${label}: ${err}`, "error");
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

// Body of the Alarms tab (the center pane's tab bar provides the title).
function bacAlarmsPaneBody(dev) {
  const fresh = bac.alarms.deviceKey === dev.key;
  const rows = bacAlarmRows();
  const loading = bac.alarms.loading && fresh;
  const errored = fresh && !!bac.alarms.error;
  const alarmsUnsupported = !bacCapSupported(dev.key, "alarms");

  let stateEl = null;
  if (loading) {
    stateEl = el("p", { class: "muted small", role: "status", "aria-live": "polite" }, "Reading alarms…");
  } else if (alarmsUnsupported) {
    stateEl = el("p", { class: "muted small" },
      "This device reported it does not support alarm reporting (GetEventInformation / GetAlarmSummary).");
  } else if (errored) {
    stateEl = el("div", { class: "bac-alarms-state bac-alarms-error", role: "alert" },
      el("span", {}, `Could not read alarms: ${bac.alarms.error}`),
      el("button", { class: "btn-ghost", onclick: bacReadAlarms }, "Retry"));
  } else if (fresh && bac.alarms.ran && rows.length === 0) {
    stateEl = el("p", { class: "muted small bac-alarms-empty" }, "No active or unacknowledged alarms on this device.");
  } else if (!bac.alarms.ran || !fresh) {
    stateEl = el("div", { class: "bac-alarms-state bac-alarms-cta" },
      el("span", { class: "muted small" }, "Alarms haven't been read for this device yet."),
      el("button", {
        class: "btn",
        disabled: loading ? "disabled" : undefined,
        onclick: bacReadAlarms,
      }, "Read alarms"));
  }

  return el("div", { class: "bm-alarms-body" },
    el("div", { class: "action-row bm-alarms-actions" },
      el("button", {
        class: "btn-ghost",
        disabled: loading || alarmsUnsupported ? "disabled" : undefined,
        title: alarmsUnsupported
          ? "This device does not support alarm reporting"
          : "List active and unacknowledged alarms (GetEventInformation / GetAlarmSummary)",
        onclick: bacReadAlarms,
      }, loading ? "…" : (bac.alarms.ran && fresh ? "Refresh alarms" : "Read alarms")),
    ),
    stateEl,
    rows.length
      ? el("div", { class: "table-scroll bm-alarms-scroll" },
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
    if (bac.trend.objectKey !== bacObjectKey(obj)) return;
    bac.trend.records = result.records;
    bac.trend.recordCount = result.recordCount;
    bac.trend.truncated = result.truncated;
    logTo("bacnet-manager", `Read ${result.records.length} trend record${result.records.length === 1 ? "" : "s"} from ${obj.typeName}:${obj.instance}.`, "ok");
  } catch (err) {
    if (bac.trend.objectKey !== bacObjectKey(obj)) return;
    if (bacIsUnsupportedError(err)) bacMarkCapUnsupported(dev.key, "trend");
    logTo("bacnet-manager", `Trend read failed for ${obj.typeName}:${obj.instance}: ${err}`, "error");
  } finally {
    if (bac.trend.objectKey === bacObjectKey(obj)) {
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
  logTo("bacnet-manager", `Exported ${bac.trend.records.length} trend records to CSV.`, "ok");
}

function bacTrendChartWidth() {
  const pane = document.querySelector(".bm-object-detail");
  if (!pane) return 480;
  return Math.max(200, pane.clientWidth - 24);
}

const BM_LEFT_MIN = 200;
const BM_LEFT_MAX = 480;
const BM_LEFT_DEFAULT = 280;
const BM_RIGHT_MIN = 260;
const BM_RIGHT_MAX = 560;
const BM_RIGHT_DEFAULT = 360;

function bacEnsurePaneWidths() {
  if (!userState.bacnetManager || typeof userState.bacnetManager !== "object") userState.bacnetManager = {};
  const pw = userState.bacnetManager.paneWidths;
  if (!pw || typeof pw !== "object") {
    userState.bacnetManager.paneWidths = { left: BM_LEFT_DEFAULT, right: BM_RIGHT_DEFAULT };
  } else {
    if (!Number.isFinite(pw.left)) pw.left = BM_LEFT_DEFAULT;
    if (!Number.isFinite(pw.right)) pw.right = BM_RIGHT_DEFAULT;
  }
}

function bacLeftPaneWidth() {
  bacEnsurePaneWidths();
  return clampPaneWidth(userState.bacnetManager.paneWidths.left, { min: BM_LEFT_MIN, max: BM_LEFT_MAX });
}

function bacRightPaneWidth() {
  bacEnsurePaneWidths();
  return clampPaneWidth(userState.bacnetManager.paneWidths.right, { min: BM_RIGHT_MIN, max: BM_RIGHT_MAX });
}

function bacApplyExplorerColumns() {
  const explorer = document.getElementById("bm-explorer");
  if (!explorer) return;
  const hasDetail = explorer.classList.contains("bm-explorer-detail");
  const left = bacLeftPaneWidth();
  explorer.style.gridTemplateColumns = hasDetail
    ? buildGridColumns({ left, right: bacRightPaneWidth(), threePane: true })
    : buildGridColumns({ left });
}

function bacSetLeftPaneWidth(px, persist) {
  bacEnsurePaneWidths();
  userState.bacnetManager.paneWidths.left = clampPaneWidth(px, { min: BM_LEFT_MIN, max: BM_LEFT_MAX });
  bacApplyExplorerColumns();
  updateSplitterAria(document.getElementById("bm-splitter-left"), userState.bacnetManager.paneWidths.left);
  if (persist) saveUserState();
}

function bacSetRightPaneWidth(px, persist) {
  bacEnsurePaneWidths();
  userState.bacnetManager.paneWidths.right = clampPaneWidth(px, { min: BM_RIGHT_MIN, max: BM_RIGHT_MAX });
  bacApplyExplorerColumns();
  updateSplitterAria(document.getElementById("bm-splitter-right"), userState.bacnetManager.paneWidths.right);
  if (persist) saveUserState();
}

function bacRedrawTrendChart() {
  const host = document.getElementById("bac-trend-chart");
  if (!host || !bac.trend.records.length) return;
  host.replaceChildren(lineChartCanvas({
    samples: bacTrendSamplesFromRecords(bac.trend.records),
    width: bacTrendChartWidth(),
    height: 150,
  }));
}

function bacPaneResizeEnd() {
  bacRedrawTrendChart();
}

function bacMakeExplorerSplitter({ id, ariaLabel, min, max, getWidth, setWidth, dragRight = false }) {
  const splitter = createPaneSplitter({
    id,
    ariaLabel,
    min,
    max,
    value: getWidth(),
    onKeyDown: paneSplitterKeyHandler(getWidth, (px) => setWidth(px, true), saveUserState),
    onDoubleReset: () => setWidth(id.includes("right") ? BM_RIGHT_DEFAULT : BM_LEFT_DEFAULT, true),
  });
  (dragRight ? attachPaneDragRight : attachPaneDrag)(splitter, {
    getWidth,
    setWidth,
    persist: saveUserState,
    onEnd: bacPaneResizeEnd,
  });
  return splitter;
}

function bacTrendSamplesFromRecords(recs) {
  const out = [];
  for (const r of recs) {
    const value = Number(String(r.value ?? "").trim());
    if (!Number.isFinite(value)) continue;
    const ts = Date.parse(String(r.timestamp ?? ""));
    if (!Number.isFinite(ts)) continue;
    out.push({ ts, value });
  }
  return out.sort((a, b) => a.ts - b.ts);
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

  const dev = bacSelectedDevice();
  const trendUnsupported = dev && !bacCapSupported(dev.key, "trend");

  const maxInput = el("input", {
    type: "text", class: "nm-input bac-trend-max",
    title: "Max records to read",
    disabled: trendUnsupported ? "disabled" : undefined,
    value: bac.trend.max,
    oninput: (e) => { bac.trend.max = e.target.value; },
  });

  return el("div", { class: "bac-trend bac-trend-fill" },
    el("div", { class: "section-head" },
      el("h4", {}, "Trend log"),
      bac.trend.recordCount
        ? el("span", { class: "muted small" }, `${bac.trend.recordCount} records on device${bac.trend.truncated ? ` · showing ${recs.length}` : ""}`)
        : null,
    ),
    trendUnsupported
      ? el("p", { class: "muted small" }, "This device reported it does not support ReadRange (trend-log read).")
      : null,
    el("div", { class: "action-row bac-trend-controls" },
      el("label", { class: "nm-field bac-trend-field" },
        el("span", { class: "nm-field-label" }, "Max records"), maxInput),
      el("button", {
        class: "btn btn-primary",
        disabled: bac.trend.loading || trendUnsupported ? "disabled" : undefined,
        onclick: bacReadTrend,
      }, bac.trend.loading ? "Reading…" : "Read trend"),
      el("button", {
        class: "btn-ghost",
        disabled: recs.length === 0 ? "disabled" : undefined,
        onclick: bacExportTrend,
      }, "Export CSV"),
    ),
    recs.length > 0
      ? el("div", { id: "bac-trend-chart", class: "bac-trend-chart" },
          lineChartCanvas({
            samples: bacTrendSamplesFromRecords(recs),
            width: bacTrendChartWidth(),
            height: 150,
          }))
      : null,
    el("div", { class: "table-scroll table-scroll-fill" },
      el("table", { class: "bac-table bac-trend-table" },
        el("thead", {}, el("tr", {},
          el("th", {}, "Timestamp"),
          el("th", {}, "Value"),
          el("th", {}, "Status"),
        )),
        el("tbody", {}, ...rows),
      )),
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

  const writeDisabled = disabled || !bac.writeArmed ? "disabled" : undefined;
  const armToggle = el("label", {
    class: `bac-write-arm${bac.writeArmed ? " bac-write-arm-on" : ""}`,
    title: "Safety latch — writes and relinquish are disabled until armed",
  },
    el("input", {
      type: "checkbox", disabled,
      checked: bac.writeArmed ? "checked" : undefined,
      onchange: (e) => { bac.writeArmed = e.target.checked; renderAll(); },
    }),
    el("span", {}, bac.writeArmed ? "Writes armed" : "Arm writes"),
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
    el("div", { class: "action-row bac-write-actions" },
      armToggle,
      el("button", { class: "btn btn-primary", disabled: writeDisabled, onclick: () => bacWrite(false) }, "Write"),
      el("button", {
        class: "btn-ghost", disabled: writeDisabled,
        title: "Write Null at the selected priority to release the slot",
        onclick: () => bacWrite(true),
      }, "Relinquish"),
      el("button", { class: "btn-ghost", disabled, onclick: bacRefreshProps }, "Refresh"),
    ),
    bac.writeArmed
      ? el("p", { class: "muted small bac-write-hint bac-write-hint-armed" },
          "Armed — Write/Relinquish will command this live point after a confirmation.")
      : el("p", { class: "muted small bac-write-hint" },
          "Writes are disarmed. Refresh (read-back) stays available; arm to command this point."),
  );
}

// Live COV subscribe/stop toggle plus the update badge (#bac-cov-badge is
// patched in place by bacApplyCovUpdate when notifications arrive).
function bacCovControls() {
  const dev = bacSelectedDevice();
  const obj = bacSelectedObject();
  const active = bacCovActive() && obj && bac.cov.objectKey === bacObjectKey(obj);
  const busy = bac.cov.busy;
  const covUnsupported = dev && !bacCapSupported(dev.key, "cov");
  const blocked = !dev || !obj || busy || (covUnsupported && !active);
  return el("div", { class: "bac-cov-controls" },
    el("button", {
      class: `btn-ghost bac-cov-btn${active ? " bac-cov-on" : ""}`,
      disabled: blocked ? "disabled" : undefined,
      title: covUnsupported && !active
        ? "This device reported it does not support COV (SubscribeCOV)"
        : active
          ? "Stop the live COV subscription"
          : "Subscribe to Change-of-Value notifications for live present-value updates",
      onclick: bacToggleCov,
    }, busy ? "…" : (active ? "Stop live" : (covUnsupported ? "COV unsupported" : "Go live (COV)"))),
    el("span", { id: "bac-cov-badge", class: "muted small bac-cov-badge" },
      active ? `live · ${bac.cov.updates} update${bac.cov.updates === 1 ? "" : "s"}` : ""),
  );
}

// Prominent present-value + status readout for the selected object, drawn from
// the property cache the object grid already populated.
function bacObjectReadout(obj) {
  const cache = bac.objectPropCache[bacObjectKey(obj)];
  const pv = bacCurrentPresentValue(obj);
  const flags = bacPropFromCache(cache, 111)?.display;
  const units = bacnetUnitSymbol(bacPropFromCache(cache, 117)?.display);
  return el("div", { class: "bm-detail-readout" },
    el("div", { class: "bm-detail-pv" },
      pv != null ? pv : el("span", { class: "muted" }, "—"),
      units ? el("span", { class: "bm-detail-units muted small" }, ` ${units}`) : null),
    flags ? el("div", { class: "bm-detail-flags muted small" }, `Status flags: ${flags}`) : null,
  );
}

// Right pane: the selected object's live detail (present value, COV, armed
// write, trend). Stays mounted as an empty prompt while a device is selected so
// the 3-pane layout doesn't jump when you click between objects.
function bacObjectDetailSection() {
  const dev = bacSelectedDevice();
  if (!dev) return null;
  const obj = bacSelectedObject();
  if (!obj) {
    return el("aside", { class: "plugin-section bm-pane bm-pane-right bm-object-detail bm-object-detail-empty" },
      el("p", { class: "muted small" },
        bac.objectsLoading
          ? "Loading objects…"
          : "Select an object to read live values, write a value, or pull its trend log."));
  }
  const children = [
    el("div", { class: "section-head bm-object-detail-head" },
      el("h3", {}, `${obj.typeName}:${obj.instance}${obj.name?.trim() ? ` — ${obj.name.trim()}` : ""}`),
      bacCovControls(),
    ),
    bacObjectReadout(obj),
    bacWritePanel(),
  ];
  if (bacObjectIsTrendLog(obj)) children.push(bacTrendPanel());
  return el("aside", { class: "plugin-section bm-pane bm-pane-right bm-object-detail" }, ...children);
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
function bacTargetChips({ onTargetChange } = {}) {
  const chips = [];
  const seen = new Set();
  const { loaded, adapters } = networkManager.getAdapterSnapshot();
  for (const a of adapters) {
    const t = bacSweepTargetFor(a.name);
    if (!t || seen.has(t.value)) continue;
    seen.add(t.value);
    chips.push(el("button", {
      class: `bac-chip ${bac.target === t.value ? "bac-chip-on" : ""}`,
      "data-target-value": t.value,
      title: `Who-Is target(s) for ${a.name}`,
      disabled: bac.discovering ? "disabled" : undefined,
      onclick: () => {
        bac.target = t.value;
        if (onTargetChange) onTargetChange();
        else renderAll();
      },
    }, `${a.name} · ${t.label}`));
  }
  if (chips.length === 0) {
    return el("p", { class: "muted small bac-chip-row" },
      loaded ? "" : "Reading adapters for subnet suggestions…");
  }
  return el("div", { class: "bac-chip-row" }, ...chips);
}

function renderDiscoverSection() {
  const customSettings = bacDiscoverUsesAdvancedSettings();

  const settingsBtn = el("button", {
    id: "bm-discover-settings-btn",
    class: `btn btn-ghost bm-discover-settings-btn${customSettings ? " bm-discover-settings-custom" : ""}`,
    disabled: bac.discovering ? "disabled" : undefined,
    title: bacDiscoverSettingsTitle(),
    onclick: bacOpenDiscoverSettingsModal,
  },
    "Settings",
    customSettings ? el("span", { class: "bm-discover-settings-dot", "aria-hidden": "true" }) : null,
  );

  const discoverBtn = el("button", {
    class: "btn btn-primary",
    disabled: bac.discovering ? "disabled" : undefined,
    title: bac.devices.length
      ? "Run Who-Is again to refresh the device list"
      : "Discover BACnet devices on the selected network",
    onclick: bacDiscover,
  }, bac.discovering ? "Discovering…" : (bac.devices.length ? "Refresh" : "Discover"));

  const cancelBtn = bac.discovering
    ? el("button", {
        class: "btn btn-ghost bm-discover-cancel",
        disabled: bac.cancelling ? "disabled" : undefined,
        title: "Stop the scan and keep the devices found so far",
        onclick: bacCancelDiscovery,
      }, bac.cancelling ? "Cancelling…" : "Cancel")
    : null;

  const age = bacDiscoveryAgeLabel();
  const ageHint = age && bac.devices.length && !bac.discovering
    ? el("span", { class: "muted small bm-discover-age", title: userState.bacnetManager?.discovery?.discoveredAt || "" },
      `${bac.devices.length} device${bac.devices.length === 1 ? "" : "s"} · last scan ${age}`)
    : null;

  return el("div", { class: "bm-discover" },
    bacDiagnosticsBanner(),
    el("div", { class: "bm-discover-bar" }, settingsBtn, discoverBtn, cancelBtn, ageHint),
    bacDiscoveryProgressEl(),
  );
}

// Warns when the shared 47808 listener failed to bind (usually another BACnet
// app holding the port), which silently breaks broadcast I-Am reception.
function bacDiagnosticsBanner() {
  const d = bac.diagnostics;
  if (!d || d.listenerBound !== false) return null;
  return el("div", { class: "bm-diagnostics-warning", role: "alert" },
    el("span", {},
      `Port ${d.listenerPort} is in use by another application, so broadcast device replies may be missed. ` +
      "Close other BACnet tools (e.g. another explorer/Niagara) and re-run discovery, or target a device IP directly."));
}

// One-shot health probe so a port conflict surfaces without the user guessing
// why discovery comes back empty.
let bacDiagnosticsQueried = false;
function bacEnsureDiagnostics() {
  if (bacDiagnosticsQueried) return;
  bacDiagnosticsQueried = true;
  Promise.resolve()
    .then(() => bacnetRead().diagnostics())
    .then((d) => { if (d) { bac.diagnostics = d; if (d.listenerBound === false) renderAll(); } })
    .catch((err) => console.warn("bacnet diagnostics failed:", err));
}

// Center pane tab bar: Objects | Alarms for the selected device.
function bacDeviceTabBar() {
  const tab = (id, label) => el("button", {
    class: `bm-tab${bac.deviceTab === id ? " bm-tab-active" : ""}`,
    role: "tab",
    "aria-selected": bac.deviceTab === id ? "true" : "false",
    onclick: () => { if (bac.deviceTab !== id) { bac.deviceTab = id; renderAll(); } },
  }, label);
  return el("div", { class: "bm-tabbar", role: "tablist" },
    tab("objects", "Objects"),
    tab("alarms", "Alarms"),
  );
}

// Objects tab body: toolbar + bulk bar + status + the (live-patched) grid.
function bacObjectsPaneBody() {
  return el("div", { class: "bac-browse-unified" },
    bacObjectToolbar(),
    bacObjectBulkBar(),
    el("p", { id: "bac-objects-status", class: "muted small" },
      bac.objectsLoading
        ? (bac.objectsProgress
            ? `Walking object-list… ${bac.objectsProgress.done}/${bac.objectsProgress.total}`
            : "Reading object list…")
        : (bacNamesLoading()
            ? "Loading object names…"
            : (bac.objectPropsLoading ? "Reading property values…" : ""))),
    el("div", { class: "table-scroll bac-browse-scroll" },
      el("table", { id: "bac-browse-table", class: "bac-table bac-browse-table" },
        bacBrowseTableHead(),
        el("tbody", { id: "bac-browse-body" }, ...bacBrowseTableRows()),
      ),
    ),
  );
}

// Center pane: Objects/Alarms for the selected device (empty prompt otherwise).
function renderObjectsCenterPane() {
  const dev = bacSelectedDevice();
  if (!dev) {
    return el("section", { class: "plugin-section bm-pane bm-pane-center bm-pane-empty" },
      el("p", { class: "muted small" }, "Select a device to browse its objects and alarms."),
    );
  }
  const onObjects = bac.deviceTab === "objects";
  return el("section", { class: "plugin-section bm-pane bm-pane-center" },
    el("div", { class: "section-head bm-pane-head" },
      bacDeviceTabBar(),
      onObjects
        ? el("span", { id: "bac-object-count", class: "muted small" }, bacObjectCountText())
        : null,
    ),
    el("p", { class: "muted small bm-pane-subhead", title: bacDeviceLabel(dev) }, bacDeviceLabel(dev)),
    onObjects ? bacObjectsPaneBody() : bacAlarmsPaneBody(dev),
  );
}

function renderBacnetManagerPage() {
  bacEnsureListeners();
  bacEnsureForeignDeviceStatus();
  bacEnsureDiagnostics();
  networkManager.ensureLoaded();
  bacRestoreBrowseColumns();
  bacRestoreDiscovery();
  inboxUi().restoreState?.();
  const inv = inventoryInstance();

  const left = inv
    ? inboxUi().renderDevicePanel(inv)
    : el("section", { class: "plugin-section bm-pane bm-pane-left" },
        el("p", { class: "muted" }, "Inventory is not ready."));

  const detail = bacObjectDetailSection();
  const hasDetail = !!detail;
  bacEnsurePaneWidths();

  const splitterLeft = bacMakeExplorerSplitter({
    id: "bm-splitter-left",
    ariaLabel: "Resize device list",
    min: BM_LEFT_MIN,
    max: BM_LEFT_MAX,
    getWidth: bacLeftPaneWidth,
    setWidth: bacSetLeftPaneWidth,
  });

  const splitterRight = hasDetail
    ? bacMakeExplorerSplitter({
        id: "bm-splitter-right",
        ariaLabel: "Resize properties panel",
        min: BM_RIGHT_MIN,
        max: BM_RIGHT_MAX,
        getWidth: bacRightPaneWidth,
        setWidth: bacSetRightPaneWidth,
        dragRight: true,
      })
    : null;

  const explorer = el("div", {
    id: "bm-explorer",
    class: `bm-explorer${hasDetail ? " bm-explorer-detail" : ""}`,
  },
    left,
    splitterLeft,
    renderObjectsCenterPane(),
    splitterRight,
    detail || null,
  );
  explorer.style.gridTemplateColumns = hasDetail
    ? buildGridColumns({ left: bacLeftPaneWidth(), right: bacRightPaneWidth(), threePane: true })
    : buildGridColumns({ left: bacLeftPaneWidth() });

  return el("div", { id: "bm-root", class: "plugin-controls plugin-controls-fill bac-root bm-unified" },
    renderDiscoverSection(),
    explorer,
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
  renderPage: renderBacnetManagerPage,
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
    bac.driftSummary = null;
    bac.driftMissing = [];
    bac.deviceStatusByKey = {};
    bac.selectedDeviceKey = null;
    bac.objects = [];
    bac.objectPropCache = {};
    bac.objectPropsLoadToken += 1;
    bac.objectPropsLoading = false;
    bac.objectSelection.clear();
    bac.alarms = { loading: false, entries: [], deviceKey: null, error: null, ran: false };
    bacClearPersistedDiscovery();
  },
  isDiscovering: () => bac.discovering,
  getDriftSummary: () => bac.driftSummary,
  getDriftMissing: () => bac.driftMissing,
  getDeviceDriftStatus: (key) => bac.deviceStatusByKey[key] || null,
  driftSummaryEl: bacDriftSummaryEl,
  deviceDriftBadge: bacDeviceStatusBadge,
  addressText: bacAddressText,
  vendorText: bacVendorText,
  deviceLabel: bacDeviceLabel,
  deviceRef: bacDeviceRef,
  discoveryProgressEl: bacDiscoveryProgressEl,
  getPropsForObject: (obj) => bacPropsForObject(obj),
  getTarget: () => bac.target,
  getSelectedDevice: bacSelectedDevice,
  bacnetRead,
  flushOnPageHide,
  renderDevicesScope: () => inboxUi().renderDevicesScope(),
  renderInboxScope: () => inboxUi().renderDevicesScope(),
};
}
