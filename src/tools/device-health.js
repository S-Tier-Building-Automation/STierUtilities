// Device Health service — the "device management, done right" feature. Like the
// BACnet Historian, it writes ZERO BACnet, discovery, scheduling, or storage
// code: each is a declared capability dependency. It periodically health-checks
// every modeled BACnet device using two signals — network reachability
// (netscan) and BACnet responsiveness (a Device-object read via bacnet.read) —
// computes an online/degraded/offline status with flap debouncing, persists it
// onto the inventory equip entity, writes per-device metrics to timeseries, and
// exposes offline/degraded devices as alerts for the Alarm Console to merge.
// Pure + dependency-injected for unit testing under `node --test`.

import { numericFromValue } from "./historian.js";

const JOB_ID = "device-health";

/** BACnet OBJECT_DEVICE object-type — read to probe a device's responsiveness. */
export const OBJECT_DEVICE = 8;
/** BACnet system-status property id; enumerated 0 == operational. */
export const PROP_SYSTEM_STATUS = 112;
/** Valid device lifecycle states. maintenance/decommissioned suppress alerts. */
export const LIFECYCLE_STATES = new Set(["active", "maintenance", "decommissioned"]);

/** Strip a BACnet address's optional ":port" suffix down to the bare host. */
export function deviceIp(device) {
  if (!device || typeof device !== "object") return null;
  const ip = device.address ?? device.deviceRef?.address ?? device.ip;
  if (typeof ip !== "string") return null;
  const host = ip.split(":")[0].trim();
  return host || null;
}

/** deviceInstance off an equip/device ref, or null. */
export function deviceInstanceOf(device) {
  const n = Number(device?.deviceInstance ?? device?.deviceRef?.deviceInstance ?? device?.instance);
  return Number.isFinite(n) ? n : null;
}

/** Pull the enumerated system-status (prop 112) out of a read-properties result. */
export function extractSystemStatus(props) {
  if (!Array.isArray(props)) return null;
  const entry = props.find((p) => p && (p.name === "system-status" || p.id === PROP_SYSTEM_STATUS));
  if (!entry || entry.error || !Array.isArray(entry.values) || entry.values.length === 0) return null;
  return numericFromValue(entry.values[0]);
}

function compactTags(tags) {
  return Object.fromEntries(Object.entries(tags).filter(([, v]) => v != null && String(v) !== ""));
}

/**
 * Pure health state machine. Given the previous health record and a freshly
 * gathered signal, return the next health record. Offline is debounced: an
 * unreachable device holds its prior status until `offlineThreshold` consecutive
 * misses, so a single dropped poll doesn't flap the feed.
 *
 * @param {object|null} prev   previous health record (or null/unknown)
 * @param {{reachable:boolean, rttMs:?number, bacnetResponsive:?boolean, systemStatus:?number, at:number}} signal
 * @param {{offlineThreshold?:number}} [opts]
 */
export function computeHealth(prev, signal, { offlineThreshold = 2 } = {}) {
  const prevStatus = prev?.status || "unknown";
  const at = signal.at;
  let status;
  let consecutiveMisses = prev?.consecutiveMisses || 0;
  let lastSeenAt = prev?.lastSeenAt ?? null;
  let lastRttMs = prev?.lastRttMs ?? null;
  let systemStatus = signal.systemStatus ?? prev?.systemStatus ?? null;

  if (signal.reachable) {
    consecutiveMisses = 0;
    lastSeenAt = at;
    lastRttMs = signal.rttMs ?? null;
    const bacnetUsed = signal.bacnetResponsive != null;
    const sysBad = signal.systemStatus != null && signal.systemStatus !== 0; // 0 == operational
    if (bacnetUsed && signal.bacnetResponsive === false) status = "degraded";
    else if (sysBad) status = "degraded";
    else status = "online";
  } else {
    consecutiveMisses += 1;
    // Debounce: only fall to offline after enough consecutive misses; until then
    // hold a previously-good status (online/degraded). A never-seen device that
    // stays unreachable still flips to offline once the threshold is crossed.
    if (consecutiveMisses >= offlineThreshold) status = "offline";
    else if (prevStatus === "online" || prevStatus === "degraded" || prevStatus === "offline") status = prevStatus;
    else status = "unknown";
  }

  const since = prevStatus === status && prev?.since != null ? prev.since : at;
  return { status, since, checkedAt: at, lastSeenAt, lastRttMs, consecutiveMisses, systemStatus };
}

/**
 * @param {{inventory:object, scheduler:object, bacnet?:object|null, netscan?:object|null,
 *          timeseries?:object|null, now?:()=>number, offlineThreshold?:number}} deps
 */
export function createDeviceHealthService({
  inventory, scheduler, bacnet = null, netscan = null, timeseries = null,
  now = () => Date.now(), offlineThreshold = 2,
}) {
  if (!inventory) throw new Error("device-health requires the inventory capability");
  if (!scheduler) throw new Error("device-health requires the scheduler capability");

  /** Modeled BACnet devices: equip entities tagged device (or carrying a device ref). */
  function listDevices() {
    return inventory.listEntities({ type: "equip" })
      .filter((e) => e?.tags?.device || e?.deviceInstance != null || e?.deviceRef);
  }

  /** Probe one device: reachability (netscan) + BACnet responsiveness (Device read). */
  async function gatherSignal(equip) {
    const ip = deviceIp(equip);
    const deviceInstance = deviceInstanceOf(equip);
    const pingable = Boolean(netscan && ip);

    let reachable = true;
    let rttMs = null;
    if (pingable) {
      try {
        const r = await netscan.isReachable(ip);
        reachable = Boolean(r?.reachable);
        rttMs = r?.rttMs ?? null;
      } catch {
        reachable = false; // a failed probe counts as a miss, not an assumed-up
      }
    }

    let bacnetResponsive = null;
    let systemStatus = null;
    // Skip the BACnet read when ping already proved the device is down — avoids a
    // long protocol timeout on an offline device.
    const skipBacnet = pingable && !reachable;
    if (bacnet && deviceInstance != null && !skipBacnet) {
      try {
        const ref = equip.deviceRef || { deviceInstance };
        const props = await bacnet.readPoint(ref, OBJECT_DEVICE, deviceInstance);
        bacnetResponsive = true;
        systemStatus = extractSystemStatus(props);
      } catch {
        bacnetResponsive = false;
      }
    }
    // Reachability-only mode (no netscan): let the BACnet read stand in for reach.
    if (!pingable && bacnetResponsive != null) reachable = bacnetResponsive;

    return { reachable, rttMs, bacnetResponsive, systemStatus, at: now() };
  }

  function persistHealth(equip, health) {
    inventory.upsertEntity({ id: equip.id, type: "equip", health });
  }

  function writeMetric(equip, health, ts) {
    if (!timeseries) return;
    const fields = { online: health.status === "online" ? 1 : 0 };
    if (typeof health.lastRttMs === "number") fields.rtt_ms = health.lastRttMs;
    timeseries.write({
      measurement: "bacnet_device",
      tags: compactTags({
        device: deviceInstanceOf(equip) != null ? String(deviceInstanceOf(equip)) : "",
        site: equip.siteId,
        equip: equip.id,
        name: equip.name,
      }),
      fields,
      ts,
    });
  }

  const api = {
    /** Modeled devices (with any persisted .health/.lifecycle attached). */
    getDevices() {
      return listDevices();
    },

    /** Probe + recompute + persist a single device; returns its new health. */
    async checkDevice(equip) {
      const signal = await gatherSignal(equip);
      const health = computeHealth(equip.health || null, signal, { offlineThreshold });
      persistHealth(equip, health);
      return health;
    },

    /** Health-check every modeled device. Returns a status tally. */
    async checkAll() {
      const devices = listDevices();
      const ts = now();
      let online = 0, degraded = 0, offline = 0, unknown = 0;
      for (const equip of devices) {
        let health;
        try {
          const signal = await gatherSignal(equip);
          health = computeHealth(equip.health || null, signal, { offlineThreshold });
        } catch {
          // A gather failure shouldn't abort the sweep; treat as a miss.
          health = computeHealth(equip.health || null,
            { reachable: false, rttMs: null, bacnetResponsive: null, systemStatus: null, at: ts },
            { offlineThreshold });
        }
        persistHealth(equip, health);
        writeMetric(equip, health, ts);
        if (health.status === "online") online++;
        else if (health.status === "degraded") degraded++;
        else if (health.status === "offline") offline++;
        else unknown++;
      }
      return { online, degraded, offline, unknown, total: devices.length };
    },

    /**
     * Offline/degraded devices as alert payloads for the alerts service to merge.
     * Devices in maintenance/decommissioned lifecycle are suppressed.
     */
    listAlerts() {
      const out = [];
      for (const equip of listDevices()) {
        const h = equip.health;
        if (!h || (h.status !== "offline" && h.status !== "degraded")) continue;
        const lifecycle = equip.lifecycle || "active";
        if (lifecycle === "maintenance" || lifecycle === "decommissioned") continue;
        out.push({
          equipId: equip.id,
          equipName: equip.name,
          deviceInstance: deviceInstanceOf(equip),
          status: h.status,
          since: h.since ?? null,
          lastSeenAt: h.lastSeenAt ?? null,
        });
      }
      return out;
    },

    /** Set a device's lifecycle state (active | maintenance | decommissioned). */
    setLifecycle(equipId, lifecycle) {
      if (!LIFECYCLE_STATES.has(lifecycle)) throw new Error(`invalid lifecycle "${lifecycle}"`);
      return inventory.upsertEntity({ id: equipId, type: "equip", lifecycle });
    },

    start(intervalMs = 60000) {
      scheduler.register(JOB_ID, { intervalMs, run: () => api.checkAll(), immediate: true });
      return JOB_ID;
    },

    stop() {
      scheduler.unregister(JOB_ID);
    },

    isRunning() {
      return scheduler.has(JOB_ID);
    },
  };

  return api;
}
