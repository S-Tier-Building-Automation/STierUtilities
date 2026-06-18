// App shell — sidebar, breadcrumbs, render orchestration, updater.

import { updater, tauriProcess } from "../platform/tauri.js";
import { el } from "./dom.js";

/**
 * @param {object} deps
 * @param {string} deps.appVersion
 * @param {() => Array<object>} deps.getTools
 * @param {(id: string) => boolean} deps.isFavorite
 * @param {(id: string) => boolean} deps.isHidden
 * @param {(view: string) => void} deps.setView
 * @param {(id: string) => string} deps.pluginView
 * @param {() => string} deps.currentView
 * @param {() => string|null} deps.currentPluginId
 * @param {() => void} deps.applySidebarCollapsed
 * @param {(on: boolean) => void} deps.setSidebarCollapsed
 * @param {object} deps.pages — { library, settings, account, services, activity, plugin }
 * @param {() => object|null} deps.getBuildingWorkspace
 */
export function createAppShell({
  appVersion, getTools, isFavorite, isHidden, setView, pluginView,
  currentView, currentPluginId, applySidebarCollapsed, setSidebarCollapsed,
  pages, getBuildingWorkspace,
}) {
  let updateInFlight = false;
  let lastRenderedView = "";

  function setUpdateStatus(text, kind = "info") {
    const node = document.getElementById("update-status");
    if (!node) return;
    node.textContent = text;
    node.className = `menu-app-version update-status-${kind}`;
  }

  async function checkForUpdates({ manual = false, silent = false } = {}) {
    if (updateInFlight) return;
    updateInFlight = true;
    try {
      if (!silent) setUpdateStatus("Checking for updates…");
      const update = await updater.check();
      if (!update) {
        if (!silent) setUpdateStatus(`You're on the latest version (v${appVersion}).`, "ok");
        if (manual && !document.getElementById("update-status")) {
          alert(`You're on the latest version (v${appVersion}).`);
        }
        return;
      }
      setUpdateStatus(`Update available: v${update.version}. Download will start when confirmed.`, "warn");

      const ok = confirm(
        `A new version is available.\n\n` +
        `Installed: v${appVersion}\n` +
        `Latest:    v${update.version}\n\n` +
        (update.body ? `Notes:\n${update.body}\n\n` : "") +
        `Download and install now?`,
      );
      if (!ok) {
        setUpdateStatus(`Update v${update.version} available. Use "Check for update" to install later.`, "warn");
        return;
      }

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

  function renderSidebar() {
    const favList = document.getElementById("sidebar-favorites");
    favList.replaceChildren();
    const favTools = getTools().filter((t) => isFavorite(t.id) && !isHidden(t.id));
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
    for (const btn of document.querySelectorAll(".header-nav-item")) {
      btn.classList.toggle(
        "active",
        btn.dataset.view === "library"
          ? (view === "library" || view.startsWith("plugin:"))
          : btn.dataset.view === view,
      );
    }
  }

  function renderScrollTargets() {
    const selectors = [
      "#view-root",
      ".plugin-page",
      ".scroll-fill",
      ".bw-device-inbox-scroll",
      ".bw-tree-list",
      ".activity-log",
      ".bac-table-wrap",
      ".nm-scan-results",
    ];
    return selectors.flatMap((selector) =>
      [...document.querySelectorAll(selector)].map((node, index) => ({ selector, index, node })));
  }

  function captureRenderUiState() {
    const active = document.activeElement;
    let start = null;
    let end = null;
    if (active && active !== document.body) {
      try {
        start = active.selectionStart;
        end = active.selectionEnd;
      } catch (_) { /* checkbox/radio/file inputs throw on selection APIs */ }
    }
    const activeState = active && active !== document.body && active.id
      ? {
          id: active.id,
          start: typeof start === "number" ? start : null,
          end: typeof end === "number" ? end : null,
        }
      : null;
    return {
      active: activeState,
      scrolls: renderScrollTargets()
        .filter(({ node }) => node.scrollTop || node.scrollLeft)
        .map(({ selector, index, node }) => ({
          selector,
          index,
          top: node.scrollTop,
          left: node.scrollLeft,
        })),
    };
  }

  function restoreRenderUiState(state) {
    if (!state) return;
    for (const item of state.scrolls || []) {
      const node = document.querySelectorAll(item.selector)[item.index];
      if (!node) continue;
      node.scrollTop = item.top;
      node.scrollLeft = item.left;
    }
    if (state.active?.id) {
      const active = document.getElementById(state.active.id);
      if (active && typeof active.focus === "function") {
        active.focus({ preventScroll: true });
        if (state.active.start != null && typeof active.setSelectionRange === "function") {
          active.setSelectionRange(state.active.start, state.active.end ?? state.active.start);
        }
      }
    }
  }

  function renderHeaderBreadcrumb() {
    const bc = document.getElementById("header-breadcrumb");
    if (!bc) return;
    bc.replaceChildren();
    const view = currentView();
    if (view === "settings") {
      bc.appendChild(el("span", { class: "crumb-current" }, "Settings"));
    } else if (view === "account") {
      bc.appendChild(el("span", { class: "crumb-current" }, "Account"));
    } else if (view === "services") {
      bc.appendChild(el("span", { class: "crumb-current" }, "Services & Capabilities"));
    } else if (view === "activity") {
      bc.appendChild(el("span", { class: "crumb-current" }, "Activity"));
    } else if (view.startsWith("plugin:")) {
      const id = view.slice("plugin:".length);
      const tool = getTools().find((t) => t.id === id);
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

  function renderChrome() {
    renderSidebar();
    const view = currentView();
    renderHeaderBreadcrumb();
    document.getElementById("header-account-menu")?.classList.toggle(
      "active",
      view === "account" || view === "settings" || view === "services",
    );
  }

  function renderCurrentPage() {
    const view = currentView();
    if (view === "settings") pages.settings.renderPage();
    else if (view === "account") pages.account.renderPage();
    else if (view === "services") pages.services.renderPage();
    else if (view === "activity") pages.activity.renderPage();
    else if (view.startsWith("plugin:")) pages.plugin.renderPage(view.slice("plugin:".length));
    else pages.library.renderPage();
  }

  function renderScoped(scope = "page") {
    const bw = getBuildingWorkspace();
    if (scope === "chrome") {
      renderChrome();
      return;
    }
    if (scope === "building-workspace") {
      bw?.renderWorkspaceScope?.();
      return;
    }
    if (scope === "building-workspace:tab") {
      bw?.renderTabScope?.();
      return;
    }
    if (scope === "building-workspace:model") {
      bw?.renderModelScope?.({ tree: true, details: true, header: true });
      return;
    }
    if (scope === "building-workspace:inbox") {
      bw?.renderInboxScope?.();
      return;
    }
    if (scope === "all") {
      renderAll();
      return;
    }
    const view = currentView();
    const uiState = view === lastRenderedView ? captureRenderUiState() : null;
    renderCurrentPage();
    lastRenderedView = view;
    if (uiState) requestAnimationFrame(() => restoreRenderUiState(uiState));
  }

  function renderAll() {
    const view = currentView();
    const uiState = view === lastRenderedView ? captureRenderUiState() : null;
    renderChrome();
    renderCurrentPage();
    lastRenderedView = view;
    if (uiState) requestAnimationFrame(() => restoreRenderUiState(uiState));
  }

  return {
    renderAll,
    renderScoped,
    renderChrome,
    checkForUpdates,
    applySidebarCollapsed,
    setSidebarCollapsed,
  };
}
