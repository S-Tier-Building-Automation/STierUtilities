// Analytics app — run rule packs against the building model and review/export
// findings. A thin shell over the rules.v1 capability: it owns no rule logic,
// only the rule configuration, run controls, KPIs, filtering, and exports.

import { setAppIntent } from "../../ui/app-intent.js";
import { confirmAction } from "../../ui/modal.js";

const ANALYTICS_TS_RE = /[:.]/g;
const RULE_KINDS = [
  ["missing-point", "Missing point"],
  ["range", "In range"],
  ["threshold", "Threshold"],
];
const OPERATORS = ["lt", "lte", "gt", "gte", "eq"];
const SEVERITIES = ["high", "medium", "low"];
const STATUS_FILTERS = [
  ["open", "Open"],
  ["fail", "Fail"],
  ["warn", "Warn"],
  ["pass", "Pass"],
  ["skip", "Skip"],
  ["all", "All"],
];

/**
 * @param {object} deps
 * @param {import("../../ui/dom.js").el} deps.el
 * @param {(toolId: string, msg: string, kind?: string) => void} deps.logTo
 * @param {() => void} deps.renderAll
 * @param {() => object|null} deps.getPlatform
 * @param {() => object|null} deps.getInventory
 * @param {object} deps.userState
 * @param {() => void} deps.saveUserState
 * @param {(view: string) => void} deps.setView
 * @param {(id: string) => string} deps.pluginView
 */
export function createBuildingAnalyticsUi({
  el, logTo, renderAll, getPlatform, getInventory, userState, saveUserState, setView, pluginView,
}) {
  let busy = false;
  // Ephemeral UI state (kept out of persisted state so it survives re-render
  // without disk churn): expand toggles and the in-progress rule editor draft.
  let rulesOpen = false;
  let historyOpen = false;
  let editingRuleId = null;  // null | "new" | <customRuleId>
  let draft = null;

  // Persisted, scope-aware UI state.
  function st() {
    const cur = userState.analytics;
    if (!cur || typeof cur !== "object") {
      userState.analytics = {
        siteId: "", useLive: true, lastRunId: null,
        enabledRules: {}, ruleParams: {}, customRules: [],
        filterStatus: "open", filterSeverity: "all", search: "",
      };
    } else {
      // Backfill new fields onto an older persisted shape.
      if (typeof cur.useLive !== "boolean") cur.useLive = true;
      if (!cur.enabledRules || typeof cur.enabledRules !== "object") cur.enabledRules = {};
      if (!cur.ruleParams || typeof cur.ruleParams !== "object") cur.ruleParams = {};
      if (!Array.isArray(cur.customRules)) cur.customRules = [];
      if (!cur.filterStatus) cur.filterStatus = "open";
      if (!cur.filterSeverity) cur.filterSeverity = "all";
      if (typeof cur.search !== "string") cur.search = "";
    }
    return userState.analytics;
  }
  function patchState(patch) {
    Object.assign(st(), patch);
    saveUserState();
  }

  function rulesCap() {
    const platform = getPlatform();
    return platform ? platform.capability("rules.v1") : null;
  }

  function rulePack() {
    const rules = rulesCap();
    return rules ? rules.listRules() : [];
  }

  function customRules() {
    return st().customRules || [];
  }

  function allRules() {
    return [...rulePack(), ...customRules()];
  }

  function isRuleEnabled(id) {
    return st().enabledRules[id] !== false;
  }

  // Known point roles, harvested from the built-in pack, for the editor datalist.
  function knownRoles() {
    const set = new Set();
    for (const r of allRules()) for (const role of (r.roles || [])) set.add(role);
    ["space-temperature", "discharge-air-temp", "dat", "airflow", "cfm", "fan", "damper", "reheat", "co2", "humidity"].forEach((r) => set.add(r));
    return [...set].sort();
  }

  // ---- custom-rule CRUD ----

  function newRuleId() {
    return `custom-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`;
  }

  function startCreate() {
    draft = { id: newRuleId(), name: "", severity: "medium", kind: "range", roles: "", scopeTag: "vav", min: "", max: "", value: "", operator: "lt", unit: "", excludeNamePatterns: "" };
    editingRuleId = "new";
    rulesOpen = true;
    renderAll();
  }

  function startEdit(rule) {
    draft = {
      id: rule.id,
      name: rule.name || "",
      severity: rule.severity || "medium",
      kind: rule.kind || "range",
      roles: (rule.roles || []).join(", "),
      scopeTag: Object.keys(rule.scope?.tags || { vav: true })[0] || "vav",
      min: rule.min ?? "",
      max: rule.max ?? "",
      value: rule.value ?? "",
      operator: rule.operator || "lt",
      unit: rule.unit || "",
      excludeNamePatterns: (rule.excludeNamePatterns || []).join(", "),
    };
    editingRuleId = rule.id;
    rulesOpen = true;
    renderAll();
  }

  function cancelDraft() {
    draft = null;
    editingRuleId = null;
    renderAll();
  }

  function draftToRule() {
    const csv = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
    const rule = {
      id: draft.id,
      name: draft.name.trim() || "Untitled rule",
      severity: draft.severity,
      kind: draft.kind,
      scope: { tags: { [draft.scopeTag.trim() || "vav"]: true } },
      roles: csv(draft.roles),
      custom: true,
    };
    if (draft.excludeNamePatterns.trim()) rule.excludeNamePatterns = csv(draft.excludeNamePatterns);
    if (draft.unit.trim()) rule.unit = draft.unit.trim();
    if (draft.kind === "range") {
      if (draft.min !== "") rule.min = Number(draft.min);
      if (draft.max !== "") rule.max = Number(draft.max);
    } else if (draft.kind === "threshold") {
      rule.operator = draft.operator;
      if (draft.value !== "") rule.value = Number(draft.value);
    }
    return rule;
  }

  function saveDraft() {
    if (!draft) return;
    if (!draft.name.trim()) { logTo("building-analytics", "Rule needs a name.", "warn"); return; }
    if (!draftToRule().roles.length && draft.kind !== "missing-point") {
      // range/threshold rules need a role to locate a point.
    }
    const rule = draftToRule();
    const list = [...customRules()];
    const idx = list.findIndex((r) => r.id === rule.id);
    if (idx >= 0) list[idx] = rule; else list.push(rule);
    patchState({ customRules: list });
    logTo("building-analytics", `Saved rule "${rule.name}".`, "ok");
    draft = null;
    editingRuleId = null;
    renderAll();
  }

  async function deleteCustomRule(rule) {
    const ok = await confirmAction({ title: "Delete rule", message: `Delete custom rule "${rule.name}"? This cannot be undone.`, confirmLabel: "Delete", danger: true });
    if (!ok) return;
    const list = customRules().filter((r) => r.id !== rule.id);
    const enabled = { ...st().enabledRules };
    delete enabled[rule.id];
    patchState({ customRules: list, enabledRules: enabled });
    logTo("building-analytics", `Deleted rule "${rule.name}".`, "ok");
    renderAll();
  }

  function resetRuleParams(ruleId) {
    const ruleParams = { ...st().ruleParams };
    delete ruleParams[ruleId];
    patchState({ ruleParams });
    renderAll();
  }

  function paramFor(rule) {
    const saved = st().ruleParams[rule.id] || {};
    return {
      min: saved.min ?? rule.min,
      max: saved.max ?? rule.max,
      value: saved.value ?? rule.value,
    };
  }

  function buildOverrides() {
    const overrides = {};
    for (const rule of rulePack()) {
      const p = paramFor(rule);
      if (rule.kind === "range") overrides[rule.id] = { min: Number(p.min), max: Number(p.max) };
      else if (rule.kind === "threshold") overrides[rule.id] = { value: Number(p.value) };
    }
    return overrides;
  }

  function setRuleEnabled(id, on) {
    const enabled = { ...st().enabledRules, [id]: on };
    patchState({ enabledRules: enabled });
    renderAll();
  }

  function setRuleParam(id, key, value) {
    const ruleParams = { ...st().ruleParams, [id]: { ...(st().ruleParams[id] || {}), [key]: value } };
    patchState({ ruleParams });
  }

  function setAllRules(on) {
    const enabled = {};
    for (const rule of rulePack()) enabled[rule.id] = on;
    patchState({ enabledRules: enabled });
    renderAll();
  }

  function downloadFile(name, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function analyticsTimestamp() {
    return new Date().toISOString().replace(ANALYTICS_TS_RE, "-");
  }

  async function runRules(inv) {
    const rules = rulesCap();
    if (!rules || busy) return;
    const enabled = allRules().filter((r) => isRuleEnabled(r.id));
    if (!enabled.length) {
      logTo("building-analytics", "No rules enabled — enable at least one rule to run.", "warn");
      return;
    }
    busy = true;
    renderAll();
    try {
      const s = st();
      const run = await rules.run({
        scope: { siteId: s.siteId || null },
        rules: enabled,
        useLive: s.useLive,
        options: { ruleOverrides: buildOverrides() },
      });
      const saved = inv.recordRuleRun(run);
      patchState({ lastRunId: saved.id });
      const fails = run.summary?.fail || 0;
      const warns = run.summary?.warn || 0;
      logTo("building-analytics", fails || warns
        ? `Analytics found ${fails} failure${fails === 1 ? "" : "s"} and ${warns} warning${warns === 1 ? "" : "s"}.`
        : "Analytics passed with no issues.", fails ? "warn" : "ok");
    } catch (err) {
      logTo("building-analytics", `Analytics run failed: ${err}`, "error");
    } finally {
      busy = false;
      renderAll();
    }
  }

  function openGraphics(equipId) {
    setAppIntent("device-graphics", { equipId });
    setView(pluginView("device-graphics"));
  }
  function openWorkspace(equipId) {
    setAppIntent("building-workspace", { equipId });
    setView(pluginView("building-workspace"));
  }

  // ---- presentation helpers ----

  function sevPill(severity) {
    const sev = String(severity || "medium").toLowerCase();
    const cls = sev === "high" ? "pill-warn" : sev === "low" ? "pill-muted" : "pill-idle";
    return el("span", { class: `pill pill-sm ${cls}` }, sev);
  }

  function statusPill(status) {
    const map = { fail: "pill-warn", warn: "pill-idle", pass: "pill-running", skip: "pill-muted" };
    return el("span", { class: `pill pill-sm ${map[status] || "pill-muted"}` }, String(status || "").toUpperCase());
  }

  function thresholdText(f) {
    const t = f.threshold;
    if (!t) return "";
    if (t.min != null || t.max != null) return `expected ${t.min ?? "—"}–${t.max ?? "—"}${t.unit ? ` ${t.unit}` : ""}`;
    if (t.value != null) return `${t.operator || ""} ${t.value}${t.unit ? ` ${t.unit}` : ""}`.trim();
    return "";
  }

  function passRate(summary) {
    const total = (summary?.fail || 0) + (summary?.warn || 0) + (summary?.pass || 0);
    if (!total) return "—";
    return `${Math.round((summary.pass / total) * 100)}%`;
  }

  function countTile(label, value, cls = "") {
    return el("div", { class: "bw-count-tile" },
      el("span", { class: `bw-count-value ${cls}` }, String(value)),
      el("span", { class: "bw-count-label" }, label));
  }

  function matchesFilters(f, s) {
    if (s.filterStatus === "open") { if (f.status !== "fail" && f.status !== "warn") return false; }
    else if (s.filterStatus !== "all" && f.status !== s.filterStatus) return false;
    if (s.filterSeverity !== "all" && String(f.severity || "medium").toLowerCase() !== s.filterSeverity) return false;
    if (s.search) {
      const hay = `${f.equipName || ""} ${f.ruleName || ""} ${f.pointName || ""} ${f.message || ""}`.toLowerCase();
      if (!hay.includes(s.search.toLowerCase())) return false;
    }
    return true;
  }

  function findingRow(f) {
    const detail = [f.pointName, f.value != null ? `= ${f.value}` : null, thresholdText(f)].filter(Boolean).join(" ");
    return el("div", { class: "bw-card bw-detail-card an-finding-row" },
      el("div", { class: "an-finding-head" },
        statusPill(f.status),
        sevPill(f.severity),
        el("span", { class: "an-finding-equip" }, f.equipName || f.equipId || "—"),
        el("span", { class: "muted small an-finding-rule" }, f.ruleName || f.ruleId || "")),
      el("p", { class: "an-finding-msg" }, f.message || ""),
      detail ? el("p", { class: "muted small an-finding-detail" }, detail) : null,
      f.equipId
        ? el("div", { class: "tool-actions an-finding-actions" },
            el("button", { class: "btn-ghost btn-sm", onclick: () => openGraphics(f.equipId) }, "Graphics"),
            el("button", { class: "btn-ghost btn-sm", onclick: () => openWorkspace(f.equipId) }, "Workspace"))
        : null);
  }

  // ---- cards ----

  function controlsCard(inv, vavCount) {
    const s = st();
    const sites = inv.listEntities({ type: "site" });
    const enabledCount = allRules().filter((r) => isRuleEnabled(r.id)).length;
    return el("div", { class: "bw-card bw-rule-controls" },
      el("div", { class: "bac-discover-controls" },
        sites.length
          ? el("label", { class: "nm-field" }, el("span", { class: "nm-field-label" }, "Site"),
              el("select", { class: "nm-input", onchange: (e) => { patchState({ siteId: e.target.value }); renderAll(); } },
                el("option", { value: "" }, "All sites"),
                ...sites.map((site) => el("option", { value: site.id, selected: site.id === s.siteId ? "selected" : undefined }, site.name || site.id))))
          : null,
        el("label", { class: "bw-cx-check" },
          el("input", { type: "checkbox", checked: s.useLive ? "checked" : undefined, onchange: (e) => patchState({ useLive: e.target.checked }) }),
          el("span", {}, "Use live BACnet values")),
        el("button", {
          class: "btn btn-primary",
          disabled: busy || vavCount === 0 || enabledCount === 0 ? "disabled" : undefined,
          onclick: () => runRules(inv),
        }, busy ? "Running…" : "Run analytics")),
      el("p", { class: "muted small" }, `${vavCount} VAV${vavCount === 1 ? "" : "s"} in scope · ${enabledCount} of ${allRules().length} rule${allRules().length === 1 ? "" : "s"} enabled · ${s.useLive ? "live reads on" : "model-only"}`));
  }

  function builtinRuleRow(rule) {
    const p = paramFor(rule);
    const tuned = !!st().ruleParams[rule.id];
    const params = rule.kind === "range"
      ? el("span", { class: "an-rule-params" },
          el("input", { class: "nm-input bac-range-input", value: String(p.min ?? ""), title: "min", oninput: (e) => setRuleParam(rule.id, "min", e.target.value) }),
          el("span", { class: "muted small" }, "–"),
          el("input", { class: "nm-input bac-range-input", value: String(p.max ?? ""), title: "max", oninput: (e) => setRuleParam(rule.id, "max", e.target.value) }),
          rule.unit ? el("span", { class: "muted small" }, rule.unit) : null,
          tuned ? el("button", { class: "btn-ghost btn-sm", title: "Reset to defaults", onclick: () => resetRuleParams(rule.id) }, "Reset") : null)
      : rule.kind === "threshold"
        ? el("span", { class: "an-rule-params" },
            el("span", { class: "muted small" }, rule.operator || "lt"),
            el("input", { class: "nm-input bac-range-input", value: String(p.value ?? ""), title: "threshold", oninput: (e) => setRuleParam(rule.id, "value", e.target.value) }),
            rule.unit ? el("span", { class: "muted small" }, rule.unit) : null,
            tuned ? el("button", { class: "btn-ghost btn-sm", title: "Reset to defaults", onclick: () => resetRuleParams(rule.id) }, "Reset") : null)
        : el("span", { class: "muted small an-rule-params" }, "presence check");
    return el("div", { class: "an-rule-row" },
      el("label", { class: "bw-cx-check an-rule-toggle" },
        el("input", { type: "checkbox", checked: isRuleEnabled(rule.id) ? "checked" : undefined, onchange: (e) => setRuleEnabled(rule.id, e.target.checked) }),
        el("span", { class: "an-rule-name" }, rule.name)),
      sevPill(rule.severity),
      params);
  }

  function customRuleRow(rule) {
    if (editingRuleId === rule.id) return ruleEditor();
    const kindLabel = (RULE_KINDS.find(([k]) => k === rule.kind) || [rule.kind, rule.kind])[1];
    const detail = rule.kind === "range" ? `${rule.min ?? "—"}–${rule.max ?? "—"}${rule.unit ? ` ${rule.unit}` : ""}`
      : rule.kind === "threshold" ? `${rule.operator || "lt"} ${rule.value ?? "—"}${rule.unit ? ` ${rule.unit}` : ""}`
      : (rule.roles || []).join(", ");
    return el("div", { class: "an-rule-row" },
      el("label", { class: "bw-cx-check an-rule-toggle" },
        el("input", { type: "checkbox", checked: isRuleEnabled(rule.id) ? "checked" : undefined, onchange: (e) => setRuleEnabled(rule.id, e.target.checked) }),
        el("span", { class: "an-rule-name" }, rule.name)),
      sevPill(rule.severity),
      el("span", { class: "muted small an-rule-params" }, `${kindLabel}${detail ? ` · ${detail}` : ""}`),
      el("span", { class: "an-rule-actions" },
        el("button", { class: "btn-ghost btn-sm", onclick: () => startEdit(rule) }, "Edit"),
        el("button", { class: "btn-ghost btn-sm", onclick: () => deleteCustomRule(rule) }, "Delete")));
  }

  function ruleEditor() {
    const field = (label, node) => el("label", { class: "nm-field" }, el("span", { class: "nm-field-label" }, label), node);
    const textInput = (key, placeholder = "") => el("input", { class: "nm-input", value: String(draft[key] ?? ""), placeholder, oninput: (e) => { draft[key] = e.target.value; } });
    const kindFields = draft.kind === "range"
      ? el("div", { class: "bac-discover-controls" },
          field("Min", el("input", { class: "nm-input bac-range-input", value: String(draft.min ?? ""), oninput: (e) => { draft.min = e.target.value; } })),
          field("Max", el("input", { class: "nm-input bac-range-input", value: String(draft.max ?? ""), oninput: (e) => { draft.max = e.target.value; } })),
          field("Unit", el("input", { class: "nm-input bac-range-input", value: String(draft.unit ?? ""), oninput: (e) => { draft.unit = e.target.value; } })))
      : draft.kind === "threshold"
        ? el("div", { class: "bac-discover-controls" },
            field("Operator", el("select", { class: "nm-input", onchange: (e) => { draft.operator = e.target.value; } },
              ...OPERATORS.map((op) => el("option", { value: op, selected: draft.operator === op ? "selected" : undefined }, op)))),
            field("Value", el("input", { class: "nm-input bac-range-input", value: String(draft.value ?? ""), oninput: (e) => { draft.value = e.target.value; } })),
            field("Unit", el("input", { class: "nm-input bac-range-input", value: String(draft.unit ?? ""), oninput: (e) => { draft.unit = e.target.value; } })))
        : el("p", { class: "muted small" }, "Presence check — fails when no point matches the role(s) below.");
    return el("div", { class: "bw-card an-rule-editor" },
      el("h4", { class: "bw-card-title" }, editingRuleId === "new" ? "New rule" : "Edit rule"),
      el("div", { class: "bac-discover-controls" },
        field("Name", textInput("name", "e.g. High zone CO₂")),
        field("Severity", el("select", { class: "nm-input", onchange: (e) => { draft.severity = e.target.value; } },
          ...SEVERITIES.map((sev) => el("option", { value: sev, selected: draft.severity === sev ? "selected" : undefined }, sev)))),
        field("Kind", el("select", { class: "nm-input", onchange: (e) => { draft.kind = e.target.value; renderAll(); } },
          ...RULE_KINDS.map(([k, label]) => el("option", { value: k, selected: draft.kind === k ? "selected" : undefined }, label)))),
        field("Applies to tag", textInput("scopeTag", "vav"))),
      el("div", { class: "bac-discover-controls" },
        field("Roles", el("input", { class: "nm-input an-roles-input", list: "an-known-roles", value: String(draft.roles ?? ""), placeholder: "comma-separated, e.g. co2", oninput: (e) => { draft.roles = e.target.value; } })),
        field("Exclude name patterns", textInput("excludeNamePatterns", "e.g. setpoint, alarm"))),
      el("datalist", { id: "an-known-roles" }, ...knownRoles().map((r) => el("option", { value: r }))),
      kindFields,
      el("div", { class: "tool-actions" },
        el("button", { class: "btn btn-primary btn-sm", onclick: () => saveDraft() }, "Save rule"),
        el("button", { class: "btn-ghost btn-sm", onclick: () => cancelDraft() }, "Cancel")));
  }

  // Explicit collapsible (not <details>) so CRUD re-renders never collapse it.
  function collapsibleCard(open, title, onToggle, body) {
    return el("div", { class: "bw-card bw-detail-card an-collapsible" },
      el("button", { class: "an-collapse-head", type: "button", "aria-expanded": open ? "true" : "false", onclick: onToggle },
        el("span", { class: "an-collapse-caret" }, open ? "▾" : "▸"),
        el("span", { class: "bw-card-title" }, title)),
      ...(open ? body : []));
  }

  function rulesConfigCard() {
    const builtins = rulePack();
    const customs = customRules();
    const enabledCount = allRules().filter((r) => isRuleEnabled(r.id)).length;
    const body = [
      el("div", { class: "tool-actions" },
        el("button", { class: "btn-ghost btn-sm", onclick: () => setAllRules(true) }, "Enable all"),
        el("button", { class: "btn-ghost btn-sm", onclick: () => setAllRules(false) }, "Disable all"),
        el("button", { class: "btn btn-primary btn-sm", onclick: () => startCreate() }, "New rule")),
      editingRuleId === "new" ? ruleEditor() : null,
      el("h5", { class: "an-rule-group" }, "Built-in rules"),
      el("div", { class: "bw-bind-list" }, ...builtins.map(builtinRuleRow)),
      el("h5", { class: "an-rule-group" }, `Custom rules${customs.length ? ` (${customs.length})` : ""}`),
      customs.length
        ? el("div", { class: "bw-bind-list" }, ...customs.map(customRuleRow))
        : el("p", { class: "muted small" }, "No custom rules yet. Use \u201cNew rule\u201d to add one."),
    ].filter(Boolean);
    return collapsibleCard(rulesOpen, `Rule configuration (${enabledCount}/${allRules().length} on)`, () => { rulesOpen = !rulesOpen; renderAll(); }, body);
  }

  function filtersBar(s, counts) {
    return el("div", { class: "bw-card an-filters" },
      el("div", { class: "an-filter-chips" },
        ...STATUS_FILTERS.map(([key, label]) => el("button", {
          class: `bw-tab ${s.filterStatus === key ? "bw-tab-on" : ""}`,
          onclick: () => { patchState({ filterStatus: key }); renderAll(); },
        }, `${label}${counts[key] != null ? ` (${counts[key]})` : ""}`))),
      el("div", { class: "bac-discover-controls" },
        el("label", { class: "nm-field" }, el("span", { class: "nm-field-label" }, "Severity"),
          el("select", { class: "nm-input", onchange: (e) => { patchState({ filterSeverity: e.target.value }); renderAll(); } },
            ...["all", "high", "medium", "low"].map((sev) => el("option", { value: sev, selected: s.filterSeverity === sev ? "selected" : undefined }, sev === "all" ? "All severities" : sev)))),
        el("label", { class: "nm-field an-search" }, el("span", { class: "nm-field-label" }, "Search"),
          el("input", { class: "nm-input", placeholder: "equipment, rule, point…", value: s.search, oninput: (e) => { patchState({ search: e.target.value }); renderAll(); } }))));
  }

  function renderPage() {
    const inv = getInventory();
    const rules = rulesCap();
    if (!inv || !rules) {
      return el("div", { class: "plugin-controls" },
        el("section", { class: "plugin-section" },
          el("p", { class: "empty-state" }, "Building model or analytics engine is not available.")));
    }

    const s = st();
    const runs = inv.listEntities({ type: "ruleRun" });
    const run = s.lastRunId ? inv.getEntity(s.lastRunId) : runs.at(-1);
    const allFindings = run?.findings || [];
    const vavCount = inv.listEntities({ type: "equip" }).filter((e) => e.tags?.vav || e.templateId === "template:vav").length;

    const counts = {
      open: allFindings.filter((f) => f.status === "fail" || f.status === "warn").length,
      fail: allFindings.filter((f) => f.status === "fail").length,
      warn: allFindings.filter((f) => f.status === "warn").length,
      pass: allFindings.filter((f) => f.status === "pass").length,
      skip: allFindings.filter((f) => f.status === "skip").length,
      all: allFindings.length,
    };
    const visible = allFindings.filter((f) => matchesFilters(f, s));

    const kpis = run
      ? el("div", { class: "bw-count-grid an-kpis" },
          countTile("Equipment", run.summary?.equips ?? 0),
          countTile("Failures", run.summary?.fail ?? 0, (run.summary?.fail || 0) ? "an-kpi-bad" : ""),
          countTile("Warnings", run.summary?.warn ?? 0),
          countTile("Pass rate", passRate(run.summary)),
          countTile("Last run", run.finishedAt ? new Date(run.finishedAt).toLocaleTimeString() : "—"))
      : null;

    const exportActions = run
      ? el("div", { class: "tool-actions" },
          el("button", { class: "btn-ghost", onclick: () => downloadFile(`analytics-${analyticsTimestamp()}.md`, rules.exportMarkdown(inv.exportSnapshot(), run), "text/markdown;charset=utf-8") }, "Export Markdown"),
          el("button", { class: "btn-ghost", onclick: () => downloadFile(`analytics-${analyticsTimestamp()}.csv`, rules.exportCsv(run), "text/csv;charset=utf-8") }, "Export CSV"))
      : null;

    const findingsBody = !run
      ? el("p", { class: "muted small" }, "No analytics run yet. Configure rules and run analytics to populate findings.")
      : visible.length
        ? el("div", { class: "an-findings" }, ...visible.map(findingRow))
        : el("p", { class: "muted small" }, "No findings match the current filters.");

    const history = runs.length > 1
      ? collapsibleCard(historyOpen, `Run history (${runs.length})`, () => { historyOpen = !historyOpen; renderAll(); }, [
          el("ul", { class: "bw-bind-list" },
            ...runs.slice(-12).reverse().map((r) => el("li", { class: "bw-bind-row" },
              el("button", { class: `btn-ghost btn-sm ${r.id === run?.id ? "is-active" : ""}`, onclick: () => { patchState({ lastRunId: r.id }); renderAll(); } }, r.finishedAt ? new Date(r.finishedAt).toLocaleString() : (r.startedAt || r.id)),
              el("span", { class: "muted small" }, `${r.summary?.fail || 0} fail · ${r.summary?.warn || 0} warn · ${r.summary?.pass || 0} pass`)))),
        ])
      : null;

    return el("div", { class: "plugin-controls" },
      el("section", { class: "plugin-section" },
        controlsCard(inv, vavCount),
        kpis,
        rulesConfigCard(),
        run ? filtersBar(s, counts) : null,
        exportActions,
        findingsBody,
        history));
  }

  function renderStatusPill() {
    const inv = getInventory();
    if (!inv) return { label: "—", cls: "pill-muted" };
    const run = st().lastRunId ? inv.getEntity(st().lastRunId) : inv.listEntities({ type: "ruleRun" }).at(-1);
    if (!run) return { label: "Idle", cls: "pill-idle" };
    const fails = run.summary?.fail || 0;
    const warns = run.summary?.warn || 0;
    if (fails) return { label: `${fails} fail`, cls: "pill-warn" };
    if (warns) return { label: `${warns} warn`, cls: "pill-idle" };
    return { label: "Clear", cls: "pill-running" };
  }

  return { renderPage, renderStatusPill };
}
