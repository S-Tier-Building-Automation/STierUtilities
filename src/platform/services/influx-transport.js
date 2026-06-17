// The InfluxDB transport for the timeseries service. When the Observability Pack
// is running, the observability UI builds one of these and attaches it via
// timeseries.setTransport(), upgrading the service from degraded (ring-buffer)
// mode to live delivery. `write` hands normalized points to the Rust
// `timeseries_write` command (which encodes line protocol and POSTs to InfluxDB);
// `panelUrl` builds embeddable Grafana URLs. `invoke` is injected for testability.

/**
 * Build an embeddable Grafana URL.
 *  - spec.panelId set  -> a single-panel `/d-solo/...` embed
 *  - otherwise         -> a full-dashboard `/d/...` embed in kiosk mode
 * spec.vars become `var-<k>=<v>` template variables; spec.from/to set the range.
 */
export function buildGrafanaPanelUrl(config, spec = {}) {
  const base = `http://127.0.0.1:${config.grafanaPort}`;
  const params = new URLSearchParams();
  params.set("orgId", "1");
  if (spec.from) params.set("from", String(spec.from));
  if (spec.to) params.set("to", String(spec.to));
  for (const [k, v] of Object.entries(spec.vars || {})) params.set(`var-${k}`, String(v));
  const dash = encodeURIComponent(spec.dashboard || "");

  if (spec.panelId != null) {
    params.set("panelId", String(spec.panelId));
    return `${base}/d-solo/${dash}?${params.toString()}`;
  }
  return `${base}/d/${dash}?${params.toString()}&kiosk`;
}

export function createInfluxTransport({ invoke, config }) {
  if (typeof invoke !== "function") throw new Error("createInfluxTransport requires an invoke function");
  const validPort = (p) => Number.isInteger(p) && p >= 1 && p <= 65535;
  if (!config || !validPort(config.influxPort)) throw new Error("createInfluxTransport requires a PackConfig with a valid influxPort (1-65535)");
  if (!validPort(config.grafanaPort)) throw new Error("createInfluxTransport requires a PackConfig with a valid grafanaPort (1-65535)");

  return {
    /** Deliver a batch of normalized points. Throws on failure so the service re-queues. */
    async write(points) {
      await invoke("timeseries_write", { config, points });
    },
    /** Embeddable Grafana panel/dashboard URL. */
    panelUrl(spec) {
      return buildGrafanaPanelUrl(config, spec);
    },
  };
}
