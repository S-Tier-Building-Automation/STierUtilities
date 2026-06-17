// The service/capability catalog — the developer-facing API reference that
// powers the in-app Services page. It JOINS two sources:
//
//   1. The LIVE capability graph (buildRegistry): which capabilities exist, what
//      version, which tool provides each, and which tools consume them. Always
//      accurate — derived from the same manifests the kernel boots from.
//   2. CAPABILITY_DOCS below: the human-readable contract for each capability —
//      a summary plus the method signatures a consumer calls via host.use().
//
// New capabilities show up automatically; the "every provided capability is
// documented" test (service-catalog.test.js) fails until a CAPABILITY_DOCS entry
// is added, so the reference can't silently drift from the code.
//
// Pure (no DOM/Tauri imports) so it is unit-testable under `node --test`.

import { buildRegistry } from "./registry.js";
import { parseVersion } from "./semver.js";

/**
 * Contract docs keyed by capability name. Each method documents the interface a
 * consumer reaches through `host.use("<capability>.v<major>")`.
 * @type {Record<string, { summary: string, methods: Array<{name:string, sig:string, returns:string, desc:string}>, notes?: string }>}
 */
export const CAPABILITY_DOCS = {
  timeseries: {
    summary:
      "Shared telemetry sink. Write structured metric points here instead of " +
      "talking to InfluxDB directly; they always land in a local ring buffer and " +
      "stream to InfluxDB/Grafana when the Observability Pack is running.",
    methods: [
      { name: "write", sig: "write({ measurement, tags?, fields, ts? })", returns: "Point",
        desc: "Record one point. `fields` needs ≥1 number/boolean/string value; `ts` defaults to now. Throws on a malformed point." },
      { name: "recent", sig: "recent(n = 50)", returns: "Point[]",
        desc: "The most recent points from the ring buffer — works even with no backend installed." },
      { name: "query", sig: "query(q)", returns: "Promise<any>",
        desc: "Query the backend. Throws in degraded mode (no Observability Pack installed)." },
      { name: "panelUrl", sig: "panelUrl(spec)", returns: "string | null",
        desc: "An embeddable Grafana panel URL, or null when no dashboard backend exists." },
      { name: "stats", sig: "stats()", returns: "{ buffered, ring, written, dropped, degraded, backend }",
        desc: "Buffer/ring counters and whether a live backend is attached." },
    ],
    notes: "Degrades gracefully: with no backend it keeps only the ring buffer, so consumers work unchanged.",
  },

  scheduler: {
    summary:
      "Shared recurring-job runner. Register work by id + interval; the scheduler " +
      "runs it, skips overlapping ticks, and tracks run counts and the last error.",
    methods: [
      { name: "register", sig: "register(id, { intervalMs, run, immediate? })", returns: "string",
        desc: "Register (or replace) a recurring job. `run` is your async work; `immediate:true` runs one tick right away." },
      { name: "unregister", sig: "unregister(id)", returns: "boolean",
        desc: "Stop and remove a job. Returns false if no such job." },
      { name: "has", sig: "has(id)", returns: "boolean", desc: "Whether a job id is currently registered." },
      { name: "runNow", sig: "runNow(id)", returns: "Promise<void>", desc: "Run a registered job's tick once, now (awaitable)." },
      { name: "list", sig: "list()", returns: "Array<{ id, intervalMs, runs, lastError, running }>",
        desc: "Snapshot of all registered jobs." },
    ],
  },

  netscan: {
    summary: "Subnet sweeps and single-host reachability over the local network.",
    methods: [
      { name: "scan", sig: "scan(cidr)", returns: "Promise<ScanResult>",
        desc: 'Sweep a subnet given as "ip/prefix" (e.g. "192.168.1.0/24"). Returns live hosts + totals.' },
      { name: "isReachable", sig: "isReachable(ip)", returns: "Promise<{ reachable, rttMs }>",
        desc: "One ICMP echo to a single host." },
      { name: "localSubnetFor", sig: "localSubnetFor(adapterName)", returns: "Promise<{ ip, prefix, network, hostCount } | null>",
        desc: "Derive the sweepable subnet for an adapter from its live IPv4 state." },
    ],
  },

  "network.adapters": {
    summary: "Enumerate and read the live IPv4/DNS state of Windows network adapters.",
    methods: [
      { name: "list", sig: "list()", returns: "Promise<Adapter[]>", desc: "All adapters with live metadata." },
      { name: "readState", sig: "readState(name)", returns: "Promise<AdapterState>",
        desc: "One adapter's current IPv4 address, mask, gateway and DNS." },
    ],
  },

  "media.convert": {
    summary: "Probe and convert phone media — HEIC/HEIF images and MOV video — via the bundled FFmpeg sidecar.",
    methods: [
      { name: "probe", sig: "probe(path)", returns: "Promise<{ kind, ... }>", desc: "Inspect a file (image vs video, metadata)." },
      { name: "convert", sig: "convert(paths, opts?)", returns: "Promise<ConvertResult>",
        desc: "Convert images→JPEG/PNG and videos→MP4. opts: { outputDir?, imageFormat?, overwrite? }." },
    ],
  },

  "bacnet.read": {
    summary:
      "The reusable BACnet/IP contract: discovery, object/property reads, writes, " +
      "trend reads, and COV lifecycle. Owned by the headless bacnet-core service " +
      "so tools can use BACnet without embedding a stack.",
    methods: [
      { name: "listDevices", sig: "listDevices(opts?)", returns: "Promise<BacnetDevice[]>",
        desc: "Broadcast/unicast Who-Is discovery. opts: { target?, lowLimit?, highLimit?, durationMs? }." },
      { name: "readPoint", sig: "readPoint(device, objectType, instance)", returns: "Promise<Property[]>",
        desc: "Read every property of one object on a device." },
      { name: "listObjects", sig: "listObjects(device, deviceInstance)", returns: "Promise<BacnetObject[]>",
        desc: "Read a device object-list and resolve object names." },
      { name: "writeProperty", sig: "writeProperty({ device, objectType, instance, property, value, priority?, arrayIndex? })", returns: "Promise<any>",
        desc: "Write a BACnet property, including Null values for relinquish." },
      { name: "readTrend", sig: "readTrend({ device, objectType, instance, maxRecords })", returns: "Promise<TrendReadResult>",
        desc: "Read records from trend-log or trend-log-multiple objects." },
      { name: "subscribeCov", sig: "subscribeCov({ device, deviceInstance, objectType, instance, confirmed? })", returns: "Promise<number>",
        desc: "Subscribe to COV notifications and return the process id." },
      { name: "unsubscribeCov", sig: "unsubscribeCov({ device, objectType, instance, processId })", returns: "Promise<any>",
        desc: "Cancel a COV subscription." },
      { name: "registerForeignDevice", sig: "registerForeignDevice({ bbmd, ttlSeconds? })", returns: "Promise<ForeignDeviceStatus>",
        desc: "Register with a BBMD so broadcast discovery reaches other IP subnets (foreign-device mode)." },
      { name: "unregisterForeignDevice", sig: "unregisterForeignDevice()", returns: "Promise<any>",
        desc: "Stop the foreign-device registration; the BBMD drops us at TTL expiry." },
      { name: "foreignDeviceStatus", sig: "foreignDeviceStatus()", returns: "Promise<ForeignDeviceStatus | null>",
        desc: "The active BBMD registration ({ bbmd, ttlSeconds }), or null." },
      { name: "getAlarms", sig: "getAlarms(device)", returns: "Promise<AlarmEntry[]>",
        desc: "List a device's active/unacknowledged alarms (GetEventInformation, GetAlarmSummary fallback)." },
      { name: "acknowledgeAlarm", sig: "acknowledgeAlarm({ device, objectType, instance })", returns: "Promise<any>",
        desc: "Acknowledge an alarm on an event-initiating object (a write; the UI confirms and audits it)." },
      { name: "canSuggestTargets", sig: "canSuggestTargets()", returns: "boolean",
        desc: "Whether netscan-backed discovery-target suggestions are available." },
      { name: "suggestTargets", sig: "suggestTargets(cidr)", returns: "Promise<ScanResult> | null",
        desc: "Suggest live hosts on a subnet as discovery targets (delegates to netscan)." },
    ],
  },

  "bacnet.historian": {
    summary:
      "Continuously logs selected BACnet points into the timeseries service on a " +
      "scheduler cadence — a composed capability built from bacnet.read + " +
      "scheduler + timeseries.",
    methods: [
      { name: "addPoint", sig: "addPoint({ device, objectType, instance, label? })", returns: "PointRecord",
        desc: "Add a point to historize (deduped by device:type:instance)." },
      { name: "removePoint", sig: "removePoint(point)", returns: "boolean", desc: "Stop historizing a point." },
      { name: "points", sig: "points()", returns: "PointRecord[]", desc: "Current points with last value/error/read count." },
      { name: "pollOnce", sig: "pollOnce()", returns: "Promise<{ written, errors, points }>", desc: "Read every point once and write values to timeseries." },
      { name: "start", sig: "start(intervalMs = 60000)", returns: "void", desc: "Begin logging on a schedule (polls immediately)." },
      { name: "stop", sig: "stop()", returns: "void", desc: "Stop the scheduled logging." },
      { name: "isRunning", sig: "isRunning()", returns: "boolean", desc: "Whether scheduled logging is active." },
    ],
  },

  inventory: {
    summary:
      "Tagged building model for sites, equipment, points, source references, templates, " +
      "and commissioning runs. This is the lightweight Haystack-aware layer used by " +
      "Building Workspace workflows.",
    methods: [
      { name: "upsertEntity", sig: "upsertEntity(entity)", returns: "Entity",
        desc: "Create or update a site, equip, point, template, tag, sourceRef, or commissioningRun entity." },
      { name: "removeEntity", sig: "removeEntity(id)", returns: "boolean",
        desc: "Remove one entity by id." },
      { name: "listEntities", sig: "listEntities(filter?)", returns: "Entity[]",
        desc: "List entities, optionally filtered by type, text, tag, equipment, or source." },
      { name: "getEntity", sig: "getEntity(id)", returns: "Entity | null",
        desc: "Read one entity by id." },
      { name: "linkSource", sig: "linkSource(entityId, sourceRef)", returns: "Entity",
        desc: 'Attach a source reference such as "bacnet:123:0:4" to an entity.' },
      { name: "setTags", sig: "setTags(entityId, tags)", returns: "Entity",
        desc: "Replace an entity's marker/value tags." },
      { name: "applyTemplate", sig: "applyTemplate(entityId, templateId)", returns: "Entity",
        desc: "Merge a template's tags onto a site/equipment/point entity." },
      { name: "recordCommissioningRun", sig: "recordCommissioningRun(run)", returns: "Entity",
        desc: "Persist the result of a commissioning workflow run." },
      { name: "exportSnapshot", sig: "exportSnapshot()", returns: "{ version, exportedAt, entities }",
        desc: "Export the full local model for dashboards, reports, or backups." },
    ],
  },
};

/** "bacnet.read" -> "bacnetRead" (a sample variable name for usage snippets). */
function camelOf(capability) {
  return capability
    .split(".")
    .map((seg, i) => (i === 0 ? seg : seg.charAt(0).toUpperCase() + seg.slice(1)))
    .join("");
}

/** A copy-pasteable consume-this-capability snippet. */
function usageSnippet(entry) {
  const v = camelOf(entry.capability);
  const first = entry.doc && entry.doc.methods[0];
  const call = first ? `const result = await ${v}.${first.name}(…);` : `// call ${v}'s methods`;
  return [
    "// 1. Declare it in your tool manifest:",
    `requires: [{ capability: "${entry.capability}", version: "^${entry.version}" }]`,
    "",
    "// 2. Resolve it from your scoped host and call it:",
    `const ${v} = host.use("${entry.ref}");`,
    call,
  ].join("\n");
}

/**
 * Build the developer catalog: one entry per (capability, provider), joined with
 * its contract docs and the tools that currently consume it.
 * @param {object[]} manifests  the full manifest set (first-party + installed)
 */
export function buildServiceCatalog(manifests) {
  const reg = buildRegistry(manifests);
  const entries = [];

  for (const [capability, provs] of reg.providers) {
    for (const { toolId, version } of provs) {
      const provider = reg.tools.get(toolId);

      // Consumers = tools whose dependency resolved to THIS provider for this cap.
      const consumers = [];
      for (const [consumerId, res] of reg.resolutions) {
        const r = res.find((x) => x.capability === capability && x.providerId === toolId);
        if (!r) continue;
        const cm = reg.tools.get(consumerId);
        consumers.push({ id: consumerId, name: (cm && cm.name) || consumerId, optional: r.optional });
      }
      consumers.sort((a, b) => a.name.localeCompare(b.name));

      const doc = CAPABILITY_DOCS[capability] || null;
      const entry = {
        capability,
        version,
        ref: `${capability}.v${parseVersion(version).major}`,
        provider: {
          id: toolId,
          name: (provider && provider.name) || toolId,
          category: (provider && provider.category) || null,
          emoji: (provider && provider.ui && provider.ui.emoji) || "🧩",
          permissions: (provider && provider.permissions) || [],
        },
        consumers,
        doc,
        documented: Boolean(doc),
      };
      entry.usage = usageSnippet(entry);
      entries.push(entry);
    }
  }

  // Stable order: by provider name, then capability.
  entries.sort((a, b) =>
    a.provider.name.localeCompare(b.provider.name) || a.capability.localeCompare(b.capability),
  );

  return { entries, ok: reg.ok };
}
