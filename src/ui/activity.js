// Centralized activity log and Activity page.

/**
 * @param {object} deps
 * @param {import("./dom.js").el} deps.el
 * @param {() => object} deps.getUserState
 * @param {() => void} deps.saveUserState
 * @param {() => string} deps.currentView
 * @param {() => Array<object>} deps.getTools
 * @param {(id: string) => boolean} deps.isHidden
 * @param {(toolId: string) => string} deps.toolLabel
 */
export function createActivityLog({
  el, getUserState, saveUserState, currentView, getTools, isHidden, toolLabel,
}) {
  const pluginLogs = new Map();

  function logTo(toolId, msg, kind = "info") {
    let arr = pluginLogs.get(toolId);
    if (!arr) {
      arr = [];
      pluginLogs.set(toolId, arr);
    }
    arr.unshift({ time: new Date(), msg, kind });
    while (arr.length > 100) arr.pop();
    if (currentView() === "activity") renderPage();
  }

  function activityEntries() {
    return [...pluginLogs.entries()]
      .flatMap(([toolId, entries]) => entries.map((entry) => ({ ...entry, toolId, toolLabel: toolLabel(toolId) })))
      .sort((a, b) => b.time - a.time);
  }

  function filteredActivityEntries() {
    const userState = getUserState();
    const toolFilter = userState.activityToolFilter || "all";
    const kindFilter = userState.activityKindFilter || "all";
    return activityEntries().filter((entry) =>
      (toolFilter === "all" || entry.toolId === toolFilter) &&
      (kindFilter === "all" || entry.kind === kindFilter));
  }

  function renderActivityLogEntry(entry) {
    return el("li", { class: `log-${entry.kind} activity-log-row` },
      el("span", { class: "log-time" }, entry.time.toLocaleTimeString()),
      el("span", { class: "activity-source" }, entry.toolLabel),
      el("span", { class: `activity-kind activity-kind-${entry.kind}` }, entry.kind),
      el("span", { class: "log-msg" }, entry.msg),
    );
  }

  function setActivityFilter(key, value) {
    getUserState()[key] = value;
    saveUserState();
    renderPage();
  }

  function clearActivityFiltered() {
    const userState = getUserState();
    const toolFilter = userState.activityToolFilter || "all";
    const kindFilter = userState.activityKindFilter || "all";
    if (toolFilter === "all" && kindFilter === "all") {
      pluginLogs.clear();
    } else {
      for (const [toolId, entries] of pluginLogs.entries()) {
        if (toolFilter !== "all" && toolId !== toolFilter) continue;
        if (kindFilter === "all") {
          pluginLogs.delete(toolId);
          continue;
        }
        const remaining = entries.filter((entry) => entry.kind !== kindFilter);
        if (remaining.length) pluginLogs.set(toolId, remaining);
        else pluginLogs.delete(toolId);
      }
    }
    renderPage();
  }

  function renderPage() {
    const root = document.getElementById("view-root");
    root.replaceChildren();
    const userState = getUserState();
    const entries = filteredActivityEntries();
    const allEntries = activityEntries();
    const toolFilter = userState.activityToolFilter || "all";
    const kindFilter = userState.activityKindFilter || "all";
    const toolIds = new Set(getTools().filter((tool) => !isHidden(tool.id)).map((tool) => tool.id));
    for (const entry of allEntries) toolIds.add(entry.toolId);
    if (toolFilter !== "all") toolIds.add(toolFilter);
    const activityToolIds = [...toolIds].sort((a, b) => toolLabel(a).localeCompare(toolLabel(b)));
    const kinds = ["ok", "info", "warn", "error"];

    root.appendChild(el("div", { class: "view-header" },
      el("h2", {}, "Activity"),
      el("div", { class: "view-header-right" },
        el("button", { class: "btn-ghost", disabled: allEntries.length ? undefined : "disabled", onclick: clearActivityFiltered }, "Clear"),
      ),
    ));

    root.appendChild(el("section", { class: "plugin-section plugin-section-fill activity-panel" },
      el("div", { class: "activity-controls" },
        el("label", { class: "nm-field activity-filter" },
          el("span", { class: "nm-field-label" }, "Tool"),
          el("select", {
            class: "nm-input",
            onchange: (e) => setActivityFilter("activityToolFilter", e.target.value),
          },
            el("option", { value: "all", selected: toolFilter === "all" ? "selected" : undefined }, "All tools"),
            ...activityToolIds.map((toolId) => {
              const count = allEntries.filter((entry) => entry.toolId === toolId).length;
              return el("option", { value: toolId, selected: toolFilter === toolId ? "selected" : undefined }, `${toolLabel(toolId)} (${count})`);
            }))),
        el("label", { class: "nm-field activity-filter" },
          el("span", { class: "nm-field-label" }, "Status"),
          el("select", {
            class: "nm-input",
            onchange: (e) => setActivityFilter("activityKindFilter", e.target.value),
          },
            el("option", { value: "all", selected: kindFilter === "all" ? "selected" : undefined }, "All statuses"),
            ...kinds.map((kind) => {
              const count = allEntries.filter((entry) => entry.kind === kind).length;
              return el("option", { value: kind, selected: kindFilter === kind ? "selected" : undefined }, `${kind} (${count})`);
            })))),
      entries.length === 0
        ? el("p", { class: "muted small activity-empty" }, allEntries.length ? "No activity matches the current filters." : "No activity yet. Use a tool and its events will appear here.")
        : el("ol", { id: "activity-log-list", class: "plugin-log activity-log scroll-fill" },
            ...entries.map(renderActivityLogEntry),
          ),
    ));
  }

  return { logTo, renderPage };
}
