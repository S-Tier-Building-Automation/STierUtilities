// Home overview — system health, quick launch, and recent activity.

/**
 * @param {object} deps
 * @param {import("./dom.js").el} deps.el
 * @param {string} deps.appVersion
 * @param {() => Array<object>} deps.getTools
 * @param {(id: string) => boolean} deps.isFavorite
 * @param {(id: string) => boolean} deps.isHidden
 * @param {(id: string) => object|undefined} deps.toolById
 * @param {() => string[]} deps.getRecentTools
 * @param {(view: string) => void} deps.setView
 * @param {(id: string) => string} deps.pluginView
 * @param {() => object} deps.getActivitySummary
 * @param {() => object} deps.getSystemStatus
 */
export function createHomeUi({
  el, appVersion, getTools, isFavorite, isHidden, toolById, getRecentTools,
  setView, pluginView, getActivitySummary, getSystemStatus,
}) {

  function statusCard({ title, label, detail, cls = "pill-idle", action = null }) {
    return el("article", { class: "home-stat-card" },
      el("div", { class: "home-stat-head" },
        el("h3", { class: "home-stat-title" }, title),
        el("span", { class: `pill ${cls}` }, label)),
      detail ? el("p", { class: "muted small home-stat-detail" }, detail) : null,
      action || null,
    );
  }

  function quickTile(tool) {
    const status = tool.renderStatusPill ? tool.renderStatusPill() : null;
    return el("button", {
      type: "button",
      class: "home-quick-tile",
      title: tool.tagline || tool.name,
      onclick: () => setView(pluginView(tool.id)),
    },
      el("span", { class: "home-quick-icon" }, tool.emoji),
      el("span", { class: "home-quick-copy" },
        el("span", { class: "home-quick-name" }, tool.name),
        status ? el("span", { class: `pill pill-sm ${status.cls}` }, status.label) : null,
      ),
    );
  }

  function activityRow(entry) {
    return el("li", { class: `home-activity-row log-${entry.kind}` },
      el("span", { class: "log-time" }, entry.time.toLocaleTimeString()),
      el("span", { class: "activity-source" }, entry.toolLabel),
      el("span", { class: `activity-kind activity-kind-${entry.kind}` }, entry.kind),
      el("span", { class: "log-msg" }, entry.msg),
    );
  }

  function renderPage() {
    const root = document.getElementById("view-root");
    root.replaceChildren();

    const status = getSystemStatus();
    const activity = getActivitySummary();
    const favTools = getTools().filter((t) => isFavorite(t.id) && !isHidden(t.id));
    const recentIds = getRecentTools().filter((id) => !isHidden(id));
    const recentTools = recentIds.map((id) => toolById(id)).filter(Boolean);

    const alertBadge = activity.errors + activity.warns;
    root.appendChild(el("div", { class: "view-header home-header" },
      el("div", { class: "home-header-copy" },
        el("h2", {}, "Home"),
        el("p", { class: "muted small home-subtitle" }, `S-Tier Utilities v${appVersion} — your local operations hub`),
      ),
      el("div", { class: "view-header-right" },
        alertBadge > 0
          ? el("button", {
              class: "btn-ghost home-alert-btn",
              onclick: () => setView("activity"),
            }, `${alertBadge} alert${alertBadge === 1 ? "" : "s"}`)
          : null,
        el("button", { class: "btn-ghost", onclick: () => setView("library") }, "Browse library"),
      ),
    ));

    const stats = el("section", { class: "home-stats" },
      statusCard({
        title: "Observability",
        label: status.observability.label,
        detail: status.observability.detail,
        cls: status.observability.cls,
        action: el("button", { class: "btn-ghost btn-sm", onclick: () => setView(pluginView("observability")) }, "Open"),
      }),
      statusCard({
        title: "Historian",
        label: status.historian.label,
        detail: status.historian.detail,
        cls: status.historian.cls,
        action: el("button", { class: "btn-ghost btn-sm", onclick: () => setView(pluginView("bacnet-historian")) }, "Open"),
      }),
      statusCard({
        title: "Building model",
        label: status.inventory.label,
        detail: status.inventory.detail,
        cls: status.inventory.cls,
        action: el("button", { class: "btn-ghost btn-sm", onclick: () => setView(pluginView("building-workspace")) }, "Open"),
      }),
      statusCard({
        title: "Platform",
        label: status.platform.label,
        detail: status.platform.detail,
        cls: status.platform.cls,
        action: el("button", { class: "btn-ghost btn-sm", onclick: () => setView("services") }, "Capabilities"),
      }),
    );
    root.appendChild(stats);

    const bmsApps = ["building-workspace", "alarm-console", "building-analytics", "device-graphics"]
      .map((id) => toolById(id))
      .filter((t) => t && !isHidden(t.id));
    if (bmsApps.length) {
      root.appendChild(el("h3", { class: "section-subhead" }, "Building automation"));
      root.appendChild(el("div", { class: "home-quick-grid" }, ...bmsApps.map(quickTile)));
    }

    if (favTools.length) {
      root.appendChild(el("h3", { class: "section-subhead" }, "Favorites"));
      root.appendChild(el("div", { class: "home-quick-grid" }, ...favTools.map(quickTile)));
    }

    if (recentTools.length) {
      root.appendChild(el("h3", { class: "section-subhead" }, "Recently used"));
      root.appendChild(el("div", { class: "home-quick-grid" }, ...recentTools.map(quickTile)));
    }

    root.appendChild(el("div", { class: "home-lower" },
      el("section", { class: "home-panel" },
        el("div", { class: "section-head" },
          el("h3", {}, "Recent activity"),
          el("button", { class: "btn-ghost btn-sm", onclick: () => setView("activity") }, "View all"),
        ),
        activity.recent.length
          ? el("ol", { class: "home-activity-list" }, ...activity.recent.map(activityRow))
          : el("p", { class: "muted small" }, "No activity yet. Open a tool and events will show up here."),
      ),
      el("section", { class: "home-panel home-panel-tips" },
        el("h3", {}, "Quick tips"),
        el("ul", { class: "home-tips" },
          el("li", {}, "Star tools in the Library to pin them in the sidebar."),
          el("li", {}, "Use the header search to jump to any tool by name or capability."),
          el("li", {}, "Building Workspace models BACnet sites; BACnet Manager discovers devices."),
        ),
      ),
    ));
  }

  return { renderPage };
}
