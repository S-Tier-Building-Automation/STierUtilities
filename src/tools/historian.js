// BACnet Historian core. The flagship inter-tool feature: it writes ZERO BACnet,
// discovery, scheduling, or storage code — each is a declared capability
// dependency. It periodically reads configured BACnet points via the bacnet.read
// capability and writes their present-value into the timeseries service on a
// scheduler cadence. Pure + dependency-injected for unit testing.

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

const JOB_ID = "bacnet-historian";

export function createHistorian({ bacnet, scheduler, timeseries, now = () => Date.now() }) {
  if (!bacnet) throw new Error("historian requires the bacnet.read capability");
  if (!scheduler) throw new Error("historian requires the scheduler capability");

  // points: { device, objectType, instance, label, lastValue, lastError, reads }
  const points = [];

  function keyOf(p) {
    return `${deviceTag(p.device)}:${p.objectType}:${p.instance}`;
  }

  const api = {
    addPoint(point) {
      const existing = points.find((p) => keyOf(p) === keyOf(point));
      if (existing) return existing;
      const rec = { ...point, lastValue: null, lastError: null, reads: 0 };
      points.push(rec);
      return rec;
    },

    removePoint(point) {
      const i = points.findIndex((p) => keyOf(p) === keyOf(point));
      if (i >= 0) points.splice(i, 1);
      return i >= 0;
    },

    points() {
      return points.map((p) => ({ ...p }));
    },

    /** Read every configured point once and write numeric values to timeseries. */
    async pollOnce() {
      let written = 0;
      let errors = 0;
      const ts = now();
      for (const p of points) {
        try {
          const props = await bacnet.readPoint(p.device, p.objectType, p.instance);
          const value = extractPresentValue(props);
          p.reads++;
          p.lastError = null;
          if (value != null) {
            p.lastValue = value;
            if (timeseries) {
              timeseries.write({
                measurement: "bacnet_point",
                tags: { device: deviceTag(p.device), object: `${p.objectType}:${p.instance}`, label: p.label || "" },
                fields: { present_value: value },
                ts,
              });
              written++;
            }
          }
        } catch (err) {
          p.lastError = String(err && err.message ? err.message : err);
          errors++;
        }
      }
      return { written, errors, points: points.length };
    },

    start(intervalMs = 60000) {
      scheduler.register(JOB_ID, { intervalMs, run: () => api.pollOnce(), immediate: true });
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
