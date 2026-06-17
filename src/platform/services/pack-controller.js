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

  // True if we're already connected against an equivalent config, so re-attaching
  // (which would reset `connected` and swap the transport) can be skipped. Compares
  // by value, not reference, so a freshly-loaded config object with the same fields
  // still counts as "already connected".
  function alreadyConnectedWith(cfg) {
    return connected && config != null && cfg != null &&
      config.influxPort === cfg.influxPort &&
      config.grafanaPort === cfg.grafanaPort &&
      config.telegrafListenerPort === cfg.telegrafListenerPort &&
      config.token === cfg.token &&
      config.org === cfg.org &&
      config.bucket === cfg.bucket;
  }

  return {
    status: () => invoke("observability_status"),
    packStatus: () => invoke("observability_pack_status"),
    install: () => invoke("observability_install"),
    async stop() {
      // Clear `connected` so a later connect()/bringUp() actually re-attaches the
      // transport instead of short-circuiting on stale state after a stop/crash.
      const r = await invoke("observability_stop");
      connected = false;
      return r;
    },

    async ensureConfig() { return ensureConfig(); },
    async writeConfigs() { await ensureConfig(); return invoke("observability_write_configs", { config }); },
    async start() { await ensureConfig(); await invoke("observability_write_configs", { config }); return invoke("observability_start", { config }); },
    async health() { await ensureConfig(); return invoke("observability_health", { config }); },
    async onboard() { await ensureConfig(); return invoke("observability_onboard", { config }); },

    /** Attach the live transport and flush anything buffered. */
    async connect(cfg) {
      if (cfg) config = cfg;
      await ensureConfig();
      // Idempotent: if we're already live against this exact config, don't swap the
      // transport / reset `connected` — just flush whatever is buffered.
      if (alreadyConnectedWith(config)) {
        await timeseries.flushAll();
        return config;
      }
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
      // Idempotent: if the pack is already up and connected against this exact
      // config, don't tear it back down / re-attach — just report done.
      if (alreadyConnectedWith(config)) {
        onStep('done');
        return config;
      }
      // install is version-aware: it fast-skips up-to-date components and only
      // (re)downloads what's missing or outdated, so it doubles as the updater.
      onStep('install');
      await invoke("observability_install");
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
