<script>
  // Route-driven breadcrumb. Replaces the string-parsing renderHeaderBreadcrumb;
  // reads the breadcrumbModel derived from the route store, resolving tool names
  // from the catalog store.
  import { breadcrumbModel } from "../../platform/router.js";
  import { tools as toolsStore } from "../../platform/store.js";

  let { setView } = $props();

  function toolLabel(id) {
    const t = $toolsStore.find((x) => x.id === id);
    return t ? `${t.emoji} ${t.name}` : id;
  }
</script>

{#each $breadcrumbModel as crumb, i (i)}
  {#if i > 0}<span class="crumb-sep">›</span>{/if}
  {#if crumb.view}
    <a class="crumb-link" href="#" onclick={(e) => { e.preventDefault(); setView(crumb.view); }}>{crumb.label}</a>
  {:else}
    <span class="crumb-current">{crumb.toolId ? toolLabel(crumb.toolId) : crumb.label}</span>
  {/if}
{/each}
