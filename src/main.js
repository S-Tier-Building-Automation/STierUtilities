const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const opener = window.__TAURI__.opener;

// -------------------- Tool catalog --------------------

const TOOLS = [
  {
    id: "clipboardtyper",
    name: "ClipboardTyper",
    emoji: "⌨️",
    tagline: "Middle-click your mouse to auto-type your clipboard.",
    description:
      "Useful for password fields, remote-desktop login screens, VMs, and anywhere Ctrl+V is blocked.",
    repo: "https://github.com/stier1ba/ClipboardTyper",
    renderControls: renderClipboardTyperControls,
  },
];

// -------------------- Persistent UI state --------------------

const STORAGE_KEY = "microtools.user_state.v1";

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
    view: stored.view === "settings" ? "settings" : "library",
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
  if (on) userState.hidden[id] = true;
  else delete userState.hidden[id];
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

// -------------------- Live tool state (ClipboardTyper) --------------------

let ct = {
  running: false,
  armed: false,
  settings: { type_delay_ms: 60, modifier_hold_ms: 40, start_delay_ms: 40 },
};
let ctPending = { ...ct.settings };

// -------------------- DOM helpers --------------------

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

function log(msg, kind = "info") {
  const list = document.getElementById("log-list");
  const time = new Date().toLocaleTimeString();
  const li = el(
    "li",
    { class: `log-${kind}` },
    el("span", { class: "log-time" }, time),
    el("span", { class: "log-msg" }, msg),
  );
  list.prepend(li);
  while (list.children.length > 50) list.removeChild(list.lastChild);
}

async function openExternal(url) {
  try {
    await opener.openUrl(url);
  } catch (err) {
    log(`Couldn't open link: ${err}`, "error");
  }
}

// -------------------- ClipboardTyper controls --------------------

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
      log(`Failed to update settings: ${err}`, "error");
    }
  }, 100);
}

async function ctToggleEnabled() {
  try {
    if (ct.running) {
      await invoke("clipboardtyper_stop");
      log("ClipboardTyper disabled. Middle-click is back to normal.", "warn");
    } else {
      await invoke("clipboardtyper_start");
      log("ClipboardTyper enabled. Middle-click anywhere to type your clipboard.", "ok");
    }
  } catch (err) {
    log(`${err}`, "error");
  }
}

async function ctSetArmed(armed) {
  try {
    await invoke("clipboardtyper_set_armed", { armed });
  } catch (err) {
    log(`Failed to set armed: ${err}`, "error");
  }
}

function renderClipboardTyperControls() {
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

  return el("div", {},
    el("div", { class: "tool-actions" }, enableBtn, armToggle),
    el("div", { class: "tool-settings" },
      el("h4", {}, "Timing"),
      ctSlider("type_delay_ms", "Type delay", 0, 200, 5, "ms"),
      ctSlider("modifier_hold_ms", "Modifier hold", 0, 200, 5, "ms"),
      ctSlider("start_delay_ms", "Start delay", 0, 500, 10, "ms"),
      el("p", { class: "settings-hint" },
        "Modifier hold matters for remote-desktop tools like DeskIn — raise it if shifted characters drop.",
      ),
    ),
  );
}

function renderClipboardTyperStatus() {
  return ctStatusPill();
}

// -------------------- Tool card (full) --------------------

function renderToolCard(tool) {
  const fav = isFavorite(tool.id);
  const status = tool.id === "clipboardtyper" ? renderClipboardTyperStatus() : null;

  const headerRight = el("div", { class: "card-header-right" });
  if (status) {
    headerRight.appendChild(el("span", { class: `pill ${status.cls}` }, status.label));
  }
  headerRight.appendChild(el("button", {
    class: `star-btn ${fav ? "star-on" : ""}`,
    title: fav ? "Unfavorite" : "Favorite",
    "aria-pressed": fav ? "true" : "false",
    onclick: () => setFavorite(tool.id, !fav),
  }, fav ? "★" : "☆"));

  const controls = tool.renderControls ? tool.renderControls() : null;

  const meta = el("div", { class: "tool-actions tool-actions-secondary" },
    el("button", { class: "btn-ghost", onclick: () => openExternal(tool.repo) }, "Source"),
    el("button", {
      class: "btn-ghost",
      onclick: () => setHidden(tool.id, true),
    }, "Hide"),
  );

  return el("article",
    {
      class: "tool-card",
      id: `tool-card-${tool.id}`,
      "data-tool": tool.id,
    },
    el("div", { class: "tool-icon" }, tool.emoji),
    el("div", { class: "tool-body" },
      el("div", { class: "tool-header" },
        el("h3", {}, tool.name),
        headerRight,
      ),
      el("p", { class: "tool-tagline" }, tool.tagline),
      el("p", { class: "tool-desc" }, tool.description),
      controls,
      meta,
    ),
  );
}

function renderHiddenRow(tool) {
  return el("li", { class: "hidden-row" },
    el("span", { class: "hidden-row-icon" }, tool.emoji),
    el("span", { class: "hidden-row-name" }, tool.name),
    el("span", { class: "hidden-row-tag" }, "hidden"),
    el("button", {
      class: "btn-ghost",
      onclick: () => setHidden(tool.id, false),
    }, "Restore"),
  );
}

// -------------------- Library view --------------------

function renderLibrary() {
  const root = document.getElementById("view-root");
  root.replaceChildren();

  const visible = TOOLS.filter((t) => !isHidden(t.id));
  const hidden = TOOLS.filter((t) => isHidden(t.id));

  const header = el("div", { class: "view-header" },
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
  );
  root.appendChild(header);

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

// -------------------- Settings view --------------------

function renderSettings() {
  const root = document.getElementById("view-root");
  root.replaceChildren();

  root.appendChild(el("div", { class: "view-header" },
    el("h2", {}, "Settings"),
  ));

  root.appendChild(el("section", { class: "settings-card" },
    el("h3", {}, "About"),
    el("p", {},
      "MicroTools is a small Tauri desktop hub for native Windows utilities.",
    ),
    el("p", {},
      "Source: ",
      el("a", { href: "#", onclick: (e) => { e.preventDefault(); openExternal("https://github.com/stier1ba/MicroTools"); } },
        "github.com/stier1ba/MicroTools"),
    ),
  ));

  root.appendChild(el("section", { class: "settings-card" },
    el("h3", {}, "Preferences"),
    el("p", { class: "settings-hint" },
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
        log("Preferences reset.", "ok");
      },
    }, "Reset preferences"),
  ));
}

// -------------------- Sidebar --------------------

function renderSidebar() {
  const favList = document.getElementById("sidebar-favorites");
  favList.replaceChildren();
  const favTools = TOOLS.filter((t) => isFavorite(t.id));
  if (favTools.length === 0) {
    favList.appendChild(el("li", { class: "sidebar-empty" },
      "No favorites yet. Tap the star on a tool.",
    ));
  } else {
    for (const tool of favTools) {
      favList.appendChild(el("li", {
        class: "sidebar-fav",
        onclick: () => focusTool(tool.id),
        title: tool.name,
      },
        el("span", { class: "sidebar-fav-icon" }, tool.emoji),
        el("span", { class: "sidebar-fav-name" }, tool.name),
      ));
    }
  }

  for (const btn of document.querySelectorAll(".sidebar-nav-item")) {
    btn.classList.toggle("active", btn.dataset.view === userState.view);
  }
}

function focusTool(id) {
  if (userState.view !== "library") setView("library");
  // After (possible) re-render
  requestAnimationFrame(() => {
    if (isHidden(id)) {
      setHidden(id, false);
    }
    const card = document.getElementById(`tool-card-${id}`);
    if (!card) return;
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.classList.remove("pulse");
    void card.offsetWidth; // restart animation
    card.classList.add("pulse");
  });
}

// -------------------- Top-level render --------------------

function renderAll() {
  renderSidebar();
  if (userState.view === "settings") renderSettings();
  else renderLibrary();
}

// -------------------- Tauri event wiring --------------------

listen("clipboardtyper:state", (event) => {
  ct = event.payload;
  ctPending = { ...ct.settings };
  renderAll();
});

listen("clipboardtyper:typed", (event) => {
  const { chars, error } = event.payload;
  if (error) log(`Typing failed: ${error}`, "error");
  else log(`Typed ${chars} char${chars === 1 ? "" : "s"}.`, "ok");
});

// -------------------- Bootstrap --------------------

window.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("clear-log").addEventListener("click", () => {
    document.getElementById("log-list").replaceChildren();
  });
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
    log(`Could not read ClipboardTyper state: ${err}`, "error");
  }
  renderAll();
});
