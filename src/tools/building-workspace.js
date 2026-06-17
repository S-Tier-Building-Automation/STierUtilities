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
      selectable: status === "new" || status === "queued",
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

export function bwModelQueuedDevices({ inventory, devices = [], candidates = {}, floor, site, building, makeEntity, keys = null } = {}) {
  if (!inventory || !floor || !site || !building || typeof makeEntity !== "function") {
    return { imported: [], skipped: 0, candidates };
  }
  const next = { ...candidates };
  const requested = Array.isArray(keys) && keys.length ? new Set(keys) : null;
  const queuedKeys = Object.values(next)
    .filter((c) => c?.status === "queued" && (!requested || requested.has(c.key)))
    .map((c) => c.key);
  const byKey = new Map(devices.map((device) => [bwDeviceKey(device), device]));
  const imported = [];
  let skipped = 0;
  for (const key of queuedKeys) {
    const device = byKey.get(key);
    if (!device) {
      skipped++;
      continue;
    }
    const existing = bwFindModeledDeviceForBacnet(inventory.listEntities({ type: "equip" }), device);
    if (existing) {
      next[key] = { ...next[key], status: "modeled", modeledEntityId: existing.id };
      skipped++;
      continue;
    }
    const entity = inventory.upsertEntity(makeEntity({ site, building, floor, device }));
    next[key] = { ...next[key], status: "modeled", modeledEntityId: entity.id, targetFloorId: floor.id };
    imported.push(entity);
  }
  return { imported, skipped, candidates: next };
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

export function pointEntityFromBacnet({ siteId, buildingId, floorId, equipId, device, object, props = [] }) {
  if (!device || !object) throw new Error("point import requires a BACnet device and object");
  const deviceInstance = Number(device.instance ?? device.deviceInstance);
  const objectType = Number(object.objectType);
  const instance = Number(object.instance);
  if (![deviceInstance, objectType, instance].every(Number.isFinite)) {
    throw new Error("point import requires numeric BACnet device instance, object type, and object instance");
  }
  const name = object.name || `${object.typeName || objectType}:${instance}`;
  const unitProp = props.find((p) => p && (p.name === "units" || p.id === 117));
  const sourceRef = bacnetSourceRef(deviceInstance, objectType, instance);
  return {
    type: "point",
    name,
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
    unit: unitProp && !unitProp.error ? unitProp.display : object.unit,
    tags: {
      point: true,
      bacnet: true,
      cur: objectType === 0 || objectType === 2 || objectType === 13,
      writable: objectType === 1 || objectType === 2 || objectType === 5 || objectType === 14 || objectType === 19,
    },
  };
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

export function generateBuildingDashboard(snapshot, { siteId = null, buildingId = null, floorId = null, equipId = null, title = "S-Tier Building Workspace" } = {}) {
  const entities = snapshot?.entities || [];
  const points = entities.filter((e) =>
    e.type === "point" &&
    (!siteId || e.siteId === siteId) &&
    (!buildingId || e.buildingId === buildingId) &&
    (!floorId || e.floorId === floorId) &&
    (!equipId || e.equipId === equipId));
  const uid = slug(`stier-${uidPart(siteId, "site")}-${uidPart(buildingId, "building")}-${uidPart(floorId, "floor")}-${uidPart(equipId, "all")}`).slice(0, 40);
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
        targets: [{ refId: "A", query: 'from(bucket: "utilities") |> range(start: v.timeRangeStart) |> filter(fn: (r) => r._measurement == "bacnet_point") |> filter(fn: (r) => r._field == "present_value")' }],
        gridPos: { x: 0, y: 0, w: 16, h: 9 },
      },
      {
        id: 2,
        type: "table",
        title: "Latest values",
        targets: [{ refId: "A", query: 'from(bucket: "utilities") |> range(start: -1h) |> filter(fn: (r) => r._measurement == "bacnet_point") |> last()' }],
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
    if ((point.tags?.writable || options.commandAll) && writeProperty && commandValue != null) {
      try {
        await writeProperty({ point, ref, value: commandValue, priority: options.priority || 8 });
        step(point, "command", "pass", { value: commandValue, priority: options.priority || 8 });
        // Relinquish has its own try/catch: if the command succeeded but the
        // relinquish failed, the point is left overridden — that's a distinct
        // (and operationally serious) failure, not a command failure.
        try {
          await writeProperty({ point, ref, value: null, priority: options.priority || 8, relinquish: true });
          step(point, "relinquish", "pass", { priority: options.priority || 8 });
        } catch (relinquishErr) {
          step(point, "relinquish", "fail", { error: String(relinquishErr && relinquishErr.message ? relinquishErr.message : relinquishErr) });
        }
      } catch (err) {
        step(point, "command", "fail", { error: String(err && err.message ? err.message : err) });
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
