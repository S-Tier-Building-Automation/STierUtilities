// Native capability implementations. Each factory receives the tool's scoped
// host and registers the capabilities its manifest declares, wrapping the raw
// Tauri `invoke` commands behind a stable, reusable interface other tools call
// via host.use(). `invoke` is injected so this module is unit-testable with a
// mock under `node --test` (no Tauri runtime needed).

import { createTimeseries } from "../platform/services/timeseries.js";
import { createScheduler } from "../platform/services/scheduler.js";
import { createHistorian } from "./historian.js";
import { createBrowserInventoryStorage, createInventory } from "./inventory.js";

// ---- pure helpers (exported for tests) ----

/** Dotted IPv4 mask -> CIDR prefix length, or null if malformed. */
export function maskToPrefix(mask) {
  const parts = String(mask || "").split(".").map((n) => parseInt(n, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  let bits = 0;
  for (const oct of parts) bits += ((oct >>> 0).toString(2).match(/1/g) || []).length;
  return bits;
}

/** Parse "192.168.1.0/24" -> { ip, prefix }. Throws on malformed input. */
export function parseCidr(cidr) {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(String(cidr).trim());
  if (!m) throw new Error(`invalid CIDR: "${cidr}"`);
  const ip = m[1];
  const prefix = Number(m[2]);
  const octets = ip.split(".").map(Number);
  if (octets.some((o) => o < 0 || o > 255) || prefix > 32) throw new Error(`invalid CIDR: "${cidr}"`);
  return { ip, prefix };
}

/**
 * Derive the scannable subnet from a networkmanager adapter state object
 * ({ ipAddress, subnetMask }). Returns { ip, prefix, network, hostCount } or null.
 */
export function subnetFromState(state) {
  if (!state || !state.ipAddress) return null;
  const prefix = maskToPrefix(state.subnetMask);
  if (prefix == null || prefix < 1 || prefix > 32) return null;
  const ipParts = state.ipAddress.split(".").map((n) => parseInt(n, 10));
  if (ipParts.length !== 4 || ipParts.some((n) => Number.isNaN(n))) return null;
  const ipNum = ((ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3]) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const net = (ipNum & mask) >>> 0;
  const network = [(net >>> 24) & 255, (net >>> 16) & 255, (net >>> 8) & 255, net & 255].join(".");
  const hostCount = Math.max(0, Math.pow(2, 32 - prefix) - 2);
  return { ip: state.ipAddress, prefix, network, hostCount };
}

// ---- factory wiring ----

/**
 * Build the native-tool factory map for the kernel.
 * @param {(cmd: string, args?: object) => Promise<any>} invoke  Tauri invoke (or a mock)
 * @returns {Map<string, (host: object) => Promise<void>>}
 */
export function buildFactories(invoke, options = {}) {
  const factories = new Map();

  // The observability service provides the shared timeseries capability. In
  // Phase 2 it runs degraded (no transport -> in-memory ring buffer only); the
  // Observability Pack supervisor attaches a real InfluxDB transport in Phase 3.
  factories.set("observability", async (host) => {
    const ts = options.timeseries || createTimeseries(options.timeseriesOpts || {});
    host.provide("timeseries", "1.0", ts);
    const scheduler = options.scheduler || createScheduler(options.schedulerOpts || {});
    host.provide("scheduler", "1.0", scheduler);
  });

  // bacnet-historian: composes bacnet.read + scheduler + timeseries into a
  // continuous point logger — the worked example from the design doc.
  factories.set("bacnet-historian", async (host) => {
    const bacnet = host.use("bacnet.read.v1");
    const scheduler = host.use("scheduler.v1");
    const timeseries = host.tryUse("timeseries.v1");
    const netscan = host.tryUse("netscan.v1");
    host.provide("bacnet.historian", "1.0", createHistorian({ bacnet, scheduler, timeseries, netscan }));
  });

  factories.set("building-workspace", async (host) => {
    host.use("bacnet.read.v1");
    host.use("bacnet.historian.v1");
    host.use("scheduler.v1");
    host.use("timeseries.v1");
    host.provide("inventory", "1.0", createInventory({
      storage: options.inventoryStorage || createBrowserInventoryStorage(),
    }));
  });

  // networkmanager provides the network primitives other tools reuse.
  factories.set("networkmanager", async (host) => {
    const ts = host.tryUse("timeseries.v1"); // optional telemetry sink

    host.provide("network.adapters", "1.0", {
      /** List all adapters with live metadata. */
      list: () => invoke("networkmanager_list_adapters"),
      /** Read one adapter's IPv4/DNS state. */
      readState: (name) => invoke("networkmanager_read_state", { name }),
    });

    host.provide("netscan", "1.0", {
      /** Sweep a subnet. Accepts "ip/prefix" CIDR. Returns the backend ScanResult. */
      scan: async (cidr) => {
        const { ip, prefix } = parseCidr(cidr);
        const result = await invoke("netscan_scan", { ip, prefix });
        // Telemetry: record sweep results so host presence can be trended over
        // time once the Observability Pack is installed (degrades to a no-op).
        if (ts) {
          ts.write({
            measurement: "netscan_sweep",
            tags: { subnet: `${ip}/${prefix}` },
            fields: { hosts: result?.hosts?.length ?? 0, total: result?.total ?? 0 },
          });
        }
        return result;
      },
      /** Single-host reachability via one ICMP echo. Returns { reachable, rttMs }. */
      isReachable: async (ip) => {
        const rtt = await invoke("netscan_ping", { ip });
        return { reachable: rtt != null, rttMs: rtt ?? null };
      },
      /** Resolve the subnet to sweep for a given adapter, from its live state. */
      localSubnetFor: async (adapterName) => {
        const state = await invoke("networkmanager_read_state", { name: adapterName });
        return subnetFromState(state);
      },
    });
  });

  // heicmov exposes its sidecar-backed conversion as a reusable capability.
  factories.set("heicmov", async (host) => {
    host.provide("media.convert", "1.0", {
      probe: (path) => invoke("heicmov_probe", { path }),
      convert: (paths, opts = {}) =>
        invoke("heicmov_convert", {
          paths,
          outputDir: opts.outputDir ?? null,
          imageFormat: opts.imageFormat ?? null,
          overwrite: opts.overwrite ?? null,
        }),
    });
  });

  // bacnet-core is the headless BACnet service: it provides the reusable
  // bacnet.read capability and *consumes* netscan (optional) to suggest
  // discovery targets. The BACnet Inspector and Historian both resolve
  // bacnet.read from here rather than embedding their own BACnet code.
  factories.set("bacnet-core", async (host) => {
    const netscan = host.tryUse("netscan.v1"); // null if networkmanager absent/disabled
    host.provide("bacnet.read", "1.0", {
      /** Broadcast/unicast Who-Is discovery. */
      listDevices: (opts = {}) =>
        invoke("bacnet_discover", {
          target: opts.target ?? null,
          lowLimit: opts.lowLimit ?? null,
          highLimit: opts.highLimit ?? null,
          durationMs: opts.durationMs ?? null,
        }),
      /** Cancel an in-flight discovery (returns devices found so far). */
      cancelDiscovery: () => invoke("bacnet_cancel_discovery"),
      /** BACnet/IP stack health: listener bind, local address, foreign device. */
      diagnostics: () => invoke("bacnet_diagnostics"),
      /** Read all properties of one object on a device. `device` is a device ref. */
      readPoint: (device, objectType, instance) =>
        invoke("bacnet_read_properties", { device, objectType, instance }),
      /** Read a device's object-list and object names. */
      listObjects: (device, deviceInstance) =>
        invoke("bacnet_read_objects", { device, deviceInstance }),
      /** Write a BACnet property, including Null relinquish values. */
      writeProperty: ({ device, objectType, instance, property, value, priority = null, arrayIndex = null }) =>
        invoke("bacnet_write_property", { device, objectType, instance, property, value, priority, arrayIndex }),
      /** Read trend-log or trend-log-multiple records. */
      readTrend: ({ device, objectType, instance, maxRecords }) =>
        invoke("bacnet_read_trend", { device, objectType, instance, maxRecords }),
      /** Subscribe to COV notifications. */
      subscribeCov: ({ device, deviceInstance, objectType, instance, confirmed = false }) =>
        invoke("bacnet_subscribe_cov", { device, deviceInstance, objectType, instance, confirmed }),
      /** Cancel a COV subscription created by subscribeCov. */
      unsubscribeCov: ({ device, objectType, instance, processId }) =>
        invoke("bacnet_unsubscribe_cov", { device, objectType, instance, processId }),
      /** Register as a foreign device with a BBMD so broadcast discovery reaches
       *  other IP subnets. Resolves to { bbmd, ttlSeconds }. */
      registerForeignDevice: ({ bbmd, ttlSeconds = null }) =>
        invoke("bacnet_register_foreign_device", { bbmd, ttlSeconds }),
      /** Stop the foreign-device registration (the BBMD drops us at TTL expiry). */
      unregisterForeignDevice: () => invoke("bacnet_unregister_foreign_device"),
      /** The active foreign-device registration, or null. */
      foreignDeviceStatus: () => invoke("bacnet_foreign_device_status"),
      /** List a device's active / unacknowledged alarms (GetEventInformation,
       *  falling back to GetAlarmSummary). */
      getAlarms: (device) => invoke("bacnet_get_alarms", { device }),
      /** Acknowledge an alarm on an event-initiating object (a write). */
      acknowledgeAlarm: ({ device, objectType, instance }) =>
        invoke("bacnet_acknowledge_alarm", { device, objectType, instance }),
      /** Whether discovery-target suggestions are available (netscan present). */
      canSuggestTargets: () => netscan != null,
      /** Suggest live hosts on a subnet as discovery targets (requires netscan). */
      suggestTargets: netscan ? (cidr) => netscan.scan(cidr) : null,
    });
  });

  // clipboardtyper declares no provided capabilities — nothing to register.
  return factories;
}
