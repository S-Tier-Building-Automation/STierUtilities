import { TOOL_MANIFESTS } from "./tools/manifests.js";
import { createKernel } from "./platform/host.js";
import { buildFactories } from "./tools/capabilities.js";
import { buildServiceCatalog } from "./platform/service-catalog.js";
import { createTimeseries } from "./platform/services/timeseries.js";
import { createScheduler } from "./platform/services/scheduler.js";
import { createPackController } from "./platform/services/pack-controller.js";
import { validateManifest } from "./platform/manifest.js";
import { grantsFromInstall, approveInstall } from "./platform/mcp-loader.js";
import { buildMcpFactories } from "./platform/services/mcp-client.js";

const { invoke, convertFileSrc } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const opener = window.__TAURI__.opener;
const updater = window.__TAURI__.updater;
const tauriProcess = window.__TAURI__.process;

const APP_VERSION = "0.5.4";

// ============================================================================
// Tool catalog — derived from manifests (the single source of truth) plus the
// per-tool UI renderers. The platform kernel boots from the same manifests, so
// "registering a tool" means adding a manifest, not editing this list.
// ============================================================================

// Renderers keyed by manifest id. The referenced functions are hoisted
// declarations defined later in this file.
const TOOL_RENDERERS = {
  clipboardtyper: { renderStatusPill: ctStatusPill, renderPage: renderClipboardTyperPage },
  heicmov: { renderStatusPill: hmStatusPill, renderPage: renderHeicMovPage },
  networkmanager: { renderStatusPill: nmStatusPill, renderPage: renderNetworkManagerPage },
  bacnet: { renderStatusPill: bacStatusPill, renderPage: renderBacnetPage },
  observability: { renderStatusPill: obsStatusPill, renderPage: renderObservabilityPage },
  "bacnet-historian": { renderStatusPill: histStatusPill, renderPage: renderHistorianPage },
};

// Map a manifest to a catalog entry. First-party tools use their dedicated
// renderer; installed kind:"mcp" tools get a generic MCP page.
function manifestToTool(m) {
  let renderers = TOOL_RENDERERS[m.id];
  if (!renderers && m.kind === "mcp") {
    renderers = { renderStatusPill: () => mcpStatusPill(m), renderPage: () => renderMcpToolPage(m) };
  }
  renderers = renderers || {};
  return {
    id: m.id,
    name: m.name,
    emoji: (m.ui && m.ui.emoji) || "🧩",
    tagline: (m.ui && m.ui.tagline) || "",
    description: (m.ui && m.ui.description) || "",
    repo: m.ui && m.ui.repo,
    manifest: m,
    ...renderers,
  };
}

// The full manifest set = first-party + installed third-party (mcp) tools, and
// the catalog derived from it. Both are rebuilt (rebuildCatalog) once user state
// is loaded and after any install/remove. The kernel boots from ALL_MANIFESTS.
let ALL_MANIFESTS = [...TOOL_MANIFESTS];
// The nav-facing catalog excludes headless services (e.g. bacnet-core): they
// provide capabilities and boot in the kernel — which reads ALL_MANIFESTS — but
// have no page, so they must not show up as empty, unclickable tiles. A tool is
// catalog-visible iff manifestToTool gave it a renderPage (apps + mcp tools).
let TOOLS = ALL_MANIFESTS.map(manifestToTool).filter((t) => t.renderPage);

function rebuildCatalog() {
  const installed = (userState.installedTools || []).filter((m) => validateManifest(m).valid);
  ALL_MANIFESTS = [...TOOL_MANIFESTS, ...installed];
  TOOLS = ALL_MANIFESTS.map(manifestToTool).filter((t) => t.renderPage);
}

function toolById(id) { return TOOLS.find((t) => t.id === id); }

// The platform kernel. Booted once in bootstrap(); tool pages reach shared
// capabilities through platformHost(toolId) once it's up.
let platform = null;
// The shared timeseries service instance (passed into the kernel factories so
// every tool writes to the same buffer/ring), the scheduler, and the
// Observability Pack controller.
let telemetry = null;
let scheduler = null;
let pack = null;

/** Scoped host for a tool's page, or null if the kernel isn't booted. */
function platformHost(toolId) {
  try { return platform ? platform.hostFor(toolId) : null; }
  catch (_) { return null; }
}

// ============================================================================
// Persistent UI state
// ============================================================================

const STORAGE_KEY = "microtools.user_state.v2";

const userState = loadUserState();
rebuildCatalog(); // fold installed third-party (mcp) tools into the catalog

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
    libraryView: stored.libraryView === "list" ? "list" : "grid",
    nmRailWidth: Number.isFinite(stored.nmRailWidth) ? stored.nmRailWidth : 240,
    view: typeof stored.view === "string" ? stored.view : "library",
    sidebarCollapsed: Boolean(stored.sidebarCollapsed),
    historian: stored.historian || null,
    installedTools: Array.isArray(stored.installedTools) ? stored.installedTools : [],
    installedGrants: stored.installedGrants || {},
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

function setLibraryView(view) {
  userState.libraryView = view === "list" ? "list" : "grid";
  saveUserState();
  renderLibrary();
}

function setView(view) {
  userState.view = view;
  saveUserState();
  renderAll();
}

function applySidebarCollapsed() {
  const app = document.querySelector(".app");
  if (app) app.classList.toggle("sidebar-collapsed", userState.sidebarCollapsed);
  const toggle = document.getElementById("sidebar-toggle");
  if (toggle) {
    toggle.setAttribute("aria-expanded", String(!userState.sidebarCollapsed));
    toggle.title = userState.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar";
  }
}

function setSidebarCollapsed(on) {
  userState.sidebarCollapsed = on;
  saveUserState();
  applySidebarCollapsed();
}

function currentView() {
  if (userState.view === "library" || userState.view === "settings" || userState.view === "services") {
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
  settings: { type_delay_ms: 60, modifier_hold_ms: 40, start_delay_ms: 40, trailing_tab: false, newline_as_tab: false, column_major: false, rules: [] },
};
// Deep-copy so editing pending rules doesn't mutate the last-applied state.
function ctClonePending(settings) {
  return { ...settings, rules: (settings.rules || []).map((r) => ({ ...r })) };
}
let ctPending = ctClonePending(ct.settings);

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
// App header (sidebar toggle + Files / Docs / Settings / About)
// ============================================================================

const REPO_URL = "https://github.com/S-Tier-Building-Automation/STierUtilities";

async function openAppDataDir() {
  try {
    await invoke("app_open_data_dir");
  } catch (err) {
    console.warn("openAppDataDir failed:", err);
    alert(`Could not open the app data folder:\n${err}`);
  }
}

// --- About popover ---

function aboutMenuEl() { return document.getElementById("about-menu"); }
function aboutBtnEl() { return document.getElementById("header-about"); }

function buildAboutMenu() {
  return el("div", { class: "header-menu", id: "about-menu", role: "menu", hidden: true },
    el("h4", {}, "S-Tier Utilities"),
    el("p", { class: "menu-ver" }, `Version ${APP_VERSION}`),
    el("button", {
      class: "btn btn-primary",
      onclick: () => { closeAboutMenu(); checkForUpdates({ manual: true }); },
    }, "Check for updates"),
    el("a", {
      class: "menu-link", href: "#",
      onclick: (e) => { e.preventDefault(); closeAboutMenu(); openExternal(REPO_URL); },
    }, "GitHub repository"),
  );
}

function onAboutOutside(e) {
  const m = aboutMenuEl();
  if (!m || m.hidden) return;
  if (m.contains(e.target) || aboutBtnEl()?.contains(e.target)) return;
  closeAboutMenu();
}
function onAboutKey(e) { if (e.key === "Escape") closeAboutMenu(); }

function openAboutMenu() {
  const m = aboutMenuEl();
  if (!m) return;
  m.hidden = false;
  aboutBtnEl()?.setAttribute("aria-expanded", "true");
  // Defer so the click that opened the menu doesn't immediately close it.
  setTimeout(() => {
    document.addEventListener("click", onAboutOutside, true);
    document.addEventListener("keydown", onAboutKey);
  }, 0);
}
function closeAboutMenu() {
  const m = aboutMenuEl();
  if (!m || m.hidden) return;
  m.hidden = true;
  aboutBtnEl()?.setAttribute("aria-expanded", "false");
  document.removeEventListener("click", onAboutOutside, true);
  document.removeEventListener("keydown", onAboutKey);
}
function toggleAboutMenu() {
  const m = aboutMenuEl();
  if (m && m.hidden) openAboutMenu();
  else closeAboutMenu();
}

// --- Generic modal (used for the per-tool "About" pop-out) ---
// One modal at a time: a backdrop overlay + centered card. Closes on the × button,
// a click on the backdrop (but not the card), or Escape.

let activeModal = null;

function closeModal() {
  if (!activeModal) return;
  document.removeEventListener("keydown", activeModal.onKey);
  activeModal.overlay.remove();
  activeModal = null;
}

function openModal({ title, body = [] } = {}) {
  closeModal(); // never stack
  const closeBtn = el("button", {
    class: "modal-close", title: "Close", "aria-label": "Close", onclick: closeModal,
  }, "×");
  const card = el("div",
    { class: "modal-card", role: "dialog", "aria-modal": "true", "aria-label": title || "Dialog" },
    el("div", { class: "modal-head" },
      el("h3", { class: "modal-title" }, title || ""),
      closeBtn,
    ),
    el("div", { class: "modal-body" }, ...(Array.isArray(body) ? body : [body])),
  );
  const overlay = el("div", {
    class: "modal-overlay",
    onclick: (e) => { if (e.target === e.currentTarget) closeModal(); },
  }, card);
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); closeModal(); } };
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
  activeModal = { overlay, onKey };
  closeBtn.focus(); // land keyboard focus inside the dialog
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

function ctSetTrailingTab(value) {
  ctPending.trailing_tab = value;
  ctPushSettings();
  logTo(
    "clipboardtyper",
    value ? "Trailing Tab on: a Tab is sent after the last cell." : "Trailing Tab off.",
    "info",
  );
  renderAll();
}

function ctSetNewlineAsTab(value) {
  ctPending.newline_as_tab = value;
  ctPushSettings();
  logTo(
    "clipboardtyper",
    value
      ? "New line → Tab on: line breaks advance with Tab (good for copied columns)."
      : "New line → Tab off: line breaks press Enter.",
    "info",
  );
  renderAll();
}

function ctSetColumnMajor(value) {
  ctPending.column_major = value;
  ctPushSettings();
  logTo(
    "clipboardtyper",
    value
      ? "Column order on: a copied block types each column top-to-bottom (Tab-separated)."
      : "Column order off: types in Excel's left-to-right, row-by-row order.",
    "info",
  );
  renderAll();
}

function ctAddRule() {
  ctPending.rules = [...(ctPending.rules || []), { match: "", output: "" }];
  ctPushSettings();
  renderAll();
}

function ctRemoveRule(index) {
  ctPending.rules = (ctPending.rules || []).filter((_, i) => i !== index);
  ctPushSettings();
  renderAll();
}

// Live-edit of a rule field. No renderAll here — that would recreate the input
// and steal focus mid-keystroke; the state echo is also suppressed (see listener).
function ctUpdateRule(index, field, value) {
  if (!ctPending.rules || !ctPending.rules[index]) return;
  ctPending.rules[index][field] = value;
  ctPushSettings();
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
      el("h3", {}, "Behavior"),
      el("label",
        { class: `toggle ${ctPending.trailing_tab ? "toggle-on" : ""}` },
        el("input", {
          type: "checkbox",
          checked: ctPending.trailing_tab ? "checked" : undefined,
          onchange: (e) => ctSetTrailingTab(e.target.checked),
        }),
        el("span", { class: "toggle-track" }, el("span", { class: "toggle-knob" })),
        el("span", { class: "toggle-label" }, "Trailing Tab"),
      ),
      el("p", { class: "muted small" },
        "Press Tab once more after the last cell, so you can type a copied Excel ",
        "row and land on the next field (or next row) without advancing manually.",
      ),
      el("label",
        { class: `toggle ${ctPending.newline_as_tab ? "toggle-on" : ""}` },
        el("input", {
          type: "checkbox",
          checked: ctPending.newline_as_tab ? "checked" : undefined,
          onchange: (e) => ctSetNewlineAsTab(e.target.checked),
        }),
        el("span", { class: "toggle-track" }, el("span", { class: "toggle-knob" })),
        el("span", { class: "toggle-label" }, "New line → Tab"),
      ),
      el("p", { class: "muted small" },
        "Treat line breaks as a Tab instead of Enter. A column copied from Excel is ",
        "new-line separated (no tabs), so turn this on to advance field-to-field.",
      ),
      el("label",
        { class: `toggle ${ctPending.column_major ? "toggle-on" : ""}` },
        el("input", {
          type: "checkbox",
          checked: ctPending.column_major ? "checked" : undefined,
          onchange: (e) => ctSetColumnMajor(e.target.checked),
        }),
        el("span", { class: "toggle-track" }, el("span", { class: "toggle-knob" })),
        el("span", { class: "toggle-label" }, "Column order (top → bottom)"),
      ),
      el("p", { class: "muted small" },
        "When you copy a block of several columns, type each column top-to-bottom ",
        "instead of Excel's left-to-right, row-by-row order. Values are Tab-separated, ",
        "so this covers the \"New line → Tab\" case on its own.",
      ),
    ),

    el("section", { class: "plugin-section" },
      el("h3", {}, "Cell Rules"),
      el("p", { class: "muted small rule-tokens" },
        "When a cell matches (case-insensitive), send the output instead of typing it. ",
        "Output can mix text with key tokens: ",
        el("code", {}, "{space}"), " ", el("code", {}, "{tab}"), " ", el("code", {}, "{enter}"), " ",
        el("code", {}, "{esc}"), " ", el("code", {}, "{up}"), " ", el("code", {}, "{down}"), " ",
        el("code", {}, "{left}"), " ", el("code", {}, "{right}"), " ", el("code", {}, "{bksp}"), " ",
        el("code", {}, "{del}"), ". Leave the output blank to skip the cell (just advance).",
      ),
      ...(ctPending.rules || []).map((rule, i) =>
        el("div", { class: "rule-row" },
          el("input", {
            type: "text",
            class: "rule-input rule-match",
            placeholder: "when cell is…",
            value: rule.match ?? "",
            oninput: (e) => ctUpdateRule(i, "match", e.target.value),
          }),
          el("span", { class: "rule-arrow" }, "→"),
          el("input", {
            type: "text",
            class: "rule-input rule-output",
            placeholder: "send instead (e.g. {space})",
            value: rule.output ?? "",
            oninput: (e) => ctUpdateRule(i, "output", e.target.value),
          }),
          el("button", { class: "btn btn-ghost rule-remove", title: "Remove rule", onclick: () => ctRemoveRule(i) }, "✕"),
        ),
      ),
      el("button", { class: "btn btn-ghost", onclick: ctAddRule }, "+ Add rule"),
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
  selectedId: null,        // selected profile id (mutually exclusive with selectedAdapter)
  selectedAdapter: null,   // selected adapter name, when inspecting a live NIC
  stateByAdapter: {},      // adapterName -> AdapterNetworkState
  matchById: {},           // profileId -> ProfileMatchResult
  busy: false,
  busyLabel: "",
  loaded: false,           // adapters/state read at least once this session
  tab: "configure",        // "configure" (merged adapters+profiles) | "scan"
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
  nm.selectedAdapter = null;
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
  nm.selectedAdapter = null;
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
  if (nm.selectedId === id && !nm.selectedAdapter) return;
  nm.selectedId = id;
  nm.selectedAdapter = null;
  renderAll();
}

// Select a live adapter (shows its detail in the config panel). Mutually
// exclusive with a profile selection.
function nmSelectAdapter(name) {
  if (nm.selectedAdapter === name) return;
  nm.selectedAdapter = name;
  nm.selectedId = null;
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
  const rail = document.getElementById("nm-config-rail");
  if (rail) rail.replaceChildren(...nmConfigRailContent());
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
    nm.selectedAdapter = null;   // show the new profile's editor in the config panel
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

// Active / Drift / Idle status for a profile, derived from its live-match result:
// Active = currently applied; Drift = its target adapter is present but live config
// differs; Idle = no present target adapter.
function nmProfileStatus(p) {
  if (nmMatch(p).isMatch) return { dot: "nm-dot-active", label: "Active", cls: "nm-nic-active" };
  const present = nm.adapters.some((a) => a.name === p.adapterName && a.status !== "Not Present");
  return present
    ? { dot: "nm-dot-drift", label: "Drift", cls: "nm-state-drift" }
    : { dot: "nm-dot-idle", label: "Idle", cls: "muted" };
}

// A profile row in the grouped config rail (the adapter it targets is implied by
// its group, so the row only carries name + status).
function nmRailProfileRow(p) {
  const active = !nm.selectedAdapter && p.id === nm.selectedId;
  const s = nmProfileStatus(p);
  return el("div", {
    class: `nm-rail-profile ${active ? "selected" : ""}`,
    role: "button",
    tabindex: "0",
    title: p.name || "(unnamed)",
    "aria-pressed": active ? "true" : "false",
    onclick: () => nmSelect(p.id),
    onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); nmSelect(p.id); } },
  },
    el("span", { class: `nm-rail-dot ${s.dot}`, "aria-hidden": "true" }),
    el("span", { class: "nm-rail-pname" }, p.name || "(unnamed)"),
    el("span", { class: `nm-rail-pstate small ${s.cls}` }, s.label),
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
      // Static scroll wrapper; refresh swaps the inner <table> in place (no re-nesting).
      el("div", { class: "table-scroll" }, table),
    ),
  );
}

function nmTabBar() {
  const tab = (id, label) => el("button", {
    class: `nm-tab ${nm.tab === id ? "nm-tab-active" : ""}`,
    onclick: () => { nm.tab = id; renderAll(); },
  }, label);
  return el("div", { class: "nm-tabs" },
    tab("configure", "Configure"),
    tab("scan", "Scan"),
  );
}

// ---- resizable rail (the splitter between the rail and the config panel) ----

function nmRailWidthPx() {
  return Math.max(180, Math.min(440, userState.nmRailWidth || 240));
}
function nmSetRailWidth(px, persist) {
  userState.nmRailWidth = Math.max(180, Math.min(440, Math.round(px)));
  const md = document.getElementById("nm-config-md");
  if (md) md.style.gridTemplateColumns = `${userState.nmRailWidth}px 8px minmax(0, 1fr)`;
  const sep = document.getElementById("nm-splitter");
  if (sep) sep.setAttribute("aria-valuenow", String(userState.nmRailWidth));
  if (persist) saveUserState();
}
// Track the drag on window so it survives the pointer leaving the handle.
// Pointer capture + a pointercancel teardown guard against a "stuck" drag if the
// matching pointerup is ever lost (alt-tab, OS cancel).
function nmStartRailDrag(e) {
  e.preventDefault();
  const startX = e.clientX;
  const startW = nmRailWidthPx();
  const handle = e.currentTarget;
  try { handle.setPointerCapture(e.pointerId); } catch (_) { /* not fatal */ }
  document.body.classList.add("nm-resizing");
  const onMove = (ev) => nmSetRailWidth(startW + (ev.clientX - startX), false);
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    document.body.classList.remove("nm-resizing");
    try { handle.releasePointerCapture(e.pointerId); } catch (_) { /* already released */ }
    saveUserState();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}
function nmRailKeyResize(e) {
  if (e.key === "ArrowLeft") { e.preventDefault(); nmSetRailWidth(nmRailWidthPx() - 16, true); }
  else if (e.key === "ArrowRight") { e.preventDefault(); nmSetRailWidth(nmRailWidthPx() + 16, true); }
}

// ---- merged Configure view (adapters + profiles, master/detail) ----

// The grouped rail: each present adapter is a header (selectable → live detail)
// with its saved profiles nested beneath; profiles whose target adapter isn't
// present fall into an "Other" group.
function nmConfigRailContent() {
  const children = [];
  const present = nm.adapters.filter((a) => a.status !== "Not Present");
  const byAdapter = new Map();
  for (const p of nm.profiles) {
    const key = p.adapterName || "";
    if (!byAdapter.has(key)) byAdapter.set(key, []);
    byAdapter.get(key).push(p);
  }
  for (const a of present) {
    children.push(nmRailAdapterHeader(a));
    for (const p of (byAdapter.get(a.name) || [])) children.push(nmRailProfileRow(p));
    byAdapter.delete(a.name);
  }
  const others = [];
  for (const ps of byAdapter.values()) others.push(...ps);
  if (others.length) {
    children.push(el("div", { class: "nm-rail-other-head" }, "Other profiles"));
    for (const p of others) children.push(nmRailProfileRow(p));
  }
  if (!children.length) {
    children.push(el("p", { class: "muted small nm-rail-empty" },
      nm.loaded ? "No adapters or profiles yet." : "Reading adapters…"));
  }
  return children;
}

function nmRailAdapterHeader(a) {
  const st = nm.stateByAdapter[a.name];
  const selected = nm.selectedAdapter === a.name;
  return el("div", { class: `nm-rail-adapter ${selected ? "selected" : ""}` },
    el("div", { class: "nm-rail-adapter-head" },
      // The name is the selectable region; Save is a SIBLING (not a nested button),
      // so keyboard Enter/Space on Save can't trigger the adapter selection.
      el("span", {
        class: "nm-rail-adapter-name",
        role: "button",
        tabindex: "0",
        title: a.description || a.name,
        "aria-pressed": selected ? "true" : "false",
        onclick: () => nmSelectAdapter(a.name),
        onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); nmSelectAdapter(a.name); } },
      }, a.name),
      el("button", {
        class: "btn-ghost nm-rail-save",
        title: "Save this adapter as a profile",
        "aria-label": `Save ${a.name} as a profile`,
        disabled: nm.busy ? "disabled" : undefined,
        onclick: () => nmCaptureAdapter(a.name),
      }, "Save"),
    ),
    el("div", { class: "nm-rail-summary" },
      st ? `IPv4 ${nmIpv4Summary(st)} · gw ${st.gateway || "none"}` : (nm.loaded ? "no live state" : "reading…")),
  );
}

// Config panel when a live adapter (not a profile) is selected.
function nmAdapterDetail(a) {
  const st = nm.stateByAdapter[a.name];
  const matching = nm.profiles.filter((p) => p.adapterName === a.name);
  const profilesList = el("div", { class: "nm-rail-list" });
  if (matching.length) for (const p of matching) profilesList.appendChild(nmRailProfileRow(p));
  else profilesList.appendChild(el("p", { class: "muted small" }, "No profiles yet — save this adapter to make one."));

  return el("div", { class: "nm-editor-pane" },
    el("div", { class: "nm-editor-head" },
      el("h3", { class: "nm-editor-title" }, a.name),
      el("div", { class: "nm-editor-actions" },
        el("button", {
          class: "btn btn-primary",
          disabled: nm.busy ? "disabled" : undefined,
          onclick: () => nmCaptureAdapter(a.name),
        }, "Save as profile"),
      ),
    ),
    el("section", { class: "plugin-section" },
      el("h3", {}, "Live adapter"),
      el("p", { class: "muted small" }, a.description || ""),
      el("div", { class: "muted small" }, `Status: ${a.status}`),
      el("div", { class: "muted small" }, st ? `IPv4 ${nmIpv4Summary(st)}` : "No live snapshot — use Refresh adapters."),
      st ? el("div", { class: "muted small" }, `Gateway ${st.gateway || "none"} · DNS ${nmDnsSummary(st)}`) : null,
    ),
    el("section", { class: "plugin-section" },
      el("h3", {}, "Profiles for this adapter"),
      profilesList,
    ),
  );
}

function nmConfigEmpty() {
  return el("div", { class: "nm-editor-pane nm-editor-empty" },
    el("div", { class: "nm-empty" },
      el("p", { class: "nm-empty-title" }, "Select an adapter or profile"),
      el("p", { class: "muted small" },
        "Pick a NIC on the left to see its live config and save it as a profile, or pick a profile to edit and apply it."),
    ),
  );
}

function nmConfigureTab() {
  const railList = el("div", { id: "nm-config-rail", class: "nm-rail-list" }, ...nmConfigRailContent());
  const rail = el("div", { class: "nm-rail" },
    railList,
    el("button", {
      class: "btn btn-primary nm-new-btn",
      disabled: nm.busy ? "disabled" : undefined,
      onclick: nmNew,
    }, "+ New profile"),
  );

  let panel;
  if (nm.selectedAdapter) {
    const a = nm.adapters.find((x) => x.name === nm.selectedAdapter);
    panel = a ? nmAdapterDetail(a) : nmConfigEmpty();
  } else {
    const sel = nmSelected();
    panel = sel ? el("div", { class: "nm-editor-pane" }, ...nmEditorContent(sel)) : nmConfigEmpty();
  }

  const splitter = el("div", {
    id: "nm-splitter",
    class: "nm-splitter",
    role: "separator",
    tabindex: "0",
    "aria-orientation": "vertical",
    "aria-label": "Resize the configuration panel",
    "aria-valuemin": "180",
    "aria-valuemax": "440",
    "aria-valuenow": String(nmRailWidthPx()),
    title: "Drag to resize · double-click to reset",
    onpointerdown: nmStartRailDrag,
    ondblclick: () => nmSetRailWidth(240, true),
    onkeydown: nmRailKeyResize,
  });

  const md = el("div", { id: "nm-config-md", class: "nm-config-md" }, rail, splitter, panel);
  md.style.gridTemplateColumns = `${nmRailWidthPx()}px 8px minmax(0, 1fr)`;

  return el("div", { class: "plugin-controls" },
    el("div", { class: "nm-config-head" },
      el("button", {
        class: "btn-ghost",
        disabled: nm.busy ? "disabled" : undefined,
        onclick: nmRefresh,
      }, nm.busy ? "Reading…" : "Refresh adapters"),
    ),
    md,
  );
}

function renderNetworkManagerPage() {
  nmEnsureLoaded();
  const body = nm.tab === "scan" ? nmScanTab() : nmConfigureTab();
  return el("div", { class: "plugin-controls nm-root" },
    nmTabBar(),
    body,
  );
}


// ============================================================================
// BACnet Explorer (status pill + page)
// ============================================================================

let bac = {
  discovering: false,
  devices: [],            // BacnetDevice[] from the backend (key, address, instance, …)
  deviceFilter: "",       // free-text over instance/name/address/vendor/model
  deviceSortKey: "instance", // "instance" | "name" | "address" | "vendor" | "model"
  deviceSortDir: "asc",
  selectedDeviceKey: null,
  objects: [],            // BacnetObject[] for the selected device
  objectsLoading: false,
  objectsProgress: null,  // { done, total } during index-by-index walks
  objectFilter: "",
  selectedObjectKey: null, // "type:instance"
  props: [],              // PropertyEntry[] for the selected object
  propsLoading: false,
  cov: { processId: null, objectKey: null, busy: false, updates: 0, lastAt: null },
  trend: { loading: false, records: [], recordCount: 0, truncated: false, objectKey: null, max: "200" },
  write: { propertyId: "85", kind: "real", value: "", priority: "", arrayIndex: "" },
  target: "255.255.255.255",
  lowLimit: "",
  highLimit: "",
  listenersReady: false,
};

function bacStatusPill() {
  if (bac.discovering) return { label: "Discovering…", cls: "pill-running" };
  const n = bac.devices.length;
  if (n === 0) return { label: "Idle", cls: "pill-idle" };
  return { label: `${n} device${n === 1 ? "" : "s"}`, cls: "pill-muted" };
}

function bacSelectedDevice() {
  return bac.devices.find((d) => d.key === bac.selectedDeviceKey) || null;
}

// The DeviceRef the backend needs to reach a device (router addressing included).
function bacDeviceRef(d) {
  return { address: d.address, network: d.network ?? null, mac: d.mac ?? null };
}

function bacObjectKey(o) { return `${o.objectType}:${o.instance}`; }

function bacSelectedObject() {
  return bac.objects.find((o) => bacObjectKey(o) === bac.selectedObjectKey) || null;
}

function bacDeviceLabel(d) {
  const route = d.network != null ? ` · net ${d.network}` : "";
  return `${d.name || `device ${d.instance}`} (${d.instance})${route}`;
}

// ---- events ----

function bacEnsureListeners() {
  if (bac.listenersReady) return;
  bac.listenersReady = true;
  listen("bacnet:device", (e) => {
    const d = e.payload;
    if (!bac.devices.some((x) => x.key === d.key)) bac.devices.push(d);
    bacScheduleDevicesRender();
  });
  listen("bacnet:device_update", (e) => {
    const d = e.payload;
    const i = bac.devices.findIndex((x) => x.key === d.key);
    if (i >= 0) bac.devices[i] = d;
    else bac.devices.push(d);
    bacScheduleDevicesRender();
  });
  listen("bacnet:objects_progress", (e) => {
    bac.objectsProgress = e.payload;
    const node = document.getElementById("bac-objects-status");
    if (node) node.textContent = `Walking object-list… ${e.payload.done}/${e.payload.total}`;
  });
  listen("bacnet:object_names", (e) => {
    // Names stream from a detached pass; ignore batches for a device we've
    // already navigated away from.
    if (!e.payload || e.payload.deviceKey !== bac.selectedDeviceKey) return;
    const map = new Map((e.payload.names || []).map((x) => [x.key, x.name]));
    for (const o of bac.objects) {
      const n = map.get(bacObjectKey(o));
      if (n) o.name = n;
    }
    bacApplyObjectFilter();
  });
  listen("bacnet:cov", (e) => {
    const p = e.payload;
    if (!p) return;
    // Only apply notifications for the subscription we're currently showing.
    if (p.processId !== bac.cov.processId) return;
    if (`${p.objectType}:${p.instance}` !== bac.cov.objectKey) return;
    // Skip while the property grid is mid-rebuild (a re-read cleared bac.props);
    // applying now would bump the counter against rows that aren't there yet.
    if (bac.propsLoading || bac.props.length === 0) return;
    bac.cov.updates += 1;
    bac.cov.lastAt = Date.now();
    bacApplyCovUpdate(p.values || []);
  });
}

// ---- actions ----

// Inter-tool dependency in action: BACnet Explorer borrows Network Manager's
// subnet scanner (the `netscan` capability) to find live hosts to aim discovery
// at — instead of reimplementing an ICMP sweep. Only offered when the kernel
// resolved the optional dependency, so it degrades cleanly if Network Manager
// is unavailable.
async function bacSuggestTargets() {
  const netscan = platformHost("bacnet")?.tryUse("netscan.v1");
  if (!netscan) { logTo("bacnet", "Network scan capability unavailable.", "warn"); return; }
  if (!nm.loaded) { try { await nmRefresh(); } catch (_) {} }
  let subnet = null;
  for (const a of nm.adapters) {
    const s = nmScanSubnetFor(a.name);
    if (s) { subnet = s; break; }
  }
  if (!subnet) { logTo("bacnet", "No adapter with a scannable IPv4 subnet to search.", "warn"); return; }
  logTo("bacnet", `Scanning ${subnet.network}/${subnet.prefix} for live hosts (via Network Manager)…`, "info");
  try {
    const result = await netscan.scan(`${subnet.ip}/${subnet.prefix}`);
    const hosts = result?.hosts || [];
    if (hosts.length === 0) { logTo("bacnet", "No live hosts found on the subnet.", "warn"); return; }
    const preview = hosts.slice(0, 12).map((h) => h.ip).join(", ");
    logTo("bacnet", `Found ${hosts.length} live host${hosts.length === 1 ? "" : "s"}: ${preview}${hosts.length > 12 ? "…" : ""}`, "ok");
  } catch (err) {
    logTo("bacnet", `Host scan failed: ${err}`, "error");
  }
}

// The Explorer consumes the extracted bacnet-core service for the two operations
// in the reusable bacnet.read contract (discovery + point reads). If the kernel
// didn't boot, it falls back to direct backend calls so the Explorer still works
// — the platform must never take the UI down.
function bacnetRead() {
  const cap = platformHost("bacnet")?.tryUse("bacnet.read.v1");
  if (cap) return cap;
  return {
    listDevices: (o = {}) => invoke("bacnet_discover", {
      target: o.target ?? null, lowLimit: o.lowLimit ?? null,
      highLimit: o.highLimit ?? null, durationMs: o.durationMs ?? null,
    }),
    readPoint: (device, objectType, instance) =>
      invoke("bacnet_read_properties", { device, objectType, instance }),
  };
}

async function bacDiscover() {
  if (bac.discovering) return;
  bacEnsureListeners();
  if (bac.cov.processId != null) await bacCovStop();
  bac.discovering = true;
  bac.devices = [];
  bac.selectedDeviceKey = null;
  bac.objects = [];
  bac.selectedObjectKey = null;
  bac.props = [];
  renderAll();
  const low = parseInt(bac.lowLimit, 10);
  const high = parseInt(bac.highLimit, 10);
  try {
    const devices = await bacnetRead().listDevices({
      target: bac.target.trim() || null,
      lowLimit: Number.isFinite(low) ? low : null,
      highLimit: Number.isFinite(high) ? high : null,
      durationMs: null,
    });
    bac.devices = devices;
    logTo("bacnet", `Discovery finished — ${devices.length} device${devices.length === 1 ? "" : "s"}.`, devices.length ? "ok" : "warn");
  } catch (err) {
    logTo("bacnet", `Discovery failed: ${err}`, "error");
  } finally {
    bac.discovering = false;
    renderAll();
  }
}

async function bacSelectDevice(key) {
  if (bac.selectedDeviceKey === key) return;
  if (bac.cov.processId != null) await bacCovStop();
  bac.selectedDeviceKey = key;
  bac.objects = [];
  bac.selectedObjectKey = null;
  bac.props = [];
  bac.objectFilter = "";
  const dev = bacSelectedDevice();
  if (!dev) { renderAll(); return; }
  bac.objectsLoading = true;
  bac.objectsProgress = null;
  renderAll();
  try {
    const objects = await invoke("bacnet_read_objects", {
      device: bacDeviceRef(dev),
      deviceInstance: dev.instance,
    });
    // A faster click may have switched devices while this was in flight; don't
    // overwrite the newer selection with stale results.
    if (bac.selectedDeviceKey !== key) return;
    bac.objects = objects;
    logTo("bacnet", `Read ${bac.objects.length} objects from ${bacDeviceLabel(dev)}.`, "ok");
  } catch (err) {
    if (bac.selectedDeviceKey !== key) return;
    logTo("bacnet", `Object list failed for ${bacDeviceLabel(dev)}: ${err}`, "error");
  } finally {
    if (bac.selectedDeviceKey === key) {
      bac.objectsLoading = false;
      bac.objectsProgress = null;
      renderAll();
    }
  }
}

async function bacSelectObject(key) {
  // Drop any live subscription tied to the previously-viewed object.
  if (bac.cov.processId != null && bac.cov.objectKey !== key) await bacCovStop();
  if (bac.trend.objectKey !== key) {
    bac.trend = { loading: false, records: [], recordCount: 0, truncated: false, objectKey: null, max: bac.trend.max };
  }
  bac.selectedObjectKey = key;
  bac.props = [];
  const dev = bacSelectedDevice();
  const obj = bacSelectedObject();
  if (!dev || !obj) { renderAll(); return; }
  bac.propsLoading = true;
  renderAll();
  try {
    const props = await bacnetRead().readPoint(
      bacDeviceRef(dev), obj.objectType, obj.instance,
    );
    // Guard against a newer object selection resolving first.
    if (bac.selectedObjectKey !== key) return;
    bac.props = props;
  } catch (err) {
    if (bac.selectedObjectKey !== key) return;
    logTo("bacnet", `Property read failed for ${obj.typeName}:${obj.instance}: ${err}`, "error");
  } finally {
    if (bac.selectedObjectKey === key) {
      bac.propsLoading = false;
      renderAll();
    }
  }
}

async function bacRefreshProps() {
  const key = bac.selectedObjectKey;
  bac.selectedObjectKey = null; // force re-select to re-read
  await bacSelectObject(key);
}

// ---- COV (live values) ----

function bacCovActive() {
  return bac.cov.processId != null && bac.cov.objectKey === bac.selectedObjectKey;
}

// Tear down any live subscription (fire-and-forget the cancel to the device).
async function bacCovStop() {
  const { processId, objectKey } = bac.cov;
  if (processId == null) return;
  const dev = bacSelectedDevice();
  bac.cov = { processId: null, objectKey: null, busy: false, updates: 0, lastAt: null };
  if (dev && objectKey) {
    const [t, i] = objectKey.split(":").map((n) => parseInt(n, 10));
    try {
      await invoke("bacnet_unsubscribe_cov", {
        device: bacDeviceRef(dev), objectType: t, instance: i, processId,
      });
    } catch (_) { /* device drops us at lifetime expiry anyway */ }
  }
}

async function bacToggleCov() {
  if (bacCovActive()) {
    await bacCovStop();
    logTo("bacnet", "Stopped COV subscription.", "info");
    renderAll();
    return;
  }
  const dev = bacSelectedDevice();
  const obj = bacSelectedObject();
  if (!dev || !obj) return;
  // Replace any subscription on a previous object.
  if (bac.cov.processId != null) await bacCovStop();
  bac.cov.busy = true;
  renderAll();
  try {
    const processId = await invoke("bacnet_subscribe_cov", {
      device: bacDeviceRef(dev),
      deviceInstance: dev.instance,
      objectType: obj.objectType,
      instance: obj.instance,
      confirmed: false,
    });
    bac.cov = { processId, objectKey: bacObjectKey(obj), busy: false, updates: 0, lastAt: null };
    logTo("bacnet", `Subscribed to COV on ${obj.typeName}:${obj.instance} (live values).`, "ok");
  } catch (err) {
    bac.cov.busy = false;
    logTo("bacnet", `COV subscribe failed for ${obj.typeName}:${obj.instance}: ${err}`, "error");
  }
  renderAll();
}

// Patch the property rows a COV notification touched, in place, and flash them.
function bacApplyCovUpdate(values) {
  if (currentPluginId() !== "bacnet") return;
  for (const v of values) {
    const row = bac.props.find((p) => p.id === v.id);
    if (row) { row.display = v.display; row.values = v.values; row.error = v.error; }
  }
  const body = document.getElementById("bac-props-body");
  if (body) body.replaceChildren(...bacPropRows(new Set(values.map((v) => v.id))));
  const badge = document.getElementById("bac-cov-badge");
  if (badge) badge.textContent = `live · ${bac.cov.updates} update${bac.cov.updates === 1 ? "" : "s"}`;
}

// Builds the typed value payload the backend expects ({ kind, ... }).
// Integer kinds use Number.isSafeInteger so a value past 2^53 is rejected
// rather than silently rounded to a different integer before it's written.
function bacBuildWriteValue() {
  const kind = bac.write.kind;
  const raw = bac.write.value.trim();
  // An empty field must never silently become 0 — writing 0 to a live setpoint
  // is dangerous. Only Null (no value) and an intentional empty string are ok.
  if (raw === "" && kind !== "null" && kind !== "characterString") {
    throw new Error("Enter a value to write.");
  }
  const safeInt = (allowNegative) => {
    const v = Number(raw);
    if (!Number.isInteger(v) || (!allowNegative && v < 0)) {
      throw new Error(`"${raw}" is not ${allowNegative ? "an integer" : "a non-negative integer"}`);
    }
    if (!Number.isSafeInteger(v)) {
      throw new Error(`"${raw}" is too large to enter precisely (max ${Number.MAX_SAFE_INTEGER})`);
    }
    return v;
  };
  switch (kind) {
    case "null": return { kind: "null" };
    case "real": {
      const v = Number(raw);
      if (!Number.isFinite(v)) throw new Error(`"${raw}" is not a number`);
      return { kind: "real", value: v };
    }
    case "unsigned": return { kind: "unsigned", value: safeInt(false) };
    case "signed": return { kind: "signed", value: safeInt(true) };
    case "enumerated": return { kind: "enumerated", value: safeInt(false) };
    case "boolean": {
      const t = raw.toLowerCase();
      if (!["true", "false", "1", "0", "active", "inactive"].includes(t)) {
        throw new Error(`"${raw}" is not a boolean (use true/false)`);
      }
      return { kind: "boolean", value: t === "true" || t === "1" || t === "active" };
    }
    case "characterString": return { kind: "characterString", value: bac.write.value };
    default: throw new Error(`unsupported type ${kind}`);
  }
}

async function bacWrite(relinquish = false) {
  const dev = bacSelectedDevice();
  const obj = bacSelectedObject();
  if (!dev || !obj) return;
  const propertyId = parseInt(bac.write.propertyId, 10);
  if (!Number.isInteger(propertyId)) {
    logTo("bacnet", "Pick a property number to write.", "warn");
    return;
  }
  const priority = bac.write.priority === "" ? null : parseInt(bac.write.priority, 10);
  if (relinquish && priority == null) {
    logTo("bacnet", "Relinquish needs a priority (the slot to release).", "warn");
    return;
  }
  const arrayIndex = bac.write.arrayIndex === "" ? null : parseInt(bac.write.arrayIndex, 10);
  let value;
  try {
    value = relinquish ? { kind: "null" } : bacBuildWriteValue();
  } catch (err) {
    logTo("bacnet", `Invalid value: ${err.message}`, "warn");
    return;
  }
  const what = relinquish
    ? `relinquish p${priority}`
    : `write ${JSON.stringify(value)}${priority != null ? ` @ p${priority}` : ""}`;
  try {
    await invoke("bacnet_write_property", {
      device: bacDeviceRef(dev),
      objectType: obj.objectType,
      instance: obj.instance,
      property: propertyId,
      value,
      priority,
      arrayIndex,
    });
    logTo("bacnet", `OK — ${what} on ${obj.typeName}:${obj.instance}.`, "ok");
    await bacRefreshProps();
  } catch (err) {
    logTo("bacnet", `Write failed on ${obj.typeName}:${obj.instance}: ${err}`, "error");
  }
}

// ---- live render helpers (in-place, no focus stealing) ----

// Coalesce bursts of device events (hundreds can arrive in one discovery
// window) into at most ~7 table rebuilds per second.
let bacDevicesRenderTimer = null;
function bacScheduleDevicesRender() {
  if (bacDevicesRenderTimer) return;
  bacDevicesRenderTimer = setTimeout(() => {
    bacDevicesRenderTimer = null;
    bacRenderDevicesLive();
  }, 150);
}

function bacRenderDevicesLive() {
  if (currentPluginId() !== "bacnet") return;
  const body = document.getElementById("bac-device-rows");
  if (body) body.replaceChildren(...bacDeviceRows());
  const count = document.getElementById("bac-device-count");
  if (count) count.textContent = bacDeviceCountText();
}

// Vendor/model display string, matching the table cells (so filter + export
// see the same text the user sees).
function bacVendorText(d) { return d.vendorName || (d.vendorId ? `vendor ${d.vendorId}` : ""); }
function bacAddressText(d) {
  return d.network != null ? `${d.address} → net ${d.network}/${d.mac || "?"}` : d.address;
}

// Hosts narrowed by the free-text filter (case-insensitive substring over
// instance, name, address, vendor, model). Empty filter returns all devices.
function bacFilteredDevices() {
  const q = bac.deviceFilter.trim().toLowerCase();
  if (!q) return bac.devices;
  return bac.devices.filter((d) =>
    String(d.instance).includes(q) ||
    (d.name || "").toLowerCase().includes(q) ||
    bacAddressText(d).toLowerCase().includes(q) ||
    bacVendorText(d).toLowerCase().includes(q) ||
    (d.modelName || "").toLowerCase().includes(q));
}

// Sort devices by the active column/direction. instance/maxApdu compare
// numerically; text columns compare case-insensitively with blanks pinned
// last; instance is the stable tiebreaker.
function bacSortedDevices(devices) {
  const { deviceSortKey: key, deviceSortDir: dir } = bac;
  const sign = dir === "desc" ? -1 : 1;
  const byInst = (a, b) => (a.instance || 0) - (b.instance || 0);
  const textOf = (d) =>
    key === "name" ? (d.name || "")
    : key === "address" ? bacAddressText(d)
    : key === "vendor" ? bacVendorText(d)
    : key === "model" ? (d.modelName || "")
    : "";
  return devices.slice().sort((a, b) => {
    if (key === "instance") return byInst(a, b) * sign;
    const av = textOf(a).toLowerCase();
    const bv = textOf(b).toLowerCase();
    if (!av && !bv) return byInst(a, b);
    if (!av) return 1;
    if (!bv) return -1;
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return (cmp || byInst(a, b)) * sign;
  });
}

function bacVisibleDevices() { return bacSortedDevices(bacFilteredDevices()); }

function bacDeviceCountText() {
  const total = bac.devices.length;
  if (bac.discovering) return `Listening… ${total} device${total === 1 ? "" : "s"} so far`;
  if (bac.deviceFilter.trim()) return `${bacFilteredDevices().length} of ${total} shown`;
  return `${total} device${total === 1 ? "" : "s"}`;
}

// Re-render just the device rows + count in place (so typing in the filter
// or clicking a sort header never rebuilds the page and steals input focus).
function bacApplyDeviceView() {
  if (currentPluginId() !== "bacnet") return;
  const tbl = document.getElementById("bac-device-table");
  if (tbl) tbl.replaceWith(bacDeviceTableEl());
  const count = document.getElementById("bac-device-count");
  if (count) count.textContent = bacDeviceCountText();
}

function bacSetDeviceSort(key) {
  if (bac.deviceSortKey === key) bac.deviceSortDir = bac.deviceSortDir === "asc" ? "desc" : "asc";
  else { bac.deviceSortKey = key; bac.deviceSortDir = "asc"; }
  bacApplyDeviceView();
}

// CSV of the currently-visible (filtered + sorted) devices.
function bacDevicesToCsv() {
  const rows = bacVisibleDevices();
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ["instance", "name", "address", "network", "mac", "vendorId", "vendorName", "model", "maxApdu", "segmentation"];
  const lines = [header.join(",")];
  for (const d of rows) {
    lines.push([
      d.instance, d.name, d.address, d.network ?? "", d.mac ?? "",
      d.vendorId, d.vendorName, d.modelName, d.maxApdu, d.segmentation,
    ].map(esc).join(","));
  }
  return lines.join("\r\n");
}

async function bacCopyDevices() {
  const csv = bacDevicesToCsv();
  try {
    await navigator.clipboard.writeText(csv);
    logTo("bacnet", `Copied ${bacVisibleDevices().length} devices to clipboard (CSV).`, "ok");
  } catch (err) {
    logTo("bacnet", `Clipboard copy failed: ${err}`, "error");
  }
}

function bacExportDevices() {
  const csv = bacDevicesToCsv();
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: `bacnet-devices-${bacTimestamp()}.csv` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  logTo("bacnet", `Exported ${bacVisibleDevices().length} devices to CSV.`, "ok");
}

function bacTimestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function bacFilteredObjects() {
  const q = bac.objectFilter.trim().toLowerCase();
  if (!q) return bac.objects;
  return bac.objects.filter((o) =>
    o.name.toLowerCase().includes(q) ||
    o.typeName.toLowerCase().includes(q) ||
    String(o.instance).includes(q));
}

function bacApplyObjectFilter() {
  if (currentPluginId() !== "bacnet") return;
  const list = document.getElementById("bac-object-list");
  if (list) list.replaceChildren(...bacObjectRows());
  const count = document.getElementById("bac-object-count");
  if (count) count.textContent = bacObjectCountText();
}

function bacObjectCountText() {
  const total = bac.objects.length;
  if (!bac.objectFilter.trim()) return `${total} object${total === 1 ? "" : "s"}`;
  return `${bacFilteredObjects().length} of ${total} shown`;
}

// ---- render ----

function bacDeviceRows() {
  if (bac.devices.length === 0) {
    const msg = bac.discovering ? "Listening for I-Am replies…" : "No devices yet — run Discover.";
    return [el("tr", {}, el("td", { class: "muted small", colspan: "6" }, msg))];
  }
  const devices = bacVisibleDevices();
  if (devices.length === 0) {
    return [el("tr", {}, el("td", { class: "muted small", colspan: "6" }, "No devices match the filter."))];
  }
  return devices.map((d) => {
    const active = d.key === bac.selectedDeviceKey;
    return el("tr", {
      class: `bac-device-row ${active ? "bac-row-active" : ""}`,
      onclick: () => bacSelectDevice(d.key),
    },
      el("td", { class: "bac-num" }, String(d.instance)),
      el("td", {}, d.name || el("span", { class: "muted" }, "—")),
      el("td", { class: "bac-mono" }, bacAddressText(d)),
      el("td", {}, bacVendorText(d) || el("span", { class: "muted" }, "—")),
      el("td", {}, d.modelName || el("span", { class: "muted" }, "—")),
      el("td", { class: "bac-num" }, `${d.maxApdu} · ${d.segmentation}`),
    );
  });
}

function bacDeviceHeaderCell(key, label, cls) {
  const active = bac.deviceSortKey === key;
  const arrow = active ? (bac.deviceSortDir === "asc" ? "▲" : "▼") : "";
  return el("th", {
    class: `bac-th${active ? " bac-th-active" : ""}${cls ? " " + cls : ""}`,
    role: "button",
    tabindex: "0",
    "aria-sort": active ? (bac.deviceSortDir === "asc" ? "ascending" : "descending") : "none",
    onclick: () => bacSetDeviceSort(key),
    onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); bacSetDeviceSort(key); } },
  }, label, el("span", { class: "bac-sort-ind" }, arrow));
}

function bacDeviceTableEl() {
  return el("table", { id: "bac-device-table", class: "bac-table" },
    el("thead", {}, el("tr", {},
      bacDeviceHeaderCell("instance", "Instance"),
      bacDeviceHeaderCell("name", "Name"),
      bacDeviceHeaderCell("address", "Address"),
      bacDeviceHeaderCell("vendor", "Vendor"),
      bacDeviceHeaderCell("model", "Model"),
      el("th", {}, "Max APDU · seg"),
    )),
    el("tbody", { id: "bac-device-rows" }, ...bacDeviceRows()),
  );
}

function bacObjectRows() {
  const objects = bacFilteredObjects();
  if (objects.length === 0) {
    let msg;
    if (bac.objects.length > 0) msg = "No objects match the filter.";
    else if (bac.objectsLoading) msg = "Reading object list…";
    else msg = "Select a device to list its objects.";
    return [el("li", { class: "muted small bac-object-empty" }, msg)];
  }
  return objects.map((o) => {
    const key = bacObjectKey(o);
    const active = key === bac.selectedObjectKey;
    return el("li", {
      class: `bac-object-row ${active ? "bac-row-active" : ""}`,
      role: "button",
      tabindex: "0",
      onclick: () => bacSelectObject(key),
      onkeydown: (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); bacSelectObject(key); }
      },
    },
      el("span", { class: "bac-object-type" }, `${o.typeName}:${o.instance}`),
      el("span", { class: "bac-object-name" }, o.name || ""),
    );
  });
}

function bacPropRows(flashIds) {
  if (bac.props.length === 0) {
    const msg = bac.propsLoading
      ? "Reading properties…"
      : "Select an object to read its properties.";
    return [el("tr", {}, el("td", { class: "muted small", colspan: "2" }, msg))];
  }
  return bac.props.map((p) => {
    const flash = flashIds && flashIds.has(p.id);
    return el("tr", { class: `${p.error ? "bac-prop-error" : ""}${flash ? " bac-prop-flash" : ""}` },
      el("td", { class: "bac-prop-name", title: `property ${p.id}` }, p.name),
      el("td", { class: "bac-prop-value" }, p.display),
    );
  });
}

// ---- trend logs (ReadRange) ----

function bacObjectIsTrendLog(obj) {
  return obj && (obj.objectType === 20 || obj.objectType === 27); // trend-log / trend-log-multiple
}

async function bacReadTrend() {
  const dev = bacSelectedDevice();
  const obj = bacSelectedObject();
  if (!dev || !obj) return;
  const max = Math.max(1, Math.min(2000, parseInt(bac.trend.max, 10) || 200));
  bac.trend.loading = true;
  bac.trend.objectKey = bacObjectKey(obj);
  renderAll();
  try {
    const result = await invoke("bacnet_read_trend", {
      device: bacDeviceRef(dev),
      objectType: obj.objectType,
      instance: obj.instance,
      maxRecords: max,
    });
    // Ignore if the user navigated away mid-read.
    if (bac.selectedObjectKey !== bacObjectKey(obj)) return;
    bac.trend.records = result.records;
    bac.trend.recordCount = result.recordCount;
    bac.trend.truncated = result.truncated;
    logTo("bacnet", `Read ${result.records.length} trend record${result.records.length === 1 ? "" : "s"} from ${obj.typeName}:${obj.instance}.`, "ok");
  } catch (err) {
    if (bac.selectedObjectKey !== bacObjectKey(obj)) return;
    logTo("bacnet", `Trend read failed for ${obj.typeName}:${obj.instance}: ${err}`, "error");
  } finally {
    if (bac.selectedObjectKey === bacObjectKey(obj)) {
      bac.trend.loading = false;
      renderAll();
    }
  }
}

function bacTrendToCsv() {
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = ["timestamp,value,status"];
  for (const r of bac.trend.records) {
    lines.push([r.timestamp, r.value, r.status].map(esc).join(","));
  }
  return lines.join("\r\n");
}

function bacExportTrend() {
  const obj = bacSelectedObject();
  const csv = bacTrendToCsv();
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: `trend-${obj ? `${obj.typeName}-${obj.instance}` : "log"}-${bacTimestamp()}.csv` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  logTo("bacnet", `Exported ${bac.trend.records.length} trend records to CSV.`, "ok");
}

function bacTrendPanel() {
  const recs = bac.trend.records;
  const rows = recs.length === 0
    ? [el("tr", {}, el("td", { class: "muted small", colspan: "3" },
        bac.trend.loading ? "Reading trend log…" : "No records read yet — click Read trend."))]
    : recs.map((r) => el("tr", {},
        el("td", { class: "bac-mono" }, r.timestamp),
        el("td", { class: "bac-prop-value" }, r.value),
        el("td", {}, r.status || el("span", { class: "muted" }, "—")),
      ));

  const maxInput = el("input", {
    type: "text", class: "nm-input bac-trend-max",
    title: "Max records to read",
    value: bac.trend.max,
    oninput: (e) => { bac.trend.max = e.target.value; },
  });

  return el("div", { class: "bac-trend" },
    el("div", { class: "section-head" },
      el("h4", {}, "Trend log"),
      bac.trend.recordCount
        ? el("span", { class: "muted small" }, `${bac.trend.recordCount} records on device${bac.trend.truncated ? ` · showing ${recs.length}` : ""}`)
        : null,
    ),
    el("div", { class: "action-row bac-trend-controls" },
      el("label", { class: "nm-field bac-trend-field" },
        el("span", { class: "nm-field-label" }, "Max records"), maxInput),
      el("button", {
        class: "btn btn-primary",
        disabled: bac.trend.loading ? "disabled" : undefined,
        onclick: bacReadTrend,
      }, bac.trend.loading ? "Reading…" : "Read trend"),
      el("button", {
        class: "btn-ghost",
        disabled: recs.length === 0 ? "disabled" : undefined,
        onclick: bacExportTrend,
      }, "Export CSV"),
    ),
    el("table", { class: "bac-table bac-trend-table" },
      el("thead", {}, el("tr", {},
        el("th", {}, "Timestamp"),
        el("th", {}, "Value"),
        el("th", {}, "Status"),
      )),
      el("tbody", {}, ...rows),
    ),
  );
}

function bacWritePanel() {
  const dev = bacSelectedDevice();
  const obj = bacSelectedObject();
  const disabled = !dev || !obj ? "disabled" : undefined;

  const propInput = el("input", {
    type: "text", class: "nm-input bac-write-prop", disabled,
    title: "Property number (85 = present-value)",
    value: bac.write.propertyId,
    oninput: (e) => { bac.write.propertyId = e.target.value; },
  });
  const kindSelect = el("select", {
    class: "nm-input bac-write-kind", disabled,
    onchange: (e) => { bac.write.kind = e.target.value; },
  },
    ...[
      ["real", "Real"],
      ["unsigned", "Unsigned"],
      ["signed", "Signed"],
      ["enumerated", "Enumerated"],
      ["boolean", "Boolean"],
      ["characterString", "Text"],
      ["null", "Null"],
    ].map(([v, label]) => el("option", {
      value: v,
      selected: bac.write.kind === v ? "selected" : undefined,
    }, label)),
  );
  const valueInput = el("input", {
    type: "text", class: "nm-input bac-write-value", disabled,
    placeholder: "value (e.g. 72.5)",
    value: bac.write.value,
    oninput: (e) => { bac.write.value = e.target.value; },
  });
  const prioritySelect = el("select", {
    class: "nm-input bac-write-priority", disabled,
    title: "Command priority (8 = manual operator)",
    onchange: (e) => { bac.write.priority = e.target.value; },
  },
    el("option", { value: "" }, "no priority"),
    ...Array.from({ length: 16 }, (_, i) => el("option", {
      value: String(i + 1),
      selected: bac.write.priority === String(i + 1) ? "selected" : undefined,
    }, `priority ${i + 1}`)),
  );

  return el("div", { class: "bac-write" },
    el("div", { class: "bac-write-row" },
      el("label", { class: "nm-field bac-write-field" },
        el("span", { class: "nm-field-label" }, "Property #"), propInput),
      el("label", { class: "nm-field bac-write-field" },
        el("span", { class: "nm-field-label" }, "Type"), kindSelect),
      el("label", { class: "nm-field bac-write-field bac-write-grow" },
        el("span", { class: "nm-field-label" }, "Value"), valueInput),
      el("label", { class: "nm-field bac-write-field" },
        el("span", { class: "nm-field-label" }, "Priority"), prioritySelect),
    ),
    el("div", { class: "action-row" },
      el("button", { class: "btn btn-primary", disabled, onclick: () => bacWrite(false) }, "Write"),
      el("button", {
        class: "btn-ghost", disabled,
        title: "Write Null at the selected priority to release the slot",
        onclick: () => bacWrite(true),
      }, "Relinquish"),
      el("button", { class: "btn-ghost", disabled, onclick: bacRefreshProps }, "Refresh"),
    ),
  );
}

// Directed-broadcast address for an adapter (e.g. 192.168.7.255 for a /21),
// derived from the Network Manager's live adapter state. Null when unusable.
function bacDirectedBroadcastFor(adapterName) {
  const st = nm.stateByAdapter[adapterName];
  if (!st || !st.ipAddress) return null;
  const prefix = nmMaskToPrefix(st.subnetMask);
  if (prefix == null || prefix < 8 || prefix > 30) return null;
  const p = st.ipAddress.split(".").map((n) => parseInt(n, 10));
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return null;
  const ip = ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const bcast = (ip | ~mask) >>> 0;
  return [(bcast >>> 24) & 255, (bcast >>> 16) & 255, (bcast >>> 8) & 255, bcast & 255].join(".");
}

// Discovery target(s) for an adapter. For subnets wider than /24 this also
// sweeps every /24 directed broadcast inside the range — flat BAS networks
// often mix masks, and a /24-configured controller ignores the /21 broadcast.
function bacSweepTargetFor(adapterName) {
  const st = nm.stateByAdapter[adapterName];
  if (!st || !st.ipAddress) return null;
  const prefix = nmMaskToPrefix(st.subnetMask);
  if (prefix == null || prefix < 16 || prefix > 30) return null;
  const bcast = bacDirectedBroadcastFor(adapterName);
  if (!bcast) return null;
  if (prefix >= 24) return { value: bcast, label: bcast };
  const p = st.ipAddress.split(".").map((n) => parseInt(n, 10));
  const ip = ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  const net = (ip & mask) >>> 0;
  const count = Math.min(Math.pow(2, 24 - prefix), 32); // cap the sweep at 32 /24s
  const targets = [bcast];
  for (let i = 0; i < count; i++) {
    const sub = (net + i * 256) >>> 0;
    targets.push([(sub >>> 24) & 255, (sub >>> 16) & 255, (sub >>> 8) & 255, 255].join("."));
  }
  const netStr = [(net >>> 24) & 255, (net >>> 16) & 255, (net >>> 8) & 255, net & 255].join(".");
  return { value: targets.join(","), label: `${netStr}/${prefix} sweep` };
}

// One clickable chip per adapter subnet, so multi-NIC machines (VPN, WSL,
// Hyper-V) can aim the Who-Is at the right network in one click.
function bacTargetChips() {
  const chips = [];
  const seen = new Set();
  for (const a of nm.adapters) {
    const t = bacSweepTargetFor(a.name);
    if (!t || seen.has(t.value)) continue;
    seen.add(t.value);
    chips.push(el("button", {
      class: `bac-chip ${bac.target === t.value ? "bac-chip-on" : ""}`,
      title: `Who-Is target(s) for ${a.name}`,
      disabled: bac.discovering ? "disabled" : undefined,
      onclick: () => { bac.target = t.value; renderAll(); },
    }, `${a.name} · ${t.label}`));
  }
  if (chips.length === 0) {
    return el("p", { class: "muted small bac-chip-row" },
      nm.loaded ? "" : "Reading adapters for subnet suggestions…");
  }
  return el("div", { class: "bac-chip-row" }, ...chips);
}

function renderBacnetPage() {
  bacEnsureListeners();
  nmEnsureLoaded(); // adapter state feeds the target suggestions

  const targetInput = el("input", {
    type: "text", class: "nm-input",
    placeholder: "255.255.255.255 or 192.168.1.255 or a device IP",
    disabled: bac.discovering ? "disabled" : undefined,
    value: bac.target,
    oninput: (e) => { bac.target = e.target.value; },
  });
  const lowInput = el("input", {
    type: "text", class: "nm-input bac-range-input", placeholder: "low",
    disabled: bac.discovering ? "disabled" : undefined,
    value: bac.lowLimit,
    oninput: (e) => { bac.lowLimit = e.target.value; },
  });
  const highInput = el("input", {
    type: "text", class: "nm-input bac-range-input", placeholder: "high",
    disabled: bac.discovering ? "disabled" : undefined,
    value: bac.highLimit,
    oninput: (e) => { bac.highLimit = e.target.value; },
  });
  const discoverBtn = el("button", {
    class: "btn btn-primary",
    disabled: bac.discovering ? "disabled" : undefined,
    onclick: bacDiscover,
  }, bac.discovering ? "Discovering…" : "Discover");

  // Offered only when the platform kernel resolved BACnet's optional dependency
  // on the netscan capability (i.e. Network Manager is present).
  const scanBtn = platformHost("bacnet")?.has("netscan.v1")
    ? el("button", {
        class: "btn btn-ghost",
        disabled: bac.discovering ? "disabled" : undefined,
        title: "Use Network Manager's scanner to list live hosts on your subnet",
        onclick: bacSuggestTargets,
      }, "Find live hosts")
    : null;

  const discoverSection = el("section", { class: "plugin-section" },
    el("div", { class: "nm-pane-head" },
      el("div", { class: "nm-pane-head-text" },
        el("h3", {}, "Discover devices"),
        el("p", { class: "muted small nm-section-sub" },
          "Broadcasts a Who-Is on UDP 47808. Use a directed broadcast (x.x.x.255) for a ",
          "specific subnet, or a device's IP to probe it directly across subnets."),
      ),
    ),
    el("div", { class: "bac-discover-controls" },
      el("label", { class: "nm-field bac-target-field" },
        el("span", { class: "nm-field-label" }, "Target"), targetInput),
      el("label", { class: "nm-field" },
        el("span", { class: "nm-field-label" }, "Instance range (optional)"),
        el("div", { class: "bac-range-pair" }, lowInput, el("span", { class: "muted" }, "–"), highInput),
      ),
      discoverBtn,
      scanBtn,
    ),
    bacTargetChips(),
  );

  const hasDevices = bac.devices.length > 0;
  const devicesSection = el("section", { class: "plugin-section" },
    el("div", { class: "section-head" },
      el("h3", {}, "Devices"),
      el("span", { id: "bac-device-count", class: "muted small" }, bacDeviceCountText()),
    ),
    hasDevices
      ? el("div", { class: "bac-device-toolbar" },
          el("input", {
            type: "search",
            class: "nm-input bac-device-filter",
            placeholder: "Filter by instance, name, address, vendor, model…",
            "aria-label": "Filter devices",
            value: bac.deviceFilter,
            oninput: (e) => { bac.deviceFilter = e.target.value; bacApplyDeviceView(); },
          }),
          el("button", {
            class: "btn-ghost", title: "Copy visible devices as CSV", onclick: bacCopyDevices,
          }, "Copy"),
          el("button", {
            class: "btn-ghost", title: "Download visible devices as a CSV file", onclick: bacExportDevices,
          }, "Export CSV"),
        )
      : null,
    // Static scroll wrapper; bacApplyDeviceView swaps the inner <table> in place (no re-nesting).
    el("div", { class: "table-scroll" }, bacDeviceTableEl()),
  );

  const dev = bacSelectedDevice();
  const obj = bacSelectedObject();

  const objectsPane = el("div", { class: "bac-objects-pane" },
    el("div", { class: "section-head" },
      el("h3", {}, dev ? `Objects — ${bacDeviceLabel(dev)}` : "Objects"),
      el("span", { id: "bac-object-count", class: "muted small" }, bacObjectCountText()),
    ),
    el("input", {
      type: "search", class: "nm-input bac-object-filter",
      placeholder: "Filter objects…",
      "aria-label": "Filter objects",
      value: bac.objectFilter,
      oninput: (e) => { bac.objectFilter = e.target.value; bacApplyObjectFilter(); },
    }),
    el("p", { id: "bac-objects-status", class: "muted small" },
      bac.objectsLoading
        ? (bac.objectsProgress
            ? `Walking object-list… ${bac.objectsProgress.done}/${bac.objectsProgress.total}`
            : "Reading object list…")
        : ""),
    el("ul", { id: "bac-object-list", class: "bac-object-list" }, ...bacObjectRows()),
  );

  const covOn = bacCovActive();
  const covBtn = el("button", {
    class: `btn-ghost bac-cov-btn ${covOn ? "bac-cov-on" : ""}`,
    disabled: !obj || bac.cov.busy ? "disabled" : undefined,
    title: "Subscribe to Change-of-Value notifications for live updates",
    onclick: bacToggleCov,
  }, bac.cov.busy ? "…" : covOn ? "Stop live" : "Subscribe live (COV)");

  const propsPane = el("div", { class: "bac-props-pane" },
    el("div", { class: "section-head" },
      el("h3", {}, obj ? `Properties — ${obj.typeName}:${obj.instance}` : "Properties"),
      el("div", { class: "bac-props-head-right" },
        covOn ? el("span", { id: "bac-cov-badge", class: "pill pill-running bac-cov-badge" },
          `live · ${bac.cov.updates} update${bac.cov.updates === 1 ? "" : "s"}`) : null,
        obj && obj.name ? el("span", { class: "muted small" }, obj.name) : null,
        covBtn,
      ),
    ),
    el("table", { class: "bac-table bac-props-table" },
      el("thead", {}, el("tr", {},
        el("th", {}, "Property"),
        el("th", {}, "Value"),
      )),
      el("tbody", { id: "bac-props-body" }, ...bacPropRows()),
    ),
    bacObjectIsTrendLog(obj) ? bacTrendPanel() : null,
    bacWritePanel(),
  );

  const browseSection = el("section", { class: "plugin-section" },
    el("div", { class: "bac-browse" }, objectsPane, propsPane),
  );

  return el("div", { class: "plugin-controls" },
    discoverSection,
    devicesSection,
    browseSection,
  );
}

// ============================================================================
// Observability (platform service page)
// ============================================================================

// Pack UI state.
let obsBusy = false;
let obsPhase = "";       // high-level bring-up phase label
let obsProgress = null;  // latest per-component install event (download %, rate, ETA, …)
let obsHealth = null;
let obsPack = null;      // installed-vs-pinned component versions (update detection)
let obsPackLoading = false;

const OBS_COMPONENT_NAMES = { influxdb: "InfluxDB", telegraf: "Telegraf", grafana: "Grafana" };

// Lazily fetch pack version status (installed vs pinned) once per page visit.
function obsEnsurePackStatus() {
  if (obsPack !== null || obsPackLoading || !pack) return;
  obsPackLoading = true;
  pack.packStatus()
    .then((s) => { obsPack = s; obsPackLoading = false; renderAll(); })
    .catch(() => { obsPackLoading = false; });
}

// "InfluxDB 2.7.5 · Telegraf 1.30.0 · Grafana 11.1.0 → 11.2.0" + an update badge.
function obsVersionsLine() {
  if (!obsPack || !obsPack.components) return null;
  const parts = obsPack.components.map((c) => {
    const name = OBS_COMPONENT_NAMES[c.name] || c.name;
    const ver = c.present ? (c.installedVersion || "?") : "not installed";
    const upgrade = c.present && c.needsUpdate ? ` → ${c.pinnedVersion}` : "";
    return `${name} ${ver}${upgrade}`;
  });
  return el("p", { class: "muted small" },
    parts.join(" · "),
    obsPack.updatesAvailable ? el("span", { class: "pill pill-running", style: "margin-left:8px" }, "Update available") : null,
  );
}

const OBS_PHASE_LABELS = {
  status: "Checking what's installed…",
  install: "Downloading & installing components…",
  "write-configs": "Writing configuration…",
  start: "Starting InfluxDB, Telegraf & Grafana…",
  "wait-influx": "Waiting for InfluxDB to come up…",
  onboard: "Initializing InfluxDB…",
  connect: "Connecting telemetry…",
  done: "Done",
};

function renderInstallProgress() {
  const pr = obsProgress;
  const downloading = pr && pr.step === "download" && pr.percent != null;
  const pct = downloading ? Math.max(0, Math.min(100, Math.round(Number(pr.percent)))) : null;
  let detail;
  if (downloading) {
    detail = `Downloading ${pr.component} (${(pr.index ?? 0) + 1}/${pr.total ?? 3}) — ` +
      `${pct}% · ${pr.received}/${pr.size} · ${pr.rate}/s · ETA ${pr.eta}`;
  } else if (pr && pr.step) {
    const verb = { extract: "Extracting", install: "Installing", "already-installed": "Already installed",
      done: "Installed", verify: "Verifying" }[pr.step] || pr.step;
    detail = `${verb} ${pr.component} (${(pr.index ?? 0) + 1}/${pr.total ?? 3})…`;
  } else {
    detail = obsPhase || "Working…";
  }
  const fill = el("div", { class: "progress-fill" });
  fill.style.width = pct != null ? `${pct}%` : "100%";
  if (pct == null) fill.style.opacity = "0.4"; // indeterminate phases
  const bar = el("div", { class: "progress-bar" }, fill);
  bar.style.display = "block";
  return el("section", { class: "plugin-section" },
    el("h3", {}, obsPhase || "Installing…"),
    el("p", { class: "muted small" }, detail),
    bar,
  );
}

function obsStatusPill() {
  if (obsHealth && obsHealth.influxReady) return { label: "Live", cls: "pill-running" };
  if (obsHealth && obsHealth.influxUp) return { label: "Starting", cls: "pill-muted" };
  const s = telemetry ? telemetry.stats() : null;
  if (s && s.backend && s.degraded) return { label: "Reconnecting", cls: "pill-muted" };
  return { label: "Local", cls: "pill-idle" };
}

async function obsRefreshHealth() {
  if (!pack) return;
  try { obsHealth = await pack.health(); }
  catch (_) { obsHealth = null; }
  renderAll();
}

async function obsBringUp() {
  if (!pack || obsBusy) return;
  obsBusy = true; obsPhase = OBS_PHASE_LABELS.status; obsProgress = null; renderAll();
  try {
    logTo("observability", "Bringing up the Observability Pack… (first run downloads ~400 MB)", "info");
    const cfg = await pack.bringUp((s) => {
      obsPhase = OBS_PHASE_LABELS[s] || s;
      if (s !== "install") obsProgress = null; // download detail only during install
      renderAll();
    });
    logTo("observability", `Pack up — InfluxDB :${cfg.influxPort}, Grafana :${cfg.grafanaPort}.`, "ok");
    await obsRefreshHealth();
  } catch (err) {
    logTo("observability", `Bring-up failed: ${err}`, "error");
  } finally {
    // Re-fetch installed versions on success OR failure (a partial update may
    // have changed them), so the version line / Update-available badge is fresh.
    obsPack = null;
    obsBusy = false; obsPhase = ""; obsProgress = null; renderAll();
  }
}

async function obsStop() {
  if (!pack) return;
  try { await pack.stop(); logTo("observability", "Stopped pack services.", "info"); await obsRefreshHealth(); }
  catch (err) { logTo("observability", `Stop failed: ${err}`, "error"); }
}

async function obsWriteConfigs() {
  if (!pack) return;
  try { const dir = await pack.writeConfigs(); logTo("observability", `Wrote pack config files to ${dir}.`, "ok"); }
  catch (err) { logTo("observability", `Could not write configs: ${err}`, "error"); }
}

function renderObservabilityPage() {
  obsEnsurePackStatus();
  const stats = telemetry ? telemetry.stats() : null;
  const recent = telemetry ? telemetry.recent(15) : [];
  const cfg = pack ? pack.getConfig() : null;

  const healthLine = obsHealth
    ? `InfluxDB: ${obsHealth.influxReady ? "ready" : obsHealth.influxUp ? "starting" : "down"} · Grafana: ${obsHealth.grafanaUp ? "up" : "down"}`
    : "Health unknown — click Check health.";

  const installLabel = obsBusy ? "Working…"
    : (obsPack && obsPack.updatesAvailable) ? "Update & restart pack"
    : (obsPack && obsPack.installed) ? "Restart pack"
    : "Install & start pack";

  const statusCard = el("section", { class: "plugin-section" },
    el("h3", {}, "Observability Pack"),
    el("p", { class: "muted small" },
      "Telegraf + InfluxDB + Grafana run locally on 127.0.0.1. The first install downloads ~400 MB; " +
      "until then, tool metrics are kept in an in-memory ring buffer (still visible below)."),
    obsVersionsLine(),
    el("p", { class: "muted small" }, obsBusy ? (obsPhase || "Working…") : healthLine),
    el("div", { class: "tool-actions" },
      el("button", {
        class: "btn btn-primary",
        disabled: obsBusy ? "disabled" : undefined,
        onclick: obsBringUp,
      }, installLabel),
      el("button", { class: "btn-ghost", disabled: obsBusy ? "disabled" : undefined, onclick: obsStop }, "Stop"),
      el("button", { class: "btn-ghost", onclick: obsRefreshHealth }, "Check health"),
      el("button", { class: "btn-ghost", disabled: obsBusy ? "disabled" : undefined, onclick: obsWriteConfigs }, "Write configs"),
      obsHealth && obsHealth.grafanaUp && cfg
        ? el("button", { class: "btn-ghost", onclick: () => openExternal(`http://127.0.0.1:${cfg.grafanaPort}`) }, "Open Grafana")
        : null,
    ),
  );

  const statRow = (label, val) => el("div", { class: "kv-row" },
    el("span", { class: "muted small" }, label), el("span", {}, String(val)));
  const statsCard = el("section", { class: "plugin-section" },
    el("h3", {}, "Buffer"),
    stats
      ? el("div", { class: "kv-grid" },
          statRow("Recent (ring)", stats.ring),
          statRow("Buffered", stats.buffered),
          statRow("Written", stats.written),
          statRow("Dropped", stats.dropped),
        )
      : el("p", { class: "muted small" }, "Telemetry service not started."),
  );

  const recentCard = el("section", { class: "plugin-section" },
    el("div", { class: "section-head" },
      el("h3", {}, "Recent metrics"),
      el("button", { class: "btn-ghost", onclick: () => renderAll() }, "Refresh"),
    ),
    recent.length === 0
      ? el("p", { class: "muted small" }, "No metrics recorded yet. Run a tool (e.g. a network scan) to produce some.")
      : el("ol", { class: "plugin-log" },
          ...recent.slice().reverse().map((p) =>
            el("li", { class: "log-info" },
              el("span", { class: "log-time" }, new Date(p.ts).toLocaleTimeString()),
              el("span", { class: "log-msg" },
                `${p.measurement} ${Object.entries(p.tags).map(([k, v]) => `${k}=${v}`).join(",")} → ${Object.entries(p.fields).map(([k, v]) => `${k}=${v}`).join(", ")}`),
            )),
        ),
  );

  const progressCard = obsBusy ? renderInstallProgress() : null;
  return el("div", { class: "plugin-controls" }, statusCard, progressCard, statsCard, recentCard);
}

// ============================================================================
// BACnet Historian (composed tool page)
// ============================================================================

function historianInstance() {
  return platform ? platform.capability("bacnet.historian.v1") : null;
}

let histIntervalMs = 60000;

function histStatusPill() {
  const hist = historianInstance();
  if (!hist) return { label: "Off", cls: "pill-muted" };
  return hist.isRunning() ? { label: "Logging", cls: "pill-running" } : { label: "Idle", cls: "pill-idle" };
}

// Persist the configured points + run state so unattended logging survives a
// reload/restart (the historian core itself is in-memory only).
function histPersist() {
  const hist = historianInstance();
  if (!hist) return;
  userState.historian = {
    points: hist.points().map((p) => ({
      device: p.device, objectType: p.objectType, instance: p.instance, label: p.label || "",
    })),
    running: hist.isRunning(),
    intervalMs: histIntervalMs,
  };
  saveUserState();
}

function histRestore() {
  const hist = historianInstance();
  const saved = userState.historian;
  if (!hist || !saved) return;
  for (const p of saved.points || []) hist.addPoint(p);
  if (saved.intervalMs) histIntervalMs = saved.intervalMs;
  if (saved.running && (saved.points || []).length) {
    hist.start(histIntervalMs);
    logTo("bacnet-historian", `Resumed logging ${saved.points.length} point(s).`, "info");
  }
}

function renderHistorianPage() {
  const hist = historianInstance();
  if (!hist) {
    return el("div", { class: "plugin-controls" },
      el("section", { class: "plugin-section" },
        el("p", { class: "muted" }, "Historian unavailable — the platform kernel did not resolve its dependencies.")));
  }

  // Devices come from the BACnet Explorer's discovery results (inter-tool reuse).
  const devices = bac.devices || [];
  let devIdx = devices.length ? "0" : "";
  const objTypeInput = el("input", { type: "number", class: "nm-input bac-range-input", value: "0", title: "Object type (0=AI, 1=AO, 2=AV, …)" });
  const instInput = el("input", { type: "number", class: "nm-input bac-range-input", value: "0" });
  const labelInput = el("input", { type: "text", class: "nm-input", placeholder: "label (optional)" });
  const devSelect = el("select", { class: "nm-input", onchange: (e) => { devIdx = e.target.value; } },
    ...(devices.length
      ? devices.map((d, i) => el("option", { value: String(i) }, bacDeviceLabel(d)))
      : [el("option", { value: "" }, "No devices — discover in BACnet Explorer first")]));

  const addBtn = el("button", {
    class: "btn",
    disabled: devices.length ? undefined : "disabled",
    onclick: () => {
      const dev = devices[Number(devIdx)];
      if (!dev) return;
      hist.addPoint({
        device: { ...bacDeviceRef(dev), deviceInstance: dev.instance },
        objectType: Number(objTypeInput.value),
        instance: Number(instInput.value),
        label: labelInput.value.trim(),
      });
      logTo("bacnet-historian", `Added device ${dev.instance} point ${objTypeInput.value}:${instInput.value}.`, "ok");
      histPersist();
      renderAll();
    },
  }, "Add point");

  const addCard = el("section", { class: "plugin-section" },
    el("h3", {}, "Add a point"),
    el("p", { class: "muted small" }, "Points are read from devices discovered in the BACnet Explorer."),
    el("div", { class: "bac-discover-controls" },
      el("label", { class: "nm-field bac-target-field" }, el("span", { class: "nm-field-label" }, "Device"), devSelect),
      el("label", { class: "nm-field" }, el("span", { class: "nm-field-label" }, "Object type"), objTypeInput),
      el("label", { class: "nm-field" }, el("span", { class: "nm-field-label" }, "Instance"), instInput),
      el("label", { class: "nm-field" }, el("span", { class: "nm-field-label" }, "Label"), labelInput),
      addBtn,
    ),
  );

  const intervalInput = el("input", { type: "number", class: "nm-input bac-range-input", value: String(Math.round(histIntervalMs / 1000) || 60), title: "seconds" });
  const running = hist.isRunning();
  const controlCard = el("section", { class: "plugin-section" },
    el("div", { class: "section-head" },
      el("h3", {}, "Logging"),
      el("span", { class: `pill ${running ? "pill-running" : "pill-idle"}` }, running ? "Logging" : "Idle")),
    el("p", { class: "muted small" },
      "Writes present-value to the time-series service. Connect the Observability Pack to chart it in Grafana."),
    el("div", { class: "bac-discover-controls" },
      el("label", { class: "nm-field" }, el("span", { class: "nm-field-label" }, "Interval (s)"), intervalInput),
      el("button", {
        class: "btn btn-primary",
        onclick: () => {
          histIntervalMs = Math.max(5, Number(intervalInput.value) || 60) * 1000;
          hist.start(histIntervalMs);
          logTo("bacnet-historian", "Started logging.", "ok");
          histPersist();
          renderAll();
        },
      }, running ? "Restart" : "Start"),
      running
        ? el("button", { class: "btn-ghost", onclick: () => { hist.stop(); logTo("bacnet-historian", "Stopped logging.", "info"); histPersist(); renderAll(); } }, "Stop")
        : null,
      el("button", {
        class: "btn-ghost",
        onclick: async () => {
          const r = await hist.pollOnce();
          logTo("bacnet-historian", `Polled — ${r.written} written, ${r.errors} error(s).`, r.errors ? "warn" : "ok");
          renderAll();
        },
      }, "Poll now"),
    ),
  );

  const pts = hist.points();
  const pointsCard = el("section", { class: "plugin-section" },
    el("h3", {}, `Points (${pts.length})`),
    pts.length === 0
      ? el("p", { class: "muted small" }, "No points yet — add one above.")
      : el("ol", { class: "plugin-log" },
          ...pts.map((p) =>
            el("li", { class: p.lastError ? "log-error" : "log-info" },
              el("span", { class: "log-msg" },
                `${p.label ? p.label + " · " : ""}dev ${p.device.deviceInstance} ${p.objectType}:${p.instance} → ` +
                `${p.lastError ? "ERR " + p.lastError : (p.lastValue ?? "—")} (${p.reads} reads)`),
              el("button", { class: "btn-ghost", onclick: () => { hist.removePoint(p); histPersist(); renderAll(); } }, "Remove"),
            ))),
  );

  return el("div", { class: "plugin-controls" }, controlCard, addCard, pointsCard);
}

// ============================================================================
// Third-party MCP tools (install / page / remove)
// ============================================================================

function mcpStatusPill(m) {
  if (platform && platform.isBooted(m.id)) return { label: "Connected", cls: "pill-running" };
  return { label: "Off", cls: "pill-muted" };
}

function renderMcpToolPage(m) {
  const booted = platform && platform.isBooted(m.id);
  const caps = (m.provides || []).map((p) => `${p.capability}.v${String(p.version).split(".")[0]}`);
  const entry = m.entry || {};
  return el("div", { class: "plugin-controls" },
    el("section", { class: "plugin-section" },
      el("h3", {}, "Third-party MCP tool"),
      el("p", { class: "muted small" },
        booted
          ? "Connected — its capabilities are available to other tools via the kernel."
          : "Not connected — the MCP server failed to start (check the command is installed)."),
      el("p", { class: "muted small" }, `Provides: ${caps.length ? caps.join(", ") : "—"}`),
      el("p", { class: "muted small" }, `Permissions: ${(m.permissions || []).join(", ") || "none"}`),
      el("p", { class: "muted small" }, `Command: ${entry.command || "?"} ${(entry.args || []).join(" ")}`),
      el("div", { class: "tool-actions" },
        el("button", { class: "btn-ghost", onclick: () => mcpRemove(m.id) }, "Remove tool"),
      ),
    ),
  );
}

// Install a kind:"mcp" tool from a pasted manifest: validate, get permission
// approval, persist, then reload so the kernel boots it.
async function mcpInstallFromJson(jsonText) {
  let manifest;
  try { manifest = JSON.parse(jsonText); }
  catch (e) { alert(`Invalid JSON: ${e.message}`); return; }

  const { valid, errors } = validateManifest(manifest);
  if (!valid) { alert(`Invalid manifest:\n${errors.join("\n")}`); return; }
  if (manifest.kind !== "mcp") { alert('Only kind:"mcp" tools can be installed here.'); return; }
  const exists = ALL_MANIFESTS.some((t) => t.id === manifest.id);
  if (exists) { alert(`A tool with id "${manifest.id}" already exists.`); return; }

  // SECURITY: installing an MCP tool runs a native program on every launch, so
  // always require an explicit, command-disclosing confirmation — even when the
  // manifest declares no permissions. This (not the permission list) is the real
  // gate: the user is deciding whether to trust an executable.
  const entry = manifest.entry || {};
  const cmdLine = `${entry.command || "?"} ${(entry.args || []).join(" ")}`.trim();
  const envKeys = entry.env ? Object.keys(entry.env) : [];
  const ok = confirm(
    `Install "${manifest.name}"?\n\n` +
    `⚠ This runs a program on your computer every time the app launches:\n  ${cmdLine}\n` +
    (envKeys.length ? `Environment: ${envKeys.join(", ")}\n` : "") +
    `\nCapabilities it will provide: ${(manifest.provides || []).map((p) => p.capability).join(", ") || "none"}\n` +
    `Permissions requested: ${(manifest.permissions || []).join(", ") || "none"}\n\n` +
    `Only install tools from sources you trust — this is arbitrary code execution.`,
  );
  if (!ok) { alert("Install cancelled."); return; }

  // Record the approved permission set (the command was already consented to above).
  const granted = await approveInstall(manifest, () => true);

  userState.installedTools = [...(userState.installedTools || []), manifest];
  userState.installedGrants = { ...(userState.installedGrants || {}), [manifest.id]: [...granted] };
  saveUserState();
  alert(`Installed "${manifest.name}". The app will reload to start it.`);
  location.reload();
}

async function mcpRemove(id) {
  if (!confirm("Remove this MCP tool?")) return;
  try { await invoke("mcp_stop", { id }); } catch (_) {}
  userState.installedTools = (userState.installedTools || []).filter((t) => t.id !== id);
  const grants = { ...(userState.installedGrants || {}) };
  delete grants[id];
  userState.installedGrants = grants;
  if (currentPluginId() === id) userState.view = "library";
  saveUserState();
  location.reload();
}

// ============================================================================
// Library card (compact)
// ============================================================================

// Shared library affordances, so the card and the list-row can't drift apart.
function toolStarBtn(tool) {
  const fav = isFavorite(tool.id);
  return el("button", {
    class: `star-btn ${fav ? "star-on" : ""}`,
    title: fav ? "Unfavorite" : "Favorite",
    "aria-pressed": fav ? "true" : "false",
    onclick: (e) => { e.stopPropagation(); setFavorite(tool.id, !fav); },
  }, fav ? "★" : "☆");
}

// Compact "hide" affordance — revealed on hover/focus (see .tool-hide in styles.css).
// The whole card/row is the open action, so this replaces the old "Open →" button.
function toolHideBtn(tool) {
  return el("button", {
    class: "tool-hide",
    title: "Hide from library",
    "aria-label": `Hide ${tool.name}`,
    onclick: (e) => { e.stopPropagation(); setHidden(tool.id, true); },
  }, "×");
}

function toolStatusPill(tool) {
  const status = tool.renderStatusPill ? tool.renderStatusPill() : null;
  return status ? el("span", { class: `pill ${status.cls}` }, status.label) : null;
}

function renderToolCard(tool) {
  return el("article",
    {
      class: "tool-card",
      id: `tool-card-${tool.id}`,
      title: tool.tagline || tool.name,
      role: "button",
      tabindex: "0",
      onclick: () => setView(pluginView(tool.id)),
      onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setView(pluginView(tool.id)); } },
    },
    el("div", { class: "tool-icon" }, tool.emoji),
    el("div", { class: "tool-body" },
      el("div", { class: "tool-header" },
        el("h3", {}, tool.name),
        el("div", { class: "card-header-right" },
          toolStatusPill(tool),
          toolStarBtn(tool),
          toolHideBtn(tool),
        ),
      ),
      el("p", { class: "tool-tagline" }, tool.tagline),
    ),
  );
}

// Compact one-line-per-tool row for the list view. The empty-span fallback keeps
// the fixed 6-column grid aligned when a tool has no status pill.
function renderToolRow(tool) {
  return el("li",
    {
      class: "tool-row",
      id: `tool-card-${tool.id}`,
      title: tool.tagline || tool.name,
      role: "button",
      tabindex: "0",
      onclick: () => setView(pluginView(tool.id)),
      onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setView(pluginView(tool.id)); } },
    },
    el("span", { class: "tool-row-icon" }, tool.emoji),
    el("span", { class: "tool-row-name" }, tool.name),
    el("span", { class: "tool-row-tag" }, tool.tagline),
    toolStatusPill(tool) || el("span", {}),
    toolStarBtn(tool),
    toolHideBtn(tool),
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

  const listView = userState.libraryView === "list";
  const viewToggle = el("div", { class: "lib-toggle", role: "group", "aria-label": "Library layout" },
    el("button", {
      class: listView ? "" : "active",
      title: "Grid view", "aria-pressed": String(!listView),
      onclick: () => setLibraryView("grid"),
    }, "▦ Grid"),
    el("button", {
      class: listView ? "active" : "",
      title: "List view", "aria-pressed": String(listView),
      onclick: () => setLibraryView("list"),
    }, "☰ List"),
  );

  root.appendChild(el("div", { class: "view-header" },
    el("h2", {}, "Library"),
    el("div", { class: "view-header-right" },
      viewToggle,
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
  } else if (listView) {
    const list = el("ul", { class: "tool-list" });
    for (const tool of visible) list.appendChild(renderToolRow(tool));
    root.appendChild(list);
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

// ----------------------------------------------------------------------------
// Services & Capabilities — the developer API reference, generated from the live
// capability graph joined with the contract docs (src/platform/service-catalog.js).
// ----------------------------------------------------------------------------

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const prev = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => { btn.textContent = prev; }, 1200);
    }
  } catch (err) {
    console.warn("copyText failed:", err);
  }
}

function serviceBadge(provider) {
  if (provider.category === "service") return { label: "Service", cls: "svc-badge-service" };
  if (provider.category === "app") return { label: "App", cls: "svc-badge-app" };
  return { label: "Provider", cls: "" };
}

function renderCapabilityCard(e) {
  const methods = (e.doc ? e.doc.methods : []).map((m) =>
    el("div", { class: "svc-method" },
      el("code", { class: "svc-method-sig" }, m.sig),
      el("span", { class: "svc-method-ret muted small" }, `→ ${m.returns}`),
      el("p", { class: "svc-method-desc muted small" }, m.desc),
    ),
  );

  const consumers = e.consumers.length
    ? `Used by: ${e.consumers.map((c) => c.name + (c.optional ? " (optional)" : "")).join(", ")}`
    : "Not yet consumed by any tool.";

  return el("div", { class: "svc-cap" },
    el("div", { class: "svc-cap-head" },
      el("code", { class: "svc-cap-ref" }, e.ref),
      el("span", { class: "svc-cap-ver muted small" }, `contract v${e.version}`),
      el("button", {
        class: "btn-ghost svc-copy", title: "Copy the consume-this-capability snippet",
        onclick: (ev) => copyText(e.usage, ev.currentTarget),
      }, "Copy"),
    ),
    e.doc
      ? el("p", { class: "svc-cap-summary" }, e.doc.summary)
      : el("p", { class: "muted small" }, "No contract docs yet — see the provider's source."),
    methods.length ? el("div", { class: "svc-methods" }, ...methods) : null,
    e.doc && e.doc.notes ? el("p", { class: "svc-note small muted" }, `ℹ ${e.doc.notes}`) : null,
    el("details", { class: "svc-usage" },
      el("summary", {}, "How to use"),
      el("pre", { class: "svc-usage-code" }, el("code", {}, e.usage)),
    ),
    el("p", { class: "svc-consumers muted small" }, consumers),
  );
}

function renderServiceProvider(provider, caps) {
  const badge = serviceBadge(provider);
  const head = el("div", { class: "svc-provider-head" },
    el("span", { class: "svc-provider-icon" }, provider.emoji),
    el("div", { class: "svc-provider-titles" },
      el("h3", { class: "svc-provider-name" }, provider.name),
      el("span", { class: `pill svc-badge ${badge.cls}` }, badge.label),
    ),
    provider.permissions.length
      ? el("span", { class: "svc-perms muted small", title: "Permissions this provider holds" },
          `🔑 ${provider.permissions.join(", ")}`)
      : null,
  );
  return el("section", { class: "svc-provider" }, head, ...caps.map(renderCapabilityCard));
}

function renderServicesPage() {
  const root = document.getElementById("view-root");
  root.replaceChildren();

  // Built from ALL_MANIFESTS so installed third-party (mcp) capabilities appear too.
  const { entries } = buildServiceCatalog(ALL_MANIFESTS);

  root.appendChild(el("div", { class: "view-header" },
    el("h2", {}, "Services & Capabilities"),
    el("span", { class: "muted small" }, `${entries.length} capabilities`),
  ));
  root.appendChild(el("p", { class: "services-intro muted" },
    "Every capability a tool exposes is a versioned contract any app or connector can build against. ",
    "Declare it in your manifest's ", el("code", {}, "requires"),
    ", then resolve it from your scoped host with ", el("code", {}, "host.use()"),
    " — you never reach into another tool directly. Provider, version and consumers below are read live from the capability graph.",
  ));

  if (entries.length === 0) {
    root.appendChild(el("p", { class: "empty-state" }, "No capabilities are registered."));
    return;
  }

  // Group capabilities by their provider; list Services before Apps.
  const byProvider = new Map();
  for (const e of entries) {
    if (!byProvider.has(e.provider.id)) byProvider.set(e.provider.id, { provider: e.provider, caps: [] });
    byProvider.get(e.provider.id).caps.push(e);
  }
  const rank = (p) => (p.category === "service" ? 0 : 1);
  const groups = [...byProvider.values()].sort((a, b) =>
    rank(a.provider) - rank(b.provider) || a.provider.name.localeCompare(b.provider.name),
  );
  for (const g of groups) root.appendChild(renderServiceProvider(g.provider, g.caps));
}

// Body for the per-tool "About" modal: the description plus a source link.
function aboutModalBody(tool) {
  const parts = [
    el("p", { class: "modal-desc" }, tool.description || "No description available."),
  ];
  if (tool.repo) {
    parts.push(el("p", { class: "modal-foot" },
      el("a", {
        href: "#",
        onclick: (e) => { e.preventDefault(); openExternal(tool.repo); },
      }, "Source on GitHub →"),
    ));
  }
  return parts;
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

  const hasAbout = Boolean(tool.description || tool.repo);
  root.appendChild(el("header", { class: "plugin-header" },
    el("div", { class: "plugin-header-left" },
      el("div", { class: "tool-icon plugin-icon" }, tool.emoji),
      el("div", {},
        el("div", { class: "plugin-title-row" },
          el("h2", { class: "plugin-title" }, tool.name),
          hasAbout && el("button", {
            class: "info-btn",
            title: "About this tool",
            "aria-label": `About ${tool.name}`,
            onclick: () => openModal({ title: `About ${tool.name}`, body: aboutModalBody(tool) }),
          }, "ⓘ"),
        ),
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

  // (The former "About" section now lives behind the ⓘ button in the header.)

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

  // ===== Third-party tools (MCP) =====
  const installed = userState.installedTools || [];
  const mcpTextarea = el("textarea", {
    class: "nm-input",
    rows: "6",
    style: "width:100%; font-family:monospace; font-size:12px;",
    placeholder: '{ "id": "my-tool", "name": "My Tool", "version": "0.1.0", "apiVersion": "1", "kind": "mcp", "entry": { "transport": "stdio", "command": "my-mcp.exe" }, "provides": [{ "capability": "my.thing", "version": "1.0" }], "permissions": [] }',
  });
  root.appendChild(el("section", { class: "settings-card" },
    el("h3", {}, "Third-party tools (MCP)"),
    el("p", { class: "muted small" },
      "Install a tool that plugs in as an MCP server. Paste its manifest below; you'll approve its permissions, then the app restarts to connect it. Its capabilities become available to other tools."),
    installed.length
      ? el("ul", { class: "hidden-list" },
          ...installed.map((m) => el("li", { class: "hidden-row" },
            el("span", { class: "hidden-row-icon" }, (m.ui && m.ui.emoji) || "🧩"),
            el("span", { class: "hidden-row-name" }, `${m.name} (${m.id})`),
            el("span", { class: "hidden-row-tag" }, platform && platform.isBooted(m.id) ? "connected" : "off"),
            el("button", { class: "btn-ghost", onclick: () => mcpRemove(m.id) }, "Remove"),
          )))
      : el("p", { class: "muted small" }, "No third-party tools installed."),
    mcpTextarea,
    el("div", { class: "tool-actions", style: "margin-top:8px;" },
      el("button", { class: "btn btn-primary", onclick: () => mcpInstallFromJson(mcpTextarea.value) }, "Install MCP tool"),
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
      // When triggered off the Settings page (e.g. the header About popover),
      // there's no status line to update — surface the result directly.
      if (manual && !document.getElementById("update-status")) {
        alert(`You're on the latest version (v${APP_VERSION}).`);
      }
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

function renderHeaderBreadcrumb() {
  const bc = document.getElementById("header-breadcrumb");
  if (!bc) return;
  bc.replaceChildren();
  const view = currentView();
  if (view === "settings") {
    bc.appendChild(el("span", { class: "crumb-current" }, "Settings"));
  } else if (view === "services") {
    bc.appendChild(el("span", { class: "crumb-current" }, "Services & Capabilities"));
  } else if (view.startsWith("plugin:")) {
    const id = view.slice("plugin:".length);
    const tool = TOOLS.find((t) => t.id === id);
    bc.appendChild(el("a", {
      class: "crumb-link", href: "#",
      onclick: (e) => { e.preventDefault(); setView("library"); },
    }, "Library"));
    bc.appendChild(el("span", { class: "crumb-sep" }, "›"));
    bc.appendChild(el("span", { class: "crumb-current" },
      tool ? `${tool.emoji} ${tool.name}` : id));
  } else {
    bc.appendChild(el("span", { class: "crumb-current" }, "Library"));
  }
}

function renderAll() {
  renderSidebar();
  const view = currentView();
  renderHeaderBreadcrumb();
  document.getElementById("header-settings")?.classList.toggle("active", view === "settings");
  document.getElementById("header-docs")?.classList.toggle("active", view === "services");
  if (view === "settings") renderSettings();
  else if (view === "services") renderServicesPage();
  else if (view.startsWith("plugin:")) renderPluginPage(view.slice("plugin:".length));
  else renderLibrary();
}

// ============================================================================
// Tauri event wiring
// ============================================================================

listen("clipboardtyper:state", (event) => {
  const p = event.payload;
  // Skip the re-render when this is just the echo of our own settings push —
  // otherwise editing a rule field would lose focus mid-keystroke. Still
  // re-render on external settings changes or enable/arm changes.
  const settingsSame = JSON.stringify(p.settings) === JSON.stringify(ctPending);
  const liveSame = p.running === ct.running && p.armed === ct.armed;
  ct = p;
  if (!settingsSame) ctPending = ctClonePending(p.settings);
  if (!settingsSame || !liveSame) renderAll();
});

listen("clipboardtyper:typed", (event) => {
  const { chars, error } = event.payload;
  if (error) logTo("clipboardtyper", `Typing failed: ${error}`, "error");
  else logTo("clipboardtyper", `Sent ${chars} char${chars === 1 ? "" : "s"} locally.`, "ok");
});

// ============================================================================
// Bootstrap
// ============================================================================

// Cancel any live COV subscription if the webview is torn down (reload, close),
// so the backend keep-alive thread doesn't orphan. Best-effort and synchronous-
// ish; the backend also self-terminates the keep-alive after repeated failures.
window.addEventListener("pagehide", () => {
  if (bac.cov.processId != null) {
    const dev = bacSelectedDevice();
    const [t, i] = (bac.cov.objectKey || "0:0").split(":").map((n) => parseInt(n, 10));
    if (dev) {
      invoke("bacnet_unsubscribe_cov", {
        device: bacDeviceRef(dev), objectType: t, instance: i, processId: bac.cov.processId,
      }).catch(() => {});
    }
  }
});

window.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("gh-link").addEventListener("click", (e) => {
    e.preventDefault();
    openExternal("https://github.com/stier1ba");
  });
  for (const btn of document.querySelectorAll(".sidebar-nav-item")) {
    btn.addEventListener("click", () => setView(btn.dataset.view));
  }

  document
    .getElementById("sidebar-toggle")
    ?.addEventListener("click", () => setSidebarCollapsed(!userState.sidebarCollapsed));
  applySidebarCollapsed();

  // App-header actions
  document.querySelector(".app-header")?.appendChild(buildAboutMenu());
  document.getElementById("header-files")?.addEventListener("click", openAppDataDir);
  document.getElementById("header-docs")?.addEventListener("click", () => setView("services"));
  document.getElementById("header-settings")?.addEventListener("click", () => setView("settings"));
  document.getElementById("header-about")?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleAboutMenu();
  });

  // Custom titlebar window controls (native window decorations are disabled,
  // so the app header doubles as the titlebar — drag via data-tauri-drag-region).
  const appWindow = window.__TAURI__.window.getCurrentWindow();
  const MAX_ICON =
    '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1"/></svg>';
  const RESTORE_ICON =
    '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1"/><path d="M2.5 2.5V0.5H9.5V7.5H7.5" fill="none" stroke="currentColor" stroke-width="1"/></svg>';
  async function syncMaxButton() {
    try {
      const maxed = await appWindow.isMaximized();
      const btn = document.getElementById("win-max");
      if (!btn) return;
      btn.innerHTML = maxed ? RESTORE_ICON : MAX_ICON;
      btn.title = maxed ? "Restore" : "Maximize";
      btn.setAttribute("aria-label", btn.title);
    } catch (_) {}
  }
  document.getElementById("win-min")?.addEventListener("click", () => appWindow.minimize());
  document.getElementById("win-max")?.addEventListener("click", async () => {
    await appWindow.toggleMaximize();
    syncMaxButton();
  });
  document.getElementById("win-close")?.addEventListener("click", () => appWindow.close());
  appWindow.onResized(() => syncMaxButton());
  syncMaxButton();

  try {
    const s = await invoke("clipboardtyper_get_state");
    ct = s;
    ctPending = ctClonePending(s.settings);
  } catch (err) {
    logTo("clipboardtyper", `Could not read state: ${err}`, "error");
  }

  // Boot the platform kernel: validate the tool manifests, resolve the
  // capability dependency graph, and register native capability implementations
  // (network.adapters, netscan, media.convert, bacnet.read, …). Defensive — a
  // kernel failure must never take down the rest of the UI.
  try {
    telemetry = createTimeseries();
    scheduler = createScheduler();
    rebuildCatalog();
    const installed = ALL_MANIFESTS.filter((m) => m.kind === "mcp");
    const factories = new Map([
      ...buildFactories(invoke, { timeseries: telemetry, scheduler }),
      ...buildMcpFactories(invoke, installed),
    ]);
    const installGrants = new Map(
      Object.entries(userState.installedGrants || {}).map(([id, perms]) => [id, new Set(perms)]),
    );
    platform = createKernel({
      manifests: ALL_MANIFESTS,
      factories,
      grant: grantsFromInstall(installGrants),
      onLog: (e) => console.debug(`[platform:${e.toolId}] ${e.msg}`),
    });
    const res = await platform.boot();
    if (!res.ok) console.warn("[platform] capability graph issues:", res.errors);

    // Observability Pack controller. The service starts degraded (ring buffer);
    // connecting attaches the live InfluxDB transport. The periodic flush is a
    // no-op until then, so it's safe to run unconditionally.
    pack = createPackController({ invoke, timeseries: telemetry });
    setInterval(() => { pack.flush().catch(() => {}); }, 10000);

    // Granular per-component install progress (download %, rate, ETA, extract…)
    // from the Rust downloader, rendered as a live progress bar.
    listen("observability://install", (e) => {
      obsProgress = e.payload || null;
      if (currentPluginId() === "observability") renderAll();
    });

    // Restore any previously-configured Historian points + resume logging.
    histRestore();

    // Passive pack-update check: surface in the Observability activity log if an
    // app update bumped a pinned component version past what's installed.
    pack.packStatus()
      .then((s) => {
        obsPack = s;
        if (s && s.updatesAvailable) {
          const outdated = (s.components || []).filter((c) => c.present && c.needsUpdate)
            .map((c) => `${OBS_COMPONENT_NAMES[c.name] || c.name} ${c.installedVersion}→${c.pinnedVersion}`).join(", ");
          logTo("observability", `Pack update available: ${outdated}. Open Observability → "Update & restart pack".`, "info");
        }
      })
      .catch(() => {});
  } catch (err) {
    console.error("[platform] kernel boot failed:", err);
  }

  // Load saved network profiles up front so the library card shows a count.
  // Live adapter state is read lazily when the Network Manager page opens.
  nmLoadProfiles().then(renderAll);

  renderAll();

  // Background update check on launch. Runs silently — only surfaces a
  // prompt when an update is found.
  setTimeout(() => { checkForUpdates({ silent: true }).catch(() => {}); }, 2500);
});
