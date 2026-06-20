# Rendering Standards

S-Tier Utilities is a local-first operational app. UI updates should feel stable, fast, and field-friendly. Avoid full app redraws for ordinary actions.

## Render Scope Rule

Use the smallest render scope that reflects the state change:

| State change | Preferred render |
| --- | --- |
| CSS-only state, selected rows, disabled buttons | Mutate the existing DOM nodes/classes |
| Table/list contents changed | Replace only that table/list body |
| Context menu opened/closed | Mount/remove the menu overlay only |
| Current tool tab changed | Re-render that tool's body, not the app shell |
| Current tool model/detail changed | Re-render the affected pane(s), not the whole tool |
| Sidebar/header/library navigation changed | Re-render chrome and current page |
| Tool install/remove, capability graph changed, app boot state changed | Full app render or true reload only when required |

## App Helpers

`src/main.js` exposes these render scopes:

- `renderScoped("chrome")`: sidebar, header breadcrumb, and account button state.
- `renderScoped("page")`: active page only, preserving same-view scroll/focus.
- `renderScoped("building-workspace")`: Building Workspace root only.
- `renderScoped("building-workspace:tab")`: active Building Workspace tab body only.
- `renderScoped("building-workspace:model")`: Building Workspace model tree/details/header add-on.
- `renderScoped("building-workspace:inbox")`: BACnet inbox/import-plan surface.
- `renderScoped("all")` or `renderAll()`: app-level fallback.

## Standards

- Do not call `renderAll()` from row clicks, right-click menus, drag/drop, filters, inline edits, tab-local actions, or selection changes.
- Prefer stable element IDs on panes that are intended to be replaced independently.
- Preserve user context: scroll position, focus, highlighted rows, and active text selection should survive same-view updates.
- If a tool needs frequent updates, add a tool-specific scoped renderer before adding more `renderAll()` calls.
- Use full app render only when navigation, catalog membership, global chrome, or platform boot/capability state changes.

## Current Pattern

Building Workspace is the reference implementation:

- Model tree selection re-renders the tree and detail pane only.
- Tree and inbox context menus mount as overlays instead of rebuilding the page.
- BACnet discovered-device queueing re-renders only the inbox/import-plan area.
- Building Workspace tab changes re-render only the workspace root.

## Tool page chrome ownership

Plugin tools render inside the shared shell in `src/ui/plugin-page.js`. To avoid stacked duplicate headers:

| Layer | Owns | Must not duplicate |
| --- | --- | --- |
| `plugin-page.js` | `← Library` back link, tool name, tagline, about button, status pill, favorite star | — |
| Tool `renderPage()` | Workspace UI: tabs, panes, controls, **context-only** add-ons (model breadcrumb, live poll badge, scope filters) | Tool name, manifest tagline, status pill |
| `headerAddonFor(tool)` hook | Optional context row mounted **below the tagline** in the plugin header | Full second page headers with title + status |

**Rules**

1. Do not render an `<h2>` with the tool name inside a tool page — the shell already renders `plugin-title`.
2. Do not repeat `renderStatusPill()` output inside the tool body — the shell shows it in `plugin-header-right`.
3. Context that changes often (model path, live poll state) belongs in `headerAddonFor` with a stable wrapper id so scoped renderers can patch it (`bwRenderHeaderAddon` pattern).
4. If a tool needs header updates during scoped renders, update the addon node — not a second header block.

**Building Workspace** is the reference: model breadcrumb + live indicator live in `bwPluginHeaderAddon()`; tabs and panes start at `bw-root` with no `bw-page-header`.

**Regression guard:** `src/ui/plugin-chrome.test.js` statically scans `src/tools/ui/*.js` for forbidden shell class tokens (`plugin-title`, `plugin-header`, `bw-page-header`, etc.). Run `npm test` after adding or changing a tool page.

