import { bacnetSourceRef, parseSourceRef } from "./inventory.js";
import { extractPresentValue } from "./historian.js";

function slug(s) {
  return String(s || "building").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "building";
}

function csvCell(value) {
  const s = value == null ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function compactObject(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v != null && v !== ""));
}

export function bwDeviceKey(device) {
  if (device?.key) return String(device.key);
  const instance = Number(device?.instance ?? device?.deviceInstance);
  const route = device?.network != null ? `:${device.network}:${device.mac || ""}` : "";
  return Number.isFinite(instance) ? `bacnet-device:${instance}${route}` : "";
}

export function bwBacnetDeviceInstance(device) {
  const n = Number(device?.instance ?? device?.deviceInstance);
  return Number.isFinite(n) ? n : null;
}

function sameOptional(a, b) {
  const av = a == null ? "" : String(a);
  const bv = b == null ? "" : String(b);
  return av === bv;
}

export function bwFindModeledDeviceForBacnet(modeledDevices = [], device) {
  const instance = bwBacnetDeviceInstance(device);
  if (instance == null) return null;
  const routed = device?.network != null || device?.mac != null;
  return modeledDevices.find((e) => {
    if (!e?.tags?.device || Number(e.deviceInstance) !== instance) return false;
    const ref = e.deviceRef || {};
    if (!routed && ref.network == null && ref.mac == null) return true;
    return sameOptional(ref.network, device.network) && sameOptional(ref.mac, device.mac);
  }) || null;
}

function modeledDeviceChanged(modeledDevice, device) {
  if (!modeledDevice || !device) return false;
  const ref = modeledDevice.deviceRef || {};
  return (
    (device.address && modeledDevice.address && device.address !== modeledDevice.address) ||
    (device.address && ref.address && device.address !== ref.address) ||
    (device.vendorId != null && modeledDevice.vendorId != null && Number(device.vendorId) !== Number(modeledDevice.vendorId)) ||
    (device.modelName && modeledDevice.modelName && device.modelName !== modeledDevice.modelName)
  );
}

function conflictForDevice(modeledDevices, device, modeledDevice) {
  if (modeledDevice || !device) return "";
  const instance = bwBacnetDeviceInstance(device);
  const sameAddress = modeledDevices.find((e) => {
    const ref = e.deviceRef || {};
    const address = e.address || ref.address;
    return address && device.address && address === device.address && Number(e.deviceInstance) !== instance;
  });
  if (sameAddress) return `Address already modeled as device ${sameAddress.deviceInstance}`;
  return "";
}

export function bwDeviceInboxStatus({ device, candidate = null, modeledDevice = null, modeledDevices = [] } = {}) {
  if (modeledDevice) return modeledDeviceChanged(modeledDevice, device) ? "changed" : "modeled";
  if (candidate?.status === "ignored") return "ignored";
  if (candidate?.status === "queued") return "queued";
  const conflict = conflictForDevice(modeledDevices, device, modeledDevice);
  return conflict ? "conflict" : "new";
}

export function bwDeviceInboxCandidates({ devices = [], modeledDevices = [], candidates = {} } = {}) {
  return devices.map((device) => {
    const key = bwDeviceKey(device);
    const candidate = candidates[key] || null;
    const modeledDevice = bwFindModeledDeviceForBacnet(modeledDevices, device);
    const conflict = conflictForDevice(modeledDevices, device, modeledDevice);
    const status = bwDeviceInboxStatus({ device, candidate, modeledDevice, modeledDevices });
    return {
      key,
      device,
      candidate,
      modeledDevice,
      modeledEntityId: modeledDevice?.id || "",
      status,
      conflict,
      selectable: status === "new" || status === "queued" || status === "changed",
      queueable: status === "new",
    };
  });
}

export function bwQueueInboxDevices({ candidates = {}, keys = [], devices = [], modeledDevices = [], targetFloorId = "", now = () => Date.now() } = {}) {
  const next = { ...candidates };
  const byKey = new Map(bwDeviceInboxCandidates({ devices, modeledDevices, candidates }).map((c) => [c.key, c]));
  for (const key of keys) {
    const info = byKey.get(key);
    if (!info || !info.queueable) continue;
    const instance = bwBacnetDeviceInstance(info.device);
    next[key] = {
      ...(next[key] || {}),
      key,
      discoveredAt: next[key]?.discoveredAt || new Date(now()).toISOString(),
      status: "queued",
      targetFloorId: targetFloorId || next[key]?.targetFloorId || "",
      modeledEntityId: "",
      proposedName: next[key]?.proposedName || info.device?.name || (instance != null ? `Device ${instance}` : "BACnet device"),
      action: next[key]?.action || "add",
      notes: next[key]?.notes || "",
    };
  }
  return next;
}

export function bwRemoveQueuedDevices(candidates = {}, keys = []) {
  const next = { ...candidates };
  for (const key of keys) {
    if (next[key]?.status === "queued") delete next[key];
  }
  return next;
}

/** Assign a target floor to queued import-plan rows (bulk or selected). */
export function bwSetQueuedTargetFloor(candidates = {}, keys = [], targetFloorId = "") {
  const next = { ...candidates };
  const applyKeys = keys?.length
    ? keys
    : Object.values(next).filter((c) => c?.status === "queued").map((c) => c.key);
  for (const key of applyKeys) {
    if (next[key]?.status === "queued") {
      next[key] = { ...next[key], targetFloorId: targetFloorId || "" };
    }
  }
  return next;
}

/** Import discovered BACnet devices directly into inventory (no import-plan queue). */
export function bwImportDevicesToFloor({
  inventory, devices = [], keys = [], candidates = {}, floor, site, building, makeEntity,
} = {}) {
  if (!inventory || typeof makeEntity !== "function") {
    return { imported: [], skipped: 0, candidates };
  }
  const importKeys = [...new Set((keys || []).filter(Boolean))];
  if (!importKeys.length) return { imported: [], skipped: 0, candidates };

  const next = { ...candidates };
  const byKey = new Map(devices.map((device) => [bwDeviceKey(device), device]));
  const imported = [];
  let skipped = 0;
  for (const key of importKeys) {
    const device = byKey.get(key);
    if (!device) {
      skipped++;
      continue;
    }
    const candidate = next[key] || {};
    const targetFloor = inventory.getEntity(candidate.targetFloorId || floor?.id);
    const targetBuilding = inventory.getEntity(targetFloor?.buildingId || targetFloor?.parentId || building?.id);
    const targetSite = inventory.getEntity(targetFloor?.siteId || targetBuilding?.siteId || site?.id);
    if (!targetFloor || !targetBuilding || !targetSite) {
      skipped++;
      continue;
    }
    const existing = bwFindModeledDeviceForBacnet(inventory.listEntities({ type: "equip" }), device);
    if (existing) {
      next[key] = { ...next[key], status: "modeled", modeledEntityId: existing.id };
      skipped++;
      continue;
    }
    const entity = inventory.upsertEntity(makeEntity({
      site: targetSite,
      building: targetBuilding,
      floor: targetFloor,
      device,
    }));
    next[key] = {
      ...next[key],
      status: "modeled",
      modeledEntityId: entity.id,
      targetFloorId: targetFloor.id,
    };
    imported.push(entity);
  }
  return { imported, skipped, candidates: next };
}

export function bwModelQueuedDevices({ inventory, devices = [], candidates = {}, floor, site, building, makeEntity, keys = null } = {}) {
  const importKeys = Array.isArray(keys) && keys.length
    ? keys
    : Object.values(candidates)
      .filter((c) => c?.status === "queued")
      .map((c) => c.key);
  return bwImportDevicesToFloor({
    inventory, devices, keys: importKeys, candidates, floor, site, building, makeEntity,
  });
}

export function bwImportPlanItems({ devices = [], modeledDevices = [], candidates = {}, targetFloorId = "", targetFloorName = "" } = {}) {
  const byKey = new Map(devices.map((device) => [bwDeviceKey(device), device]));
  return Object.values(candidates)
    .filter((candidate) => candidate?.status === "queued")
    .map((candidate) => {
      const device = byKey.get(candidate.key) || null;
      const modeledDevice = device ? bwFindModeledDeviceForBacnet(modeledDevices, device) : null;
      const status = modeledDevice ? "modeled" : "queued";
      const instance = bwBacnetDeviceInstance(device);
      return {
        key: candidate.key,
        device,
        candidate,
        modeledDevice,
        modeledEntityId: modeledDevice?.id || candidate.modeledEntityId || "",
        status,
        action: modeledDevice ? "skip" : (candidate.action || "add"),
        proposedName: candidate.proposedName || device?.name || (instance != null ? `Device ${instance}` : "BACnet device"),
        targetFloorId: candidate.targetFloorId || targetFloorId || "",
        targetFloorName,
        selectable: true,
        queueable: false,
      };
    });
}

function uidPart(id, fallback) {
  return String(id || fallback).replace(/^[^:]+:/, "");
}

export function suggestEquipmentName(objectName = "", fallback = "Equipment") {
  const raw = String(objectName || "").trim();
  if (!raw) return fallback;
  const cleaned = raw
    .replace(/\b(zone|room|temp|temperature|sensor|cmd|command|status|feedback|sp|setpoint|pv)\b/ig, "")
    .replace(/[\s:_/-]+$/g, "")
    .trim();
  const [head] = cleaned.split(/\s+-\s+|--|:|\/|\||_/);
  return (head || raw).trim().replace(/\s+/g, " ") || fallback;
}

export function pointEntityFromBacnet({ siteId, buildingId, floorId, equipId, device, object, props = [], config = {} }) {
  if (!device || !object) throw new Error("point import requires a BACnet device and object");
  const deviceInstance = Number(device.instance ?? device.deviceInstance);
  const objectType = Number(object.objectType);
  const instance = Number(object.instance);
  if (![deviceInstance, objectType, instance].every(Number.isFinite)) {
    throw new Error("point import requires numeric BACnet device instance, object type, and object instance");
  }
  // bacnetName preserves the device's own object name for reference / reset;
  // name is the user-facing display name (config.displayName when supplied).
  const bacnetName = object.bacnetName || object.name || `${object.typeName || objectType}:${instance}`;
  const displayName = String(config.displayName ?? "").trim() || object.name || bacnetName;
  const unitProp = props.find((p) => p && (p.name === "units" || p.id === 117));
  const importedUnit = unitProp && !unitProp.error ? unitProp.display : object.unit;
  const unit = config.unit != null && String(config.unit).trim() !== "" ? String(config.unit).trim() : importedUnit;
  const sourceRef = bacnetSourceRef(deviceInstance, objectType, instance);
  const num = (v) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
  const precision = config.precision != null && config.precision !== "" && Number.isInteger(Number(config.precision))
    ? Math.max(0, Math.min(10, Number(config.precision))) : null;
  const min = num(config.min);
  const max = num(config.max);
  return compactObject({
    type: "point",
    name: displayName,
    bacnetName,
    siteId,
    buildingId,
    floorId,
    equipId,
    sourceRefs: [sourceRef],
    objectType,
    instance,
    deviceInstance,
    deviceRef: compactObject({
      address: device.address,
      network: device.network ?? null,
      mac: device.mac ?? null,
      deviceInstance,
    }),
    unit,
    precision,
    min,
    max,
    historize: config.historize ? true : null,
    tags: {
      point: true,
      bacnet: true,
      cur: objectType === 0 || objectType === 2 || objectType === 13,
      writable: objectType === 1 || objectType === 2 || objectType === 5 || objectType === 14 || objectType === 19,
    },
  });
}

// The codec renders a units property as "symbol (rawEnum)" (e.g. "°F (66)") for
// debugging in the object browser. In the building model we want just the
// symbol, so strip a trailing " (NN)". Passes through bare values and blanks.
export function bacnetUnitSymbol(raw) {
  if (raw == null) return raw;
  return String(raw).replace(/\s*\(\d+\)\s*$/, "").trim();
}

// Apply a point's configured decimal precision to a value for display only
// (storage/historian stays raw). Non-numeric or unset precision passes through.
export function formatModeledValue(point, raw) {
  const precision = point && Number.isInteger(point.precision) ? point.precision : null;
  if (precision == null || raw == null) return raw;
  const s = String(raw).trim();
  if (s === "" || !/^[+-]?\d*\.?\d+$/.test(s)) return raw;
  const n = Number(s);
  return Number.isFinite(n) ? n.toFixed(Math.max(0, Math.min(10, precision))) : raw;
}

// One-time model cleanup: a BACnet object belongs to its controller, but older
// imports parented points to name-inferred floor-level equip shells (siblings of
// the device). Re-parent every BACnet point onto its device equipment (creating
// the device equip if it's missing) and remove the now-empty inferred shells.
// Returns { reparented, removed }. Operates on an inventory instance.
export function bwRegroupPointsUnderDevices(inventory) {
  if (!inventory) return { reparented: 0, removed: 0 };
  const deviceEquipByInstance = new Map();
  for (const e of inventory.listEntities({ type: "equip" })) {
    const inst = Number(e.deviceInstance);
    if (Number.isFinite(inst) && !deviceEquipByInstance.has(inst)) deviceEquipByInstance.set(inst, e);
  }
  let reparented = 0;
  let removedDeviceObjects = 0;
  const orphanedEquipIds = new Set();
  for (const p of inventory.listEntities({ type: "point" })) {
    const inst = Number(p.deviceInstance);
    if (!Number.isFinite(inst)) continue; // manual / non-BACnet points stay put
    // The device object (object-type 8) duplicates the device equipment; drop it.
    if (Number(p.objectType) === 8) {
      if (p.equipId) orphanedEquipIds.add(p.equipId);
      inventory.removeEntity(p.id);
      removedDeviceObjects++;
      continue;
    }
    let devEquip = deviceEquipByInstance.get(inst);
    if (!devEquip) {
      devEquip = inventory.upsertEntity(compactObject({
        type: "equip",
        siteId: p.siteId,
        buildingId: p.buildingId,
        floorId: p.floorId,
        parentId: p.floorId,
        name: `Device ${inst}`,
        deviceInstance: inst,
        deviceRef: p.deviceRef || { deviceInstance: inst },
        address: p.deviceRef?.address || "",
        network: p.deviceRef?.network ?? null,
        mac: p.deviceRef?.mac ?? null,
        tags: { equip: true, device: true, bacnet: true },
      }));
      deviceEquipByInstance.set(inst, devEquip);
    }
    if (devEquip.id && p.equipId !== devEquip.id) {
      if (p.equipId) orphanedEquipIds.add(p.equipId);
      inventory.upsertEntity({
        ...p,
        equipId: devEquip.id,
        siteId: devEquip.siteId,
        buildingId: devEquip.buildingId,
        floorId: devEquip.floorId,
      });
      reparented++;
    }
  }
  // Remove only the shells we just emptied (never device equipment, and never a
  // user equip that was already empty before this pass).
  let removed = 0;
  for (const id of orphanedEquipIds) {
    const e = inventory.getEntity(id);
    if (!e || e.type !== "equip") continue;
    if (e.deviceInstance != null || e.tags?.device) continue;
    if (inventory.listEntities({ type: "point", equipId: id }).length === 0) {
      inventory.removeEntity(id);
      removed++;
    }
  }
  return { reparented, removed, removedDeviceObjects };
}

export function historianPointFromEntity(point, { site, building, floor, equip } = {}) {
  const ref = (point.sourceRefs || []).map(parseSourceRef).find((r) => r?.kind === "bacnet");
  if (!ref) throw new Error(`point "${point.id}" has no BACnet source ref`);
  return {
    device: point.deviceRef || { deviceInstance: ref.deviceInstance },
    objectType: ref.objectType,
    instance: ref.instance,
    label: point.name || point.id,
    site: site?.name || "",
    building: building?.name || "",
    floor: floor?.name || "",
    equip: equip?.name || "",
    pointId: point.id,
  };
}

// ---------------------------------------------------------------------------
// Phase 1 — discovery & onboarding at scale. Pure helpers (no DOM/Tauri) for
// bulk object modeling, re-IP conflict resolution, and discovery drift, so they
// stay node --test'able alongside the rest of this module.
// ---------------------------------------------------------------------------

/** Render a point name from a template; falls back to the object's own name. */
function renderPointName(template, object, equipName) {
  const objType = Number(object?.objectType);
  const typeName = object?.typeName || (Number.isFinite(objType) ? String(objType) : "");
  const instance = object?.instance ?? "";
  const base = object?.name || `${typeName || "obj"}:${instance}`;
  const t = String(template || "").trim();
  if (!t) return base;
  const out = t
    .replaceAll("{equip}", equipName || "")
    .replaceAll("{type}", typeName || "")
    .replaceAll("{instance}", String(instance))
    .replaceAll("{name}", base)
    .trim();
  return out || base;
}

/**
 * Plan how a device's objects map to equipment + point names before committing.
 * Groups objects by an inferred equipment name (suggestEquipmentName) and applies an
 * optional naming template ({equip}/{type}/{instance}/{name}). Pure + previewable so the
 * UI can show the plan and let the user edit it before any inventory write.
 */
export function bwPlanDeviceObjects({ device, objects = [], template = "", defaultEquipName = "" } = {}) {
  const instance = bwBacnetDeviceInstance(device);
  const deviceName = device?.name || (instance != null ? `Device ${instance}` : "BACnet device");
  const fallbackEquip = defaultEquipName || deviceName;
  const items = (objects || []).map((object) => {
    const equipName = suggestEquipmentName(object?.name || "", fallbackEquip);
    return { object, equipName, pointName: renderPointName(template, object, equipName) };
  });
  const equips = [...new Set(items.map((i) => i.equipName))];
  return { items, equips };
}

/**
 * Build the point entities for a planned batch. Equipment ids are resolved by the
 * caller (which creates/looks up equip entities first) via equipIdByName — a Map or a
 * plain object keyed by the plan's equip names. Returns entities ready for
 * inventory.upsertMany().
 */
export function bwModelObjectsBatch({ siteId, buildingId, floorId, device, items = [], equipIdByName = {} } = {}) {
  const lookup = (name) => (equipIdByName instanceof Map ? equipIdByName.get(name) : equipIdByName[name]) || "";
  return (items || []).map((item) => pointEntityFromBacnet({
    siteId,
    buildingId,
    floorId,
    equipId: lookup(item.equipName),
    device,
    // Keep the object's own name as bacnetName; the display name comes from the
    // plan's pointName (or a per-row override in item.config).
    object: { ...item.object, bacnetName: item.object?.name },
    props: item.props || [],
    config: { displayName: item.pointName, ...(item.config || {}) },
  }));
}

/** Rewrite a point's BACnet source ref + device fields onto a new device instance. */
function repointPointEntity(point, device) {
  const newInstance = bwBacnetDeviceInstance(device);
  if (newInstance == null) return point;
  const sourceRefs = (point.sourceRefs || []).map((ref) => {
    const parsed = parseSourceRef(ref);
    return parsed?.kind === "bacnet" ? bacnetSourceRef(newInstance, parsed.objectType, parsed.instance) : ref;
  });
  return {
    ...point,
    sourceRefs,
    deviceInstance: newInstance,
    deviceRef: compactObject({
      address: device.address ?? point.deviceRef?.address,
      network: device.network ?? null,
      mac: device.mac ?? null,
      deviceInstance: newInstance,
    }),
  };
}

/**
 * Resolve a device address/instance conflict (e.g. a re-IP'd or swapped device).
 *  - action "replace": re-point the existing modeled equip + its points onto the new
 *    device instance/address; returns the entities to upsert (equip first, then points).
 *  - any other action ("both"/"ignore"): no changes (caller imports separately).
 */
export function bwResolveDeviceConflict({ action = "replace", modeledDevice, device, points = [] } = {}) {
  if (action !== "replace" || !modeledDevice || !device) return { action, updated: [] };
  const newInstance = bwBacnetDeviceInstance(device);
  const equip = {
    ...modeledDevice,
    deviceInstance: newInstance ?? modeledDevice.deviceInstance,
    address: device.address ?? modeledDevice.address,
    deviceRef: compactObject({
      ...(modeledDevice.deviceRef || {}),
      address: device.address ?? modeledDevice.deviceRef?.address,
      network: device.network ?? null,
      mac: device.mac ?? null,
      deviceInstance: newInstance ?? modeledDevice.deviceInstance,
    }),
  };
  const repointed = (points || [])
    .filter((p) => Number(p.deviceInstance) === Number(modeledDevice.deviceInstance))
    .map((p) => repointPointEntity(p, device));
  return { action: "replace", updated: [equip, ...repointed] };
}

/** Which device fields drifted between two observations of the same device key. */
function deviceDriftFields(before, after) {
  const fields = [];
  for (const k of ["address", "vendorId", "modelName", "name"]) {
    const a = before?.[k];
    const b = after?.[k];
    if (a != null && b != null && String(a) !== String(b)) fields.push(k);
  }
  return fields;
}

/**
 * Classify a fresh discovery against the previously-seen set: each current device is
 * new / returning / changed (address/vendor/model/name drift), plus a `missing` list for
 * devices seen before but absent now. Pure; the caller persists `current` as the next
 * baseline.
 */
export function bwClassifyDiscovery(prev = [], current = []) {
  const prevList = Array.isArray(prev) ? prev : Object.values(prev || {});
  const prevByKey = new Map(prevList.map((d) => [bwDeviceKey(d), d]));
  const seen = new Set();
  const devices = (current || []).map((device) => {
    const key = bwDeviceKey(device);
    seen.add(key);
    const before = prevByKey.get(key);
    if (!before) return { key, device, status: "new", changes: [] };
    const changes = deviceDriftFields(before, device);
    return { key, device, status: changes.length ? "changed" : "returning", changes };
  });
  const missing = [...prevByKey.entries()].filter(([k]) => !seen.has(k)).map(([, d]) => d);
  const summary = devices.reduce(
    (acc, d) => { acc[d.status] += 1; return acc; },
    { new: 0, returning: 0, changed: 0 },
  );
  summary.missing = missing.length;
  return { devices, missing, summary };
}

export function generateBuildingDashboard(snapshot, { siteId = null, buildingId = null, floorId = null, equipId = null, title = "S-Tier Building Workspace" } = {}) {
  const entities = snapshot?.entities || [];
  const points = entities.filter((e) =>
    e.type === "point" &&
    (!siteId || e.siteId === siteId) &&
    (!buildingId || e.buildingId === buildingId) &&
    (!floorId || e.floorId === floorId) &&
    (!equipId || e.equipId === equipId));
  const uid = slug(`stier-${uidPart(siteId, "site")}-${uidPart(buildingId, "building")}-${uidPart(floorId, "floor")}-${uidPart(equipId, "all")}`).slice(0, 40);
  // Scope the telemetry panels to exactly the in-scope modeled points. The
  // historian writes the tag `point` = the inventory point id, so we filter by
  // that id set rather than the site/building/floor/equip tags (which carry entity
  // *names*, and which `compactTags` drops when empty). `exists r.point` skips any
  // series without the tag, and the sentinel id keeps a scoped-but-empty dashboard
  // from falling back to unscoped (global) telemetry.
  const pointIds = points.map((p) => p.id).filter(Boolean);
  const idSet = (pointIds.length ? pointIds : ["__no_modeled_points__"]).map((id) => JSON.stringify(id)).join(", ");
  const pointFilter = ` |> filter(fn: (r) => exists r.point and contains(value: r.point, set: [${idSet}]))`;
  return {
    uid,
    title,
    tags: ["s-tier", "building-workspace"],
    timezone: "browser",
    schemaVersion: 39,
    version: 1,
    refresh: "30s",
    templating: {
      list: [],
    },
    panels: [
      {
        id: 1,
        type: "timeseries",
        title: "Present value trend",
        targets: [{ refId: "A", query: `from(bucket: "utilities") |> range(start: v.timeRangeStart) |> filter(fn: (r) => r._measurement == "bacnet_point") |> filter(fn: (r) => r._field == "present_value")${pointFilter}` }],
        gridPos: { x: 0, y: 0, w: 16, h: 9 },
      },
      {
        id: 2,
        type: "table",
        title: "Latest values",
        targets: [{ refId: "A", query: `from(bucket: "utilities") |> range(start: -1h) |> filter(fn: (r) => r._measurement == "bacnet_point")${pointFilter} |> last()` }],
        gridPos: { x: 16, y: 0, w: 8, h: 9 },
      },
      {
        id: 3,
        type: "stat",
        title: "Modeled points",
        options: { reduceOptions: { values: false, calcs: ["lastNotNull"] } },
        targets: [{ refId: "A", query: String(points.length) }],
        gridPos: { x: 0, y: 9, w: 8, h: 4 },
      },
      {
        id: 4,
        type: "table",
        title: "Polling errors",
        targets: [{ refId: "A", query: 'from(bucket: "utilities") |> range(start: -24h) |> filter(fn: (r) => r._measurement == "bacnet_point_error")' }],
        gridPos: { x: 8, y: 9, w: 16, h: 4 },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Phase 2 — live control & commissioning. Pure decoders + verify logic.
// ---------------------------------------------------------------------------

/**
 * Decode a BACnet priority-array read into 16 slots. `values` is the decoded property
 * value array (each {kind, value}; empty slots are kind "null"). BACnet priority 1 is
 * highest, so the commanding slot is the lowest-numbered non-null one.
 */
export function parsePriorityArray(values) {
  const slots = [];
  for (let i = 0; i < 16; i++) {
    const v = Array.isArray(values) ? values[i] : null;
    const isNull = !v || v.kind === "null" || v.kind == null || v.value == null;
    slots.push({ level: i + 1, active: !isNull, value: isNull ? null : v.value, kind: isNull ? null : v.kind });
  }
  const activeSlot = slots.find((s) => s.active) || null;
  return { slots, activeLevel: activeSlot ? activeSlot.level : null, activeValue: activeSlot ? activeSlot.value : null };
}

/** BACnet property id buckets for grouped object inspection. */
const BW_PROP_GROUP_DEFS = [
  { key: "identity", label: "Identity", ids: new Set([77, 79, 28, 120, 121, 70]) },
  { key: "value", label: "Value", ids: new Set([85, 87, 104, 4, 46, 74]) },
  { key: "status", label: "Status", ids: new Set([111, 36, 103, 81, 112]) },
  { key: "limits", label: "Limits", ids: new Set([65, 69, 59, 45, 25]) },
  { key: "alarming", label: "Alarming / COV", ids: new Set([22, 35, 72, 17]) },
  { key: "device", label: "Device", ids: new Set([44, 12, 98, 139, 107, 62, 58, 155, 11, 73]) },
];

/** Turn a BACnet kebab property name into a readable label. */
export function humanizePropName(name) {
  if (!name || typeof name !== "string") return "Property";
  if (name.startsWith("property-")) return `Property ${name.slice("property-".length)}`;
  return name.split("-").map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : "")).join(" ");
}

function bwPropRowFromEntry(entry) {
  const display = entry?.display ?? "";
  const hasValue = display !== "" || (Array.isArray(entry?.values) && entry.values.length);
  if (!hasValue && !entry?.error) return null;
  return {
    id: entry.id,
    label: humanizePropName(entry.name),
    display: display || "—",
    raw: entry.name || "",
    error: entry.error || null,
  };
}

/** Group a readPoint property list into labeled sections for the Properties pane. */
export function groupObjectProperties(props) {
  if (!Array.isArray(props) || !props.length) return [];
  const assigned = new Set();
  const groups = [];
  for (const def of BW_PROP_GROUP_DEFS) {
    const rows = [];
    for (const p of props) {
      if (p.id === 8 || !def.ids.has(p.id)) continue;
      const row = bwPropRowFromEntry(p);
      if (!row) continue;
      assigned.add(p.id);
      rows.push(row);
    }
    if (rows.length) groups.push({ key: def.key, label: def.label, rows });
  }
  const other = [];
  for (const p of props) {
    if (p.id === 8 || assigned.has(p.id)) continue;
    const row = bwPropRowFromEntry(p);
    if (!row) continue;
    other.push(row);
  }
  if (other.length) groups.push({ key: "other", label: "Other", rows: other });
  return groups;
}

/** Decode a BACnet status-flags bit-string into named flags. Accepts the {kind,bits} value, a raw bits string, or a property entry. */
export function interpretStatusFlags(input) {
  const names = ["inAlarm", "fault", "overridden", "outOfService"];
  const labels = ["in-alarm", "fault", "overridden", "out-of-service"];
  let bits = "";
  if (typeof input === "string") bits = input;
  else if (input && typeof input.bits === "string") bits = input.bits;
  else if (input && Array.isArray(input.values) && input.values[0]) bits = input.values[0].bits || "";
  const at = (i) => bits.charAt(i) === "1";
  const out = { raised: [] };
  names.forEach((n, i) => { out[n] = at(i); if (at(i)) out.raised.push(labels[i]); });
  return out;
}

/** Does a commissioning readback match the commanded value (numeric tolerance, else exact)? */
export function commissioningValueMatches(got, expected, tolerance = 0.5) {
  if (got == null) return false;
  const g = Number(got), e = Number(expected);
  if (!Number.isFinite(g) || !Number.isFinite(e)) return String(got) === String(expected);
  return Math.abs(g - e) <= (Number.isFinite(tolerance) ? tolerance : 0.5);
}

export async function runCommissioning({ points, bacnet, writeProperty, options = {}, now = () => Date.now() }) {
  const startedAt = new Date(now()).toISOString();
  const steps = [];
  const step = (point, check, status, detail = {}) => {
    steps.push({ pointId: point.id, pointName: point.name, check, status, at: new Date(now()).toISOString(), ...detail });
  };

  for (const point of points) {
    const ref = (point.sourceRefs || []).map(parseSourceRef).find((r) => r?.kind === "bacnet");
    if (!ref) {
      step(point, "source", "skip", { error: "No BACnet source ref" });
      continue;
    }
    let props;
    try {
      props = await bacnet.readPoint({ deviceInstance: ref.deviceInstance }, ref.objectType, ref.instance);
      const value = extractPresentValue(props);
      step(point, "read-present-value", value == null ? "warn" : "pass", { value });
      const min = Number(point.min ?? options.min);
      const max = Number(point.max ?? options.max);
      if (Number.isFinite(value) && (Number.isFinite(min) || Number.isFinite(max))) {
        const ok = (!Number.isFinite(min) || value >= min) && (!Number.isFinite(max) || value <= max);
        step(point, "range", ok ? "pass" : "fail", { value, min: Number.isFinite(min) ? min : null, max: Number.isFinite(max) ? max : null });
      }
    } catch (err) {
      step(point, "read-present-value", "fail", { error: String(err && err.message ? err.message : err) });
      continue;
    }

    const commandValue = point.commandValue ?? options.commandValue;
    const priority = options.priority || 8;
    const writable = point.tags?.writable || options.commandAll;
    const isBinary = [3, 4, 5].includes(Number(ref.objectType)); // BI / BO / BV
    const wantVerify = Boolean(options.verify);

    // Read back present-value after a command and record whether it landed.
    const verifyReadback = async (expected) => {
      try {
        const after = await bacnet.readPoint({ deviceInstance: ref.deviceInstance }, ref.objectType, ref.instance);
        const got = extractPresentValue(after);
        const ok = commissioningValueMatches(got, expected, options.tolerance);
        step(point, "verify", ok ? "pass" : "fail", {
          expected, value: got,
          ...(ok ? {} : { error: got == null ? "no readback" : "value did not change as commanded (possible stuck output or higher-priority override)" }),
        });
      } catch (err) {
        step(point, "verify", "fail", { expected, error: String(err && err.message ? err.message : err) });
      }
    };

    // Relinquish helper (its own try/catch: a failed relinquish leaves the point
    // overridden — a distinct, operationally serious failure, not a command failure).
    const relinquish = async () => {
      try {
        await writeProperty({ point, ref, value: null, priority, relinquish: true });
        step(point, "relinquish", "pass", { priority });
      } catch (relinquishErr) {
        step(point, "relinquish", "fail", { error: String(relinquishErr && relinquishErr.message ? relinquishErr.message : relinquishErr) });
      }
    };

    if (writable && writeProperty && options.toggleVerify && isBinary) {
      // Toggle-and-verify: drive active then inactive, confirming each, then release.
      // Relinquish runs in `finally` so a failure on a later write can't leave the
      // point commanded; we only release if at least one command actually landed.
      let commanded = false;
      try {
        for (const state of [1, 0]) {
          await writeProperty({ point, ref, value: state, priority });
          commanded = true;
          step(point, "command", "pass", { value: state, priority });
          if (wantVerify) await verifyReadback(state);
        }
      } catch (err) {
        step(point, "command", "fail", { error: String(err && err.message ? err.message : err) });
      } finally {
        if (commanded) await relinquish();
      }
    } else if (writable && writeProperty && commandValue != null) {
      let commanded = false;
      try {
        await writeProperty({ point, ref, value: commandValue, priority });
        commanded = true;
        step(point, "command", "pass", { value: commandValue, priority });
        if (wantVerify) await verifyReadback(commandValue);
      } catch (err) {
        step(point, "command", "fail", { error: String(err && err.message ? err.message : err) });
      } finally {
        if (commanded) await relinquish();
      }
    }
  }

  const failed = steps.filter((s) => s.status === "fail").length;
  const warned = steps.filter((s) => s.status === "warn").length;
  return {
    type: "commissioningRun",
    name: `Commissioning ${startedAt}`,
    startedAt,
    finishedAt: new Date(now()).toISOString(),
    status: failed ? "fail" : warned ? "warn" : "pass",
    steps,
    notes: options.notes || "",
  };
}

export function exportCommissioningMarkdown(snapshot, run) {
  const entities = snapshot?.entities || [];
  const sites = entities.filter((e) => e.type === "site");
  const buildings = entities.filter((e) => e.type === "building");
  const floors = entities.filter((e) => e.type === "floor");
  const equips = entities.filter((e) => e.type === "equip");
  const points = entities.filter((e) => e.type === "point");
  const lines = [
    `# ${run?.name || "Commissioning Report"}`,
    "",
    `Status: ${run?.status || "unknown"}`,
    `Started: ${run?.startedAt || ""}`,
    `Finished: ${run?.finishedAt || ""}`,
    "",
    "## Model Summary",
    `- Sites: ${sites.length}`,
    `- Buildings: ${buildings.length}`,
    `- Floors: ${floors.length}`,
    `- Equipment: ${equips.length}`,
    `- Points: ${points.length}`,
    "",
    "## Results",
    "| Point | Check | Status | Value | Detail |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const s of run?.steps || []) {
    const detail = s.error || [s.min != null ? `min ${s.min}` : "", s.max != null ? `max ${s.max}` : ""].filter(Boolean).join(", ");
    lines.push(`| ${s.pointName || s.pointId || ""} | ${s.check} | ${s.status} | ${s.value ?? ""} | ${detail} |`);
  }
  if (run?.notes) lines.push("", "## Notes", run.notes);
  return `${lines.join("\n")}\n`;
}

export function exportCommissioningCsv(run) {
  const rows = [["pointId", "pointName", "check", "status", "value", "error", "at"]];
  for (const s of run?.steps || []) rows.push([s.pointId, s.pointName, s.check, s.status, s.value ?? "", s.error || "", s.at]);
  return `${rows.map((r) => r.map(csvCell).join(",")).join("\n")}\n`;
}
