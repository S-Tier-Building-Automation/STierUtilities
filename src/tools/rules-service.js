// building-rules service — wraps the pure rule evaluator (rules.js) behind the
// rules.v1 capability so the Analytics app, Alarm Console, and Building
// Workspace share one analytics engine instead of importing rules.js directly.

import { runRules, exportRulesMarkdown, exportRulesCsv, VAV_RULE_PACK } from "./rules.js";

/**
 * @param {{ inventory: object, bacnet?: object|null }} deps
 */
export function createRulesService({ inventory, bacnet = null }) {
  if (!inventory) throw new Error("rules service requires an inventory capability");

  return {
    /** The built-in rule packs available to evaluate. */
    listRulePacks() {
      return [{ id: "vav", name: "VAV", rules: VAV_RULE_PACK }];
    },

    /** The flat list of rules for a pack (defaults to the VAV pack). */
    listRules(packId = "vav") {
      return packId === "vav" ? VAV_RULE_PACK : [];
    },

    /**
     * Evaluate rules against the modeled equipment in scope. Returns the run
     * object; callers persist it via inventory.recordRuleRun when desired.
     * @param {{ scope?: object, rules?: object[], options?: object, useLive?: boolean, now?: () => number }} [params]
     */
    run({ scope = {}, rules = VAV_RULE_PACK, options = {}, useLive = true, now } = {}) {
      return runRules({
        inventory,
        rules,
        scope,
        bacnet: useLive ? bacnet : null,
        options,
        ...(now ? { now } : {}),
      });
    },

    exportMarkdown(snapshot, run) {
      return exportRulesMarkdown(snapshot, run);
    },

    exportCsv(run) {
      return exportRulesCsv(run);
    },
  };
}
