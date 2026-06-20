// Per-tool plugin page shell and third-party MCP tool pages.

import { openModal } from "./modal.js";
import { openExternal } from "./dom.js";

function aboutModalBody(el, tool) {
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

/**
 * @param {object} deps
 * @param {import("./dom.js").el} deps.el
 * @param {(id: string) => object|undefined} deps.toolById
 * @param {(id: string) => boolean} deps.isFavorite
 * @param {(id: string, on: boolean) => void} deps.setFavorite
 * @param {(view: string) => void} deps.setView
 * @param {(id: string) => string} deps.pluginView
 * @param {(tool: object) => Node|null} deps.headerAddonFor
 * @param {() => object|null} deps.getPlatform
 * @param {(id: string) => void|Promise<void>} deps.mcpRemove
 */
export function createPluginPageUi({
  el, toolById, isFavorite, setFavorite, setView, pluginView, headerAddonFor, getPlatform, mcpRemove,
}) {

  function mcpStatusPill(m) {
    const platform = getPlatform();
    if (platform && platform.isBooted(m.id)) return { label: "Connected", cls: "pill-running" };
    return { label: "Off", cls: "pill-muted" };
  }

  function renderMcpToolPage(m) {
    const platform = getPlatform();
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
        el("p", { class: "muted small" }, `Command: ${entry.command || "?"} ${(Array.isArray(entry.args) ? entry.args : []).join(" ")}`),
        el("div", { class: "tool-actions" },
          el("button", { class: "btn-ghost", onclick: () => mcpRemove(m.id) }, "Remove tool"),
        ),
      ),
    );
  }

  function mcpToolRenderers(m) {
    return { renderStatusPill: () => mcpStatusPill(m), renderPage: () => renderMcpToolPage(m) };
  }

  function renderPage(id) {
    const root = document.getElementById("view-root");
    root.replaceChildren();
    const tool = toolById(id);
    if (!tool) {
      root.appendChild(el("p", { class: "empty-state" }, "Unknown plugin."));
      return;
    }
    const status = tool.renderStatusPill ? tool.renderStatusPill() : null;
    const fav = isFavorite(tool.id);
    const headerAddon = headerAddonFor(tool);

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
        el("div", { class: "plugin-header-copy" },
          el("div", { class: "plugin-title-row" },
            el("h2", { class: "plugin-title" }, tool.name),
            hasAbout && el("button", {
              class: "info-btn",
              title: "About this tool",
              "aria-label": `About ${tool.name}`,
              onclick: () => openModal({ title: `About ${tool.name}`, body: aboutModalBody(el, tool) }),
            }, "ⓘ"),
          ),
          el("p", { class: "plugin-tagline" }, tool.tagline),
          headerAddon,
        ),
      ),
      el("div", { class: "plugin-header-right" },
        status && el("span", { class: `pill ${status.cls}`, role: "status", "aria-live": "polite" }, status.label),
        el("button", {
          class: `star-btn ${fav ? "star-on" : ""}`,
          title: fav ? "Unfavorite" : "Favorite",
          "aria-pressed": fav ? "true" : "false",
          onclick: () => setFavorite(tool.id, !fav),
        }, fav ? "★" : "☆"),
      ),
    ));

    if (tool.renderPage) root.appendChild(tool.renderPage(tool));
  }

  return { renderPage, mcpToolRenderers };
}
