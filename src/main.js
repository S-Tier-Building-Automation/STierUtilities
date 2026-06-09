const { invoke, convertFileSrc } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const opener = window.__TAURI__.opener;
const updater = window.__TAURI__.updater;
const tauriProcess = window.__TAURI__.process;

const APP_VERSION = "0.5.4";

// ============================================================================
// Tool catalog
// ============================================================================

const TOOLS = [
  {
    id: "clipboardtyper",
    name: "ClipboardTyper",
    emoji: "⌨️",
    tagline: "Middle-click your mouse to auto-type your clipboard.",
    description:
      "Useful for local password fields, some remote-desktop login screens, " +
      "VMs, and anywhere Ctrl+V is blocked. ClipboardTyper installs a low-level " +
      "mouse hook while enabled; middle-clicks are intercepted and your clipboard " +
      "contents are sent with Windows SendInput scan codes. Some remote tools, including " +
      "DeskIn in certain modes, may ignore or refuse to forward injected input.",
    repo: "https://github.com/stier1ba/ClipboardTyper",
    renderStatusPill: ctStatusPill,
    renderPage: renderClipboardTyperPage,
  },
  {
    id: "heicmov",
    name: "HEIC & MOV",
    emoji: "🖼️",
    tagline: "Preview and convert iPhone photos and videos on Windows.",
    description:
      "Open HEIC, HEIF, and MOV files from your phone or cloud sync folder. " +
      "Preview them in the app, then convert images to JPEG (or PNG) and videos " +
      "to MP4. FFmpeg is bundled — no separate install required.",
    repo: "https://github.com/S-Tier-Building-Automation/STierUtilities",
    renderStatusPill: hmStatusPill,
    renderPage: renderHeicMovPage,
  },
  {
    id: "networkmanager",
    name: "Network Manager",
    emoji: "🌐",
    tagline: "Save network profiles and see which one Windows is using.",
    description:
      "Save reusable IPv4 + DNS profiles for your network adapters and see at a " +
      "glance whether Windows currently matches one (\"drift\"). Capture the live " +
      "settings of any adapter into a new profile, then apply a profile to switch " +
      "an adapter's IPv4/DNS settings. Applying prompts for administrator approval.",
    repo: "https://github.com/S-Tier-Building-Automation/STierUtilities",
    renderStatusPill: nmStatusPill,
    renderPage: renderNetworkManagerPage,
  },
];

function toolById(id) { return TOOLS.find((t) => t.id === id); }

// ============================================================================
// Persistent UI state
// ============================================================================

const STORAGE_KEY = "microtools.user_state.v2";

const userState = loadUserState();

function loadUserState() {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch (_) {
    stored = {};
  }
  return {
    favorites: stored.favorites || {},
    hidden: stored.hidden || {},
    showHidden: Boolean(stored.showHidden),
    view: typeof stored.view === "string" ? stored.view : "library",
  };
}

function saveUserState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(userState));
}

function isFavorite(id) { return Boolean(userState.favorites[id]); }
function isHidden(id) { return Boolean(userState.hidden[id]); }

function setFavorite(id, on) {
  if (on) userState.favorites[id] = true;
  else delete userState.favorites[id];
  saveUserState();
  renderAll();
}

function setHidden(id, on) {
  if (on) {
    userState.hidden[id] = true;
    // If currently on the plugin page, bounce to library so we don't show
    // a "page for a hidden tool" state.
    if (currentPluginId() === id) userState.view = "library";
  } else {
    delete userState.hidden[id];
  }
  saveUserState();
  renderAll();
}

function setShowHidden(on) {
  userState.showHidden = on;
  saveUserState();
  renderLibrary();
}

function setView(view) {
  userState.view = view;
  saveUserState();
  renderAll();
}

function currentView() {
  if (userState.view === "library" || userState.view === "settings") {
    return userState.view;
  }
  if (typeof userState.view === "string" && userState.view.startsWith("plugin:")) {
    return userState.view;
  }
  return "library";
}

function currentPluginId() {
  const v = currentView();
  return v.startsWith("plugin:") ? v.slice("plugin:".length) : null;
}

function pluginView(id) { return `plugin:${id}`; }

// ============================================================================
// Live tool state (ClipboardTyper)
// ============================================================================

let ct = {
  running: false,
  armed: false,
  settings: { type_delay_ms: 60, modifier_hold_ms: 40, start_delay_ms: 40 },
};
let ctPending = { ...ct.settings };

// ============================================================================
// Per-plugin activity log
// ============================================================================

const pluginLogs = new Map(); // toolId -> array (newest first), max 100

function logTo(toolId, msg, kind = "info") {
  let arr = pluginLogs.get(toolId);
  if (!arr) {
    arr = [];
    pluginLogs.set(toolId, arr);
  }
  arr.unshift({ time: new Date(), msg, kind });
  while (arr.length > 100) arr.pop();
  // Hot-reload the log section if we're currently on that plugin page.
  if (currentPluginId() === toolId) {
    const node = document.getElementById("plugin-log-list");
    if (node) node.replaceChildren(...arr.map(renderLogEntry));
  }
}

function renderLogEntry(entry) {
  return el("li", { class: `log-${entry.kind}` },
    el("span", { class: "log-time" }, entry.time.toLocaleTimeString()),
    el("span", { class: "log-msg" }, entry.msg),
  );
}

// ============================================================================
// DOM helpers
// ============================================================================

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

async function openExternal(url) {
  try {
    await opener.openUrl(url);
  } catch (err) {
    console.warn("openExternal failed:", err);
  }
}

// ============================================================================
// ClipboardTyper-specific bits (status pill + page)
// ============================================================================

function ctStatusPill() {
  if (!ct.running) return { label: "Idle", cls: "pill-idle" };
  if (ct.armed) return { label: "Armed", cls: "pill-running" };
  return { label: "Standby", cls: "pill-muted" };
}

function ctSlider(key, label, min, max, step, suffix) {
  const valueEl = el("span", { class: "slider-value" }, `${ctPending[key]} ${suffix}`);
  const input = el("input", {
    type: "range",
    min: String(min),
    max: String(max),
    step: String(step),
    value: String(ctPending[key]),
    oninput: (e) => {
      ctPending[key] = Number(e.target.value);
      valueEl.textContent = `${ctPending[key]} ${suffix}`;
      ctPushSettings();
    },
  });
  return el("div", { class: "slider-row" },
    el("label", {}, label),
    input,
    valueEl,
  );
}

let ctPushTimer = null;
function ctPushSettings() {
  if (ctPushTimer) clearTimeout(ctPushTimer);
  ctPushTimer = setTimeout(async () => {
    try {
      await invoke("clipboardtyper_set_settings", { settings: { ...ctPending } });
    } catch (err) {
      logTo("clipboardtyper", `Failed to update settings: ${err}`, "error");
    }
  }, 100);
}

async function ctToggleEnabled() {
  try {
    if (ct.running) {
      await invoke("clipboardtyper_stop");
      logTo("clipboardtyper", "Disabled. Middle-click is back to normal.", "warn");
    } else {
      await invoke("clipboardtyper_start");
      logTo("clipboardtyper", "Enabled. Middle-click anywhere to type your clipboard.", "ok");
    }
  } catch (err) {
    logTo("clipboardtyper", `${err}`, "error");
  }
}

async function ctSetArmed(armed) {
  try {
    await invoke("clipboardtyper_set_armed", { armed });
    logTo("clipboardtyper", armed ? "Armed." : "Disarmed (hook still installed).", "info");
  } catch (err) {
    logTo("clipboardtyper", `Failed to set armed: ${err}`, "error");
  }
}

function renderClipboardTyperPage(tool) {
  const status = ctStatusPill();

  const enableBtn = el("button", {
    class: ct.running ? "btn btn-danger" : "btn btn-primary",
    onclick: ctToggleEnabled,
  }, ct.running ? "Disable" : "Enable");

  const armToggle = el("label",
    {
      class: `toggle ${ct.armed ? "toggle-on" : ""} ${!ct.running ? "toggle-disabled" : ""}`,
    },
    el("input", {
      type: "checkbox",
      checked: ct.armed ? "checked" : undefined,
      disabled: !ct.running ? "disabled" : undefined,
      onchange: (e) => ctSetArmed(e.target.checked),
    }),
    el("span", { class: "toggle-track" }, el("span", { class: "toggle-knob" })),
    el("span", { class: "toggle-label" }, "Armed"),
  );

  return el("div", { class: "plugin-controls" },
    el("section", { class: "plugin-section" },
      el("div", { class: "action-row" }, enableBtn, armToggle),
      el("p", { class: "muted small" },
        ct.running
          ? (ct.armed
              ? "Middle-click anywhere - clipboard text will be sent to the focused local window."
              : "Hook installed but disarmed. Toggle Armed to react to middle-clicks.")
          : "Click Enable to install the mouse hook.",
      ),
    ),

    el("section", { class: "plugin-section" },
      el("h3", {}, "Timing"),
      ctSlider("type_delay_ms", "Type delay", 0, 200, 5, "ms"),
      ctSlider("modifier_hold_ms", "Modifier hold", 0, 200, 5, "ms"),
      ctSlider("start_delay_ms", "Start delay", 0, 500, 10, "ms"),
      el("p", { class: "muted small" },
        "Modifier hold can help when a remote tool forwards injected input but ",
        "drops shifted characters. If DeskIn receives nothing at all, it is likely ",
        "blocking injected input before timing matters.",
      ),
    ),
  );
}


// ============================================================================
// HEIC & MOV (status pill + page)
// ============================================================================

let hm = {
  files: [],
  selectedPath: null,
  outputDir: null,
  imageFormat: "jpeg",
  overwrite: false,
  busy: false,
  busyLabel: "",
  progress: null,
  previewSrc: null,
  previewMime: null,
};

function hmStatusPill() {
  if (hm.busy) {
    const label = hm.progress
      ? `${hm.busyLabel} ${hm.progress.done}/${hm.progress.total}`
      : hm.busyLabel || "Working";
    return { label, cls: "pill-running" };
  }
  if (hm.files.length === 0) return { label: "No files", cls: "pill-idle" };
  return { label: `${hm.files.length} file${hm.files.length === 1 ? "" : "s"}`, cls: "pill-muted" };
}

function hmSelectedFile() {
  return hm.files.find((f) => f.path === hm.selectedPath) || null;
}

function hmFormatFileMeta(file) {
  const parts = [];
  if (file.width && file.height) parts.push(`${file.width}×${file.height}`);
  if (file.duration_sec != null) {
    const s = Math.round(file.duration_sec);
    const m = Math.floor(s / 60);
    const r = s % 60;
    parts.push(m > 0 ? `${m}:${String(r).padStart(2, "0")}` : `${s}s`);
  }
  parts.push(file.kind === "video" ? "video" : "image");
  return parts.join(" · ");
}

async function hmRefreshPreview() {
  const file = hmSelectedFile();
  hm.previewSrc = null;
  hm.previewMime = null;
  if (!file) {
    renderAll();
    return;
  }
  hm.busy = true;
  hm.busyLabel = "Previewing";
  renderAll();
  try {
    const preview = await invoke("heicmov_make_preview", { path: file.path });
    hm.previewSrc = convertFileSrc(preview.preview_path);
    hm.previewMime = preview.mime;
    logTo("heicmov", `Preview ready: ${file.path.split(/[/\\]/).pop()}`, "ok");
  } catch (err) {
    logTo("heicmov", `Preview failed: ${err}`, "error");
  } finally {
    hm.busy = false;
    hm.busyLabel = "";
    renderAll();
  }
}

async function hmPickFiles() {
  try {
    const paths = await invoke("heicmov_pick_files");
    if (!paths || paths.length === 0) return;
    hm.busy = true;
    hm.busyLabel = "Loading";
    hm.progress = { done: 0, total: paths.length };
    renderAll();

    const files = [];
    for (const path of paths) {
      try {
        const probe = await invoke("heicmov_probe", { path });
        files.push(probe);
        logTo("heicmov", `Added ${path.split(/[/\\]/).pop()}`, "info");
      } catch (err) {
        logTo("heicmov", `Skipped ${path}: ${err}`, "error");
      }
      hm.progress.done += 1;
      renderAll();
    }

    hm.files = files;
    if (files.length > 0) {
      const stillSelected = files.some((f) => f.path === hm.selectedPath);
      hm.selectedPath = stillSelected ? hm.selectedPath : files[0].path;
      await hmRefreshPreview();
    } else {
      hm.selectedPath = null;
    }
  } catch (err) {
    logTo("heicmov", `Could not pick files: ${err}`, "error");
  } finally {
    hm.busy = false;
    hm.busyLabel = "";
    hm.progress = null;
    renderAll();
  }
}

async function hmPickOutputDir() {
  try {
    const dir = await invoke("heicmov_pick_output_dir");
    if (dir) {
      hm.outputDir = dir;
      logTo("heicmov", `Output folder: ${dir}`, "info");
      renderAll();
    }
  } catch (err) {
    logTo("heicmov", `Could not pick folder: ${err}`, "error");
  }
}

async function hmConvert() {
  if (hm.files.length === 0) return;
  hm.busy = true;
  hm.busyLabel = "Converting";
  hm.progress = { done: 0, total: hm.files.length };
  renderAll();
  try {
    const batch = await invoke("heicmov_convert", {
      paths: hm.files.map((f) => f.path),
      outputDir: hm.outputDir,
      imageFormat: hm.imageFormat,
      overwrite: hm.overwrite,
    });
    let okCount = 0;
    for (const r of batch.results) {
      const name = r.input.split(/[/\\]/).pop();
      if (r.ok) {
        okCount += 1;
        logTo("heicmov", `Converted ${name} → ${r.output.split(/[/\\]/).pop()}`, "ok");
      } else {
        logTo("heicmov", `${name}: ${r.error || "failed"}`, "error");
      }
      hm.progress.done += 1;
      renderAll();
    }
    logTo("heicmov", `Done — ${okCount}/${batch.results.length} succeeded.`, okCount ? "ok" : "warn");
  } catch (err) {
    logTo("heicmov", `Convert failed: ${err}`, "error");
  } finally {
    hm.busy = false;
    hm.busyLabel = "";
    hm.progress = null;
    renderAll();
  }
}

async function hmOpenOutputFolder() {
  const dir = hm.outputDir
    || (hm.files[0] ? hm.files[0].path.replace(/[/\\][^/\\]+$/, "") : null);
  if (!dir) return;
  try {
    await invoke("heicmov_open_path", { path: dir });
  } catch (err) {
    logTo("heicmov", `Could not open folder: ${err}`, "error");
  }
}

function hmSelectFile(path) {
  if (hm.selectedPath === path) return;
  hm.selectedPath = path;
  hmRefreshPreview();
}

function hmRemoveFile(path) {
  hm.files = hm.files.filter((f) => f.path !== path);
  if (hm.selectedPath === path) {
    hm.selectedPath = hm.files[0]?.path || null;
    hm.previewSrc = null;
    hm.previewMime = null;
    if (hm.selectedPath) hmRefreshPreview();
    else renderAll();
    return;
  }
  renderAll();
}

function hmClearFiles() {
  hm.files = [];
  hm.selectedPath = null;
  hm.previewSrc = null;
  hm.previewMime = null;
  renderAll();
}

function renderHeicMovPage() {
  const pickBtn = el("button", {
    class: "btn btn-primary",
    disabled: hm.busy ? "disabled" : undefined,
    onclick: hmPickFiles,
  }, "Choose files…");

  const clearBtn = el("button", {
    class: "btn-ghost",
    disabled: hm.busy || hm.files.length === 0 ? "disabled" : undefined,
    onclick: hmClearFiles,
  }, "Clear list");

  const fileList = el("ul", { class: "hm-file-list" });
  if (hm.files.length === 0) {
    fileList.appendChild(el("li", { class: "hm-file-empty muted small" },
      "No files yet. Choose HEIC, HEIF, or MOV files to preview and convert.",
    ));
  } else {
    for (const file of hm.files) {
      const active = file.path === hm.selectedPath;
      fileList.appendChild(el("li", {
        class: `hm-file-row ${active ? "hm-file-active" : ""}`,
        onclick: () => hmSelectFile(file.path),
      },
        el("span", { class: "hm-file-name" }, file.path.split(/[/\\]/).pop()),
        el("span", { class: "hm-file-meta muted small" }, hmFormatFileMeta(file)),
        el("button", {
          class: "btn-ghost hm-file-remove",
          title: "Remove",
          onclick: (e) => { e.stopPropagation(); hmRemoveFile(file.path); },
        }, "×"),
      ));
    }
  }

  let previewNode;
  if (hm.previewSrc && hm.previewMime?.startsWith("video/")) {
    previewNode = el("video", {
      class: "hm-preview-media",
      src: hm.previewSrc,
      controls: "controls",
    });
  } else if (hm.previewSrc) {
    previewNode = el("img", {
      class: "hm-preview-media",
      src: hm.previewSrc,
      alt: "Preview",
    });
  } else {
    previewNode = el("p", { class: "hm-preview-empty muted small" },
      hm.busy ? "Generating preview…" : "Select a file to preview.",
    );
  }

  const outputLabel = hm.outputDir
    ? hm.outputDir
    : "Same folder as each source file";

  const convertBtn = el("button", {
    class: "btn btn-primary",
    disabled: hm.busy || hm.files.length === 0 ? "disabled" : undefined,
    onclick: hmConvert,
  }, hm.busy && hm.busyLabel === "Converting" ? "Converting…" : "Convert all");

  const openFolderBtn = el("button", {
    class: "btn-ghost",
    disabled: hm.files.length === 0 && !hm.outputDir ? "disabled" : undefined,
    onclick: hmOpenOutputFolder,
  }, "Open output folder");

  return el("div", { class: "plugin-controls" },
    el("section", { class: "plugin-section" },
      el("h3", {}, "Files"),
      el("div", { class: "action-row" }, pickBtn, clearBtn),
      fileList,
    ),

    el("section", { class: "plugin-section" },
      el("h3", {}, "Preview"),
      el("div", { class: "hm-preview-frame" }, previewNode),
    ),

    el("section", { class: "plugin-section" },
      el("h3", {}, "Convert"),
      el("p", { class: "muted small" },
        "Images → JPEG or PNG. Videos → MP4 (H.264 + AAC).",
      ),
      el("div", { class: "hm-convert-options" },
        el("label", { class: "hm-option" }, "Image format",
          el("select", {
            value: hm.imageFormat,
            disabled: hm.busy ? "disabled" : undefined,
            onchange: (e) => { hm.imageFormat = e.target.value; },
          },
            el("option", { value: "jpeg" }, "JPEG"),
            el("option", { value: "png" }, "PNG"),
          ),
        ),
        el("label", { class: "checkbox-row hm-option" },
          el("input", {
            type: "checkbox",
            checked: hm.overwrite ? "checked" : undefined,
            disabled: hm.busy ? "disabled" : undefined,
            onchange: (e) => { hm.overwrite = e.target.checked; },
          }),
          el("span", {}, "Overwrite existing outputs"),
        ),
      ),
      el("p", { class: "muted small hm-output-line" },
        "Output: ",
        el("span", { class: "hm-output-path" }, outputLabel),
        el("button", {
          class: "btn-ghost hm-pick-dir",
          disabled: hm.busy ? "disabled" : undefined,
          onclick: hmPickOutputDir,
        }, hm.outputDir ? "Change folder…" : "Choose folder…"),
        hm.outputDir ? el("button", {
          class: "btn-ghost",
          disabled: hm.busy ? "disabled" : undefined,
          onclick: () => { hm.outputDir = null; renderAll(); },
        }, "Use source folders") : null,
      ),
      el("div", { class: "action-row" }, convertBtn, openFolderBtn),
    ),
  );
}


// ============================================================================
// Network Manager (status pill + page)
// ============================================================================

let nm = {
  adapters: [],            // NetworkAdapterInfo[]
  profiles: [],            // NetworkProfile[]
  selectedId: null,
  stateByAdapter: {},      // adapterName -> AdapterNetworkState
  matchById: {},           // profileId -> ProfileMatchResult
  busy: false,
  busyLabel: "",
  loaded: false,           // adapters/state read at least once this session
  tab: "profiles",         // "profiles" | "adapters" | "scan"
  scan: {
    adapterName: "",       // adapter whose subnet we sweep
    scanning: false,
    scanned: 0,
    total: 0,
    hosts: [],             // ScanHost[]: { ip, rttMs, mac, hostname }
    filter: "",            // free-text filter over ip/hostname/mac
    sortKey: "ip",         // "ip" | "hostname" | "mac" | "rtt"
    sortDir: "asc",        // "asc" | "desc"
    done: false,
    error: "",
    listenersReady: false,
  },
};

function nmNewId() {
  return (crypto?.randomUUID?.()) || `p${Date.now()}${Math.random().toString(16).slice(2)}`;
}

function nmBlankProfile() {
  return {
    id: nmNewId(),
    name: "New profile",
    adapterName: "",
    ipv4Mode: "dhcp",
    ipAddress: "",
    subnetMask: "255.255.255.0",
    gateway: "",
    dnsMode: "nochange",
    primaryDns: "",
    secondaryDns: "",
    notes: "",
    lastAppliedAt: null,
  };
}

function nmStatusPill() {
  if (nm.busy) return { label: nm.busyLabel || "Working", cls: "pill-running" };
  const n = nm.profiles.length;
  if (n === 0) return { label: "No profiles", cls: "pill-idle" };
  const active = nm.profiles.filter((p) => nm.matchById[p.id]?.isMatch).length;
  return active > 0
    ? { label: `${active}/${n} active`, cls: "pill-running" }
    : { label: `${n} profile${n === 1 ? "" : "s"}`, cls: "pill-muted" };
}

function nmSelected() { return nm.profiles.find((p) => p.id === nm.selectedId) || null; }

function nmMatch(p) {
  return nm.matchById[p.id] || { isMatch: false, status: "Needs refresh", detail: "Refresh adapters to evaluate." };
}

function nmUniqueName(base) {
  const taken = new Set(nm.profiles.map((p) => p.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  let i = 2;
  while (taken.has(`${base} ${i}`.toLowerCase())) i += 1;
  return `${base} ${i}`;
}

function nmIpv4Summary(s) {
  if (!s) return "Unavailable";
  if (s.ipv4Mode === "dhcp") return s.ipAddress ? `DHCP (${s.ipAddress})` : "DHCP";
  return s.ipAddress ? `${s.ipAddress} / ${s.subnetMask || "?"}` : "none";
}

function nmDnsSummary(s) {
  if (!s) return "Unavailable";
  const list = (s.dnsServers || []).join(", ");
  if (s.dnsMode === "manual") return list || "none";
  return list ? `Automatic (${list})` : "Automatic";
}

// ---- data flow ----

let nmSaveTimer = null;
function nmSaveSoon() {
  if (nmSaveTimer) clearTimeout(nmSaveTimer);
  nmSaveTimer = setTimeout(nmSaveNow, 250);
}
async function nmSaveNow() {
  try {
    await invoke("networkmanager_save_profiles", { profiles: nm.profiles });
  } catch (err) {
    logTo("networkmanager", `Could not save profiles: ${err}`, "error");
  }
}

async function nmLoadProfiles() {
  try {
    nm.profiles = await invoke("networkmanager_load_profiles");
    if (nm.profiles.length && !nm.selectedId) nm.selectedId = nm.profiles[0].id;
  } catch (err) {
    logTo("networkmanager", `Could not load profiles: ${err}`, "error");
  }
}

async function nmRecomputeMatch(p) {
  const state = nm.stateByAdapter[p.adapterName];
  if (!state) {
    nm.matchById[p.id] = {
      isMatch: false,
      status: p.adapterName ? "No adapter" : "Needs setup",
      detail: p.adapterName
        ? `No live snapshot for ${p.adapterName}. Refresh adapters.`
        : "Pick a target adapter for this profile.",
    };
    return;
  }
  try {
    nm.matchById[p.id] = await invoke("networkmanager_compare", { profile: p, state });
  } catch (err) {
    nm.matchById[p.id] = { isMatch: false, status: "Error", detail: String(err) };
  }
}

async function nmRecomputeAll() { await Promise.all(nm.profiles.map(nmRecomputeMatch)); }

async function nmRefresh() {
  nm.busy = true;
  nm.busyLabel = "Reading adapters";
  renderAll();
  try {
    nm.adapters = await invoke("networkmanager_list_adapters");
    nm.stateByAdapter = {};
    // Read adapter states concurrently — each shells out to PowerShell (~0.5-1.5s),
    // so a sequential loop would freeze the UI for several seconds on multi-NIC boxes.
    await Promise.all(
      nm.adapters
        .filter((a) => a.status !== "Not Present")
        .map(async (a) => {
          try {
            nm.stateByAdapter[a.name] = await invoke("networkmanager_read_state", { name: a.name });
          } catch (err) {
            logTo("networkmanager", `Could not read ${a.name}: ${err}`, "warn");
          }
        }),
    );
    await nmRecomputeAll();
    nm.loaded = true;
    logTo("networkmanager", `Read ${nm.adapters.length} adapter${nm.adapters.length === 1 ? "" : "s"}.`, "ok");
  } catch (err) {
    logTo("networkmanager", `Refresh failed: ${err}`, "error");
  } finally {
    nm.busy = false;
    nm.busyLabel = "";
    renderAll();
  }
}

function nmEnsureLoaded() {
  if (!nm.loaded && !nm.busy) nmRefresh();
}

function nmDefaultAdapter() {
  const sel = nmSelected();
  if (sel?.adapterName) return sel.adapterName;
  const up = nm.adapters.find((a) => a.status === "Up");
  return up?.name || nm.adapters[0]?.name || "";
}

async function nmNew() {
  const p = nmBlankProfile();
  p.name = nmUniqueName("New profile");
  p.adapterName = nmDefaultAdapter();
  nm.profiles.push(p);
  nm.selectedId = p.id;
  await nmRecomputeMatch(p);
  nmSaveSoon();
  logTo("networkmanager", `Created "${p.name}".`, "info");
  renderAll();
}

async function nmDuplicate() {
  const sel = nmSelected();
  if (!sel) return;
  const p = { ...sel, id: nmNewId(), name: nmUniqueName(`${sel.name} copy`), lastAppliedAt: null };
  nm.profiles.push(p);
  nm.selectedId = p.id;
  await nmRecomputeMatch(p);
  nmSaveSoon();
  renderAll();
}

function nmDelete() {
  const sel = nmSelected();
  if (!sel) return;
  if (!confirm(`Delete profile "${sel.name}"?`)) return;
  const idx = nm.profiles.findIndex((p) => p.id === sel.id);
  nm.profiles = nm.profiles.filter((p) => p.id !== sel.id);
  delete nm.matchById[sel.id];
  const next = nm.profiles[idx] || nm.profiles[idx - 1] || null;
  nm.selectedId = next?.id || null;
  nmSaveSoon();
  logTo("networkmanager", `Deleted "${sel.name}".`, "warn");
  renderAll();
}

function nmSelect(id) {
  if (nm.selectedId === id) return;
  nm.selectedId = id;
  renderAll();
}

let nmFieldTimer = null;
function nmSetText(key, value) {
  const sel = nmSelected();
  if (!sel) return;
  sel[key] = value;
  nmSaveSoon();
  if (nmFieldTimer) clearTimeout(nmFieldTimer);
  nmFieldTimer = setTimeout(async () => {
    await nmRecomputeMatch(sel);
    nmRefreshLiveBits();
  }, 250);
}

// Update only the drift banner + profile list in place, so editing a text field
// never steals focus from the input being typed into.
function nmRefreshLiveBits() {
  if (currentPluginId() !== "networkmanager") return;
  const sel = nmSelected();
  const list = document.getElementById("nm-profile-list");
  if (list && nm.profiles.length) list.replaceChildren(...nm.profiles.map(nmProfileRow));
  const drift = document.getElementById("nm-drift");
  if (drift && sel) drift.replaceWith(nmDriftBanner(sel));
  const title = document.getElementById("nm-editor-title");
  if (title && sel) title.textContent = sel.name || "(unnamed)";
}

async function nmSetChoice(key, value) {
  const sel = nmSelected();
  if (!sel) return;
  sel[key] = value;
  nmSaveSoon();
  await nmRecomputeMatch(sel);
  renderAll();
}

async function nmCaptureAdapter(adapterName) {
  if (!adapterName) {
    logTo("networkmanager", "No adapter available to capture.", "warn");
    return;
  }
  nm.busy = true;
  nm.busyLabel = "Capturing";
  renderAll();
  try {
    const p = await invoke("networkmanager_capture_profile", { name: adapterName });
    p.id = nmNewId();
    p.name = nmUniqueName(p.name);
    nm.profiles.push(p);
    nm.selectedId = p.id;
    nm.tab = "profiles";   // jump to the editor so the user sees the result
    await nmRecomputeMatch(p);
    nmSaveNow();
    logTo("networkmanager", `Captured "${p.name}" from ${adapterName}.`, "ok");
  } catch (err) {
    logTo("networkmanager", `Capture failed: ${err}`, "error");
  } finally {
    nm.busy = false;
    nm.busyLabel = "";
    renderAll();
  }
}

async function nmOpenDir() {
  try {
    await invoke("networkmanager_open_profiles_dir");
  } catch (err) {
    logTo("networkmanager", `Could not open folder: ${err}`, "error");
  }
}

async function nmApply() {
  const sel = nmSelected();
  if (!sel || nm.busy) return;
  if (!sel.adapterName) {
    logTo("networkmanager", "Pick a target adapter before applying.", "warn");
    return;
  }
  // Snapshot the profile before any await. The user can still edit fields while
  // UAC / apply / re-read is in flight, so we must verify against exactly what we
  // sent — not against a profile that changed underneath us.
  const applied = { ...sel };

  const proceed = confirm(
    `Apply "${applied.name}" to ${applied.adapterName}?\n\n` +
    `This changes Windows IPv4/DNS settings and will prompt for administrator approval.`,
  );
  if (!proceed) return;

  nm.busy = true;
  nm.busyLabel = "Applying";
  renderAll();
  let attempted = false;
  let hadStepIssue = false;
  try {
    const outcome = await invoke("networkmanager_apply_profile", { profile: applied });
    attempted = true;
    hadStepIssue = !outcome.ok;
    for (const s of outcome.steps) {
      logTo("networkmanager", `${s.step}: ${s.detail}`, s.ok ? "ok" : "error");
    }
  } catch (err) {
    logTo("networkmanager", `${err}`, "error");
  } finally {
    // The authoritative "did it work?" signal is the re-read state, NOT the step
    // exit codes — netsh can apply a change and still return non-zero. So always
    // re-read and judge success by whether Windows matches the applied snapshot.
    if (attempted && applied.adapterName) {
      nm.busyLabel = "Verifying";
      renderAll();
      await new Promise((r) => setTimeout(r, 1000));
      let state = null;
      try {
        state = await invoke("networkmanager_read_state", { name: applied.adapterName });
        nm.stateByAdapter[applied.adapterName] = state;
      } catch (err) {
        logTo("networkmanager", `Could not re-read ${applied.adapterName}: ${err}`, "warn");
      }
      let matched = false;
      let detail = "No live snapshot.";
      if (state) {
        try {
          const m = await invoke("networkmanager_compare", { profile: applied, state });
          matched = m.isMatch;
          detail = m.detail;
        } catch (err) {
          detail = String(err);
        }
      }
      if (matched) {
        const live = nm.profiles.find((p) => p.id === applied.id);
        if (live) {
          live.lastAppliedAt = new Date().toISOString();
          nmSaveNow();
        }
        logTo("networkmanager", `Applied "${applied.name}" — Windows now matches.`, "ok");
      } else {
        logTo(
          "networkmanager",
          `Applied, but Windows doesn't match yet: ${detail}`,
          hadStepIssue ? "error" : "warn",
        );
      }
      // Keep the on-screen drift for the currently-selected profile in sync.
      const cur = nmSelected();
      if (cur) await nmRecomputeMatch(cur);
    }
    nm.busy = false;
    nm.busyLabel = "";
    renderAll();
  }
}

// ---- render ----

function nmProfileRow(p) {
  const m = nmMatch(p);
  const active = p.id === nm.selectedId;
  return el("li", {
    class: `nm-profile-row ${active ? "nm-profile-active" : ""}`,
    role: "button",
    tabindex: "0",
    "aria-pressed": active ? "true" : "false",
    onclick: () => nmSelect(p.id),
    onkeydown: (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        nmSelect(p.id);
      }
    },
  },
    el("div", { class: "nm-profile-main" },
      el("span", { class: "nm-profile-name" }, p.name || "(unnamed)"),
      el("span", { class: `pill ${m.isMatch ? "pill-running" : "pill-idle"}` },
        m.isMatch ? "Active" : (m.status || "Not active")),
    ),
    el("span", { class: "nm-profile-sub muted small" }, p.adapterName ? `→ ${p.adapterName}` : "No adapter"),
    m.detail ? el("span", { class: "nm-profile-detail muted small" }, m.detail) : null,
  );
}

function nmDriftBanner(p) {
  const m = nmMatch(p);
  const state = nm.stateByAdapter[p.adapterName];
  const snapshot = state
    ? `${state.adapterName}: IPv4 ${nmIpv4Summary(state)} · gateway ${state.gateway || "none"} · DNS ${nmDnsSummary(state)}`
    : "No live snapshot yet — use Refresh adapters.";
  return el("div", { id: "nm-drift", class: `nm-drift ${m.isMatch ? "nm-drift-active" : ""}` },
    el("div", { class: "nm-drift-status" }, m.isMatch ? "✓ Active" : (m.status || "Not active")),
    m.detail ? el("div", { class: "muted small" }, m.detail) : null,
    el("div", { class: "muted small nm-drift-snapshot" }, snapshot),
  );
}

function nmTextField(label, key, opts = {}) {
  const sel = nmSelected();
  const input = el("input", {
    class: "nm-input",
    type: "text",
    placeholder: opts.placeholder || "",
    disabled: opts.disabled ? "disabled" : undefined,
    oninput: (e) => nmSetText(key, e.target.value),
  });
  input.value = sel[key] || "";
  return el("label", { class: `nm-field ${opts.disabled ? "nm-field-dim" : ""}` },
    el("span", { class: "nm-field-label" }, label),
    input,
  );
}

function nmSeg(label, key, options) {
  const sel = nmSelected();
  return el("div", { class: "nm-seg-row" },
    el("span", { class: "nm-field-label" }, label),
    el("div", { class: "nm-seg" },
      ...options.map((opt) => el("button", {
        class: `nm-seg-btn ${sel[key] === opt.value ? "nm-seg-on" : ""}`,
        onclick: () => nmSetChoice(key, opt.value),
      }, opt.label)),
    ),
  );
}

function nmEditorContent(sel) {
  const usesStatic = sel.ipv4Mode === "static";
  const usesManual = sel.dnsMode === "manual";

  const adapterSelect = el("select", {
    class: "nm-input",
    onchange: (e) => nmSetChoice("adapterName", e.target.value),
  },
    el("option", { value: "" }, "— choose adapter —"),
    ...nm.adapters.map((a) => el("option", {
      value: a.name,
      selected: a.name === sel.adapterName ? "selected" : undefined,
    }, a.description ? `${a.name} — ${a.description}` : a.name)),
    (sel.adapterName && !nm.adapters.some((a) => a.name === sel.adapterName))
      ? el("option", { value: sel.adapterName, selected: "selected" }, `${sel.adapterName} (not found)`)
      : null,
  );

  const notes = el("textarea", {
    class: "nm-input nm-textarea",
    oninput: (e) => nmSetText("notes", e.target.value),
  });
  notes.value = sel.notes || "";

  const header = el("div", { class: "nm-editor-head" },
    el("h3", { id: "nm-editor-title", class: "nm-editor-title" }, sel.name || "(unnamed)"),
    el("div", { class: "nm-editor-actions" },
      el("button", {
        class: "btn btn-primary nm-apply-btn",
        disabled: nm.busy || !sel.adapterName ? "disabled" : undefined,
        title: "Apply this profile to Windows (prompts for admin)",
        onclick: nmApply,
      }, "Apply"),
      el("button", { class: "btn-ghost", disabled: nm.busy ? "disabled" : undefined, onclick: nmDuplicate }, "Duplicate"),
      el("button", { class: "btn-ghost nm-danger", disabled: nm.busy ? "disabled" : undefined, onclick: nmDelete }, "Delete"),
    ),
  );

  return [
    header,
    el("section", { class: "plugin-section" },
      el("h3", {}, "Profile"),
      el("div", { class: "nm-grid-2" },
        nmTextField("Name", "name"),
        el("label", { class: "nm-field" },
          el("span", { class: "nm-field-label" }, "Target adapter"),
          adapterSelect,
        ),
      ),
      nmDriftBanner(sel),
      el("label", { class: "nm-field" },
        el("span", { class: "nm-field-label" }, "Notes"),
        notes,
      ),
    ),
    el("section", { class: "plugin-section" },
      el("h3", {}, "IPv4"),
      nmSeg("Mode", "ipv4Mode", [
        { value: "dhcp", label: "DHCP" },
        { value: "static", label: "Static" },
      ]),
      el("div", { class: "nm-grid-2" },
        nmTextField("IP address", "ipAddress", { disabled: !usesStatic, placeholder: "192.168.1.50" }),
        nmTextField("Subnet mask", "subnetMask", { disabled: !usesStatic, placeholder: "255.255.255.0" }),
      ),
      nmTextField("Gateway", "gateway", { disabled: !usesStatic, placeholder: "192.168.1.1 (optional)" }),
    ),
    el("section", { class: "plugin-section" },
      el("h3", {}, "DNS"),
      nmSeg("Mode", "dnsMode", [
        { value: "automatic", label: "Automatic" },
        { value: "manual", label: "Manual" },
        { value: "nochange", label: "No change" },
      ]),
      el("div", { class: "nm-grid-2" },
        nmTextField("Primary DNS", "primaryDns", { disabled: !usesManual, placeholder: "8.8.8.8" }),
        nmTextField("Alternate DNS", "secondaryDns", { disabled: !usesManual, placeholder: "8.8.4.4 (optional)" }),
      ),
    ),
    el("p", { class: "muted small nm-readonly-note" },
      "Apply changes Windows IPv4/DNS for the target adapter and prompts for administrator approval. · ",
      el("a", { href: "#", onclick: (e) => { e.preventDefault(); nmOpenDir(); } }, "open profiles folder"),
    ),
  ];
}

// ---- scan (Angry-IP-Scanner-style subnet sweep) ----

// Dotted IPv4 mask -> CIDR prefix length (count of contiguous high bits).
function nmMaskToPrefix(mask) {
  const parts = String(mask || "").split(".").map((n) => parseInt(n, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  let bits = 0;
  for (const oct of parts) bits += (oct >>> 0).toString(2).split("").filter((b) => b === "1").length;
  return bits;
}

// Resolve the subnet we'd sweep for an adapter, from its live state. Returns
// { ip, prefix, network, label } or null when the adapter has no usable IPv4.
function nmScanSubnetFor(adapterName) {
  const st = nm.stateByAdapter[adapterName];
  if (!st || !st.ipAddress) return null;
  const prefix = nmMaskToPrefix(st.subnetMask);
  if (prefix == null || prefix < 16 || prefix > 30) return null;
  const ipParts = st.ipAddress.split(".").map((n) => parseInt(n, 10));
  if (ipParts.length !== 4 || ipParts.some((n) => Number.isNaN(n))) return null;
  const ipNum = ((ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3]) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const net = (ipNum & mask) >>> 0;
  const network = [(net >>> 24) & 255, (net >>> 16) & 255, (net >>> 8) & 255, net & 255].join(".");
  const hostCount = Math.max(0, Math.pow(2, 32 - prefix) - 2);
  return { ip: st.ipAddress, prefix, network, hostCount, label: `${network}/${prefix} · ${hostCount} hosts` };
}

// Pick a sensible default adapter to scan: the current scan target if still valid,
// else the selected profile's adapter, else the first "Up" adapter with an IPv4.
function nmScanDefaultAdapter() {
  if (nm.scan.adapterName && nmScanSubnetFor(nm.scan.adapterName)) return nm.scan.adapterName;
  const sel = nmSelected();
  if (sel?.adapterName && nmScanSubnetFor(sel.adapterName)) return sel.adapterName;
  const up = nm.adapters.find((a) => a.status === "Up" && nmScanSubnetFor(a.name));
  if (up) return up.name;
  const any = nm.adapters.find((a) => nmScanSubnetFor(a.name));
  return any?.name || "";
}

function nmScanInitListeners() {
  if (nm.scan.listenersReady) return;
  nm.scan.listenersReady = true;
  listen("netscan:host", (e) => {
    const h = e.payload;
    if (!nm.scan.hosts.some((x) => x.ip === h.ip)) nm.scan.hosts.push(h);
    nmScanRenderLive();
  });
  listen("netscan:progress", (e) => {
    nm.scan.scanned = e.payload.scanned;
    nm.scan.total = e.payload.total;
    nmScanRenderLive();
  });
  listen("netscan:done", (e) => {
    // Merge rather than replace: streamed `netscan:host` rows may already carry
    // hostnames that arrived first; keep them.
    const byIp = new Map(nm.scan.hosts.map((h) => [h.ip, h]));
    nm.scan.hosts = (e.payload.hosts || []).map((h) => ({ ...h, hostname: h.hostname || byIp.get(h.ip)?.hostname || "" }));
    nm.scan.total = e.payload.total;
    nm.scan.done = true;
    nm.scan.scanning = false;
    renderAll();
  });
  listen("netscan:hostnames", (e) => {
    const map = new Map((e.payload || []).map((x) => [x.ip, x.hostname]));
    for (const h of nm.scan.hosts) { const n = map.get(h.ip); if (n) h.hostname = n; }
    nmScanRenderLive();
  });
}

async function nmScanStart() {
  if (nm.scan.scanning) return;
  const adapterName = nmScanDefaultAdapter();
  const subnet = adapterName ? nmScanSubnetFor(adapterName) : null;
  if (!subnet) {
    logTo("networkmanager", "No adapter with a scannable IPv4 subnet. Refresh adapters first.", "warn");
    return;
  }
  nm.scan.adapterName = adapterName;
  nm.scan.scanning = true;
  nm.scan.done = false;
  nm.scan.error = "";
  nm.scan.hosts = [];
  nm.scan.scanned = 0;
  nm.scan.total = subnet.hostCount;
  renderAll();
  try {
    // The `netscan:done` event is authoritative for the host list (and merges
    // streamed hostnames); don't overwrite it from the resolved value here.
    const result = await invoke("netscan_scan", { ip: subnet.ip, prefix: subnet.prefix });
    nm.scan.total = result.total;
    logTo("networkmanager", `Scan complete — ${result.hosts.length} host${result.hosts.length === 1 ? "" : "s"} on ${subnet.network}/${subnet.prefix}.`, "ok");
  } catch (err) {
    nm.scan.error = String(err);
    logTo("networkmanager", `Scan failed: ${err}`, "error");
  } finally {
    nm.scan.scanning = false;
    nm.scan.done = true;
    renderAll();
  }
}

// Patch the live bits (progress + results) in place so streamed events don't
// rebuild the whole page (which would steal focus / flicker the adapter picker).
function nmScanRenderLive() {
  if (currentPluginId() !== "networkmanager" || nm.tab !== "scan") return;
  const prog = document.getElementById("nm-scan-progress");
  if (prog) prog.replaceWith(nmScanProgress());
  nmScanApplyFilter();
}

// Hosts narrowed by the free-text filter (case-insensitive substring over
// IP, hostname, and MAC). Empty filter returns every host.
function nmScanFilteredHosts() {
  const q = nm.scan.filter.trim().toLowerCase();
  if (!q) return nm.scan.hosts;
  return nm.scan.hosts.filter((h) =>
    (h.ip || "").toLowerCase().includes(q) ||
    (h.hostname || "").toLowerCase().includes(q) ||
    (h.mac || "").toLowerCase().includes(q));
}

// Dotted IPv4 -> sortable 32-bit number; -1 for anything unparseable so
// malformed addresses sort to the top in ascending order.
function nmIpToNum(ip) {
  const p = String(ip || "").split(".").map((n) => parseInt(n, 10));
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return -1;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

// Sort a host list by the active column/direction. IP and RTT compare
// numerically; hostname/MAC compare case-insensitively with blanks pinned
// last (regardless of direction). IP is the stable tiebreaker throughout.
function nmScanSortedHosts(hosts) {
  const { sortKey, sortDir } = nm.scan;
  const dir = sortDir === "desc" ? -1 : 1;
  const ipCmp = (a, b) => nmIpToNum(a.ip) - nmIpToNum(b.ip);
  return hosts.slice().sort((a, b) => {
    if (sortKey === "ip") return ipCmp(a, b) * dir;
    if (sortKey === "rtt") {
      const cmp = (a.rttMs ?? Infinity) - (b.rttMs ?? Infinity);
      return (cmp || ipCmp(a, b)) * dir;
    }
    // hostname / mac
    const av = (a[sortKey] || "").toLowerCase();
    const bv = (b[sortKey] || "").toLowerCase();
    if (!av && !bv) return ipCmp(a, b);
    if (!av) return 1;   // blanks always last
    if (!bv) return -1;
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return (cmp || ipCmp(a, b)) * dir;
  });
}

// "N hosts" when unfiltered, "shown of total" when a filter is active.
function nmScanFilterCountText() {
  const total = nm.scan.hosts.length;
  if (!nm.scan.filter.trim()) return `${total} host${total === 1 ? "" : "s"}`;
  return `${nmScanFilteredHosts().length} of ${total} shown`;
}

// Re-render just the results body + count in place so typing in the filter
// box never rebuilds the page (which would steal focus from the input).
function nmScanApplyFilter() {
  if (currentPluginId() !== "networkmanager" || nm.tab !== "scan") return;
  const body = document.getElementById("nm-scan-results");
  if (body) body.replaceChildren(...nmScanResultRows());
  const cnt = document.getElementById("nm-scan-filter-count");
  if (cnt) cnt.textContent = nmScanFilterCountText();
}

// Filter row above the results table. The <input> is left untouched by
// nmScanApplyFilter, so it keeps focus + caret while you type.
function nmScanFilterBar() {
  return el("div", { class: "nm-scan-filter" },
    el("input", {
      type: "search",
      class: "nm-input nm-scan-filter-input",
      placeholder: "Filter by IP, hostname, or MAC…",
      "aria-label": "Filter scan results",
      value: nm.scan.filter,
      oninput: (e) => { nm.scan.filter = e.target.value; nmScanApplyFilter(); },
    }),
    el("span", { id: "nm-scan-filter-count", class: "muted small nm-scan-filter-count" },
      nmScanFilterCountText()),
  );
}

function nmScanProgress() {
  const { scanned, total, scanning, hosts } = nm.scan;
  const pct = total > 0 ? Math.min(100, Math.round((scanned / total) * 100)) : 0;
  let idle = "Pick a subnet to scan.";
  if (!scanning && !nm.scan.done) {
    const a = nmScanDefaultAdapter();
    const sub = a ? nmScanSubnetFor(a) : null;
    idle = sub ? `${sub.hostCount} hosts in range (${sub.network}/${sub.prefix})` : "No scannable subnet — refresh adapters.";
  }
  return el("div", { id: "nm-scan-progress", class: "nm-scan-progress" },
    el("div", { class: "nm-scan-bar" }, el("div", { class: "nm-scan-bar-fill", style: `width:${pct}%` })),
    el("div", { class: "muted small" },
      scanning
        ? `Scanning… ${scanned}/${total} probed · ${hosts.length} found`
        : nm.scan.done
          ? `Done · ${hosts.length} host${hosts.length === 1 ? "" : "s"} of ${total} probed`
          : idle),
  );
}

function nmScanResultRows() {
  const hosts = nmScanSortedHosts(nmScanFilteredHosts());
  if (hosts.length === 0) {
    let msg;
    if (nm.scan.hosts.length > 0) msg = "No hosts match the filter.";
    else if (nm.scan.scanning) msg = "Listening for hosts…";
    else msg = "No hosts yet — run a scan.";
    return [el("tr", {}, el("td", { class: "muted small", colspan: "4" }, msg))];
  }
  return hosts.map((h) => el("tr", { class: "nm-scan-row" },
    el("td", { class: "nm-scan-ip" }, h.ip),
    el("td", {}, h.hostname || el("span", { class: "muted" }, "—")),
    el("td", { class: "nm-scan-mac" }, h.mac || el("span", { class: "muted" }, "—")),
    el("td", { class: "nm-scan-rtt" }, `${h.rttMs} ms`),
  ));
}

// Click a column to sort by it; click the active column again to flip
// direction. Re-renders the table in place (header arrows + rows) without a
// full page render, so the filter input keeps its focus/caret.
function nmScanSetSort(key) {
  if (nm.scan.sortKey === key) nm.scan.sortDir = nm.scan.sortDir === "asc" ? "desc" : "asc";
  else { nm.scan.sortKey = key; nm.scan.sortDir = "asc"; }
  const tbl = document.getElementById("nm-scan-table");
  if (tbl) tbl.replaceWith(nmScanTableEl());
}

function nmScanHeaderCell(key, label) {
  const active = nm.scan.sortKey === key;
  const arrow = active ? (nm.scan.sortDir === "asc" ? "▲" : "▼") : "";
  return el("th", {
    class: `nm-scan-th${active ? " nm-scan-th-active" : ""}`,
    role: "button",
    tabindex: "0",
    "aria-sort": active ? (nm.scan.sortDir === "asc" ? "ascending" : "descending") : "none",
    onclick: () => nmScanSetSort(key),
    onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); nmScanSetSort(key); } },
  }, label, el("span", { class: "nm-scan-sort-ind" }, arrow));
}

function nmScanTableEl() {
  return el("table", { id: "nm-scan-table", class: "nm-scan-table" },
    el("thead", {}, el("tr", {},
      nmScanHeaderCell("ip", "IP address"),
      nmScanHeaderCell("hostname", "Hostname"),
      nmScanHeaderCell("mac", "MAC"),
      nmScanHeaderCell("rtt", "RTT"),
    )),
    el("tbody", { id: "nm-scan-results" }, ...nmScanResultRows()),
  );
}

function nmScanTab() {
  nmScanInitListeners();
  const adapterName = nmScanDefaultAdapter();
  const subnet = adapterName ? nmScanSubnetFor(adapterName) : null;

  const candidates = nm.adapters.filter((a) => nmScanSubnetFor(a.name));
  const picker = el("select", {
    class: "nm-input",
    disabled: nm.scan.scanning ? "disabled" : undefined,
    onchange: (e) => { nm.scan.adapterName = e.target.value; renderAll(); },
  },
    ...candidates.map((a) => el("option", {
      value: a.name,
      selected: a.name === adapterName ? "selected" : undefined,
    }, `${a.name} — ${nmScanSubnetFor(a.name).label}`)),
  );

  const scanBtn = el("button", {
    class: "btn btn-primary",
    disabled: nm.scan.scanning || !subnet ? "disabled" : undefined,
    onclick: nmScanStart,
  }, nm.scan.scanning ? "Scanning…" : "Scan subnet");

  const head = el("section", { class: "plugin-section" },
    el("div", { class: "nm-pane-head" },
      el("div", { class: "nm-pane-head-text" },
        el("h3", {}, "Scan local subnet"),
        el("p", { class: "muted small nm-section-sub" },
          "Ping-sweep the adapter's subnet to find live hosts, their MAC, and hostname. Un-elevated."),
      ),
    ),
    candidates.length === 0
      ? el("p", { class: "muted small" }, nm.loaded ? "No adapter has a scannable IPv4 subnet." : "Reading adapters…")
      : el("div", { class: "nm-scan-controls" },
          el("label", { class: "nm-field nm-scan-pick" },
            el("span", { class: "nm-field-label" }, "Subnet"),
            picker,
          ),
          scanBtn,
        ),
    nmScanProgress(),
  );

  const table = nmScanTableEl();

  const showFilter = nm.scan.scanning || nm.scan.done || nm.scan.hosts.length > 0;

  return el("div", { class: "plugin-controls" },
    head,
    el("section", { class: "plugin-section" },
      showFilter ? nmScanFilterBar() : null,
      table,
    ),
  );
}

function nmTabBar() {
  const tab = (id, label) => el("button", {
    class: `nm-tab ${nm.tab === id ? "nm-tab-active" : ""}`,
    onclick: () => { nm.tab = id; renderAll(); },
  }, label);
  return el("div", { class: "nm-tabs" },
    tab("profiles", "Profiles"),
    tab("adapters", "Adapters"),
    tab("scan", "Scan"),
  );
}

function nmProfilesTab() {
  const sel = nmSelected();

  const list = el("ul", { id: "nm-profile-list", class: "nm-profile-list" });
  if (nm.profiles.length === 0) {
    list.appendChild(el("li", { class: "muted small nm-profile-empty" }, "No profiles yet."));
  } else {
    for (const p of nm.profiles) list.appendChild(nmProfileRow(p));
  }

  const listPane = el("div", { class: "nm-list-pane" },
    el("div", { class: "nm-pane-head" }, el("h3", {}, "Profiles")),
    list,
    el("button", {
      class: "btn btn-primary nm-new-btn",
      disabled: nm.busy ? "disabled" : undefined,
      onclick: nmNew,
    }, "+ New profile"),
  );

  const editorPane = sel
    ? el("div", { class: "nm-editor-pane" }, ...nmEditorContent(sel))
    : el("div", { class: "nm-editor-pane nm-editor-empty" },
        el("div", { class: "nm-empty" },
          el("p", { class: "nm-empty-title" }, "Select a profile to edit"),
          el("p", { class: "muted small" },
            "Pick one from the list, create a new one, or capture an adapter from the Adapters tab."),
        ),
      );

  return el("div", { class: "nm-master-detail" }, listPane, editorPane);
}

function nmAdaptersTab() {
  const refreshBtn = el("button", {
    class: "btn-ghost",
    disabled: nm.busy ? "disabled" : undefined,
    onclick: nmRefresh,
  }, nm.busy ? "Reading…" : "Refresh");

  const nicList = el("div", { class: "nm-nic-list" });
  const present = nm.adapters.filter((a) => a.status !== "Not Present");
  if (present.length === 0) {
    nicList.appendChild(el("p", { class: "muted small" }, nm.loaded ? "No adapters found." : "Reading adapters…"));
  } else {
    for (const a of present) {
      const st = nm.stateByAdapter[a.name];
      const matching = nm.profiles
        .filter((p) => p.adapterName === a.name && nm.matchById[p.id]?.isMatch)
        .map((p) => p.name);
      nicList.appendChild(el("div", { class: "nm-nic-row" },
        el("div", { class: "nm-nic-head" },
          el("span", { class: "nm-nic-name" }, a.name),
          el("span", { class: "muted small" }, a.status),
        ),
        el("div", { class: "muted small" }, a.description),
        el("div", { class: "muted small" }, `IPv4 ${nmIpv4Summary(st)} · Gateway ${st?.gateway || "none"} · DNS ${nmDnsSummary(st)}`),
        el("div", { class: "nm-nic-foot" },
          el("span", { class: `small ${matching.length ? "nm-nic-active" : "muted"}` },
            matching.length ? `Active profile: ${matching.join(", ")}` : "No matching profile"),
          el("button", {
            class: "btn-ghost nm-nic-save",
            disabled: nm.busy ? "disabled" : undefined,
            onclick: () => nmCaptureAdapter(a.name),
          }, "Save as profile"),
        ),
      ));
    }
  }

  return el("div", { class: "plugin-controls" },
    el("section", { class: "plugin-section" },
      el("div", { class: "nm-pane-head" },
        el("div", { class: "nm-pane-head-text" },
          el("h3", {}, "Windows adapters"),
          el("p", { class: "muted small nm-section-sub" }, "Your live network adapters. Save one as a reusable profile."),
        ),
        refreshBtn,
      ),
      nicList,
    ),
  );
}

function renderNetworkManagerPage() {
  nmEnsureLoaded();
  const body =
    nm.tab === "adapters" ? nmAdaptersTab()
    : nm.tab === "scan" ? nmScanTab()
    : nmProfilesTab();
  return el("div", { class: "plugin-controls nm-root" },
    nmTabBar(),
    body,
  );
}


// ============================================================================
// Library card (compact)
// ============================================================================

function renderToolCard(tool) {
  const fav = isFavorite(tool.id);
  const status = tool.renderStatusPill ? tool.renderStatusPill() : null;

  const star = el("button", {
    class: `star-btn ${fav ? "star-on" : ""}`,
    title: fav ? "Unfavorite" : "Favorite",
    "aria-pressed": fav ? "true" : "false",
    onclick: (e) => { e.stopPropagation(); setFavorite(tool.id, !fav); },
  }, fav ? "★" : "☆");

  const hideBtn = el("button", {
    class: "btn-ghost",
    onclick: (e) => { e.stopPropagation(); setHidden(tool.id, true); },
  }, "Hide");

  const openBtn = el("button", {
    class: "btn btn-primary",
    onclick: (e) => { e.stopPropagation(); setView(pluginView(tool.id)); },
  }, "Open →");

  return el("article",
    {
      class: "tool-card",
      id: `tool-card-${tool.id}`,
      onclick: () => setView(pluginView(tool.id)),
    },
    el("div", { class: "tool-icon" }, tool.emoji),
    el("div", { class: "tool-body" },
      el("div", { class: "tool-header" },
        el("h3", {}, tool.name),
        el("div", { class: "card-header-right" },
          status && el("span", { class: `pill ${status.cls}` }, status.label),
          star,
        ),
      ),
      el("p", { class: "tool-tagline" }, tool.tagline),
      el("div", { class: "tool-actions card-footer" }, hideBtn, openBtn),
    ),
  );
}

function renderHiddenRow(tool) {
  return el("li", { class: "hidden-row" },
    el("span", { class: "hidden-row-icon" }, tool.emoji),
    el("span", { class: "hidden-row-name" }, tool.name),
    el("span", { class: "hidden-row-tag" }, "hidden"),
    el("button", { class: "btn-ghost", onclick: () => setHidden(tool.id, false) }, "Restore"),
  );
}

// ============================================================================
// Views
// ============================================================================

function renderLibrary() {
  const root = document.getElementById("view-root");
  root.replaceChildren();

  const visible = TOOLS.filter((t) => !isHidden(t.id));
  const hidden = TOOLS.filter((t) => isHidden(t.id));

  root.appendChild(el("div", { class: "view-header" },
    el("h2", {}, "Library"),
    el("div", { class: "view-header-right" },
      el("label", { class: "checkbox-row" },
        el("input", {
          type: "checkbox",
          checked: userState.showHidden ? "checked" : undefined,
          onchange: (e) => setShowHidden(e.target.checked),
        }),
        el("span", {}, `Show hidden (${hidden.length})`),
      ),
    ),
  ));

  if (visible.length === 0) {
    root.appendChild(el("p", { class: "empty-state" },
      hidden.length > 0
        ? "All tools are hidden. Toggle “Show hidden” to restore them."
        : "No tools available.",
    ));
  } else {
    const grid = el("section", { class: "tool-grid" });
    for (const tool of visible) grid.appendChild(renderToolCard(tool));
    root.appendChild(grid);
  }

  if (userState.showHidden && hidden.length > 0) {
    root.appendChild(el("h3", { class: "section-subhead" }, "Hidden"));
    const list = el("ul", { class: "hidden-list" });
    for (const tool of hidden) list.appendChild(renderHiddenRow(tool));
    root.appendChild(list);
  }
}

function renderPluginPage(id) {
  const root = document.getElementById("view-root");
  root.replaceChildren();
  const tool = toolById(id);
  if (!tool) {
    root.appendChild(el("p", { class: "empty-state" }, "Unknown plugin."));
    return;
  }
  const status = tool.renderStatusPill ? tool.renderStatusPill() : null;
  const fav = isFavorite(tool.id);

  root.appendChild(el("nav", { class: "breadcrumb" },
    el("a", {
      href: "#",
      onclick: (e) => { e.preventDefault(); setView("library"); },
    }, "← Library"),
  ));

  root.appendChild(el("header", { class: "plugin-header" },
    el("div", { class: "plugin-header-left" },
      el("div", { class: "tool-icon plugin-icon" }, tool.emoji),
      el("div", {},
        el("h2", { class: "plugin-title" }, tool.name),
        el("p", { class: "plugin-tagline" }, tool.tagline),
      ),
    ),
    el("div", { class: "plugin-header-right" },
      status && el("span", { class: `pill ${status.cls}` }, status.label),
      el("button", {
        class: `star-btn ${fav ? "star-on" : ""}`,
        title: fav ? "Unfavorite" : "Favorite",
        "aria-pressed": fav ? "true" : "false",
        onclick: () => setFavorite(tool.id, !fav),
      }, fav ? "★" : "☆"),
    ),
  ));

  // Plugin-specific page body.
  if (tool.renderPage) root.appendChild(tool.renderPage(tool));

  // Description / source row.
  root.appendChild(el("section", { class: "plugin-section" },
    el("h3", {}, "About"),
    el("p", { class: "plugin-desc" }, tool.description),
    el("p", {},
      el("a", {
        href: "#",
        onclick: (e) => { e.preventDefault(); openExternal(tool.repo); },
      }, "Source on GitHub →"),
    ),
  ));

  // Per-plugin activity log.
  const logEntries = pluginLogs.get(tool.id) || [];
  root.appendChild(el("section", { class: "plugin-section" },
    el("div", { class: "section-head" },
      el("h3", {}, "Activity"),
      el("button", {
        class: "btn-ghost",
        onclick: () => { pluginLogs.set(tool.id, []); renderPluginPage(tool.id); },
      }, "Clear"),
    ),
    logEntries.length === 0
      ? el("p", { class: "muted small" }, "No activity yet. Enable the tool and try it out.")
      : el("ol", { id: "plugin-log-list", class: "plugin-log" },
          ...logEntries.map(renderLogEntry),
        ),
  ));
}

function renderSettings() {
  const root = document.getElementById("view-root");
  root.replaceChildren();

  root.appendChild(el("div", { class: "view-header" },
    el("h2", {}, "Settings"),
  ));

  // ===== Updates card =====
  const statusLine = el("p", { class: "muted small", id: "update-status" },
    `You're running v${APP_VERSION}.`);
  const progressBar = el("div", { class: "progress-bar", id: "update-progress" },
    el("div", { class: "progress-fill", id: "update-progress-fill" }));
  progressBar.style.display = "none";
  const actions = el("div", { class: "tool-actions" });

  const checkBtn = el("button", {
    class: "btn btn-primary",
    onclick: () => checkForUpdates({ manual: true }),
  }, "Check for updates");
  actions.appendChild(checkBtn);

  root.appendChild(el("section", { class: "settings-card" },
    el("h3", {}, "Updates"),
    statusLine,
    progressBar,
    actions,
    el("p", { class: "muted small", style: "margin-top: 10px;" },
      "Updates are signed and delivered via GitHub Releases. The app checks on launch and prompts before installing.",
    ),
  ));

  // ===== About =====
  root.appendChild(el("section", { class: "settings-card" },
    el("h3", {}, "About"),
    el("p", {}, "S-Tier Utilities is a small Tauri desktop hub for native Windows utilities."),
    el("p", {},
      "Source: ",
      el("a", {
        href: "#",
        onclick: (e) => { e.preventDefault(); openExternal("https://github.com/S-Tier-Building-Automation/STierUtilities"); },
      }, "github.com/S-Tier-Building-Automation/STierUtilities"),
    ),
  ));

  // ===== Preferences =====
  root.appendChild(el("section", { class: "settings-card" },
    el("h3", {}, "Preferences"),
    el("p", { class: "muted small" },
      "Favorites and hidden tools are stored locally in this app.",
    ),
    el("button", {
      class: "btn-ghost",
      onclick: () => {
        if (!confirm("Reset all preferences (favorites, hidden tools, view)?")) return;
        localStorage.removeItem(STORAGE_KEY);
        userState.favorites = {};
        userState.hidden = {};
        userState.showHidden = false;
        userState.view = "library";
        saveUserState();
        renderAll();
      },
    }, "Reset preferences"),
  ));
}

// ============================================================================
// Updater
// ============================================================================

let updateInFlight = false;

function setUpdateStatus(text, kind = "info") {
  const node = document.getElementById("update-status");
  if (!node) return;
  node.textContent = text;
  node.className = `muted small update-status-${kind}`;
}

async function checkForUpdates({ manual = false, silent = false } = {}) {
  if (updateInFlight) return;
  updateInFlight = true;
  try {
    if (!silent) setUpdateStatus("Checking for updates…");
    const update = await updater.check();
    if (!update) {
      if (!silent) setUpdateStatus(`You're on the latest version (v${APP_VERSION}).`, "ok");
      return;
    }
    setUpdateStatus(`Update available: v${update.version}. Download will start when confirmed.`, "warn");

    const ok = confirm(
      `A new version is available.\n\n` +
      `Installed: v${APP_VERSION}\n` +
      `Latest:    v${update.version}\n\n` +
      (update.body ? `Notes:\n${update.body}\n\n` : "") +
      `Download and install now?`,
    );
    if (!ok) {
      setUpdateStatus(`Update v${update.version} available. Use "Check for updates" to install later.`, "warn");
      return;
    }

    // Show progress bar
    const bar = document.getElementById("update-progress");
    const fill = document.getElementById("update-progress-fill");
    if (bar) bar.style.display = "block";

    let downloaded = 0;
    let total = 0;
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength || 0;
        setUpdateStatus(`Downloading v${update.version}… 0%`);
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength || 0;
        if (total > 0 && fill) {
          const pct = Math.min(100, Math.round((downloaded / total) * 100));
          fill.style.width = `${pct}%`;
          setUpdateStatus(`Downloading v${update.version}… ${pct}%`);
        }
      } else if (event.event === "Finished") {
        setUpdateStatus("Installing… the app will relaunch.", "ok");
      }
    });

    // Installer should relaunch the app on Windows, but force it for safety.
    try {
      await tauriProcess.relaunch();
    } catch (_) {}
  } catch (err) {
    setUpdateStatus(`Update check failed: ${err}`, "error");
    if (manual) {
      alert(`Update check failed:\n${err}`);
    }
  } finally {
    updateInFlight = false;
  }
}

// ============================================================================
// Sidebar
// ============================================================================

function renderSidebar() {
  const favList = document.getElementById("sidebar-favorites");
  favList.replaceChildren();
  const favTools = TOOLS.filter((t) => isFavorite(t.id) && !isHidden(t.id));
  if (favTools.length === 0) {
    favList.appendChild(el("li", { class: "sidebar-empty" },
      "No favorites yet. Tap the star on a tool.",
    ));
  } else {
    for (const tool of favTools) {
      const active = currentPluginId() === tool.id;
      favList.appendChild(el("li", {
        class: `sidebar-fav ${active ? "active" : ""}`,
        onclick: () => setView(pluginView(tool.id)),
        title: tool.name,
      },
        el("span", { class: "sidebar-fav-icon" }, tool.emoji),
        el("span", { class: "sidebar-fav-name" }, tool.name),
      ));
    }
  }

  const view = currentView();
  for (const btn of document.querySelectorAll(".sidebar-nav-item")) {
    btn.classList.toggle(
      "active",
      btn.dataset.view === "library"
        ? (view === "library" || view.startsWith("plugin:"))
        : btn.dataset.view === view,
    );
  }
}

// ============================================================================
// Top-level render
// ============================================================================

function renderAll() {
  renderSidebar();
  const view = currentView();
  if (view === "settings") renderSettings();
  else if (view.startsWith("plugin:")) renderPluginPage(view.slice("plugin:".length));
  else renderLibrary();
}

// ============================================================================
// Tauri event wiring
// ============================================================================

listen("clipboardtyper:state", (event) => {
  ct = event.payload;
  ctPending = { ...ct.settings };
  renderAll();
});

listen("clipboardtyper:typed", (event) => {
  const { chars, error } = event.payload;
  if (error) logTo("clipboardtyper", `Typing failed: ${error}`, "error");
  else logTo("clipboardtyper", `Sent ${chars} char${chars === 1 ? "" : "s"} locally.`, "ok");
});

// ============================================================================
// Bootstrap
// ============================================================================

window.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("gh-link").addEventListener("click", (e) => {
    e.preventDefault();
    openExternal("https://github.com/stier1ba");
  });
  for (const btn of document.querySelectorAll(".sidebar-nav-item")) {
    btn.addEventListener("click", () => setView(btn.dataset.view));
  }

  try {
    const s = await invoke("clipboardtyper_get_state");
    ct = s;
    ctPending = { ...s.settings };
  } catch (err) {
    logTo("clipboardtyper", `Could not read state: ${err}`, "error");
  }

  // Load saved network profiles up front so the library card shows a count.
  // Live adapter state is read lazily when the Network Manager page opens.
  nmLoadProfiles().then(renderAll);

  renderAll();

  // Background update check on launch. Runs silently — only surfaces a
  // prompt when an update is found.
  setTimeout(() => { checkForUpdates({ silent: true }).catch(() => {}); }, 2500);
});
