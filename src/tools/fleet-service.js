// Fleet/supervisor service — aggregates health across every site in the model,
// the multi-site rollup that is the Niagara Supervisor / FIN-to-Cloud analog.
// Pure aggregation over the inventory snapshot (which syncs from SQLite +
// Supabase), with optional alarm/note counts injected.

function countBy(entities, type) {
  return entities.filter((e) => e.type === type).length;
}

/**
 * @param {object} deps
 * @param {object} deps.inventory                inventory capability
 * @param {(scope:object) => number} [deps.openNotes]   open-note count for a scope
 * @param {(scope:object) => number} [deps.openAlarms]  open-alarm count for a scope
 */
export function createFleetService({ inventory, openNotes, openAlarms } = {}) {
  if (!inventory) throw new Error("fleet service requires an inventory capability");

  function overridesForSite(siteId) {
    // A point is "overridden" when it carries an active manual command (tag).
    return inventory
      .listEntities({ type: "point", siteId })
      .filter((p) => p.tags && (p.tags.overridden || p.tags.manual)).length;
  }

  return {
    /** One summary row per site: structure counts + health signals. */
    siteSummaries() {
      const sites = inventory.listEntities({ type: "site" });
      return sites.map((site) => {
        const scope = { siteId: site.id };
        const ents = inventory.listEntities(scope);
        return {
          siteId: site.id,
          name: site.name,
          buildings: countBy(ents, "building"),
          floors: countBy(ents, "floor"),
          equip: countBy(ents, "equip"),
          points: countBy(ents, "point"),
          overrides: overridesForSite(site.id),
          openNotes: openNotes ? openNotes(scope) : 0,
          openAlarms: openAlarms ? openAlarms(scope) : 0,
        };
      });
    },

    /** Roll the per-site summaries into one fleet-wide total. */
    fleetTotals() {
      const sites = this.siteSummaries();
      const sum = (k) => sites.reduce((acc, s) => acc + (s[k] || 0), 0);
      return {
        sites: sites.length,
        equip: sum("equip"),
        points: sum("points"),
        overrides: sum("overrides"),
        openNotes: sum("openNotes"),
        openAlarms: sum("openAlarms"),
        healthySites: sites.filter((s) => !s.openAlarms && !s.overrides).length,
      };
    },
  };
}
