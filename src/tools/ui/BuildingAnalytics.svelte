<script module>
  // Status pill is read synchronously by the shell (plugin-page header) and by
  // getSystemStatus (home/services cards), so it stays a plain exported function.
  export function statusPill(getInventory, userState) {
    const inv = getInventory();
    if (!inv) return { label: "—", cls: "pill-muted" };
    const lastRunId = userState.analytics?.lastRunId;
    const run = lastRunId ? inv.getEntity(lastRunId) : inv.listEntities({ type: "ruleRun" }).at(-1);
    if (!run) return { label: "Idle", cls: "pill-idle" };
    const fails = run.summary?.fail || 0;
    const warns = run.summary?.warn || 0;
    if (fails) return { label: `${fails} fail`, cls: "pill-warn" };
    if (warns) return { label: `${warns} warn`, cls: "pill-idle" };
    return { label: "Clear", cls: "pill-running" };
  }
</script>

<script>
  // Analytics app — run rule packs against the building model and review/export
  // findings. A thin shell over the rules.v1 capability: it owns no rule logic,
  // only the rule configuration, run controls, KPIs, filtering, and exports.
  // Reactive on inventoryVersion so runs recorded anywhere refresh the page.
  import { onMount } from "svelte";
  import { inventoryVersion } from "../../platform/store.js";
  import { setAppIntent, takeAppIntent } from "../../ui/app-intent.js";
  import { confirmAction } from "../../ui/modal.js";

  let { logTo, getPlatform, getInventory, userState, saveUserState, setView, pluginView } = $props();

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

  // Ephemeral UI state: expand toggles and the in-progress rule editor draft.
  let busy = $state(false);
  let rulesOpen = $state(false);
  let historyOpen = $state(false);
  let editingRuleId = $state(null); // null | "new" | <customRuleId>
  let draft = $state(null);

  // Persisted, scope-aware UI state — lazy-init the default shape + backfill
  // older persisted shapes. Kept in userState; saveUserState() on every change.
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
  // Ensure the persisted shape exists up-front so $state-bound reactive reads
  // observe a stable object; the bump signal drives re-renders after writes.
  st();

  function patchState(patch) {
    Object.assign(st(), patch);
    saveUserState();
    bump();
  }

  // Persisted state lives on the plain userState object (not $state), so writes
  // to it don't trigger Svelte reactivity by themselves. Mirror a local bump
  // counter that every persisted-state mutation increments, and read it in the
  // derived bodies so the page re-renders on config changes.
  let stateVersion = $state(0);
  function bump() { stateVersion += 1; }

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
  }

  function cancelDraft() {
    draft = null;
    editingRuleId = null;
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
    const rule = draftToRule();
    if (rule.kind !== "missing-point" && !rule.roles.length) {
      logTo("building-analytics", "Range and threshold rules need at least one role to locate a point.", "warn");
      return;
    }
    const list = [...customRules()];
    const idx = list.findIndex((r) => r.id === rule.id);
    if (idx >= 0) list[idx] = rule; else list.push(rule);
    patchState({ customRules: list });
    logTo("building-analytics", `Saved rule "${rule.name}".`, "ok");
    draft = null;
    editingRuleId = null;
  }

  async function deleteCustomRule(rule) {
    const ok = await confirmAction({ title: "Delete rule", message: `Delete custom rule "${rule.name}"? This cannot be undone.`, confirmLabel: "Delete", danger: true });
    if (!ok) return;
    const list = customRules().filter((r) => r.id !== rule.id);
    const enabled = { ...st().enabledRules };
    delete enabled[rule.id];
    patchState({ customRules: list, enabledRules: enabled });
    logTo("building-analytics", `Deleted rule "${rule.name}".`, "ok");
  }

  function resetRuleParams(ruleId) {
    const ruleParams = { ...st().ruleParams };
    delete ruleParams[ruleId];
    patchState({ ruleParams });
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
    const num = (v) => (v === "" || v == null || !Number.isFinite(Number(v)) ? undefined : Number(v));
    for (const rule of rulePack()) {
      const p = paramFor(rule);
      if (rule.kind === "range") {
        const o = {};
        if (num(p.min) !== undefined) o.min = num(p.min);
        if (num(p.max) !== undefined) o.max = num(p.max);
        if (Object.keys(o).length) overrides[rule.id] = o;
      } else if (rule.kind === "threshold") {
        if (num(p.value) !== undefined) overrides[rule.id] = { value: num(p.value) };
      }
    }
    return overrides;
  }

  function setRuleEnabled(id, on) {
    const enabled = { ...st().enabledRules, [id]: on };
    patchState({ enabledRules: enabled });
  }

  function setRuleParam(id, key, value) {
    const ruleParams = { ...st().ruleParams, [id]: { ...(st().ruleParams[id] || {}), [key]: value } };
    patchState({ ruleParams });
  }

  function setAllRules(on) {
    const enabled = {};
    for (const rule of allRules()) enabled[rule.id] = on;
    patchState({ enabledRules: enabled });
  }

  function downloadFile(name, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function analyticsTimestamp() {
    return new Date().toISOString().replace(ANALYTICS_TS_RE, "-");
  }

  async function runRules() {
    const inv = getInventory();
    const rules = rulesCap();
    if (!inv || !rules || busy) return;
    const enabled = allRules().filter((r) => isRuleEnabled(r.id));
    if (!enabled.length) {
      logTo("building-analytics", "No rules enabled — enable at least one rule to run.", "warn");
      return;
    }
    busy = true;
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

  function sevClass(severity) {
    const sev = String(severity || "medium").toLowerCase();
    return sev === "high" ? "pill-warn" : sev === "low" ? "pill-muted" : "pill-idle";
  }
  function sevLabel(severity) {
    return String(severity || "medium").toLowerCase();
  }

  function statusClass(status) {
    const map = { fail: "pill-warn", warn: "pill-idle", pass: "pill-running", skip: "pill-muted" };
    return map[status] || "pill-muted";
  }
  function statusLabel(status) {
    return String(status || "").toUpperCase();
  }

  function thresholdText(f) {
    const t = f.threshold;
    if (!t) return "";
    if (t.min != null || t.max != null) return `expected ${t.min ?? "—"}–${t.max ?? "—"}${t.unit ? ` ${t.unit}` : ""}`;
    if (t.value != null) return `${t.operator || ""} ${t.value}${t.unit ? ` ${t.unit}` : ""}`.trim();
    return "";
  }

  function findingDetail(f) {
    return [f.pointName, f.value != null ? `= ${f.value}` : null, thresholdText(f)].filter(Boolean).join(" ");
  }

  function passRate(summary) {
    const total = (summary?.fail || 0) + (summary?.warn || 0) + (summary?.pass || 0);
    if (!total) return "—";
    return `${Math.round((summary.pass / total) * 100)}%`;
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

  function customRuleDetail(rule) {
    return rule.kind === "range" ? `${rule.min ?? "—"}–${rule.max ?? "—"}${rule.unit ? ` ${rule.unit}` : ""}`
      : rule.kind === "threshold" ? `${rule.operator || "lt"} ${rule.value ?? "—"}${rule.unit ? ` ${rule.unit}` : ""}`
        : (rule.roles || []).join(", ");
  }
  function customRuleKindLabel(rule) {
    return (RULE_KINDS.find(([k]) => k === rule.kind) || [rule.kind, rule.kind])[1];
  }

  // ---- derived data (read $inventoryVersion + stateVersion so cross-tool model
  //      writes and persisted-config writes both refresh the page) ----

  const inv = $derived.by(() => { $inventoryVersion; return getInventory(); });
  const rules = $derived.by(() => { $inventoryVersion; return rulesCap(); });
  const ready = $derived(!!inv && !!rules);

  const sites = $derived.by(() => { $inventoryVersion; const i = getInventory(); return i ? i.listEntities({ type: "site" }) : []; });
  const runs = $derived.by(() => { $inventoryVersion; const i = getInventory(); return i ? i.listEntities({ type: "ruleRun" }) : []; });

  const run = $derived.by(() => {
    $inventoryVersion; stateVersion;
    const i = getInventory();
    if (!i) return null;
    const s = st();
    return (s.lastRunId ? i.getEntity(s.lastRunId) : runs.at(-1)) || null;
  });

  const allFindings = $derived(run?.findings || []);

  const vavCount = $derived.by(() => {
    $inventoryVersion;
    const i = getInventory();
    return i ? i.listEntities({ type: "equip" }).filter((e) => e.tags?.vav || e.templateId === "template:vav").length : 0;
  });

  const builtins = $derived.by(() => { $inventoryVersion; return rulePack(); });
  const customs = $derived.by(() => { stateVersion; return customRules(); });
  const allRulesList = $derived.by(() => { $inventoryVersion; stateVersion; return allRules(); });
  const enabledCount = $derived.by(() => { $inventoryVersion; stateVersion; return allRules().filter((r) => isRuleEnabled(r.id)).length; });
  const roles = $derived.by(() => { $inventoryVersion; stateVersion; return knownRoles(); });

  const counts = $derived.by(() => ({
    open: allFindings.filter((f) => f.status === "fail" || f.status === "warn").length,
    fail: allFindings.filter((f) => f.status === "fail").length,
    warn: allFindings.filter((f) => f.status === "warn").length,
    pass: allFindings.filter((f) => f.status === "pass").length,
    skip: allFindings.filter((f) => f.status === "skip").length,
    all: allFindings.length,
  }));

  const visible = $derived.by(() => { stateVersion; const cur = st(); return allFindings.filter((f) => matchesFilters(f, cur)); });

  // Reactive snapshot of the persisted view state. userState.analytics is a
  // plain (non-$state) object, so template reads of its fields wouldn't be
  // tracked; key a fresh snapshot off stateVersion (bumped on every patchState).
  const view = $derived.by(() => { stateVersion; return { ...st() }; });

  // takeAppIntent — a one-shot read on first mount; apply siteId only if valid.
  onMount(() => {
    const i = getInventory();
    const intent = takeAppIntent("building-analytics");
    if (i && intent && "siteId" in intent && (!intent.siteId || i.getEntity(intent.siteId))) {
      patchState({ siteId: intent.siteId });
    }
  });
</script>

{#if !ready}
  <div class="plugin-controls">
    <section class="plugin-section">
      <p class="empty-state">Building model or analytics engine is not available.</p>
    </section>
  </div>
{:else}
  {@const s = view}
  <div class="plugin-controls">
    <section class="plugin-section">
      <!-- Controls card -->
      <div class="bw-card bw-rule-controls">
        <div class="bac-discover-controls">
          {#if sites.length}
            <label class="nm-field">
              <span class="nm-field-label">Site</span>
              <select class="nm-input" value={s.siteId} onchange={(e) => patchState({ siteId: e.target.value })}>
                <option value="">All sites</option>
                {#each sites as site}<option value={site.id}>{site.name || site.id}</option>{/each}
              </select>
            </label>
          {/if}
          <label class="bw-cx-check">
            <input type="checkbox" checked={s.useLive} onchange={(e) => patchState({ useLive: e.target.checked })} />
            <span>Use live BACnet values</span>
          </label>
          <button
            class="btn btn-primary"
            disabled={busy || vavCount === 0 || enabledCount === 0}
            onclick={() => runRules()}
          >{busy ? "Running…" : "Run analytics"}</button>
        </div>
        <p class="muted small">{vavCount} VAV{vavCount === 1 ? "" : "s"} in scope · {enabledCount} of {allRulesList.length} rule{allRulesList.length === 1 ? "" : "s"} enabled · {s.useLive ? "live reads on" : "model-only"}</p>
      </div>

      <!-- KPIs -->
      {#if run}
        <div class="bw-count-grid an-kpis">
          <div class="bw-count-tile"><span class="bw-count-value">{run.summary?.equips ?? 0}</span><span class="bw-count-label">Equipment</span></div>
          <div class="bw-count-tile"><span class="bw-count-value {(run.summary?.fail || 0) ? 'an-kpi-bad' : ''}">{run.summary?.fail ?? 0}</span><span class="bw-count-label">Failures</span></div>
          <div class="bw-count-tile"><span class="bw-count-value">{run.summary?.warn ?? 0}</span><span class="bw-count-label">Warnings</span></div>
          <div class="bw-count-tile"><span class="bw-count-value">{passRate(run.summary)}</span><span class="bw-count-label">Pass rate</span></div>
          <div class="bw-count-tile"><span class="bw-count-value">{run.finishedAt ? new Date(run.finishedAt).toLocaleTimeString() : "—"}</span><span class="bw-count-label">Last run</span></div>
        </div>
      {/if}

      <!-- Rule configuration (explicit collapsible, not <details>) -->
      <div class="bw-card bw-detail-card an-collapsible">
        <button class="an-collapse-head" type="button" aria-expanded={rulesOpen ? "true" : "false"} onclick={() => { rulesOpen = !rulesOpen; }}>
          <span class="an-collapse-caret">{rulesOpen ? "▾" : "▸"}</span>
          <span class="bw-card-title">Rule configuration ({enabledCount}/{allRulesList.length} on)</span>
        </button>
        {#if rulesOpen}
          <div class="tool-actions">
            <button class="btn-ghost btn-sm" onclick={() => setAllRules(true)}>Enable all</button>
            <button class="btn-ghost btn-sm" onclick={() => setAllRules(false)}>Disable all</button>
            <button class="btn btn-primary btn-sm" onclick={() => startCreate()}>New rule</button>
          </div>
          {#if editingRuleId === "new"}
            {@render ruleEditor()}
          {/if}
          <h5 class="an-rule-group">Built-in rules</h5>
          <div class="bw-bind-list">
            {#each builtins as rule (rule.id)}
              {@const p = (s.ruleParams || {}) && paramFor(rule)}
              {@const tuned = !!(s.ruleParams || {})[rule.id]}
              <div class="an-rule-row">
                <label class="bw-cx-check an-rule-toggle">
                  <input type="checkbox" checked={(s.enabledRules || {})[rule.id] !== false} onchange={(e) => setRuleEnabled(rule.id, e.target.checked)} />
                  <span class="an-rule-name">{rule.name}</span>
                </label>
                <span class="pill pill-sm {sevClass(rule.severity)}">{sevLabel(rule.severity)}</span>
                {#if rule.kind === "range"}
                  <span class="an-rule-params">
                    <input class="nm-input bac-range-input" value={String(p.min ?? "")} title="min" oninput={(e) => setRuleParam(rule.id, "min", e.target.value)} />
                    <span class="muted small">–</span>
                    <input class="nm-input bac-range-input" value={String(p.max ?? "")} title="max" oninput={(e) => setRuleParam(rule.id, "max", e.target.value)} />
                    {#if rule.unit}<span class="muted small">{rule.unit}</span>{/if}
                    {#if tuned}<button class="btn-ghost btn-sm" title="Reset to defaults" onclick={() => resetRuleParams(rule.id)}>Reset</button>{/if}
                  </span>
                {:else if rule.kind === "threshold"}
                  <span class="an-rule-params">
                    <span class="muted small">{rule.operator || "lt"}</span>
                    <input class="nm-input bac-range-input" value={String(p.value ?? "")} title="threshold" oninput={(e) => setRuleParam(rule.id, "value", e.target.value)} />
                    {#if rule.unit}<span class="muted small">{rule.unit}</span>{/if}
                    {#if tuned}<button class="btn-ghost btn-sm" title="Reset to defaults" onclick={() => resetRuleParams(rule.id)}>Reset</button>{/if}
                  </span>
                {:else}
                  <span class="muted small an-rule-params">presence check</span>
                {/if}
              </div>
            {/each}
          </div>
          <h5 class="an-rule-group">Custom rules{customs.length ? ` (${customs.length})` : ""}</h5>
          {#if customs.length}
            <div class="bw-bind-list">
              {#each customs as rule (rule.id)}
                {#if editingRuleId === rule.id}
                  {@render ruleEditor()}
                {:else}
                  <div class="an-rule-row">
                    <label class="bw-cx-check an-rule-toggle">
                      <input type="checkbox" checked={(s.enabledRules || {})[rule.id] !== false} onchange={(e) => setRuleEnabled(rule.id, e.target.checked)} />
                      <span class="an-rule-name">{rule.name}</span>
                    </label>
                    <span class="pill pill-sm {sevClass(rule.severity)}">{sevLabel(rule.severity)}</span>
                    <span class="muted small an-rule-params">{customRuleKindLabel(rule)}{customRuleDetail(rule) ? ` · ${customRuleDetail(rule)}` : ""}</span>
                    <span class="an-rule-actions">
                      <button class="btn-ghost btn-sm" onclick={() => startEdit(rule)}>Edit</button>
                      <button class="btn-ghost btn-sm" onclick={() => deleteCustomRule(rule)}>Delete</button>
                    </span>
                  </div>
                {/if}
              {/each}
            </div>
          {:else}
            <p class="muted small">No custom rules yet. Use “New rule” to add one.</p>
          {/if}
        {/if}
      </div>

      <!-- Filters bar -->
      {#if run}
        <div class="bw-card an-filters">
          <div class="an-filter-chips">
            {#each STATUS_FILTERS as [key, label]}
              <button class="bw-tab {s.filterStatus === key ? 'bw-tab-on' : ''}" onclick={() => patchState({ filterStatus: key })}>{label}{counts[key] != null ? ` (${counts[key]})` : ""}</button>
            {/each}
          </div>
          <div class="bac-discover-controls">
            <label class="nm-field">
              <span class="nm-field-label">Severity</span>
              <select class="nm-input" value={s.filterSeverity} onchange={(e) => patchState({ filterSeverity: e.target.value })}>
                {#each ["all", "high", "medium", "low"] as sev}
                  <option value={sev}>{sev === "all" ? "All severities" : sev}</option>
                {/each}
              </select>
            </label>
            <label class="nm-field an-search">
              <span class="nm-field-label">Search</span>
              <input class="nm-input" placeholder="equipment, rule, point…" value={s.search} oninput={(e) => patchState({ search: e.target.value })} />
            </label>
          </div>
        </div>
      {/if}

      <!-- Export actions -->
      {#if run}
        <div class="tool-actions">
          <button class="btn-ghost" onclick={() => downloadFile(`analytics-${analyticsTimestamp()}.md`, rules.exportMarkdown(inv.exportSnapshot(), run), "text/markdown;charset=utf-8")}>Export Markdown</button>
          <button class="btn-ghost" onclick={() => downloadFile(`analytics-${analyticsTimestamp()}.csv`, rules.exportCsv(run), "text/csv;charset=utf-8")}>Export CSV</button>
        </div>
      {/if}

      <!-- Findings -->
      {#if !run}
        <p class="muted small">No analytics run yet. Configure rules and run analytics to populate findings.</p>
      {:else if visible.length}
        <div class="an-findings">
          {#each visible as f}
            {@const detail = findingDetail(f)}
            <div class="bw-card bw-detail-card an-finding-row">
              <div class="an-finding-head">
                <span class="pill pill-sm {statusClass(f.status)}">{statusLabel(f.status)}</span>
                <span class="pill pill-sm {sevClass(f.severity)}">{sevLabel(f.severity)}</span>
                <span class="an-finding-equip">{f.equipName || f.equipId || "—"}</span>
                <span class="muted small an-finding-rule">{f.ruleName || f.ruleId || ""}</span>
              </div>
              <p class="an-finding-msg">{f.message || ""}</p>
              {#if detail}<p class="muted small an-finding-detail">{detail}</p>{/if}
              {#if f.equipId}
                <div class="tool-actions an-finding-actions">
                  <button class="btn-ghost btn-sm" onclick={() => openGraphics(f.equipId)}>Graphics</button>
                  <button class="btn-ghost btn-sm" onclick={() => openWorkspace(f.equipId)}>Workspace</button>
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {:else}
        <p class="muted small">No findings match the current filters.</p>
      {/if}

      <!-- Run history -->
      {#if runs.length > 1}
        <div class="bw-card bw-detail-card an-collapsible">
          <button class="an-collapse-head" type="button" aria-expanded={historyOpen ? "true" : "false"} onclick={() => { historyOpen = !historyOpen; }}>
            <span class="an-collapse-caret">{historyOpen ? "▾" : "▸"}</span>
            <span class="bw-card-title">Run history ({runs.length})</span>
          </button>
          {#if historyOpen}
            <ul class="bw-bind-list">
              {#each runs.slice(-12).reverse() as r (r.id)}
                <li class="bw-bind-row">
                  <button class="btn-ghost btn-sm {r.id === run?.id ? 'is-active' : ''}" onclick={() => patchState({ lastRunId: r.id })}>{r.finishedAt ? new Date(r.finishedAt).toLocaleString() : (r.startedAt || r.id)}</button>
                  <span class="muted small">{r.summary?.fail || 0} fail · {r.summary?.warn || 0} warn · {r.summary?.pass || 0} pass</span>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {/if}
    </section>
  </div>
{/if}

{#snippet ruleEditor()}
  <div class="bw-card an-rule-editor">
    <h4 class="bw-card-title">{editingRuleId === "new" ? "New rule" : "Edit rule"}</h4>
    <div class="bac-discover-controls">
      <label class="nm-field"><span class="nm-field-label">Name</span>
        <input class="nm-input" value={String(draft.name ?? "")} placeholder="e.g. High zone CO₂" oninput={(e) => { draft.name = e.target.value; }} /></label>
      <label class="nm-field"><span class="nm-field-label">Severity</span>
        <select class="nm-input" value={draft.severity} onchange={(e) => { draft.severity = e.target.value; }}>
          {#each SEVERITIES as sev}<option value={sev}>{sev}</option>{/each}
        </select></label>
      <label class="nm-field"><span class="nm-field-label">Kind</span>
        <select class="nm-input" value={draft.kind} onchange={(e) => { draft.kind = e.target.value; }}>
          {#each RULE_KINDS as [k, label]}<option value={k}>{label}</option>{/each}
        </select></label>
      <label class="nm-field"><span class="nm-field-label">Applies to tag</span>
        <input class="nm-input" value={String(draft.scopeTag ?? "")} placeholder="vav" oninput={(e) => { draft.scopeTag = e.target.value; }} /></label>
    </div>
    <div class="bac-discover-controls">
      <label class="nm-field"><span class="nm-field-label">Roles</span>
        <input class="nm-input an-roles-input" list="an-known-roles" value={String(draft.roles ?? "")} placeholder="comma-separated, e.g. co2" oninput={(e) => { draft.roles = e.target.value; }} /></label>
      <label class="nm-field"><span class="nm-field-label">Exclude name patterns</span>
        <input class="nm-input" value={String(draft.excludeNamePatterns ?? "")} placeholder="e.g. setpoint, alarm" oninput={(e) => { draft.excludeNamePatterns = e.target.value; }} /></label>
    </div>
    <datalist id="an-known-roles">
      {#each roles as r}<option value={r}></option>{/each}
    </datalist>
    {#if draft.kind === "range"}
      <div class="bac-discover-controls">
        <label class="nm-field"><span class="nm-field-label">Min</span>
          <input class="nm-input bac-range-input" value={String(draft.min ?? "")} oninput={(e) => { draft.min = e.target.value; }} /></label>
        <label class="nm-field"><span class="nm-field-label">Max</span>
          <input class="nm-input bac-range-input" value={String(draft.max ?? "")} oninput={(e) => { draft.max = e.target.value; }} /></label>
        <label class="nm-field"><span class="nm-field-label">Unit</span>
          <input class="nm-input bac-range-input" value={String(draft.unit ?? "")} oninput={(e) => { draft.unit = e.target.value; }} /></label>
      </div>
    {:else if draft.kind === "threshold"}
      <div class="bac-discover-controls">
        <label class="nm-field"><span class="nm-field-label">Operator</span>
          <select class="nm-input" value={draft.operator} onchange={(e) => { draft.operator = e.target.value; }}>
            {#each OPERATORS as op}<option value={op}>{op}</option>{/each}
          </select></label>
        <label class="nm-field"><span class="nm-field-label">Value</span>
          <input class="nm-input bac-range-input" value={String(draft.value ?? "")} oninput={(e) => { draft.value = e.target.value; }} /></label>
        <label class="nm-field"><span class="nm-field-label">Unit</span>
          <input class="nm-input bac-range-input" value={String(draft.unit ?? "")} oninput={(e) => { draft.unit = e.target.value; }} /></label>
      </div>
    {:else}
      <p class="muted small">Presence check — fails when no point matches the role(s) below.</p>
    {/if}
    <div class="tool-actions">
      <button class="btn btn-primary btn-sm" onclick={() => saveDraft()}>Save rule</button>
      <button class="btn-ghost btn-sm" onclick={() => cancelDraft()}>Cancel</button>
    </div>
  </div>
{/snippet}
