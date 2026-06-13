// Drives the Observability Pack lifecycle from the frontend: load/persist config,
// install binaries, start/stop services, onboard InfluxDB, check health, and —
// once the pack is up — attach the InfluxDB transport to the timeseries service.
// Owns no UI and (besides the injected sleep) no timers, so it stays unit-testable
// with a mock invoke + a real timeseries service.

import { createInfluxTransport } from "./influx-transport.js";

export function createPackController({ invoke, timeseries, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let config = null;
  let connected = false;

  // Resolve the pack config: prefer the persisted one (stable ports + token across
  // restarts), else pick fresh ports; ensure a token from the secrets store; persist.
  async function ensureConfig() {
    if (!config) {
      try { config = await invoke("observability_load_config"); } catch (_) { config = null; }
    }
    if (!config) config = await invoke("observability_pick_ports");
    if (!config.token) {
      try {
        const token = await invoke("secrets_influx_token");
        if (token) config = { ...config, token };
      } catch (_) { /* leave empty; onboard/write will surface it */ }
    }
    try { await invoke("observability_save_config", { config }); } catch (_) { /* non-fatal */ }
    return config;
  }

  function attachTransport() {
    timeseries.setTransport(createInfluxTransport({ invoke, config }));
    connected = true;
  }

  return {
    status: () => invoke("observability_status"),
    install: () => invoke("observability_install"),
    stop: () => invoke("observability_stop"),

    async ensureConfig() { return ensureConfig(); },
    async writeConfigs() { await ensureConfig(); return invoke("observability_write_configs", { config }); },
    async start() { await ensureConfig(); await invoke("observability_write_configs", { config }); return invoke("observability_start", { config }); },
    async health() { await ensureConfig(); return invoke("observability_health", { config }); },
    async onboard() { await ensureConfig(); return invoke("observability_onboard", { config }); },

    /** Attach the live transport and flush anything buffered. */
    async connect(cfg) {
      if (cfg) config = cfg;
      await ensureConfig();
      attachTransport();
      await timeseries.flushAll();
      return config;
    },

    /**
     * Full bring-up: ensure config -> install if needed -> write configs -> start
     * -> wait for InfluxDB -> onboard -> connect. Each step is optimistic; failures
     * propagate so the UI can report them. `onStep` is an optional progress hook.
     */
    async bringUp(onStep = () => {}) {
      await ensureConfig();
      onStep('status');
      const st = await invoke("observability_status");
      if (!st || !st.installed) { onStep('install'); await invoke("observability_install"); }
      onStep('write-configs');
      await invoke("observability_write_configs", { config });
      onStep('start');
      await invoke("observability_start", { config });
      onStep('wait-influx');
      let up = false;
      for (let i = 0; i < 30; i++) {
        const h = await invoke("observability_health", { config });
        if (h && h.influxUp) { up = true; break; }
        await sleep(1000);
      }
      if (!up) throw new Error("InfluxDB did not become reachable");
      onStep('onboard');
      await invoke("observability_onboard", { config });
      onStep('connect');
      attachTransport();
      await timeseries.flushAll();
      onStep('done');
      return config;
    },

    flush: () => timeseries.flushAll(),
    isConnected: () => connected,
    getConfig: () => config,
  };
}
