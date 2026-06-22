# Rendering Standards

S-Tier Utilities is a local-first operational app. UI updates should feel stable, fast, and field-friendly. Avoid full app redraws for ordinary actions.

## Architecture (current — Svelte 5 + Vite)

The frontend is **Svelte 5 on Vite**. Two kinds of UI coexist:

- **Svelte chrome + tools (preferred).** The shell chrome (`Sidebar`, `Breadcrumb`, `CommandPalette`, `ContentRoot` in `src/ui/components/`) and the migrated tool pages (`src/tools/ui/*.svelte`) are Svelte components. State lives in `svelte/store`s (`src/platform/store.js`, `src/platform/router.js`); components read them and update surgically — **no `renderAll()`**. The building model has no change event, so tools that read inventory must track the **`inventoryVersion`** store inside their `$derived` (e.g. `$derived.by(() => { $inventoryVersion; return getInventory().listEntities(...); })`) — never key a `$derived` off the identity-stable inventory instance, or it won't refresh on cross-tool writes.
- **Legacy imperative tools on the keep-alive bridge.** Large/critical tools (`bacnet-manager`, `building-workspace`, `networkmanager`, `bacnet-historian`, `observability`, `device-graphics`, `graphics-builder`) remain imperative `el()`-built pages. `ContentRoot.svelte` keeps each one's DOM **alive in a pool** across navigation (no rebuild, so scroll/focus/in-flight state survive). The legacy `renderAll()`/`renderScoped()` API still works for them via the compatibility layer in `src/platform/render-bridge.js` + scoped-renderer registry (`src/platform/scope-registry.js`). This is a permanent, supported end-state — the bridge is not scaffolding to delete.

**Adding a tool:** prefer a Svelte component. Expose `{ renderStatusPill, component, componentProps }` from `TOOL_RENDERERS` in `app-tools.js` (the shell's `plugin-page.js` mounts `component` once into the keep-alive host and owns the header/title/status-pill/star/breadcrumb — the component renders only the body). `renderStatusPill` MUST stay a plain **sync** function (read by the shell header AND `getSystemStatus`); export it from the component's `<script module>` and pass deps as args. Use `onMount` for Tauri `listen()` subscriptions (with teardown) and one-shot `takeAppIntent` reads. See `Notes.svelte` as the reference.

The scope rules below apply to the **legacy bridged tools**; Svelte tools rely on reactivity instead.

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

