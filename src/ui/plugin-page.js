// Per-tool plugin page shell and third-party MCP tool pages.
//
// Chrome ownership: this module owns tool identity (name, tagline, status, star).
// Tools must not re-render those in renderPage(); use headerAddonFor for context only.
// See docs/rendering-standards.md § Tool page chrome ownership.

import { mount } from "svelte";
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

  // Build the shell-owned chrome (back link + plugin header with title, status
  // pill, favorite star) into `root`. Returns nothing; the body is appended by
  // the caller. Tools must NOT render this themselves.
  function buildChrome(root, tool) {
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
  }

  // Rebuild only the shell-owned chrome (breadcrumb + header with status pill and
  // favorite star), leaving the tool body in place. Used on return visits so the
  // header reflects status/favorite changes that happened while the tool was
  // hidden, without rebuilding (and discarding the state of) the live body.
  function refreshChrome(root, tool) {
    root.querySelectorAll(":scope > .breadcrumb, :scope > .plugin-header").forEach((n) => n.remove());
    const frag = document.createDocumentFragment();
    buildChrome(frag, tool);
    root.insertBefore(frag, root.firstChild);
  }

  /**
   * Render a tool page into `container` (the ContentRoot keep-alive host; falls
   * back to #view-root). Two kinds of tool:
   *  - Svelte tool (tool.component): the body is a Svelte component mounted ONCE
   *    and left reactive. On a self-refresh (renderAll while active) we rebuild
   *    only the chrome and re-attach the live body, so the component instance —
   *    and its $state — survive while the status pill/star stay current.
   *  - Legacy tool (tool.renderPage): body rebuilt imperatively each call.
   * `chromeOnly` (set on return visits) rebuilds just the chrome and preserves the
   * existing body for BOTH kinds — so a legacy tool's scroll/focus/in-flight state
   * is not lost, while its header still reflects the latest status/favorite.
   */
  function renderPage(id, container, { chromeOnly = false } = {}) {
    const root = container || document.getElementById("view-root");
    const tool = toolById(id);
    if (!tool) {
      root.replaceChildren(el("p", { class: "empty-state" }, "Unknown plugin."));
      return;
    }

    // Return visit to an already-built page: refresh chrome only, keep the body.
    if (chromeOnly && root.__stMountedId === id) {
      refreshChrome(root, tool);
      return;
    }

    if (tool.component) {
      const liveBody = root.__stMountedId === id ? root.querySelector(":scope > .plugin-body") : null;
      root.replaceChildren();
      buildChrome(root, tool);
      if (liveBody) {
        root.appendChild(liveBody); // re-attach the already-mounted Svelte body
      } else {
        const body = el("div", { class: "plugin-body" });
        root.appendChild(body);
        const props = typeof tool.componentProps === "function" ? tool.componentProps() : (tool.componentProps || {});
        mount(tool.component, { target: body, props });
        root.__stMountedId = id;
      }
      return;
    }

    root.replaceChildren();
    buildChrome(root, tool);
    if (tool.renderPage) root.appendChild(tool.renderPage(tool));
    root.__stMountedId = id;
  }

  return { renderPage, mcpToolRenderers };
}
