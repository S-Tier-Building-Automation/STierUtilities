const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const opener = window.__TAURI__.opener;

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
      "Useful for password fields, remote-desktop login screens, VMs, and " +
      "anywhere Ctrl+V is blocked. ClipboardTyper installs a low-level mouse " +
      "hook while enabled; middle-clicks are intercepted and your clipboard " +
      "contents are typed at the focused field as real keystrokes.",
    repo: "https://github.com/stier1ba/ClipboardTyper",
    renderStatusPill: ctStatusPill,
    renderPage: renderClipboardTyperPage,
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
              ? "Middle-click anywhere — the clipboard text will be typed."
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
        "Modifier hold matters for remote-desktop tools like DeskIn — raise it ",
        "if shifted characters drop on the wire.",
      ),
    ),
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

  root.appendChild(el("section", { class: "settings-card" },
    el("h3", {}, "About"),
    el("p", {}, "MicroTools is a small Tauri desktop hub for native Windows utilities."),
    el("p", {},
      "Source: ",
      el("a", {
        href: "#",
        onclick: (e) => { e.preventDefault(); openExternal("https://github.com/stier1ba/MicroTools"); },
      }, "github.com/stier1ba/MicroTools"),
    ),
  ));

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
  else logTo("clipboardtyper", `Typed ${chars} char${chars === 1 ? "" : "s"}.`, "ok");
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
  renderAll();
});
