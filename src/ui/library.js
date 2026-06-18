// Tool library — grid/list cards, favorites affordances, hidden tools.

/**
 * @param {object} deps
 * @param {import("./dom.js").el} deps.el
 * @param {() => object} deps.getUserState
 * @param {() => void} deps.saveUserState
 * @param {() => Array<object>} deps.getTools
 * @param {(id: string) => boolean} deps.isFavorite
 * @param {(id: string) => boolean} deps.isHidden
 * @param {(id: string, on: boolean) => void} deps.setFavorite
 * @param {(id: string, on: boolean) => void} deps.setHidden
 * @param {(view: string) => void} deps.setView
 * @param {(id: string) => string} deps.pluginView
 */
export function createLibraryUi({
  el, getUserState, saveUserState, getTools, isFavorite, isHidden, setFavorite, setHidden, setView, pluginView,
}) {

  function setShowHidden(on) {
    getUserState().showHidden = on;
    saveUserState();
    renderPage();
  }

  function setLibraryView(view) {
    getUserState().libraryView = view === "list" ? "list" : "grid";
    saveUserState();
    renderPage();
  }

  function toolStarBtn(tool) {
    const fav = isFavorite(tool.id);
    return el("button", {
      class: `star-btn ${fav ? "star-on" : ""}`,
      title: fav ? "Unfavorite" : "Favorite",
      "aria-pressed": fav ? "true" : "false",
      onclick: (e) => { e.stopPropagation(); setFavorite(tool.id, !fav); },
    }, fav ? "★" : "☆");
  }

  function toolHideBtn(tool) {
    return el("button", {
      class: "tool-hide",
      title: "Hide from library",
      "aria-label": `Hide ${tool.name}`,
      onclick: (e) => { e.stopPropagation(); setHidden(tool.id, true); },
    }, "×");
  }

  function toolStatusPill(tool) {
    const status = tool.renderStatusPill ? tool.renderStatusPill() : null;
    return status ? el("span", { class: `pill ${status.cls}` }, status.label) : null;
  }

  function renderToolCard(tool) {
    return el("article",
      {
        class: "tool-card",
        id: `tool-card-${tool.id}`,
        title: tool.tagline || tool.name,
        role: "button",
        tabindex: "0",
        onclick: () => setView(pluginView(tool.id)),
        onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setView(pluginView(tool.id)); } },
      },
      el("div", { class: "tool-icon" }, tool.emoji),
      el("div", { class: "tool-body" },
        el("div", { class: "tool-header" },
          el("h3", {}, tool.name),
          el("div", { class: "card-header-right" },
            toolStatusPill(tool),
            toolStarBtn(tool),
            toolHideBtn(tool),
          ),
        ),
        el("p", { class: "tool-tagline" }, tool.tagline),
      ),
    );
  }

  function renderToolRow(tool) {
    return el("li",
      {
        class: "tool-row",
        id: `tool-card-${tool.id}`,
        title: tool.tagline || tool.name,
        role: "button",
        tabindex: "0",
        onclick: () => setView(pluginView(tool.id)),
        onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setView(pluginView(tool.id)); } },
      },
      el("span", { class: "tool-row-icon" }, tool.emoji),
      el("span", { class: "tool-row-name" }, tool.name),
      el("span", { class: "tool-row-tag" }, tool.tagline),
      toolStatusPill(tool) || el("span", {}),
      toolStarBtn(tool),
      toolHideBtn(tool),
    );
  }

  function renderHiddenRow(tool) {
    return el("li", { class: "hidden-row" },
      el("span", { class: "hidden-row-icon" }, tool.emoji),
      el("span", { class: "hidden-row-name" }, tool.name),
      el("span", { class: "hidden-row-tag" }, "hidden"),
      el("button", { class: "btn-ghost", onclick: () => setHidden(tool.id, false) }, "Restore"),
    );
  }

  function renderPage() {
    const userState = getUserState();
    const root = document.getElementById("view-root");
    root.replaceChildren();

    const TOOLS = getTools();
    const visible = TOOLS.filter((t) => !isHidden(t.id));
    const hidden = TOOLS.filter((t) => isHidden(t.id));

    const listView = userState.libraryView === "list";
    const viewToggle = el("div", { class: "lib-toggle", role: "group", "aria-label": "Library layout" },
      el("button", {
        class: listView ? "" : "active",
        title: "Grid view", "aria-pressed": String(!listView),
        onclick: () => setLibraryView("grid"),
      }, "▦ Grid"),
      el("button", {
        class: listView ? "active" : "",
        title: "List view", "aria-pressed": String(listView),
        onclick: () => setLibraryView("list"),
      }, "☰ List"),
    );

    root.appendChild(el("div", { class: "view-header" },
      el("h2", {}, "Library"),
      el("div", { class: "view-header-right" },
        viewToggle,
        el("label", { class: "checkbox-row" },
          el("input", {
            type: "checkbox",
            checked: userState.showHidden ? "checked" : undefined,
            onchange: (e) => setShowHidden(e.target.checked),
          }),
          el("span", {}, `Show hidden (${hidden.length})`),
        ),
      ),
    ));

    if (visible.length === 0) {
      root.appendChild(el("p", { class: "empty-state" },
        hidden.length > 0
          ? "All tools are hidden. Toggle “Show hidden” to restore them."
          : "No tools available.",
      ));
    } else if (listView) {
      const list = el("ul", { class: "tool-list" });
      for (const tool of visible) list.appendChild(renderToolRow(tool));
      root.appendChild(list);
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

  return { renderPage, setLibraryView, setShowHidden };
}
