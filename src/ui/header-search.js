// Header tool search — quick launcher with keyboard navigation.

import { el } from "./dom.js";
import { filterTools } from "./tool-search.js";

const MAX_RESULTS = 8;

/**
 * @param {object} deps
 * @param {() => Array<object>} deps.getTools
 * @param {(id: string) => boolean} deps.isHidden
 * @param {(view: string) => void} deps.setView
 * @param {(id: string) => string} deps.pluginView
 */
export function initHeaderSearch({ getTools, isHidden, setView, pluginView }) {
  const input = document.getElementById("header-tool-search");
  const resultsEl = document.getElementById("header-search-results");
  if (!input || !resultsEl) return;

  let activeIndex = -1;

  function closeResults() {
    resultsEl.hidden = true;
    resultsEl.replaceChildren();
    activeIndex = -1;
  }

  function clearSearch() {
    input.value = "";
    closeResults();
  }

  function openTool(id) {
    closeResults();
    clearSearch();
    input.blur();
    setView(pluginView(id));
  }

  function renderResults(query) {
    const matches = filterTools(getTools(), query, { isHidden }).slice(0, MAX_RESULTS);
    resultsEl.replaceChildren();
    if (!query.trim() || matches.length === 0) {
      closeResults();
      if (query.trim()) {
        resultsEl.hidden = false;
        resultsEl.appendChild(el("div", { class: "header-search-empty" }, "No matching tools"));
      }
      return;
    }
    activeIndex = 0;
    resultsEl.hidden = false;
    for (let i = 0; i < matches.length; i++) {
      const tool = matches[i];
      resultsEl.appendChild(el("button", {
        type: "button",
        class: `header-search-item ${i === activeIndex ? "header-search-item-active" : ""}`,
        role: "option",
        onclick: () => openTool(tool.id),
      },
        el("span", { class: "header-search-icon" }, tool.emoji),
        el("span", { class: "header-search-copy" },
          el("span", { class: "header-search-name" }, tool.name),
          el("span", { class: "header-search-tag" }, tool.tagline),
        ),
      ));
    }
  }

  function highlightIndex(next) {
    const items = [...resultsEl.querySelectorAll(".header-search-item")];
    if (!items.length) return;
    activeIndex = (next + items.length) % items.length;
    items.forEach((node, i) => node.classList.toggle("header-search-item-active", i === activeIndex));
    items[activeIndex]?.scrollIntoView({ block: "nearest" });
  }

  input.addEventListener("input", () => renderResults(input.value));
  input.addEventListener("focus", () => { if (input.value.trim()) renderResults(input.value); });
  input.addEventListener("keydown", (e) => {
    const items = resultsEl.querySelectorAll(".header-search-item");
    if (e.key === "ArrowDown" && items.length) {
      e.preventDefault();
      highlightIndex(activeIndex + 1);
    } else if (e.key === "ArrowUp" && items.length) {
      e.preventDefault();
      highlightIndex(activeIndex - 1);
    } else if (e.key === "Enter") {
      if (activeIndex >= 0 && items[activeIndex]) {
        e.preventDefault();
        const tool = filterTools(getTools(), input.value, { isHidden })[activeIndex];
        if (tool) openTool(tool.id);
      }
    } else if (e.key === "Escape") {
      closeResults();
      input.blur();
    }
  });

  document.addEventListener("click", (e) => {
    if (input.contains(e.target) || resultsEl.contains(e.target)) return;
    closeResults();
  });

  window.addEventListener("stier:view-change", clearSearch);

  return { closeResults, clearSearch };
}
