// Tool library — grid/list cards, favorites affordances, hidden tools.

import { filterTools, groupToolsByCategory } from "./tool-search.js";

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
 * @param {(id: string) => object|undefined} [deps.toolById]
 * @param {() => string[]} [deps.getRecentTools]
 */
export function createLibraryUi({
  el, getUserState, saveUserState, getTools, isFavorite, isHidden, setFavorite, setHidden, setView, pluginView,
  toolById = () => null, getRecentTools = () => [],
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

  function setLibrarySearch(value) {
    getUserState().librarySearch = value;
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

  function toolCategoryPill(tool) {
    const cat = tool.manifest?.category;
    if (!cat) return null;
    const label = cat === "service" ? "Service" : cat === "app" ? "App" : cat;
    return el("span", { class: "pill pill-muted pill-sm tool-cat-pill" }, label);
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
          el("div", { class: "tool-title-row" },
            el("h3", {}, tool.name),
            el("div", { class: "card-header-actions" },
              toolStarBtn(tool),
              toolHideBtn(tool),
            ),
          ),
          el("div", { class: "tool-meta-row" },
            toolCategoryPill(tool),
            toolStatusPill(tool),
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
      toolCategoryPill(tool) || el("span", {}),
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

  function renderRecentStrip() {
    const recent = getRecentTools()
      .map((id) => toolById(id))
      .filter((t) => t && !isHidden(t.id));
    if (!recent.length) return null;
    return el("section", { class: "lib-recent" },
      el("h3", { class: "section-subhead" }, "Recently used"),
      el("div", { class: "home-quick-grid lib-recent-grid" },
        ...recent.map((tool) => el("button", {
          type: "button",
          class: "home-quick-tile",
          onclick: () => setView(pluginView(tool.id)),
        },
          el("span", { class: "home-quick-icon" }, tool.emoji),
          el("span", { class: "home-quick-name" }, tool.name),
        )),
      ),
    );
  }

  function renderGroupedTools(tools, listView) {
    const userState = getUserState();
    const query = userState.librarySearch || "";
    const filtered = filterTools(tools, query, { isHidden });
    if (!query && !listView) {
      const groups = groupToolsByCategory(filtered, () => false);
      const wrap = el("div", { class: "lib-groups" });
      for (const group of groups) {
        wrap.appendChild(el("h3", { class: "section-subhead" }, group.label));
        const grid = el("section", { class: "tool-grid" });
        for (const tool of group.tools) grid.appendChild(renderToolCard(tool));
        wrap.appendChild(grid);
      }
      return wrap;
    }
    if (listView) {
      const list = el("ul", { class: "tool-list" });
      for (const tool of filtered) list.appendChild(renderToolRow(tool));
      return list;
    }
    const grid = el("section", { class: "tool-grid" });
    for (const tool of filtered) grid.appendChild(renderToolCard(tool));
    return grid;
  }

  function renderPage() {
    const userState = getUserState();
    const root = document.getElementById("view-root");
    root.replaceChildren();

    const TOOLS = getTools();
    const visible = TOOLS.filter((t) => !isHidden(t.id));
    const hidden = TOOLS.filter((t) => isHidden(t.id));
    const listView = userState.libraryView === "list";
    const search = userState.librarySearch || "";

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

    root.appendChild(el("div", { class: "lib-search-row" },
      el("input", {
        class: "nm-input lib-search",
        type: "search",
        placeholder: "Search tools by name, tagline, or capability…",
        value: search,
        oninput: (e) => setLibrarySearch(e.target.value),
      }),
    ));

    if (!search) {
      const recentStrip = renderRecentStrip();
      if (recentStrip) root.appendChild(recentStrip);
    }

    const filteredCount = filterTools(visible, search, { isHidden }).length;
    if (visible.length === 0) {
      root.appendChild(el("p", { class: "empty-state" },
        hidden.length > 0
          ? "All tools are hidden. Toggle “Show hidden” to restore them."
          : "No tools available.",
      ));
    } else if (filteredCount === 0) {
      root.appendChild(el("p", { class: "empty-state" }, `No tools match “${search}”.`));
    } else {
      root.appendChild(renderGroupedTools(visible, listView));
    }

    if (userState.showHidden && hidden.length > 0) {
      root.appendChild(el("h3", { class: "section-subhead" }, "Hidden"));
      const list = el("ul", { class: "hidden-list" });
      for (const tool of hidden) list.appendChild(renderHiddenRow(tool));
      root.appendChild(list);
    }
  }

  return { renderPage, setLibraryView, setShowHidden, setLibrarySearch };
}
