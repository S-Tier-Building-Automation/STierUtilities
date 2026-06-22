<script>
  // Reactive sidebar: brand, nav, favorites, recent, footer status. Reads the
  // shared svelte/store projection of user state (favorites/recents/system status/
  // activity) so it updates surgically instead of via the old imperative
  // renderSidebar(). Navigation is injected (setView/pluginView).
  import {
    favoriteTools,
    recentTools,
    systemStatus,
    activitySummary,
  } from "../../platform/store.js";
  import { activeNav, activeToolId } from "../../platform/router.js";

  let { setView, pluginView, appVersion = "" } = $props();

  const NAV = [
    { view: "home", icon: "🏠", label: "Home" },
    { view: "library", icon: "📚", label: "Library" },
    { view: "activity", icon: "📋", label: "Activity" },
  ];

  const badgeCount = $derived(($activitySummary?.errors || 0) + ($activitySummary?.warns || 0));
  const badgeIsError = $derived(($activitySummary?.errors || 0) > 0);
  const obs = $derived($systemStatus?.observability || { label: "—", cls: "pill-muted" });
</script>

<div class="sidebar-brand">
  <div class="brand-mark">
    <svg width="30" height="30" viewBox="0 0 32 32" role="img" aria-label="S-Tier" class="brand-logo">
      <rect x="1" y="1" width="30" height="30" rx="7" fill="var(--bg-elev-2)" stroke="var(--border-strong)" stroke-width="1" />
      <rect x="7" y="19" width="3" height="7" rx="1.5" fill="var(--accent-2)" />
      <rect x="13" y="15" width="3" height="11" rx="1.5" fill="var(--accent-2)" />
      <rect x="19" y="11" width="3" height="15" rx="1.5" fill="var(--accent-2)" />
      <rect x="25" y="7" width="3" height="19" rx="1.5" fill="var(--signal-amber)" />
    </svg>
  </div>
  <div class="sidebar-brand-text"><h1>S-Tier Utilities</h1></div>
</div>

<div class="sidebar-section sidebar-nav-section">
  <ul class="sidebar-nav">
    {#each NAV as item}
      <li>
        <button
          class="sidebar-nav-item"
          class:active={$activeNav === item.view}
          type="button"
          title={item.label}
          onclick={() => setView(item.view)}
        >
          <span class="sidebar-nav-icon">{item.icon}</span>
          <span class="sidebar-nav-label">{item.label}</span>
          {#if item.view === "activity" && badgeCount > 0}
            <span class="sidebar-nav-badge" class:sidebar-nav-badge-error={badgeIsError} class:sidebar-nav-badge-warn={!badgeIsError}>
              {badgeCount > 99 ? "99+" : badgeCount}
            </span>
          {/if}
        </button>
      </li>
    {/each}
  </ul>
</div>

<div class="sidebar-section">
  <h2 class="sidebar-heading"><span>⭐</span> Favorites</h2>
  <ul class="sidebar-list">
    {#each $favoriteTools as tool (tool.id)}
      <li
        class="sidebar-fav"
        class:active={$activeToolId === tool.id}
        title={tool.name}
        onclick={() => setView(pluginView(tool.id))}
      >
        <span class="sidebar-fav-icon">{tool.emoji}</span>
        <span class="sidebar-fav-name">{tool.name}</span>
      </li>
    {:else}
      <li class="sidebar-empty">No favorites yet. Tap the star on a tool.</li>
    {/each}
  </ul>
</div>

<div class="sidebar-section sidebar-recent-section">
  <h2 class="sidebar-heading"><span>🕐</span> Recent</h2>
  <ul class="sidebar-list">
    {#each $recentTools as tool (tool.id)}
      <li
        class="sidebar-fav"
        class:active={$activeToolId === tool.id}
        title={tool.name}
        onclick={() => setView(pluginView(tool.id))}
      >
        <span class="sidebar-fav-icon">{tool.emoji}</span>
        <span class="sidebar-fav-name">{tool.name}</span>
      </li>
    {:else}
      <li class="sidebar-empty">Open a tool to see it here.</li>
    {/each}
  </ul>
</div>

<div class="sidebar-footer">
  <span class="pill pill-sm {obs.cls}">{obs.label}</span>
  <span class="sidebar-footer-version">v{appVersion}</span>
</div>
