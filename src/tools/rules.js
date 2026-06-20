import { parseSourceRef } from "./inventory.js";
import { extractPresentValue } from "./historian.js";
import {
  graphicForEquip,
  inferPointGraphicRole,
  normalizeGraphicRole,
  pointGraphicRole,
} from "./device-graphics/resolve.js";

function csvCell(value) {
  const s = value == null ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function parseNumeric(value) {
  if (value == null || value === "") return null;
  const n = Number(String(value).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function nameMatchesExclude(point, patterns = []) {
  const name = String(point?.name || "").toLowerCase();
  return patterns.some((p) => name.includes(String(p).toLowerCase()));
}

function nameMatchesPrefer(point, patterns = []) {
  const name = String(point?.name || "").toLowerCase();
  return patterns.some((p) => name.includes(String(p).toLowerCase()));
}

/**
 * Resolve the best point on an equip for semantic roles used by rules/graphics.
 * @param {object} equip
 * @param {object[]} points
 * @param {string[]} roles
 * @param {object|null} graphic
 * @param {{ excludeNamePatterns?: string[], preferNamePatterns?: string[] }} [opts]
 */
export function findPointForRoles(equip, points, roles = [], graphic = null, opts = {}) {
  const roleKeys = roles.map(normalizeGraphicRole).filter(Boolean);
  const equipPoints = points.filter((p) => p.equipId === equip.id);
  const exclude = opts.excludeNamePatterns || [];
  const prefer = opts.preferNamePatterns || [];

  const explicit = equipPoints.find((p) => {
    const role = pointGraphicRole(p);
    return role && roleKeys.includes(role) && !nameMatchesExclude(p, exclude);
  });
  if (explicit) return explicit;

  const preferred = equipPoints.filter((p) => !pointGraphicRole(p) && !nameMatchesExclude(p, exclude) && nameMatchesPrefer(p, prefer));
  for (const p of preferred) {
    const inferred = graphic ? inferPointGraphicRole(p, graphic, roleKeys) : "";
    if (inferred && roleKeys.includes(normalizeGraphicRole(inferred))) return p;
  }

  for (const p of equipPoints) {
    if (pointGraphicRole(p) || nameMatchesExclude(p, exclude)) continue;
    const inferred = graphic
      ? inferPointGraphicRole(p, graphic, roleKeys)
      : roleKeys.find((role) => {
          const matcher = (graphic?.roleMatchers || []).find((m) => normalizeGraphicRole(m.role) === role);
          if (!matcher) return false;
          const name = String(p.name || "").toUpperCase();
          return (matcher.patterns || []).some((pat) => name.includes(String(pat).toUpperCase()));
        });
    if (inferred && roleKeys.includes(normalizeGraphicRole(inferred))) return p;
  }
  return null;
}

export function equipMatchesRuleScope(equip, rule) {
  const scope = rule?.scope || {};
  const hasTemplates = Boolean(scope.templateIds?.length);
  const hasTags = Boolean(scope.tags && Object.keys(scope.tags).length);
  // All configured constraints must hold (conjunctive). An empty scope matches all.
  if (hasTemplates) {
    const tid = String(equip?.templateId || "");
    const templateOk = scope.templateIds.some((id) => tid === id || tid === `template:${id}` || tid.endsWith(`:${id}`));
    if (!templateOk) return false;
  }
  if (hasTags) {
    const tagsOk = Object.entries(scope.tags).every(([k, v]) => (equip?.tags || {})[k] === v);
    if (!tagsOk) return false;
  }
  return true;
}

export function listEquipsInScope(inventory, { siteId = null, buildingId = null, floorId = null, equipId = null } = {}) {
  if (equipId) {
    const equip = inventory.getEntity(equipId);
    return equip?.type === "equip" ? [equip] : [];
  }
  let equips = inventory.listEntities({ type: "equip" });
  if (siteId) equips = equips.filter((e) => e.siteId === siteId || e.id === siteId);
  if (buildingId) equips = equips.filter((e) => e.buildingId === buildingId || e.parentId === buildingId || e.id === buildingId);
  if (floorId) equips = equips.filter((e) => e.floorId === floorId || e.parentId === floorId || e.id === floorId);
  return equips;
}

function bacnetRefForPoint(point) {
  const ref = (point?.sourceRefs || []).map(parseSourceRef).find((r) => r?.kind === "bacnet");
  if (!ref) return null;
  return {
    device: point.deviceRef || { deviceInstance: ref.deviceInstance },
    objectType: ref.objectType,
    instance: ref.instance,
    deviceInstance: ref.deviceInstance,
  };
}

function liveStateForPoint(point, liveValues, bacnetReads) {
  if (!point) return null;
  if (liveValues instanceof Map && liveValues.has(point.id)) return liveValues.get(point.id);
  if (liveValues && typeof liveValues === "object" && liveValues[point.id]) return liveValues[point.id];
  if (bacnetReads && bacnetReads.has(point.id)) return bacnetReads.get(point.id);
  return null;
}

function displayMatches(match, display) {
  if (!match) return true;
  const text = String(display ?? "").trim();
  if (match instanceof RegExp) return match.test(text);
  return text.toLowerCase() === String(match).toLowerCase();
}

/** Human phrasing for a threshold breach, e.g. "lt" -> "below". */
function thresholdBreachText(operator) {
  switch (operator) {
    case "gt": return "above";
    case "gte": return "at or above";
    case "lte": return "at or below";
    case "eq": return "equal to";
    case "lt":
    default: return "below";
  }
}

function compareThreshold(operator, value, threshold) {
  const v = parseNumeric(value);
  const t = parseNumeric(threshold);
  if (v == null || t == null) return null;
  if (operator === "lt") return v < t;
  if (operator === "lte") return v <= t;
  if (operator === "gt") return v > t;
  if (operator === "gte") return v >= t;
  if (operator === "eq") return v === t;
  return null;
}

/**
 * @typedef {{ id: string, name: string, severity?: string, scope?: object, kind: string, roles?: string[], excludeNamePatterns?: string[], preferNamePatterns?: string[], min?: number, max?: number, operator?: string, value?: number, when?: object, unit?: string, description?: string }} RuleDefinition
 */

/** Default VAV diagnostic rules for Building Workspace alerts. */
export const VAV_RULE_PACK = [
  {
    id: "vav-missing-space-temp",
    name: "Missing space temperature sensor",
    description: "No modeled space temperature point is bound on the VAV.",
    severity: "high",
    scope: { tags: { vav: true } },
    kind: "missing-point",
    roles: ["space-temperature"],
    excludeNamePatterns: ["setpoint", "co2", "alarm", "humidity", "voc"],
  },
  {
    id: "vav-missing-dat",
    name: "Missing discharge air temperature sensor",
    description: "No modeled discharge air temperature point is bound on the VAV.",
    severity: "high",
    scope: { tags: { vav: true } },
    kind: "missing-point",
    roles: ["discharge-air-temp", "dat"],
    excludeNamePatterns: ["setpoint", "alarm"],
  },
  {
    id: "vav-dat-out-of-range",
    name: "Discharge air temperature out of range",
    description: "DAT present-value is outside the configured acceptable band.",
    severity: "medium",
    scope: { tags: { vav: true } },
    kind: "range",
    roles: ["discharge-air-temp", "dat"],
    excludeNamePatterns: ["setpoint", "alarm"],
    min: 45,
    max: 120,
    unit: "°F",
  },
  {
    id: "vav-low-flow",
    name: "Low airflow while fan is active",
    description: "Reported airflow is below the minimum while the fan appears active.",
    severity: "medium",
    scope: { tags: { vav: true } },
    kind: "threshold",
    roles: ["airflow", "cfm"],
    excludeNamePatterns: ["alarm", "delay", "percent", "setpoint", "nuisance"],
    preferNamePatterns: ["box flow", "cfm", "airflow"],
    operator: "lt",
    value: 50,
    when: {
      roles: ["fan"],
      excludeNamePatterns: ["alarm", "delay"],
      match: /^(on|active|1|true|running)/i,
    },
    unit: "cfm",
  },
];

function finding(rule, equip, status, message, detail = {}) {
  return {
    ruleId: rule.id,
    ruleName: rule.name,
    severity: rule.severity || "medium",
    equipId: equip.id,
    equipName: equip.name || equip.id,
    status,
    message,
    at: detail.at,
    pointId: detail.pointId || null,
    pointName: detail.pointName || null,
    value: detail.value ?? null,
    display: detail.display ?? null,
    threshold: detail.threshold ?? null,
    error: detail.error || null,
  };
}

/**
 * Evaluate one rule against one equip using inventory + optional live reads.
 * @param {RuleDefinition} rule
 * @param {object} equip
 * @param {object[]} points
 * @param {{ graphic?: object|null, liveValues?: Map|Record, bacnetReads?: Map, now?: () => number }} ctx
 */
export function evaluateRuleOnEquip(rule, equip, points, ctx = {}) {
  const now = ctx.now || (() => Date.now());
  const at = new Date(now()).toISOString();
  const graphic = ctx.graphic ?? graphicForEquip(equip, null);
  const pick = (roles, extra = {}) => findPointForRoles(equip, points, roles, graphic, {
    excludeNamePatterns: extra.excludeNamePatterns || rule.excludeNamePatterns,
    preferNamePatterns: extra.preferNamePatterns || rule.preferNamePatterns,
  });

  if (rule.kind === "missing-point") {
    const point = pick(rule.roles || []);
    if (!point) {
      return finding(rule, equip, "fail", `${rule.name} on ${equip.name || equip.id}.`, { at });
    }
    const live = liveStateForPoint(point, ctx.liveValues, ctx.bacnetReads);
    if (live?.error) {
      return finding(rule, equip, "warn", `${point.name} is bound but unreadable.`, {
        at, pointId: point.id, pointName: point.name, error: live.error,
      });
    }
    return finding(rule, equip, "pass", `${point.name} is present.`, { at, pointId: point.id, pointName: point.name });
  }

  const point = pick(rule.roles || []);
  if (!point) {
    return finding(rule, equip, "skip", `No point bound for ${rule.name}.`, { at });
  }

  const live = liveStateForPoint(point, ctx.liveValues, ctx.bacnetReads);
  if (!live) {
    return finding(rule, equip, "skip", `No live value for ${point.name}.`, { at, pointId: point.id, pointName: point.name });
  }
  if (live.error) {
    return finding(rule, equip, "warn", `Could not read ${point.name}.`, {
      at, pointId: point.id, pointName: point.name, error: live.error,
    });
  }

  const value = live.value ?? parseNumeric(live.display);
  const display = live.display ?? (value != null ? String(value) : null);

  if (rule.kind === "range") {
    const min = Number.isFinite(Number(rule.min)) ? Number(rule.min) : null;
    const max = Number.isFinite(Number(rule.max)) ? Number(rule.max) : null;
    const numeric = parseNumeric(value ?? display);
    if (numeric == null) {
      return finding(rule, equip, "warn", `${point.name} has no numeric value.`, {
        at, pointId: point.id, pointName: point.name, display,
      });
    }
    const ok = (min == null || numeric >= min) && (max == null || numeric <= max);
    return finding(rule, equip, ok ? "pass" : "fail", ok
      ? `${point.name} is ${numeric}${rule.unit ? ` ${rule.unit}` : ""} (within range).`
      : `${point.name} is ${numeric}${rule.unit ? ` ${rule.unit}` : ""} (expected ${min ?? "—"} to ${max ?? "—"}).`, {
      at, pointId: point.id, pointName: point.name, value: numeric, display,
      threshold: { min, max, unit: rule.unit || null },
    });
  }

  if (rule.kind === "threshold") {
    const when = rule.when || null;
    if (when?.roles?.length) {
      const whenPoint = pick(when.roles, when);
      const whenLive = whenPoint ? liveStateForPoint(whenPoint, ctx.liveValues, ctx.bacnetReads) : null;
      const whenDisplay = whenLive?.display ?? (whenLive?.value != null ? String(whenLive.value) : "");
      if (!whenPoint || !whenLive || whenLive.error || !displayMatches(when.match, whenDisplay)) {
        return finding(rule, equip, "pass", `Precondition not met for ${rule.name}.`, {
          at, pointId: point.id, pointName: point.name, display,
        });
      }
    }
    const numeric = parseNumeric(value ?? display);
    const hit = compareThreshold(rule.operator || "lt", numeric, rule.value);
    if (hit == null) {
      return finding(rule, equip, "warn", `${point.name} has no comparable numeric value.`, {
        at, pointId: point.id, pointName: point.name, display,
      });
    }
    const unitText = rule.unit ? ` ${rule.unit}` : "";
    return finding(rule, equip, hit ? "fail" : "pass", hit
      ? `${point.name} is ${numeric}${unitText} (${thresholdBreachText(rule.operator || "lt")} ${rule.value}${unitText}).`
      : `${point.name} is ${numeric}${unitText}.`, {
      at, pointId: point.id, pointName: point.name, value: numeric, display,
      threshold: { operator: rule.operator, value: rule.value, unit: rule.unit || null },
    });
  }

  return finding(rule, equip, "skip", `Unsupported rule kind "${rule.kind}".`, { at });
}

export function aggregateRuleRunStatus(findings = []) {
  if (findings.some((f) => f.status === "fail")) return "fail";
  if (findings.some((f) => f.status === "warn")) return "warn";
  if (findings.some((f) => f.status === "skip")) return "warn";
  return "pass";
}

/**
 * @param {{ inventory: object, rules?: RuleDefinition[], scope?: object, bacnet?: object|null, liveValues?: Map|Record|null, options?: object, now?: () => number }} params
 */
export async function runRules({
  inventory,
  rules = VAV_RULE_PACK,
  scope = {},
  bacnet = null,
  liveValues = null,
  options = {},
  now = () => Date.now(),
} = {}) {
  const startedAt = new Date(now()).toISOString();
  const equips = listEquipsInScope(inventory, scope).filter((equip) => rules.some((rule) => equipMatchesRuleScope(equip, rule)));
  const allPoints = inventory.listEntities({ type: "point" });
  const bacnetReads = new Map();

  const mergedRules = rules.map((rule) => {
    const overrides = options?.ruleOverrides?.[rule.id] || {};
    return { ...rule, ...overrides };
  });

  if (bacnet && !liveValues) {
    const pointIds = new Set();
    for (const equip of equips) {
      const graphic = graphicForEquip(equip, equip.templateId ? inventory.getEntity(equip.templateId) : null);
      for (const rule of mergedRules) {
        if (!equipMatchesRuleScope(equip, rule)) continue;
        const primary = findPointForRoles(equip, allPoints, rule.roles || [], graphic, rule);
        if (primary) pointIds.add(primary.id);
        // A threshold rule's precondition (e.g. fan running) is a separate point;
        // prefetch it too so its live value is available during evaluation.
        if (rule.when?.roles?.length) {
          const precondition = findPointForRoles(equip, allPoints, rule.when.roles, graphic, rule.when);
          if (precondition) pointIds.add(precondition.id);
        }
      }
    }
    for (const pointId of pointIds) {
      const point = inventory.getEntity(pointId);
      const ref = bacnetRefForPoint(point);
      if (!ref) {
        bacnetReads.set(pointId, { error: "No BACnet source ref" });
        continue;
      }
      try {
        const props = await bacnet.readPoint(ref.device, ref.objectType, ref.instance);
        const pv = extractPresentValue(props);
        bacnetReads.set(pointId, {
          value: pv,
          display: pv != null ? String(pv) : null,
          props,
        });
      } catch (err) {
        bacnetReads.set(pointId, { error: String(err && err.message ? err.message : err) });
      }
    }
  }

  const findings = [];
  for (const equip of equips) {
    const template = equip.templateId ? inventory.getEntity(equip.templateId) : null;
    const graphic = graphicForEquip(equip, template);
    for (const rule of mergedRules) {
      if (!equipMatchesRuleScope(equip, rule)) continue;
      findings.push(evaluateRuleOnEquip(rule, equip, allPoints, {
        graphic,
        liveValues,
        bacnetReads,
        now,
      }));
    }
  }

  const finishedAt = new Date(now()).toISOString();
  return {
    type: "ruleRun",
    name: `Rule evaluation ${startedAt}`,
    startedAt,
    finishedAt,
    status: aggregateRuleRunStatus(findings),
    scope,
    findings,
    summary: {
      equips: equips.length,
      rules: mergedRules.length,
      fail: findings.filter((f) => f.status === "fail").length,
      warn: findings.filter((f) => f.status === "warn").length,
      pass: findings.filter((f) => f.status === "pass").length,
      skip: findings.filter((f) => f.status === "skip").length,
    },
    notes: options.notes || "",
  };
}

export function exportRulesMarkdown(snapshot, run) {
  const lines = [
    `# ${run?.name || "Rule Alerts Report"}`,
    "",
    `Status: ${run?.status || "unknown"}`,
    `Started: ${run?.startedAt || ""}`,
    `Finished: ${run?.finishedAt || ""}`,
    "",
    "## Summary",
    `- Equipment evaluated: ${run?.summary?.equips ?? 0}`,
    `- Failures: ${run?.summary?.fail ?? 0}`,
    `- Warnings: ${run?.summary?.warn ?? 0}`,
    `- Passed: ${run?.summary?.pass ?? 0}`,
    "",
    "## Findings",
    "| Equipment | Rule | Severity | Status | Message | Value |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const f of run?.findings || []) {
    lines.push(`| ${f.equipName || f.equipId || ""} | ${f.ruleName || f.ruleId || ""} | ${f.severity || ""} | ${f.status || ""} | ${f.message || ""} | ${f.display ?? f.value ?? ""} |`);
  }
  if (run?.notes) lines.push("", "## Notes", run.notes);
  return `${lines.join("\n")}\n`;
}

export function exportRulesCsv(run) {
  const rows = [["equipId", "equipName", "ruleId", "ruleName", "severity", "status", "message", "pointId", "pointName", "value", "display", "error", "at"]];
  for (const f of run?.findings || []) {
    rows.push([
      f.equipId, f.equipName, f.ruleId, f.ruleName, f.severity, f.status, f.message || "",
      f.pointId || "", f.pointName || "", f.value ?? "", f.display ?? "", f.error || "", f.at || "",
    ]);
  }
  return `${rows.map((r) => r.map(csvCell).join(",")).join("\n")}\n`;
}
