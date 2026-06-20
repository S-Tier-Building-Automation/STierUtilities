// BACnet Historian core. The flagship inter-tool feature: it writes ZERO BACnet,
// discovery, scheduling, or storage code — each is a declared capability
// dependency. It periodically reads configured BACnet points via the bacnet.read
// capability and writes their present-value into the timeseries service on a
// scheduler cadence. Optional COV subscriptions stream changes between polls.
// Pure + dependency-injected for unit testing.

/** Coerce a decoded BacnetValue ({kind, value}) to a number, or null if non-numeric. */
export function numericFromValue(v) {
  if (v == null) return null;
  switch (v.kind) {
    case "real":
    case "double":
    case "unsigned":
    case "signed":
    case "enumerated":
      return typeof v.value === "number" ? v.value : Number(v.value);
    case "boolean":
      return v.value ? 1 : 0;
    default:
      return null;
  }
}

/** Pull a numeric present-value out of a bacnet_read_properties result. */
export function extractPresentValue(props) {
  if (!Array.isArray(props)) return null;
  const entry = props.find((p) => p && (p.name === "present-value" || p.id === 85));
  if (!entry || entry.error || !Array.isArray(entry.values) || entry.values.length === 0) return null;
  return numericFromValue(entry.values[0]);
}

function deviceTag(device) {
  if (device == null) return "?";
  return String(device.deviceInstance ?? device.instance ?? device.id ?? "?");
}

function deviceInstanceOf(device) {
  const n = Number(device?.deviceInstance ?? device?.instance ?? device?.id);
  return Number.isFinite(n) ? n : null;
}

function deviceIp(device) {
  if (!device || typeof device !== "object") return null;
  const ip = device.address ?? device.ip;
  if (typeof ip !== "string") return null;
  // BACnet addresses often carry a port suffix (e.g. "192.168.1.10:47808")
  // that the reachability check can't parse — strip it to the bare host.
  const host = ip.split(":")[0].trim();
  return host || null;
}

function compactTags(tags) {
  return Object.fromEntries(Object.entries(tags).filter(([, v]) => v != null && String(v) !== ""));
}

const JOB_ID = "bacnet-historian";

export function createHistorian({ bacnet, scheduler, timeseries, netscan, now = () => Date.now(), maxSamples = 1000 }) {
  if (!bacnet) throw new Error("historian requires the bacnet.read capability");
  if (!scheduler) throw new Error("historian requires the scheduler capability");

  // points: { device, objectType, instance, label, lastValue, lastError, reads }
  const points = [];
  /** @type {Map<number, string>} processId -> point key */
  const covByProcess = new Map();
  let covActive = false;
  let reachabilityCheck = true;

  function keyOf(p) {
    return `${deviceTag(p.device)}:${p.objectType}:${p.instance}`;
  }

  function findPoint(key) {
    return points.find((p) => keyOf(p) === key) || null;
  }

  async function isDeviceReachable(device) {
    if (!netscan || !reachabilityCheck) return true;
    const ip = deviceIp(device);
    if (!ip) return true;
    try {
      const result = await netscan.isReachable(ip);
      return Boolean(result?.reachable);
    } catch {
      return true;
    }
  }

  function pushSample(p, value, ts) {
    if (!p.samples) p.samples = [];
    p.samples.push({ ts, value });
    if (p.samples.length > maxSamples) p.samples.splice(0, p.samples.length - maxSamples);
  }

  function writePointSample(p, value, ts) {
    p.reads++;
    p.lastError = null;
    if (value == null) return false;
    p.lastValue = value;
    pushSample(p, value, ts);
    if (!timeseries) return false;
    timeseries.write({
      measurement: "bacnet_point",
      tags: compactTags({
        site: p.site,
        building: p.building,
        floor: p.floor,
        equip: p.equip,
        point: p.pointId,
        device: deviceTag(p.device),
        object: `${p.objectType}:${p.instance}`,
        label: p.label || "",
      }),
      fields: { present_value: value },
      ts,
    });
    return true;
  }

  async function subscribePointCov(p) {
    if (!bacnet.subscribeCov) return;
    const deviceInstance = deviceInstanceOf(p.device);
    if (deviceInstance == null) throw new Error("COV subscribe requires deviceInstance on the point device ref");
    const processId = await bacnet.subscribeCov({
      device: p.device,
      deviceInstance,
      objectType: p.objectType,
      instance: p.instance,
    });
    covByProcess.set(Number(processId), keyOf(p));
  }

  async function unsubscribePointCov(p, processId) {
    if (!bacnet.unsubscribeCov || processId == null) return;
    try {
      await bacnet.unsubscribeCov({
        device: p.device,
        objectType: p.objectType,
        instance: p.instance,
        processId,
      });
    } catch {
      // Best-effort cleanup when a device drops off the network.
    }
  }

  async function unsubscribeCovAll() {
    const pending = [];
    for (const [processId, key] of covByProcess) {
      const p = findPoint(key);
      if (p) pending.push(unsubscribePointCov(p, processId));
    }
    covByProcess.clear();
    covActive = false;
    await Promise.allSettled(pending);
  }

  async function subscribeCovAll() {
    if (!bacnet.subscribeCov) return;
    await unsubscribeCovAll();
    covActive = true;
    for (const p of points) {
      try {
        await subscribePointCov(p);
      } catch (err) {
        p.lastError = String(err && err.message ? err.message : err);
      }
    }
  }

  const api = {
    addPoint(point) {
      const tag = String(deviceTag(point && point.device)).trim();
      // Reject not just the "?" sentinel but other unusable identifiers
      // (NaN deviceInstance, empty id) that would otherwise form a junk key.
      if (!tag || tag === "?" || tag === "NaN" || tag === "undefined" || tag === "null") {
        throw new Error("historian addPoint requires a resolvable device identifier (deviceInstance/instance/id)");
      }
      const existing = points.find((p) => keyOf(p) === keyOf(point));
      if (existing) {
        // Merge configuration fields only; preserve accumulated read state.
        const { lastValue, lastError, reads, samples } = existing;
        Object.assign(existing, point, { lastValue, lastError, reads, samples: samples || [] });
        if (covActive) void subscribePointCov(existing).catch((err) => { existing.lastError = String(err); });
        return existing;
      }
      const rec = { ...point, lastValue: null, lastError: null, reads: 0, samples: [] };
      points.push(rec);
      if (covActive) void subscribePointCov(rec).catch((err) => { rec.lastError = String(err); });
      return rec;
    },

    removePoint(point) {
      const key = keyOf(point);
      const i = points.findIndex((p) => keyOf(p) === key);
      if (i < 0) return false;
      const removed = points[i];
      for (const [processId, mapped] of covByProcess) {
        if (mapped !== key) continue;
        covByProcess.delete(processId);
        void unsubscribePointCov(removed, processId);
        break;
      }
      points.splice(i, 1);
      return true;
    },

    clearPoints() {
      void unsubscribeCovAll();
      points.splice(0, points.length);
    },

    points() {
      return points.map((p) => ({ ...p, samples: p.samples ? [...p.samples] : [] }));
    },

    /** In-memory trend samples for a configured point (poll + COV). */
    history(point) {
      const p = findPoint(keyOf(point));
      if (!p || !p.samples?.length) return [];
      return p.samples.map((s) => ({ ...s }));
    },

    /** Apply a bacnet:cov event payload; returns true when a configured point was updated. */
    handleCovEvent(payload) {
      if (!payload || !covActive) return false;
      const key = covByProcess.get(Number(payload.processId));
      if (!key) return false;
      const p = findPoint(key);
      if (!p) return false;
      if (Number(payload.objectType) !== Number(p.objectType) || Number(payload.instance) !== Number(p.instance)) {
        return false;
      }
      const value = extractPresentValue(payload.values);
      writePointSample(p, value, now());
      return true;
    },

    covEnabled() {
      return covActive;
    },

    /** Read every configured point once and write numeric values to timeseries. */
    async pollOnce() {
      let written = 0;
      let errors = 0;
      let skipped = 0;
      const ts = now();
      for (const p of points) {
        try {
          if (!(await isDeviceReachable(p.device))) {
            p.lastError = "device unreachable";
            errors++;
            skipped++;
            continue;
          }
          const props = await bacnet.readPoint(p.device, p.objectType, p.instance);
          const value = extractPresentValue(props);
          if (writePointSample(p, value, ts)) written++;
        } catch (err) {
          p.lastError = String(err && err.message ? err.message : err);
          errors++;
        }
      }
      return { written, errors, skipped, points: points.length };
    },

    start(intervalMs = 60000, opts = {}) {
      reachabilityCheck = opts.reachabilityCheck !== false;
      const useCov = Boolean(opts.cov);
      if (useCov) void subscribeCovAll();
      else void unsubscribeCovAll();
      scheduler.register(JOB_ID, { intervalMs, run: () => api.pollOnce(), immediate: true });
    },

    stop() {
      scheduler.unregister(JOB_ID);
      void unsubscribeCovAll();
    },

    isRunning() {
      return scheduler.has(JOB_ID);
    },
  };

  return api;
}
