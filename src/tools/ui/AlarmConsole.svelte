<script module>
  // Status pill is read synchronously by the shell (plugin-page header) and by
  // getSystemStatus (home/services cards), so it stays a plain exported function.
  // Live BACnet alarms are component-local ephemeral state the shell can't see, so
  // the pill computes from rule fails only (matches the pre-read initial state where
  // bacnetAlarms is null → 0 active).
  export function statusPill(getPlatform, getInventory) {
    const platform = getPlatform();
    const inv = getInventory();
    const alerts = platform ? platform.capability("alerts.v1") : null;
    if (!inv || !alerts) return { label: "—", cls: "pill-muted" };
    const ruleFails = alerts.listRuleFindings({ status: ["fail"] }).length;
    // Device-health alerts derive from persisted inventory health (not ephemeral
    // like live BACnet alarms), so the synchronous pill can include them.
    const deviceFails = alerts.listDeviceAlerts ? alerts.listDeviceAlerts().length : 0;
    const total = ruleFails + deviceFails;
    return total
      ? { label: `${total} alert${total === 1 ? "" : "s"}`, cls: "pill-warn" }
      : { label: "Clear", cls: "pill-running" };
  }
</script>

<script>
  // Alarm Console app — one feed for analytics rule findings and live BACnet
  // alarms. A thin shell over the alerts.v1 capability: it owns no rule or BACnet
  // logic, only the filters, the unified list, and inline acknowledge.
  import { onMount } from "svelte";
  import { inventoryVersion } from "../../platform/store.js";
  import { takeAppIntent } from "../../ui/app-intent.js";

  let { logTo, getPlatform, getInventory, userState, saveUserState } = $props();

  // Feed-source label for each unified alert row.
  const SOURCE_LABEL = { bacnet: "BACnet", device: "Device", rule: "Rule" };

  let busy = $state(false);
  let bacnetAlarms = $state(null); // null = not yet read; [] = read, none

  // Persisted, scope-aware UI state (site filter).
  function st() {
    if (!userState.alarmConsole || typeof userState.alarmConsole !== "object") {
      userState.alarmConsole = { siteId: "" };
    }
    return userState.alarmConsole;
  }
  function setSite(value) {
    st().siteId = value;
    saveUserState();
  }

  function alertsCap() {
    const platform = getPlatform();
    return platform ? platform.capability("alerts.v1") : null;
  }

  function bacnetCap() {
    const platform = getPlatform();
    return platform ? platform.capability("bacnet.read.v1") : null;
  }

  function deviceRefs(inv) {
    const equips = inv.listEntities({ type: "equip" });
    const seen = new Set();
    const refs = [];
    for (const e of equips) {
      if (st().siteId && e.siteId !== st().siteId) continue;
      const inst = e.deviceInstance ?? e.deviceRef?.deviceInstance;
      if (inst == null && !e.deviceRef) continue;
      const key = String(inst ?? JSON.stringify(e.deviceRef));
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push(e.deviceRef || { deviceInstance: inst });
    }
    return refs;
  }

  async function readBacnetAlarms(inv) {
    const alerts = alertsCap();
    if (!alerts || busy) return;
    busy = true;
    try {
      bacnetAlarms = await alerts.listBacnetAlarms({ devices: deviceRefs(inv) });
      const active = bacnetAlarms.filter((a) => a.status === "active").length;
      logTo(
        "alarm-console",
        active
          ? `Read ${active} active BACnet alarm${active === 1 ? "" : "s"}.`
          : "No active BACnet alarms.",
        active ? "warn" : "ok",
      );
    } catch (err) {
      logTo("alarm-console", `Reading alarms failed: ${err}`, "error");
    } finally {
      busy = false;
    }
  }

  async function runScan(inv) {
    const alerts = alertsCap();
    if (!alerts || busy) return;
    busy = true;
    try {
      const run = await alerts.runRuleScan({ scope: { siteId: st().siteId || null } });
      const fails = run.summary?.fail || 0;
      logTo(
        "alarm-console",
        fails
          ? `Analytics scan found ${fails} issue${fails === 1 ? "" : "s"}.`
          : "Analytics scan clear.",
        fails ? "warn" : "ok",
      );
    } catch (err) {
      logTo("alarm-console", `Analytics scan failed: ${err}`, "error");
    } finally {
      busy = false;
    }
  }

  async function acknowledge(alert) {
    const alerts = alertsCap();
    if (!alerts || !alert.ref) return;
    try {
      await alerts.acknowledge(alert.ref);
      logTo("alarm-console", `Acknowledged ${alert.message}.`, "ok");
    } catch (err) {
      logTo("alarm-console", `Acknowledge failed: ${err}`, "error");
    }
    const inv = getInventory();
    if (inv) readBacnetAlarms(inv);
  }

  function alertRowClass(alert) {
    return alert.status === "active" || alert.status === "fail"
      ? "log-error"
      : alert.status === "error"
        ? "log-warn"
        : "log-info";
  }

  // Read the site filter from the persisted state (kept in sync via setSite).
  let siteId = $state(st().siteId || "");
  function onSiteChange(value) {
    siteId = value;
    setSite(value);
    bacnetAlarms = null;
  }

  // The inventory instance is identity-stable, so read $inventoryVersion DIRECTLY
  // inside each data derived so any model write (from any tool) refreshes here.
  const inv = $derived.by(() => {
    $inventoryVersion;
    return getInventory();
  });
  const alertsReady = $derived.by(() => {
    $inventoryVersion;
    return !!getInventory() && !!alertsCap();
  });
  const sites = $derived.by(() => {
    $inventoryVersion;
    const i = getInventory();
    return i ? i.listEntities({ type: "site" }) : [];
  });
  const ruleAlerts = $derived.by(() => {
    $inventoryVersion;
    const alerts = alertsCap();
    return alerts ? alerts.listRuleFindings({ status: ["fail", "warn"] }) : [];
  });
  const deviceCount = $derived.by(() => {
    $inventoryVersion;
    siteId; // refilter when the site selection changes
    const i = getInventory();
    return i ? deviceRefs(i).length : 0;
  });
  const deviceAlerts = $derived.by(() => {
    $inventoryVersion;
    const alerts = alertsCap();
    return alerts && alerts.listDeviceAlerts ? alerts.listDeviceAlerts() : [];
  });
  const liveAlerts = $derived(bacnetAlarms || []);
  const combined = $derived([...deviceAlerts, ...liveAlerts, ...ruleAlerts]);
  const activeLive = $derived(liveAlerts.filter((a) => a.status === "active").length);

  onMount(() => {
    const i = getInventory();
    if (!i) return;
    const intent = takeAppIntent("alarm-console");
    if (intent?.siteId && i.getEntity(intent.siteId)) {
      setSite(intent.siteId);
      siteId = intent.siteId;
    }
  });
</script>

{#if !alertsReady}
  <div class="plugin-controls">
    <section class="plugin-section">
      <p class="empty-state">Building model or alerts engine is not available.</p>
    </section>
  </div>
{:else}
  <div class="plugin-controls">
    <section class="plugin-section">
      <div class="bw-card bw-rule-controls">
        <div class="bac-discover-controls">
          {#if sites.length}
            <label class="nm-field">
              <span class="nm-field-label">Site</span>
              <select class="nm-input" bind:value={siteId} onchange={(e) => onSiteChange(e.target.value)}>
                <option value="">All sites</option>
                {#each sites as s}
                  <option value={s.id}>{s.name || s.id}</option>
                {/each}
              </select>
            </label>
          {/if}
          <button class="btn btn-primary" disabled={busy} onclick={() => runScan(inv)}>
            {busy ? "Working…" : "Run analytics scan"}
          </button>
          <button
            class="btn-ghost"
            disabled={busy || !bacnetCap() || deviceCount === 0}
            title={deviceCount === 0 ? "No bound devices in scope." : undefined}
            onclick={() => readBacnetAlarms(inv)}
          >
            {busy
              ? `Reading ${deviceCount} device${deviceCount === 1 ? "" : "s"}…`
              : `Read BACnet alarms (${deviceCount})`}
          </button>
        </div>
        <p class="muted small">
          {ruleAlerts.length} analytics finding{ruleAlerts.length === 1 ? "" : "s"} · {activeLive} active BACnet alarm{activeLive === 1 ? "" : "s"} · {deviceCount} device{deviceCount === 1 ? "" : "s"} in scope
        </p>
      </div>

      {#if combined.length}
        <ol class="plugin-log scroll-fill">
          {#each combined as alert}
            <li class={alertRowClass(alert)}>
              <span class="log-time">{SOURCE_LABEL[alert.source] || "Rule"}</span>
              <span class="log-msg">{alert.equipName ? `${alert.equipName} · ` : ""}{alert.message}</span>
              {#if alert.ackable}
                <button class="btn-ghost btn-sm" onclick={() => acknowledge(alert)}>Ack</button>
              {/if}
            </li>
          {/each}
        </ol>
      {:else}
        <p class="muted small">
          {bacnetAlarms == null
            ? "No analytics findings. Run an analytics scan or read BACnet alarms to populate the feed."
            : "No active alerts."}
        </p>
      {/if}
    </section>
  </div>
{/if}
