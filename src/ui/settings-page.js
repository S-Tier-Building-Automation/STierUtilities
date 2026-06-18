// Settings page — MCP tool install/remove and preference reset.

import { validateManifest } from "../platform/manifest.js";
import { approveInstall } from "../platform/mcp-loader.js";

/**
 * @param {object} deps
 * @param {typeof import("../platform/tauri.js").invoke} deps.invoke
 * @param {import("./dom.js").el} deps.el
 * @param {() => object} deps.getUserState
 * @param {() => void} deps.saveUserState
 * @param {() => Array<object>} deps.getAllManifests
 * @param {() => object|null} deps.getPlatform
 * @param {() => string|null} deps.currentPluginId
 * @param {() => boolean} deps.hasAuthSession
 * @param {() => void|Promise<void>} deps.resetPreferences
 */
export function createSettingsPageUi({
  invoke, el, getUserState, saveUserState, getAllManifests, getPlatform, currentPluginId, hasAuthSession, resetPreferences,
}) {

  async function mcpInstallFromJson(jsonText) {
    const userState = getUserState();
    let manifest;
    try { manifest = JSON.parse(jsonText); }
    catch (e) { alert(`Invalid JSON: ${e.message}`); return; }

    const { valid, errors } = validateManifest(manifest);
    if (!valid) { alert(`Invalid manifest:\n${errors.join("\n")}`); return; }
    if (manifest.kind !== "mcp") { alert('Only kind:"mcp" tools can be installed here.'); return; }
    if (getAllManifests().some((t) => t.id === manifest.id)) {
      alert(`A tool with id "${manifest.id}" already exists.`);
      return;
    }

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

    const granted = await approveInstall(manifest, () => true);

    userState.installedTools = [...(userState.installedTools || []), manifest];
    userState.installedGrants = { ...(userState.installedGrants || {}), [manifest.id]: [...granted] };
    saveUserState();
    alert(`Installed "${manifest.name}". The app will reload to start it.`);
    location.reload();
  }

  async function mcpRemove(id) {
    const userState = getUserState();
    if (!confirm("Remove this MCP tool?")) return;
    try { await invoke("mcp_stop", { id }); }
    catch (err) {
      console.warn(`mcp_stop(${id}) failed:`, err);
      if (!confirm(`Could not stop the MCP server (${err}). Remove it from the installed list anyway?`)) return;
    }
    userState.installedTools = (userState.installedTools || []).filter((t) => t.id !== id);
    const grants = { ...(userState.installedGrants || {}) };
    delete grants[id];
    userState.installedGrants = grants;
    if (currentPluginId() === id) userState.view = "library";
    saveUserState();
    location.reload();
  }

  function renderPage() {
    const userState = getUserState();
    const platform = getPlatform();
    const root = document.getElementById("view-root");
    root.replaceChildren();

    root.appendChild(el("div", { class: "view-header" },
      el("h2", {}, "Settings"),
    ));

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

    root.appendChild(el("section", { class: "settings-card" },
      el("h3", {}, "Preferences"),
      el("p", { class: "muted small" },
        hasAuthSession()
          ? "Favorites and hidden tools are saved to the active local profile."
          : "Favorites and hidden tools are stored locally in this app.",
      ),
      el("button", {
        class: "btn-ghost",
        onclick: resetPreferences,
      }, "Reset preferences"),
    ));
  }

  return { renderPage, mcpRemove };
}
