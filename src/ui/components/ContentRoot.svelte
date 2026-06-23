<script>
  // Keep-alive host for legacy imperative tool pages.
  //
  // Built-in pages (home/library/settings/…) keep rendering into the sibling
  // #view-root via app-shell as before. This component owns a pool of per-tool
  // host elements: when you switch away from a tool its DOM is hidden (not
  // destroyed), so returning to it preserves scroll position, focus, inputs and
  // any in-flight state — without the old scroll/focus capture-restore hack.
  //
  // It exposes an imperative {showTool, showBuiltin} API via content-host.js so
  // app-shell.renderCurrentPage can drive it from the existing render path. The
  // raw el()-built tool DOM lives inside action-managed host divs; Svelte never
  // diffs it.

  import { setContentHost } from "../../platform/content-host.js";

  // renderTool(id, hostEl) builds a tool's page (chrome + body) into hostEl —
  // injected so this component doesn't import the UI graph directly.
  let { renderTool } = $props();

  let region = $state(null);
  const pool = new Map(); // toolId -> host element (kept alive while app runs)
  let activeId = null;

  function viewRoot() {
    return document.getElementById("view-root");
  }

  function hideAllHosts() {
    for (const host of pool.values()) host.style.display = "none";
  }

  function showBuiltin() {
    activeId = null;
    hideAllHosts();
    if (region) region.style.display = "none"; // yield flex space to #view-root
    const vr = viewRoot();
    if (vr) vr.style.display = ""; // restore CSS-driven display (flex)
  }

  function showTool(id) {
    const vr = viewRoot();
    if (vr) vr.style.display = "none";
    if (region) region.style.display = ""; // restore CSS-driven flex layout

    // Same tool already shown → a full renderAll() from inside the tool, i.e. a
    // self-refresh. Rebuild its body in place (app-shell's capture/restore wraps
    // this call, so scroll/focus are preserved for the legacy path).
    if (id === activeId && pool.has(id)) {
      renderTool(id, pool.get(id));
      return;
    }

    hideAllHosts();
    let host = pool.get(id);
    if (!host) {
      host = document.createElement("div");
      host.className = "tool-host";
      host.dataset.toolId = id;
      region.appendChild(host);
      pool.set(id, host);
      renderTool(id, host); // first mount — build once
    }
    // Return visit to an already-built tool: keep its body (scroll/focus/in-flight
    // state) but refresh the shell chrome so the header status pill / favorite star
    // reflect any change that happened while the tool was hidden.
    else {
      renderTool(id, host, { chromeOnly: true });
    }
    host.style.display = "";
    activeId = id;
  }

  setContentHost({ showTool, showBuiltin });
</script>

<div class="tool-host-region" bind:this={region}></div>
