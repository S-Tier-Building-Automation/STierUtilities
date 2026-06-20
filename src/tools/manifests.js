// Tool manifests — the single source of truth for what tools exist, what
// capabilities they provide/consume, and what they're allowed to do. The kernel
// (src/platform/host.js) boots from this list; main.js attaches each tool's UI
// renderers by id. Keep this file free of Tauri/DOM imports so it stays
// unit-testable under `node --test`.
//
// Capability versions here are *contract* versions, independent of the app
// version. Bump a provided capability's major only on a breaking interface
// change so consumers' semver ranges keep working.

const REPO = "https://github.com/S-Tier-Building-Automation/STierUtilities";

export const TOOL_MANIFESTS = [
  {
    // The platform's observability service. Provides the shared timeseries
    // capability (degraded ring-buffer mode until the Observability Pack —
    // InfluxDB/Grafana/Telegraf — is installed and started). Later phases add
    // the scheduler capability and the pack supervisor here.
    id: "observability",
    name: "Observability",
    version: "1.0.0",
    apiVersion: "1",
    kind: "native",
    category: "service",
    provides: [
      { capability: "timeseries", version: "1.0" },
      { capability: "scheduler", version: "1.0" },
    ],
    requires: [],
    permissions: ["timeseries.write", "timeseries.read", "scheduler.register", "fs.appdata", "process.spawn"],
    ui: {
      emoji: "📈",
      tagline: "Local metrics now; InfluxDB + Grafana dashboards when you install the pack.",
      description:
        "The shared time-series service every tool can write to. Until you install " +
        "the optional Observability Pack (Telegraf + InfluxDB + Grafana), metrics are " +
        "kept in a local in-memory ring buffer so tools work unchanged; once the pack " +
        "is running, the same metrics stream into InfluxDB and chart in Grafana.",
      repo: REPO,
    },
  },
  {
    id: "clipboardtyper",
    name: "ClipboardTyper",
    version: "1.0.0",
    apiVersion: "1",
    kind: "native",
    category: "app",
    provides: [],
    requires: [{ capability: "timeseries", version: "^1.0", optional: true }],
    permissions: ["input.inject", "fs.appdata"],
    ui: {
      emoji: "⌨️",
      tagline: "Middle-click your mouse to auto-type your clipboard.",
      description:
        "Useful for local password fields, some remote-desktop login screens, " +
        "VMs, and anywhere Ctrl+V is blocked. ClipboardTyper installs a low-level " +
        "mouse hook while enabled; middle-clicks are intercepted and your clipboard " +
        "contents are sent with Windows SendInput scan codes. Some remote tools, including " +
        "DeskIn in certain modes, may ignore or refuse to forward injected input.",
      repo: "https://github.com/stier1ba/ClipboardTyper",
    },
  },
  {
    id: "heicmov",
    name: "HEIC & MOV",
    version: "1.0.0",
    apiVersion: "1",
    kind: "native",
    category: "app",
    provides: [{ capability: "media.convert", version: "1.0" }],
    requires: [{ capability: "timeseries", version: "^1.0", optional: true }],
    permissions: ["process.spawn", "fs.userpick", "fs.appdata"],
    ui: {
      emoji: "🖼️",
      tagline: "Preview and convert iPhone photos and videos on Windows.",
      description:
        "Open HEIC, HEIF, and MOV files from your phone or cloud sync folder. " +
        "Preview them in the app, then convert images to JPEG (or PNG) and videos " +
        "to MP4. FFmpeg is bundled — no separate install required.",
      repo: REPO,
    },
  },
  {
    id: "networkmanager",
    name: "Network Manager",
    version: "1.0.0",
    apiVersion: "1",
    kind: "native",
    category: "app",
    provides: [
      { capability: "network.adapters", version: "1.0" },
      { capability: "netscan", version: "1.0" },
    ],
    requires: [
      { capability: "timeseries", version: "^1.0", optional: true },
      { capability: "scheduler", version: "^1.0", optional: true },
    ],
    permissions: ["fs.appdata", "elevation.request", "network.raw"],
    dashboards: ["dashboards/netscan-hosts.json"],
    ui: {
      emoji: "🌐",
      tagline: "Save network profiles and see which one Windows is using.",
      description:
        "Save reusable IPv4 + DNS profiles for your network adapters and see at a " +
        'glance whether Windows currently matches one ("drift"). Capture the live ' +
        "settings of any adapter into a new profile, then apply a profile to switch " +
        "an adapter's IPv4/DNS settings. Applying prompts for administrator approval.",
      repo: REPO,
    },
  },
  {
    // The headless BACnet/IP service — the reference "extract the engine out of
    // the app" case. It owns the BACnet/IP stack and provides the reusable
    // bacnet.read capability (Who-Is discovery + point reads). The BACnet
    // Inspector App and the BACnet Historian both *consume* this contract instead
    // of embedding their own BACnet code. category:"service" marks it headless —
    // it boots in the kernel but has no page in the tool catalog.
    id: "bacnet-core",
    name: "BACnet Service",
    version: "1.0.0",
    apiVersion: "1",
    kind: "native",
    category: "service",
    provides: [{ capability: "bacnet.read", version: "1.0" }],
    requires: [{ capability: "netscan", version: "^1.0", optional: true }],
    permissions: ["network.udp"],
    ui: {
      emoji: "📡",
      tagline: "Headless BACnet/IP read service — discovery and point reads other tools reuse.",
      description:
        "The reusable BACnet/IP read capability: broadcast Who-Is discovery and " +
        "read a point's properties. It owns the BACnet/IP stack on an ephemeral " +
        "UDP port (so it coexists with Niagara or any other BACnet stack) and " +
        "exposes a stable bacnet.read contract any platform app can depend on. " +
        "BACnet Manager and the BACnet Historian consume it rather " +
        "than reimplementing BACnet. Runs headless — it has no page of its own.",
      repo: REPO,
    },
  },
  {
    // BACnet Manager — discovery, inbox/import, browse, COV, alarms, and BBMD.
    // Replaces the hidden Advanced BACnet Inspector; Building Workspace stays model-only.
    id: "bacnet-manager",
    name: "BACnet Manager",
    version: "1.0.0",
    apiVersion: "1",
    kind: "native",
    category: "app",
    provides: [],
    requires: [
      { capability: "bacnet.read", version: "^1.0" },
      { capability: "inventory", version: "^1.0" },
      { capability: "netscan", version: "^1.0", optional: true },
    ],
    permissions: ["inventory.read", "inventory.write"],
    ui: {
      emoji: "🏢",
      tagline: "Discover BACnet devices, import into the building model, browse objects, COV, and alarms.",
      description:
        "The SI workflow for BACnet protocol work: subnet discovery and drift tracking, " +
        "device discovery with direct import into the building model, object browse with reads/writes/COV/trends, and alarm " +
        "acknowledgement. Imports land in the shared inventory for Building Workspace to " +
        "model, historize, and commission. Uses the headless bacnet-core service on an " +
        "ephemeral UDP port so it coexists with Niagara or any other BACnet stack.",
      repo: REPO,
    },
  },
  {
    // The flagship inter-tool feature: continuously logs BACnet points to the
    // timeseries service on a scheduler cadence. Reuses bacnet.read (point reads),
    // netscan (reachability), scheduler, and timeseries — writing none of them.
    id: "bacnet-historian",
    name: "BACnet Historian",
    version: "1.0.0",
    apiVersion: "1",
    kind: "native",
    category: "service",
    provides: [{ capability: "bacnet.historian", version: "1.0" }],
    requires: [
      { capability: "bacnet.read", version: "^1.0" },
      { capability: "scheduler", version: "^1.0" },
      { capability: "timeseries", version: "^1.0" },
      { capability: "netscan", version: "^1.0", optional: true },
    ],
    permissions: ["timeseries.write", "scheduler.register"],
    dashboards: ["dashboards/bacnet-points.json"],
    ui: {
      emoji: "📊",
      tagline: "Continuously log BACnet points to InfluxDB and chart them in Grafana.",
      description:
        "Pick BACnet points to historize; the Historian polls them on a schedule " +
        "and streams present-value into the time-series service. With the " +
        "Observability Pack running, the same data charts live in Grafana. It " +
        "reuses the BACnet service, scheduler, and telemetry " +
        "service — no duplicated BACnet, scheduling, or storage code.",
      repo: REPO,
    },
  },
  {
    id: "building-workspace",
    name: "Building Workspace",
    version: "1.0.0",
    apiVersion: "1",
    kind: "native",
    category: "app",
    provides: [],
    requires: [
      { capability: "inventory", version: "^1.0" },
      { capability: "graphics", version: "^1.0" },
      { capability: "rules", version: "^1.0", optional: true },
      { capability: "bacnet.read", version: "^1.0" },
      { capability: "bacnet.historian", version: "^1.0" },
      { capability: "timeseries", version: "^1.0" },
      { capability: "scheduler", version: "^1.0" },
      { capability: "netscan", version: "^1.0", optional: true },
    ],
    permissions: ["inventory.read", "inventory.write", "timeseries.write", "timeseries.read", "scheduler.register"],
    dashboards: ["dashboards/building-workspace.json"],
    ui: {
      emoji: "🏗️",
      tagline: "Model, trend, commission, and report BACnet points from one SI workspace.",
      description:
        "A BACnet-first building automation workflow: import discovered devices and " +
        "objects into a lightweight tagged model, apply equipment templates, historize " +
        "points, generate dashboard definitions, run commissioning checks, and export " +
        "Markdown/CSV reports. The model-tree aggregator that ties together the building-model, " +
        "Graphics, Analytics, Alarm Console, and Historian apps on the shared platform capabilities.",
      repo: REPO,
    },
  },
  {
    // building-model: the headless building model. Owns the lightweight tagged
    // inventory (sites/equip/points/templates/runs) and provides the inventory
    // capability that BACnet Manager, Building Workspace, and every BMS app
    // consume. Runs headless — it has no page of its own.
    id: "building-model",
    name: "Building Model",
    version: "1.0.0",
    apiVersion: "1",
    kind: "native",
    category: "service",
    provides: [{ capability: "inventory", version: "1.0" }],
    requires: [],
    permissions: ["inventory.read", "inventory.write", "fs.appdata"],
    ui: {
      emoji: "🧱",
      tagline: "Headless building model — the shared tagged inventory other tools read and write.",
      description:
        "The lightweight Haystack-aware building model: sites, equipment, points, source " +
        "references, equipment templates, commissioning runs, and rule runs. It owns the " +
        "inventory contract every building tool consumes — BACnet Manager imports into it, " +
        "Building Workspace models it, and the Graphics, Analytics, and Alarm Console apps " +
        "read it. Runs headless — it has no page of its own.",
      repo: REPO,
    },
  },
  {
    // building-rules: the analytics engine. Evaluates modeled equipment against
    // rule packs and provides the rules capability the Analytics app and Alarm
    // Console consume. Runs headless.
    id: "building-rules",
    name: "Analytics Engine",
    version: "1.0.0",
    apiVersion: "1",
    kind: "native",
    category: "service",
    provides: [{ capability: "rules", version: "1.0" }],
    requires: [
      { capability: "inventory", version: "^1.0" },
      { capability: "bacnet.read", version: "^1.0", optional: true },
    ],
    permissions: ["inventory.read"],
    ui: {
      emoji: "🧮",
      tagline: "Headless analytics — evaluate modeled equipment against rule packs.",
      description:
        "The shared analytics engine: it runs rule packs (missing sensors, out-of-range " +
        "values, low airflow, and more) against the modeled equipment and optionally reads " +
        "live BACnet values during a run. The Analytics app and Alarm Console consume it " +
        "rather than embedding rule logic. Runs headless — it has no page of its own.",
      repo: REPO,
    },
  },
  {
    // building-graphics: resolves device graphic definitions and binds modeled
    // points to graphic slots. Provides the graphics capability the Graphics app
    // and Building Workspace consume. Runs headless.
    id: "building-graphics",
    name: "Graphics Engine",
    version: "1.0.0",
    apiVersion: "1",
    kind: "native",
    category: "service",
    provides: [{ capability: "graphics", version: "1.0" }],
    requires: [{ capability: "inventory", version: "^1.0" }],
    permissions: ["inventory.read", "inventory.write"],
    ui: {
      emoji: "🎛️",
      tagline: "Headless graphics — resolve device graphics and bind points to callouts.",
      description:
        "The device-graphics engine: it resolves the right graphic for a piece of equipment " +
        "and binds modeled points to its callouts, status chips, and parameters, including " +
        "auto-tagging by point name. The Graphics app and Building Workspace render through " +
        "it. Runs headless — it has no page of its own.",
      repo: REPO,
    },
  },
  {
    // building-alerts: unifies rule findings and live BACnet alarms into one
    // acknowledgeable feed. Provides the alerts capability the Alarm Console
    // consumes. Runs headless.
    id: "building-alerts",
    name: "Alerts Engine",
    version: "1.0.0",
    apiVersion: "1",
    kind: "native",
    category: "service",
    provides: [{ capability: "alerts", version: "1.0" }],
    requires: [
      { capability: "inventory", version: "^1.0" },
      { capability: "rules", version: "^1.0" },
      { capability: "bacnet.read", version: "^1.0", optional: true },
    ],
    permissions: ["inventory.read", "inventory.write"],
    ui: {
      emoji: "🚨",
      tagline: "Headless alerts — unify rule findings and live BACnet alarms.",
      description:
        "The alerts engine: it merges analytics rule findings with live BACnet alarms into a " +
        "single acknowledgeable feed and runs rule scans on demand. The Alarm Console consumes " +
        "it. Runs headless — it has no page of its own.",
      repo: REPO,
    },
  },
  {
    id: "alarm-console",
    name: "Alarm Console",
    version: "1.0.0",
    apiVersion: "1",
    kind: "native",
    category: "app",
    provides: [],
    requires: [
      { capability: "alerts", version: "^1.0" },
      { capability: "inventory", version: "^1.0" },
      { capability: "bacnet.read", version: "^1.0", optional: true },
    ],
    permissions: ["inventory.read", "inventory.write"],
    ui: {
      emoji: "🚨",
      tagline: "One feed for analytics findings and live BACnet alarms.",
      description:
        "Triage building alerts in one place: out-of-range and missing-sensor findings from " +
        "the Analytics engine alongside live BACnet alarms read from devices, filterable by " +
        "site and equipment. Acknowledge BACnet alarms inline and re-run analytics on demand.",
      repo: REPO,
    },
  },
  {
    id: "building-analytics",
    name: "Analytics",
    version: "1.0.0",
    apiVersion: "1",
    kind: "native",
    category: "app",
    provides: [],
    requires: [
      { capability: "rules", version: "^1.0" },
      { capability: "inventory", version: "^1.0" },
    ],
    permissions: ["inventory.read", "inventory.write"],
    ui: {
      emoji: "🧮",
      tagline: "Run rule packs against the building model and export findings.",
      description:
        "Evaluate the modeled equipment against rule packs — missing space temperature, " +
        "discharge-air-temperature range, low airflow, and more — with configurable thresholds. " +
        "Review run history and export findings to Markdown or CSV. Built on the shared " +
        "Analytics engine and building model.",
      repo: REPO,
    },
  },
  {
    id: "device-graphics",
    name: "Graphics",
    version: "1.0.0",
    apiVersion: "1",
    kind: "native",
    category: "app",
    provides: [],
    requires: [
      { capability: "graphics", version: "^1.0" },
      { capability: "inventory", version: "^1.0" },
      { capability: "bacnet.read", version: "^1.0", optional: true },
    ],
    permissions: ["inventory.read", "inventory.write"],
    ui: {
      emoji: "🎛️",
      tagline: "Live device graphics for modeled equipment, like a VAV box screen.",
      description:
        "Open a device-level graphic for any modeled piece of equipment: a schematic with live " +
        "callouts, status chips, and monitoring parameters bound to modeled points. Poll live " +
        "BACnet values, and bind or rebind points to graphic roles. Built on the shared Graphics " +
        "engine and building model.",
      repo: REPO,
    },
  },
];

/** Look up a manifest by tool id. */
export function manifestById(id) {
  return TOOL_MANIFESTS.find((m) => m.id === id) || null;
}
