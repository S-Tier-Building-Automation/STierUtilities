// Home overview — the branded operations hub: system health, quick launch, and
// recent activity. Control-room instrument styling lives in styles.css.

import { brandMark, BRAND } from "./brand.js";

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

  function statusCard({ title, label, detail, cls = "pill-idle", action = null }, index = 0) {
    // Map pill class to a state token for the left signal bar.
    const state = cls.replace("pill-", "");
    return el("article", { class: `home-stat-card home-reveal stat-${state}`, style: `--i:${index}` },
      el("span", { class: "home-stat-bar" }),
      el("div", { class: "home-stat-main" },
        el("div", { class: "home-stat-label" }, title),
        el("div", { class: "home-stat-value-row" },
          el("span", { class: "home-stat-value" }, label),
        ),
        detail ? el("p", { class: "muted small home-stat-detail" }, detail) : null,
      ),
      action ? el("div", { class: "home-stat-action" }, action) : null,
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
        tool.tagline ? el("span", { class: "home-quick-sub muted small" }, tool.tagline) : null,
      ),
      status ? el("span", { class: `pill pill-sm ${status.cls}` }, status.label) : null,
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

  function gridSection(heading, tools) {
    return [
      el("h3", { class: "section-subhead" }, heading),
      el("div", { class: "home-quick-grid" }, ...tools.map(quickTile)),
    ];
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

    // ---- Branded hero ----
    const healthChip = alertBadge > 0
      ? el("button", { class: "home-chip home-chip-alert", onclick: () => setView("activity") },
          el("span", { class: "home-dot dot-warn" }), `${alertBadge} alert${alertBadge === 1 ? "" : "s"}`)
      : el("span", { class: "home-chip home-chip-ok" }, el("span", { class: "home-dot dot-ok" }), "All systems nominal");

    const hero = el("section", { class: "home-hero home-reveal", style: "--i:0" },
      el("div", { class: "home-hero-mark" }, brandMark({ size: 46 })),
      el("div", { class: "home-hero-copy" },
        el("div", { class: "home-hero-eyebrow" }, BRAND.org),
        el("h2", { class: "home-hero-name" }, BRAND.name),
        el("p", { class: "home-hero-tagline muted" }, BRAND.tagline),
        el("div", { class: "home-hero-meta" },
          el("span", { class: "home-chip mono" }, `v${appVersion}`),
          el("span", { class: "home-chip home-chip-env" }, "LOCAL"),
          healthChip,
        ),
      ),
      el("div", { class: "home-hero-actions" },
        el("button", { class: "btn btn-primary", onclick: () => setView("library") }, "Browse library"),
        el("button", { class: "btn-ghost", onclick: () => setView("activity") }, "Activity"),
      ),
    );
    root.appendChild(hero);

    // ---- Instrument status strip ----
    const cards = [
      { title: "Observability", ...status.observability, view: pluginView("observability"), actionLabel: "Open" },
      { title: "Historian", ...status.historian, view: pluginView("bacnet-historian"), actionLabel: "Open" },
      { title: "Building model", ...status.inventory, view: pluginView("building-workspace"), actionLabel: "Open" },
      { title: "Platform", ...status.platform, view: "services", actionLabel: "Capabilities" },
    ];
    const stats = el("section", { class: "home-stats" }, ...cards.map((c, i) => statusCard({
      title: c.title, label: c.label, detail: c.detail, cls: c.cls,
      action: el("button", { class: "btn-ghost btn-sm", onclick: () => setView(c.view) }, c.actionLabel),
    }, i + 1)));
    root.appendChild(stats);

    // ---- Quick launch ----
    const bmsApps = ["building-workspace", "alarm-console", "building-analytics", "device-graphics", "graphics-builder", "schedules", "notes"]
      .map((id) => toolById(id))
      .filter((t) => t && !isHidden(t.id));
    if (bmsApps.length) root.append(...gridSection("Building automation", bmsApps));
    if (favTools.length) root.append(...gridSection("Favorites", favTools));
    if (recentTools.length) root.append(...gridSection("Recently used", recentTools));

    // ---- Lower panels ----
    const activityPanel = el("section", { class: "home-panel" },
      el("div", { class: "section-head" },
        el("h3", {}, "Recent activity"),
        el("button", { class: "btn-ghost btn-sm", onclick: () => setView("activity") }, "View all"),
      ),
      activity.recent.length
        ? el("ol", { class: "home-activity-list" }, ...activity.recent.map(activityRow))
        : el("div", { class: "home-empty" },
            el("p", { class: "muted small" }, "No activity yet. Get started:"),
            el("div", { class: "home-next-chips" },
              el("button", { class: "home-next-chip", onclick: () => setView(pluginView("bacnet-manager")) }, "Discover devices"),
              el("button", { class: "home-next-chip", onclick: () => setView(pluginView("building-workspace")) }, "Model a site"),
              el("button", { class: "home-next-chip", onclick: () => setView(pluginView("bacnet-historian")) }, "Historize points"),
            ),
          ),
    );

    const tipsPanel = el("section", { class: "home-panel home-panel-tips" },
      el("h3", {}, "Quick tips"),
      el("ul", { class: "home-tips" },
        el("li", {}, "Star tools in the Library to pin them in the sidebar."),
        el("li", {}, "Use the header search to jump to any tool by name or capability."),
        el("li", {}, "Building Workspace models BACnet sites; BACnet Manager discovers devices."),
      ),
    );

    root.appendChild(el("div", { class: "home-lower" }, activityPanel, tipsPanel));
  }

  return { renderPage };
}
