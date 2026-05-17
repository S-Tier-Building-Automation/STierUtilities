const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const opener = window.__TAURI__.opener;

const TOOLS = [
  {
    id: "clipboardtyper",
    name: "ClipboardTyper",
    emoji: "⌨️",
    tagline: "Middle-click your mouse to auto-type your clipboard.",
    description:
      "Useful for password fields, remote-desktop login screens, VMs, and anywhere Ctrl+V is blocked.",
    repo: "https://github.com/stier1ba/ClipboardTyper",
    launchCmd: "launch_clipboardtyper",
  },
];

const state = {
  running: new Set(),
  pythonOk: false,
};

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function log(msg, kind = "info") {
  const list = document.getElementById("log-list");
  const time = new Date().toLocaleTimeString();
  const li = el("li", { class: `log-${kind}` },
    el("span", { class: "log-time" }, time),
    el("span", { class: "log-msg" }, msg),
  );
  list.prepend(li);
  while (list.children.length > 50) list.removeChild(list.lastChild);
}

function renderCard(tool) {
  const isRunning = state.running.has(tool.id);
  const card = el("article", { class: "tool-card", "data-tool": tool.id });
  card.appendChild(
    el("div", { class: "tool-icon" }, tool.emoji),
  );
  card.appendChild(
    el("div", { class: "tool-body" },
      el("div", { class: "tool-header" },
        el("h3", {}, tool.name),
        el("span", {
          class: `pill ${isRunning ? "pill-running" : "pill-idle"}`,
          "data-status": tool.id,
        }, isRunning ? "Running" : "Idle"),
      ),
      el("p", { class: "tool-tagline" }, tool.tagline),
      el("p", { class: "tool-desc" }, tool.description),
      el("div", { class: "tool-actions" },
        el("button", {
          class: isRunning ? "btn btn-danger" : "btn btn-primary",
          "data-action": tool.id,
          onclick: () => toggleTool(tool),
        }, isRunning ? "Stop" : "Launch"),
        el("button", {
          class: "btn-ghost",
          onclick: () => openExternal(tool.repo),
        }, "Source"),
      ),
    ),
  );
  return card;
}

function renderAll() {
  const grid = document.getElementById("tool-grid");
  grid.replaceChildren(...TOOLS.map(renderCard));
}

function updateCardState(toolId) {
  const isRunning = state.running.has(toolId);
  const pill = document.querySelector(`.pill[data-status="${toolId}"]`);
  const btn = document.querySelector(`[data-action="${toolId}"]`);
  if (pill) {
    pill.textContent = isRunning ? "Running" : "Idle";
    pill.className = `pill ${isRunning ? "pill-running" : "pill-idle"}`;
  }
  if (btn) {
    btn.textContent = isRunning ? "Stop" : "Launch";
    btn.className = isRunning ? "btn btn-danger" : "btn btn-primary";
  }
}

async function toggleTool(tool) {
  if (state.running.has(tool.id)) {
    try {
      await invoke("stop_tool", { toolId: tool.id });
      state.running.delete(tool.id);
      updateCardState(tool.id);
      log(`Stopped ${tool.name}.`, "warn");
    } catch (err) {
      log(`Stop failed: ${err}`, "error");
    }
    return;
  }
  if (!state.pythonOk) {
    log("Python is required but was not detected. Install Python 3.10+ and ensure it's on PATH.", "error");
    return;
  }
  try {
    const pid = await invoke(tool.launchCmd);
    state.running.add(tool.id);
    updateCardState(tool.id);
    log(`Launched ${tool.name} (PID ${pid}). Look for its console window.`, "ok");
  } catch (err) {
    const msg = String(err);
    log(`Launch failed: ${msg}`, "error");
    if (msg.toLowerCase().includes("no module named")) {
      log("Looks like missing Python deps. Installing them now…", "info");
      await installDeps(tool);
    }
  }
}

async function installDeps(tool) {
  try {
    await invoke("install_clipboardtyper_deps");
    log("Dependencies installed. Try Launch again.", "ok");
  } catch (err) {
    log(`pip install failed: ${err}`, "error");
  }
}

async function openExternal(url) {
  try {
    await opener.openUrl(url);
  } catch (err) {
    log(`Couldn't open link: ${err}`, "error");
  }
}

async function checkPython() {
  const badge = document.getElementById("python-badge");
  try {
    const ver = await invoke("check_python");
    badge.textContent = `Python: ${ver}`;
    badge.className = "pill pill-ok";
    state.pythonOk = true;
  } catch (err) {
    badge.textContent = "Python: not found";
    badge.className = "pill pill-error";
    state.pythonOk = false;
    log("Python isn't on PATH. Install from python.org and restart the app.", "error");
  }
}

async function syncRunningState() {
  for (const tool of TOOLS) {
    try {
      const running = await invoke("tool_running", { toolId: tool.id });
      if (running) state.running.add(tool.id);
      else state.running.delete(tool.id);
      updateCardState(tool.id);
    } catch (_) {
      // ignore
    }
  }
}

listen("tool-exited", (event) => {
  const { tool_id, code } = event.payload;
  state.running.delete(tool_id);
  updateCardState(tool_id);
  const tool = TOOLS.find((t) => t.id === tool_id);
  const name = tool ? tool.name : tool_id;
  log(
    code === 0 || code === null
      ? `${name} exited.`
      : `${name} exited with code ${code}.`,
    code === 0 || code === null ? "info" : "warn",
  );
});

window.addEventListener("DOMContentLoaded", () => {
  renderAll();
  checkPython();
  syncRunningState();
  document.getElementById("clear-log").addEventListener("click", () => {
    document.getElementById("log-list").replaceChildren();
  });
  document.getElementById("gh-link").addEventListener("click", (e) => {
    e.preventDefault();
    openExternal("https://github.com/stier1ba");
  });
});
