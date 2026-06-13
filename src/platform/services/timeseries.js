// timeseries.v1 — the shared telemetry service. Tools write structured points
// here instead of talking to InfluxDB directly; the service buffers + batches
// them to a backend "transport" when one is attached (the Observability Pack,
// Phase 3) and ALWAYS keeps a local ring buffer of recent points so the service
// is useful even with no backend installed (the "degraded" mode).
//
// Pure and dependency-injected (transport + clock) so it is fully unit-testable
// under `node --test`.

export function createTimeseries(opts = {}) {
  const {
    transport = null, // { write(points): Promise, query?(q): Promise, panelUrl?(spec): string }
    ringCapacity = 500,
    batchSize = 200,
    maxBuffer = 5000,
    now = () => Date.now(),
  } = opts;

  let tx = transport;
  const ring = []; // last N normalized points, kept regardless of backend
  const buffer = []; // points pending delivery to the transport
  let written = 0;
  let dropped = 0;
  let degraded = false;
  let lastError = null;

  function normalize(point) {
    if (!point || typeof point !== "object") throw new Error("point must be an object");
    const measurement = String(point.measurement || "").trim();
    if (!measurement) throw new Error("point.measurement is required");

    const tags = {};
    for (const [k, v] of Object.entries(point.tags || {})) {
      if (v == null) continue;
      tags[k] = String(v);
    }

    const rawFields = point.fields && typeof point.fields === "object" ? point.fields : {};
    const fields = {};
    for (const [k, v] of Object.entries(rawFields)) {
      if (v == null) continue;
      const t = typeof v;
      if (t !== "number" && t !== "boolean" && t !== "string") {
        throw new Error(`field "${k}" must be number|boolean|string (got ${t})`);
      }
      if (t === "number" && !Number.isFinite(v)) throw new Error(`field "${k}" is not finite`);
      fields[k] = v;
    }
    if (Object.keys(fields).length === 0) throw new Error("point.fields must have at least one usable field");

    const ts = Number.isFinite(point.ts) ? point.ts : now();
    return { measurement, tags, fields, ts };
  }

  function dropOldestOverflow() {
    while (buffer.length > maxBuffer) {
      buffer.shift();
      dropped++;
    }
  }

  const service = {
    /** Record a point. Always lands in the ring; queued for delivery if a backend exists. */
    write(point) {
      const p = normalize(point); // throws on caller error — surface it
      ring.push(p);
      while (ring.length > ringCapacity) ring.shift();
      if (tx) {
        buffer.push(p);
        dropOldestOverflow();
      }
      return p;
    },

    /** Deliver one batch to the transport. Re-queues on failure and marks degraded. */
    async flush() {
      if (!tx || buffer.length === 0) return { sent: 0, degraded };
      const batch = buffer.splice(0, batchSize);
      try {
        await tx.write(batch);
        written += batch.length;
        degraded = false;
        lastError = null;
        return { sent: batch.length, degraded: false };
      } catch (err) {
        buffer.unshift(...batch); // retry these next time
        dropOldestOverflow();
        degraded = true;
        lastError = String(err && err.message ? err.message : err);
        return { sent: 0, degraded: true, error: lastError };
      }
    },

    /** Drain the whole buffer in batches. Stops early if the transport starts failing. */
    async flushAll() {
      let total = 0;
      while (tx && buffer.length) {
        const r = await service.flush();
        if (r.sent === 0) break;
        total += r.sent;
      }
      return { sent: total, degraded };
    },

    /** Attach/replace the backend transport at runtime (degraded -> live upgrade). */
    setTransport(t) {
      tx = t;
    },

    hasBackend() {
      return tx != null;
    },

    /** Query the backend. Throws in degraded mode (no backend to query). */
    async query(q) {
      if (!tx || !tx.query) {
        throw new Error("timeseries has no query backend (Observability Pack not installed)");
      }
      return tx.query(q);
    },

    /** Embeddable Grafana panel URL, or null when no dashboard backend exists. */
    panelUrl(spec) {
      return tx && tx.panelUrl ? tx.panelUrl(spec) : null;
    },

    /** The most recent points (works even with no backend — the degraded value). */
    recent(n = 50) {
      return ring.slice(-n);
    },

    stats() {
      return { buffered: buffer.length, ring: ring.length, written, dropped, degraded, lastError, backend: tx != null };
    },
  };

  return service;
}
