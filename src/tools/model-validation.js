// Static model validation & coverage — the "did we model this well?" linter.
//
// rules.js evaluates *live* equipment behavior (reads present-values off
// devices). This module is its static counterpart: it inspects the inventory
// snapshot itself for integrity, tagging completeness, and coverage gaps with
// no network access, so it stays pure and node --test'able. It implements the
// "validation, tag completeness, communication health, coverage" step of the
// BACnet engineering workflow over the model we already hold.

import { parseSourceRef } from "./inventory.js";

// BACnet object-type buckets. Only analog objects (AI/AO/AV) carry engineering
// units, so unit-completeness only applies to them.
const ANALOG_TYPES = new Set([0, 1, 2]);

function csvCell(value) {
  const s = value == null ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function isMarker(tags, key) {
  return Boolean(tags && Object.prototype.hasOwnProperty.call(tags, key) && tags[key] === true);
}

function bacnetRefOf(point) {
  return (point?.sourceRefs || []).map(parseSourceRef).find((r) => r?.kind === "bacnet") || null;
}

function hasSourceRef(entity) {
  return (entity?.sourceRefs || []).some((ref) => parseSourceRef(ref));
}

function isAnalogPoint(point) {
  const t = Number(point?.objectType);
  if (Number.isFinite(t)) return ANALOG_TYPES.has(t);
  const ref = bacnetRefOf(point);
  return ref ? ANALOG_TYPES.has(ref.objectType) : false;
}

function hasUnit(point) {
  return String(point?.unit ?? "").trim() !== "";
}

function isUnnamed(entity) {
  const name = String(entity?.name ?? "").trim();
  return name === "" || name === entity?.id;
}

// Which other entity each foreign-key field is expected to point at, so a
// dangling reference can name the missing target's type in its message.
const REFERENCE_FIELDS = [
  { field: "siteId", label: "site" },
  { field: "buildingId", label: "building" },
  { field: "floorId", label: "floor" },
  { field: "equipId", label: "equipment" },
  { field: "parentId", label: "parent" },
  { field: "templateId", label: "template" },
];

function inScope(entity, scope = {}) {
  if (scope.equipId) return entity.id === scope.equipId || entity.equipId === scope.equipId;
  if (scope.floorId) return entity.id === scope.floorId || entity.floorId === scope.floorId || entity.parentId === scope.floorId;
  if (scope.buildingId) return entity.id === scope.buildingId || entity.buildingId === scope.buildingId || entity.parentId === scope.buildingId;
  if (scope.siteId) return entity.id === scope.siteId || entity.siteId === scope.siteId;
  return true;
}

function pct(part, whole) {
  if (!whole) return null;
  return Math.round((part / whole) * 1000) / 10;
}

function finding(check, entity, message, detail = {}) {
  return {
    checkId: check.id,
    checkName: check.name,
    category: check.category,
    severity: check.severity,
    status: check.status,
    entityId: entity?.id || detail.entityId || null,
    entityType: entity?.type || detail.entityType || null,
    entityName: entity?.name || entity?.id || detail.entityName || null,
    message,
    detail,
  };
}

// Each check is a descriptor + a pure function that emits findings for the
// in-scope entities. Keeping them declarative makes the catalog easy to extend
// (the workflow's "user-extensible rules") and easy to document.
export const VALIDATION_CHECKS = [
  {
    id: "dangling-reference",
    name: "Dangling reference",
    category: "integrity",
    severity: "high",
    status: "fail",
    run({ scoped, byId }) {
      const out = [];
      for (const entity of scoped) {
        for (const { field, label } of REFERENCE_FIELDS) {
          const target = entity[field];
          if (!target || byId.has(target)) continue;
          out.push(finding(this, entity, `${entity.type} "${entity.name || entity.id}" references a missing ${label} (${target}).`, { field, target }));
        }
      }
      return out;
    },
  },
  {
    id: "duplicate-source-ref",
    name: "Duplicate source reference",
    category: "integrity",
    severity: "high",
    status: "fail",
    run({ scopedIds, allPoints }) {
      const byRef = new Map();
      for (const point of allPoints) {
        for (const ref of point.sourceRefs || []) {
          if (!parseSourceRef(ref)) continue;
          if (!byRef.has(ref)) byRef.set(ref, []);
          byRef.get(ref).push(point);
        }
      }
      const out = [];
      for (const [ref, points] of byRef) {
        if (points.length < 2) continue;
        // Only report when at least one offending point is in scope, but always
        // list the full conflicting set so the user sees every duplicate.
        if (!points.some((p) => scopedIds.has(p.id))) continue;
        const names = points.map((p) => p.name || p.id);
        out.push(finding(this, points[0], `${points.length} points share the source reference ${ref}: ${names.join(", ")}.`, {
          sourceRef: ref,
          pointIds: points.map((p) => p.id),
        }));
      }
      return out;
    },
  },
  {
    id: "point-without-equip",
    name: "Point not assigned to equipment",
    category: "structure",
    severity: "medium",
    status: "warn",
    run({ scopedPoints, byId }) {
      const out = [];
      for (const point of scopedPoints) {
        if (point.equipId && byId.has(point.equipId)) continue;
        if (point.equipId) continue; // dangling-reference covers a broken equipId
        out.push(finding(this, point, `Point "${point.name || point.id}" is not assigned to any equipment.`));
      }
      return out;
    },
  },
  {
    id: "point-missing-marker",
    name: "Point missing 'point' tag",
    category: "tagging",
    severity: "low",
    status: "warn",
    run({ scopedPoints }) {
      return scopedPoints
        .filter((p) => !isMarker(p.tags, "point"))
        .map((p) => finding(this, p, `Point "${p.name || p.id}" is missing the 'point' marker tag.`));
    },
  },
  {
    id: "equip-missing-marker",
    name: "Equipment missing 'equip' tag",
    category: "tagging",
    severity: "low",
    status: "warn",
    run({ scopedEquips }) {
      return scopedEquips
        .filter((e) => !isMarker(e.tags, "equip"))
        .map((e) => finding(this, e, `Equipment "${e.name || e.id}" is missing the 'equip' marker tag.`));
    },
  },
  {
    id: "analog-point-no-unit",
    name: "Analog point missing engineering units",
    category: "tagging",
    severity: "medium",
    status: "warn",
    run({ scopedPoints }) {
      return scopedPoints
        .filter((p) => isAnalogPoint(p) && !hasUnit(p))
        .map((p) => finding(this, p, `Analog point "${p.name || p.id}" has no engineering units.`));
    },
  },
  {
    id: "entity-unnamed",
    name: "Entity has no display name",
    category: "tagging",
    severity: "low",
    status: "warn",
    run({ scoped }) {
      return scoped
        .filter((e) => (e.type === "point" || e.type === "equip") && isUnnamed(e))
        .map((e) => finding(this, e, `${e.type} ${e.id} has no display name (defaults to its id).`));
    },
  },
  {
    id: "point-no-source-ref",
    name: "Point has no source reference",
    category: "coverage",
    severity: "low",
    status: "info",
    run({ scopedPoints }) {
      return scopedPoints
        .filter((p) => !hasSourceRef(p))
        .map((p) => finding(this, p, `Point "${p.name || p.id}" has no source reference (manual or unmapped).`));
    },
  },
  {
    id: "equip-no-points",
    name: "Equipment has no points",
    category: "coverage",
    severity: "medium",
    status: "warn",
    run({ scopedEquips, pointsByEquip }) {
      return scopedEquips
        .filter((e) => !(pointsByEquip.get(e.id)?.length))
        .map((e) => finding(this, e, `Equipment "${e.name || e.id}" has no modeled points.`));
    },
  },
  {
    id: "equip-no-template",
    name: "Equipment has no template applied",
    category: "coverage",
    severity: "low",
    status: "info",
    run({ scopedEquips }) {
      return scopedEquips
        .filter((e) => !e.templateId && !isMarker(e.tags, "device"))
        .map((e) => finding(this, e, `Equipment "${e.name || e.id}" has no equipment template applied.`));
    },
  },
];

const CHECK_BY_ID = new Map(VALIDATION_CHECKS.map((c) => [c.id, c]));

function buildContext(entities, scope) {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const allPoints = entities.filter((e) => e.type === "point");
  const scoped = entities.filter((e) => inScope(e, scope));
  const scopedIds = new Set(scoped.map((e) => e.id));
  const scopedPoints = scoped.filter((e) => e.type === "point");
  const scopedEquips = scoped.filter((e) => e.type === "equip");
  const pointsByEquip = new Map();
  for (const p of allPoints) {
    if (!p.equipId) continue;
    if (!pointsByEquip.has(p.equipId)) pointsByEquip.set(p.equipId, []);
    pointsByEquip.get(p.equipId).push(p);
  }
  return { byId, allPoints, scoped, scopedIds, scopedPoints, scopedEquips, pointsByEquip };
}

function computeCoverage({ scopedPoints, scopedEquips, pointsByEquip }) {
  const analogPoints = scopedPoints.filter(isAnalogPoint);
  const pointsWithSourceRef = scopedPoints.filter(hasSourceRef).length;
  const analogWithUnit = analogPoints.filter(hasUnit).length;
  const pointsTagged = scopedPoints.filter((p) => isMarker(p.tags, "point")).length;
  const equipsWithPoints = scopedEquips.filter((e) => pointsByEquip.get(e.id)?.length).length;
  const equipsWithTemplate = scopedEquips.filter((e) => Boolean(e.templateId)).length;
  const equipsTagged = scopedEquips.filter((e) => isMarker(e.tags, "equip")).length;
  return {
    points: scopedPoints.length,
    analogPoints: analogPoints.length,
    pointsWithSourceRef,
    pointsTagged,
    analogWithUnit,
    equips: scopedEquips.length,
    equipsWithPoints,
    equipsWithTemplate,
    equipsTagged,
    pct: {
      pointsWithSourceRef: pct(pointsWithSourceRef, scopedPoints.length),
      pointsTagged: pct(pointsTagged, scopedPoints.length),
      analogWithUnit: pct(analogWithUnit, analogPoints.length),
      equipsWithPoints: pct(equipsWithPoints, scopedEquips.length),
      equipsWithTemplate: pct(equipsWithTemplate, scopedEquips.length),
      equipsTagged: pct(equipsTagged, scopedEquips.length),
    },
  };
}

function aggregateStatus(findings) {
  if (findings.some((f) => f.status === "fail")) return "fail";
  if (findings.some((f) => f.status === "warn")) return "warn";
  return "pass";
}

/**
 * Validate a building model snapshot for integrity, tagging, and coverage.
 *
 * @param {object} params
 * @param {object} [params.inventory] - an inventory instance (exportSnapshot/listEntities).
 * @param {object[]} [params.entities] - raw entity array (alternative to inventory).
 * @param {{ siteId?: string, buildingId?: string, floorId?: string, equipId?: string }} [params.scope]
 * @param {string[]} [params.checkIds] - restrict to a subset of checks by id.
 * @param {() => number} [params.now]
 * @param {object} [params.options]
 * @returns {object} a modelValidation run.
 */
export function validateModel({ inventory, entities, scope = {}, checkIds = null, now = () => Date.now(), options = {} } = {}) {
  const list = Array.isArray(entities)
    ? entities
    : inventory?.exportSnapshot
      ? inventory.exportSnapshot().entities || []
      : inventory?.listEntities
        ? inventory.listEntities()
        : [];
  const startedAt = new Date(now()).toISOString();
  const ctx = buildContext(list, scope);
  const checks = (checkIds && checkIds.length)
    ? checkIds.map((id) => CHECK_BY_ID.get(id)).filter(Boolean)
    : VALIDATION_CHECKS;

  const findings = [];
  for (const check of checks) {
    for (const f of check.run(ctx)) findings.push(f);
  }
  findings.sort((a, b) =>
    String(a.category).localeCompare(String(b.category)) ||
    String(a.checkId).localeCompare(String(b.checkId)) ||
    String(a.entityName || "").localeCompare(String(b.entityName || "")));

  const coverage = computeCoverage(ctx);
  const finishedAt = new Date(now()).toISOString();
  return {
    type: "modelValidation",
    name: `Model validation ${startedAt}`,
    startedAt,
    finishedAt,
    status: aggregateStatus(findings),
    scope,
    findings,
    coverage,
    summary: {
      entities: ctx.scoped.length,
      points: coverage.points,
      equips: coverage.equips,
      checks: checks.length,
      fail: findings.filter((f) => f.status === "fail").length,
      warn: findings.filter((f) => f.status === "warn").length,
      info: findings.filter((f) => f.status === "info").length,
      byCategory: findings.reduce((acc, f) => {
        acc[f.category] = (acc[f.category] || 0) + 1;
        return acc;
      }, {}),
    },
    notes: options.notes || "",
  };
}

function pctText(value) {
  return value == null ? "—" : `${value}%`;
}

export function exportValidationMarkdown(run) {
  const cov = run?.coverage || {};
  const p = cov.pct || {};
  const lines = [
    `# ${run?.name || "Model Validation Report"}`,
    "",
    `Status: ${run?.status || "unknown"}`,
    `Started: ${run?.startedAt || ""}`,
    `Finished: ${run?.finishedAt || ""}`,
    "",
    "## Summary",
    `- Entities in scope: ${run?.summary?.entities ?? 0}`,
    `- Points: ${run?.summary?.points ?? 0}`,
    `- Equipment: ${run?.summary?.equips ?? 0}`,
    `- Failures: ${run?.summary?.fail ?? 0}`,
    `- Warnings: ${run?.summary?.warn ?? 0}`,
    `- Info: ${run?.summary?.info ?? 0}`,
    "",
    "## Coverage",
    "| Metric | Covered | Total | % |",
    "| --- | --- | --- | --- |",
    `| Points with source reference | ${cov.pointsWithSourceRef ?? 0} | ${cov.points ?? 0} | ${pctText(p.pointsWithSourceRef)} |`,
    `| Points tagged 'point' | ${cov.pointsTagged ?? 0} | ${cov.points ?? 0} | ${pctText(p.pointsTagged)} |`,
    `| Analog points with units | ${cov.analogWithUnit ?? 0} | ${cov.analogPoints ?? 0} | ${pctText(p.analogWithUnit)} |`,
    `| Equipment with points | ${cov.equipsWithPoints ?? 0} | ${cov.equips ?? 0} | ${pctText(p.equipsWithPoints)} |`,
    `| Equipment with template | ${cov.equipsWithTemplate ?? 0} | ${cov.equips ?? 0} | ${pctText(p.equipsWithTemplate)} |`,
    "",
    "## Findings",
    "| Category | Check | Severity | Status | Entity | Message |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const f of run?.findings || []) {
    lines.push(`| ${f.category || ""} | ${f.checkName || f.checkId || ""} | ${f.severity || ""} | ${f.status || ""} | ${f.entityName || f.entityId || ""} | ${f.message || ""} |`);
  }
  if (run?.notes) lines.push("", "## Notes", run.notes);
  return `${lines.join("\n")}\n`;
}

export function exportValidationCsv(run) {
  const rows = [["category", "checkId", "checkName", "severity", "status", "entityId", "entityType", "entityName", "message"]];
  for (const f of run?.findings || []) {
    rows.push([f.category, f.checkId, f.checkName, f.severity, f.status, f.entityId || "", f.entityType || "", f.entityName || "", f.message || ""]);
  }
  return `${rows.map((r) => r.map(csvCell).join(",")).join("\n")}\n`;
}
