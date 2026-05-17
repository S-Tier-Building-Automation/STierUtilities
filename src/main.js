const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const opener = window.__TAURI__.opener;

const CLIPBOARDTYPER = {
  id: "clipboardtyper",
  name: "ClipboardTyper",
  emoji: "⌨️",
  tagline: "Middle-click your mouse to auto-type your clipboard.",
  description:
    "Useful for password fields, remote-desktop login screens, VMs, and anywhere Ctrl+V is blocked.",
  repo: "https://github.com/stier1ba/ClipboardTyper",
};

let state = {
  running: false,
  armed: false,
  settings: { type_delay_ms: 60, modifier_hold_ms: 40, start_delay_ms: 40 },
};

let pendingSettings = { ...state.settings };

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
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

function statusPill() {
  if (!state.running) return { label: "Idle", cls: "pill-idle" };
  if (state.armed) return { label: "Armed", cls: "pill-running" };
  return { label: "Standby", cls: "pill-muted" };
}

function slider(key, label, min, max, step, suffix) {
  const valueEl = el("span", { class: "slider-value" }, `${pendingSettings[key]} ${suffix}`);
  const input = el("input", {
    type: "range",
    min: String(min),
    max: String(max),
    step: String(step),
    value: String(pendingSettings[key]),
    oninput: (e) => {
      pendingSettings[key] = Number(e.target.value);
      valueEl.textContent = `${pendingSettings[key]} ${suffix}`;
      pushSettings();
    },
  });
  return el(
    "div",
    { class: "slider-row" },
    el("label", {}, label),
    input,
    valueEl,
  );
}

let pushTimer = null;
function pushSettings() {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    try {
      await invoke("clipboardtyper_set_settings", { settings: { ...pendingSettings } });
    } catch (err) {
      log(`Failed to update settings: ${err}`, "error");
    }
  }, 100);
}

function renderCard() {
  const tool = CLIPBOARDTYPER;
  const { label, cls } = statusPill();

  const enableBtn = el(
    "button",
    {
      class: state.running ? "btn btn-danger" : "btn btn-primary",
      onclick: toggleEnabled,
    },
    state.running ? "Disable" : "Enable",
  );

  const armToggle = el(
    "label",
    { class: `toggle ${state.armed ? "toggle-on" : ""} ${!state.running ? "toggle-disabled" : ""}` },
    el("input", {
      type: "checkbox",
      checked: state.armed ? "checked" : undefined,
      disabled: !state.running ? "disabled" : undefined,
      onchange: async (e) => {
        try {
          await invoke("clipboardtyper_set_armed", { armed: e.target.checked });
        } catch (err) {
          log(`Failed to set armed: ${err}`, "error");
        }
      },
    }),
    el("span", { class: "toggle-track" }, el("span", { class: "toggle-knob" })),
    el("span", { class: "toggle-label" }, "Armed"),
  );

  const settings = el(
    "div",
    { class: "tool-settings" },
    el("h4", {}, "Timing"),
    slider("type_delay_ms", "Type delay", 0, 200, 5, "ms"),
    slider("modifier_hold_ms", "Modifier hold", 0, 200, 5, "ms"),
    slider("start_delay_ms", "Start delay", 0, 500, 10, "ms"),
    el(
      "p",
      { class: "settings-hint" },
      "Modifier hold matters for remote-desktop tools like DeskIn — raise if shifted characters drop.",
    ),
  );

  const card = el(
    "article",
    { class: "tool-card", "data-tool": tool.id },
    el("div", { class: "tool-icon" }, tool.emoji),
    el(
      "div",
      { class: "tool-body" },
      el(
        "div",
        { class: "tool-header" },
        el("h3", {}, tool.name),
        el("span", { class: `pill ${cls}` }, label),
      ),
      el("p", { class: "tool-tagline" }, tool.tagline),
      el("p", { class: "tool-desc" }, tool.description),
      el(
        "div",
        { class: "tool-actions" },
        enableBtn,
        armToggle,
        el("button", { class: "btn-ghost", onclick: () => openExternal(tool.repo) }, "Source"),
      ),
      settings,
    ),
  );
  return card;
}

function renderAll() {
  document.getElementById("tool-grid").replaceChildren(renderCard());
}

async function toggleEnabled() {
  try {
    if (state.running) {
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

async function openExternal(url) {
  try {
    await opener.openUrl(url);
  } catch (err) {
    log(`Couldn't open link: ${err}`, "error");
  }
}

function applyState(next) {
  state = next;
  pendingSettings = { ...next.settings };
  renderAll();
}

listen("clipboardtyper:state", (event) => {
  applyState(event.payload);
});

listen("clipboardtyper:typed", (event) => {
  const { chars, error } = event.payload;
  if (error) log(`Typing failed: ${error}`, "error");
  else log(`Typed ${chars} char${chars === 1 ? "" : "s"}.`, "ok");
});

window.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("clear-log").addEventListener("click", () => {
    document.getElementById("log-list").replaceChildren();
  });
  document.getElementById("gh-link").addEventListener("click", (e) => {
    e.preventDefault();
    openExternal("https://github.com/stier1ba");
  });

  try {
    const s = await invoke("clipboardtyper_get_state");
    applyState(s);
  } catch (err) {
    log(`Could not read ClipboardTyper state: ${err}`, "error");
    renderAll();
  }
});
