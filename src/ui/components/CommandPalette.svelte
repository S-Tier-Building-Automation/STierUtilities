<script>
  // Command palette (Ctrl/Cmd-K). Subsumes the old header tool-search and adds
  // navigation + command entries. Reads the reactive tools store; navigation and
  // app commands are injected as props so this component stays decoupled from the
  // wiring layer.
  import { tools as toolsStore, cycleTheme, isHidden as storeIsHidden } from "../../platform/store.js";
  import { filterTools } from "../tool-search.js";

  let {
    setView,
    pluginView,
    checkForUpdates,
    setSidebarCollapsed,
    getSidebarCollapsed = () => false,
  } = $props();

  let open = $state(false);
  let query = $state("");
  let activeIndex = $state(0);
  let inputEl = $state(null);

  const navActions = [
    { id: "nav:home", label: "Home", icon: "🏠", group: "Go to", run: () => setView("home") },
    { id: "nav:library", label: "Library", icon: "📚", group: "Go to", run: () => setView("library") },
    { id: "nav:activity", label: "Activity", icon: "📋", group: "Go to", run: () => setView("activity") },
    { id: "nav:services", label: "Services & Capabilities", icon: "🧩", group: "Go to", run: () => setView("services") },
    { id: "nav:settings", label: "Settings", icon: "⚙️", group: "Go to", run: () => setView("settings") },
    { id: "nav:account", label: "Account", icon: "◎", group: "Go to", run: () => setView("account") },
  ];
  const commandActions = [
    { id: "cmd:theme", label: "Toggle theme", hint: "dark · light · system", icon: "◐", group: "Commands", run: () => cycleTheme() },
    { id: "cmd:sidebar", label: "Toggle sidebar", icon: "▦", group: "Commands", run: () => setSidebarCollapsed?.(!getSidebarCollapsed()) },
    { id: "cmd:updates", label: "Check for updates", icon: "⬆", group: "Commands", run: () => checkForUpdates?.({ manual: true }) },
  ];

  const results = $derived.by(() => {
    const q = query.trim().toLowerCase();
    const actions = [...navActions, ...commandActions].filter(
      (a) => !q || a.label.toLowerCase().includes(q) || (a.hint || "").toLowerCase().includes(q),
    );
    const toolItems = filterTools($toolsStore, query, { isHidden: storeIsHidden }).map((t) => ({
      id: "tool:" + t.id,
      label: t.name,
      hint: t.tagline,
      icon: t.emoji || "🧩",
      group: "Tools",
      run: () => setView(pluginView(t.id)),
    }));
    return [...actions, ...toolItems];
  });

  function openPalette() {
    open = true;
    query = "";
    activeIndex = 0;
    queueMicrotask(() => inputEl?.focus());
  }
  function closePalette() {
    open = false;
  }
  function runItem(item) {
    closePalette();
    item.run();
  }

  function onWindowKeydown(e) {
    if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      open ? closePalette() : openPalette();
      return;
    }
    if (!open) return;
    const n = results.length;
    if (e.key === "Escape") {
      e.preventDefault();
      closePalette();
    } else if (e.key === "ArrowDown" && n) {
      e.preventDefault();
      activeIndex = (activeIndex + 1) % n;
    } else if (e.key === "ArrowUp" && n) {
      e.preventDefault();
      activeIndex = (activeIndex - 1 + n) % n;
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = results[activeIndex];
      if (item) runItem(item);
    }
  }

  // Reset the highlighted row whenever the query changes.
  $effect(() => {
    query;
    activeIndex = 0;
  });
</script>

<svelte:window onkeydown={onWindowKeydown} />

{#if open}
  <div class="cmdk-overlay" onmousedown={closePalette} role="presentation">
    <div class="cmdk-panel" onmousedown={(e) => e.stopPropagation()} role="dialog" aria-label="Command palette">
      <input
        bind:this={inputEl}
        bind:value={query}
        class="cmdk-input"
        type="text"
        placeholder="Search tools and commands…"
        autocomplete="off"
        spellcheck="false"
        aria-label="Search tools and commands"
      />
      <div class="cmdk-list" role="listbox">
        {#each results as item, i (item.id)}
          <button
            type="button"
            class="cmdk-item"
            class:active={i === activeIndex}
            role="option"
            aria-selected={i === activeIndex}
            onmouseenter={() => (activeIndex = i)}
            onclick={() => runItem(item)}
          >
            <span class="cmdk-icon">{item.icon}</span>
            <span class="cmdk-copy">
              <span class="cmdk-label">{item.label}</span>
              {#if item.hint}<span class="cmdk-hint">{item.hint}</span>{/if}
            </span>
            <span class="cmdk-group">{item.group}</span>
          </button>
        {:else}
          <div class="cmdk-empty">No matching tools or commands</div>
        {/each}
      </div>
      <div class="cmdk-footer">
        <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
        <span><kbd>↵</kbd> open</span>
        <span><kbd>esc</kbd> close</span>
      </div>
    </div>
  </div>
{/if}
