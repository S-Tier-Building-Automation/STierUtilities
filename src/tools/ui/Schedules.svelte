<script module>
  // Status pill is read synchronously by the shell (plugin-page header) and by
  // getSystemStatus (home/services cards), so it stays a plain exported function.
  function bacnetCapOf(getPlatform) {
    const platform = getPlatform();
    return platform ? platform.capability("bacnet.read.v1") : null;
  }

  export function statusPill(getPlatform, userState) {
    // `busy` is component-local and cannot be observed here; the shell repaints
    // the pill on render, so an idle/entries pill is the stable representation.
    if (!bacnetCapOf(getPlatform)) return { label: "—", cls: "pill-muted" };
    const plan = userState.schedules?.plan;
    const entries = (plan?.days || []).reduce((n, d) => n + d.length, 0);
    return entries
      ? { label: `${entries} entr${entries === 1 ? "y" : "ies"}`, cls: "pill-idle" }
      : { label: "Idle", cls: "pill-idle" };
  }
</script>

<script>
  // Schedule editor — read a BACnet Schedule object, plan a weekly schedule with
  // the tested model, and command/override its present-value. Talks to the BACnet
  // integration directly (it is a protocol-management tool), resolving devices
  // from the discovery cache.
  import { toast } from "../../ui/toast.js";
  import { confirmAction } from "../../ui/modal.js";
  import {
    createScheduleService,
    createWeeklySchedule,
    addEntry,
    removeEntry,
    findConflicts,
    SCHEDULE_DAYS,
  } from "../schedule-service.js";

  const VALUE_KINDS = ["real", "unsigned", "enumerated", "boolean", "null"];

  let { logTo, getPlatform, getInventory, userState, saveUserState } = $props();

  // Lazy-init the persisted shape + plan backfill, mirroring the original st().
  function st() {
    if (!userState.schedules || typeof userState.schedules !== "object") {
      userState.schedules = { deviceKey: "", instance: 1, plan: null, commandKind: "real", commandValue: "", priority: "" };
    }
    if (!userState.schedules.plan) userState.schedules.plan = createWeeklySchedule({ scheduleDefault: null });
    return userState.schedules;
  }
  st();

  // Ephemeral UI state.
  let busy = $state(false);
  let properties = $state(null); // last readSchedule result
  let draft = $state({ day: "Mon", time: "08:00", value: "" });

  // Persisted fields surfaced as reactive locals; writes go through patchState so
  // userState stays the source of truth and persistence fires.
  let deviceKey = $state(st().deviceKey);
  let instance = $state(st().instance);
  let commandKind = $state(st().commandKind);
  let commandValue = $state(st().commandValue);
  let priority = $state(st().priority);
  let plan = $state(st().plan);

  function patchState(patch) {
    Object.assign(st(), patch);
    saveUserState();
  }

  function bacnetCap() {
    const platform = getPlatform();
    return platform ? platform.capability("bacnet.read.v1") : null;
  }
  const hasBacnet = $derived(!!getPlatform()?.capability?.("bacnet.read.v1"));

  function scheduleSvc() {
    const bacnet = bacnetCap();
    return bacnet ? createScheduleService({ bacnet }) : null;
  }

  function devices() {
    return Array.isArray(userState.bacnetDiscoveryCache) ? userState.bacnetDiscoveryCache : [];
  }
  function selectedDevice() {
    const d = devices().find((x) => x.key === deviceKey);
    return d ? { address: d.address, network: d.network ?? null, mac: d.mac ?? null } : null;
  }

  const conflicts = $derived(findConflicts(plan));

  async function readSchedule() {
    const svc = scheduleSvc();
    const device = selectedDevice();
    if (!svc || !device) { toast("Pick a discovered device first.", "warn"); return; }
    busy = true;
    try {
      properties = await svc.read({ device, instance: Number(instance) });
      logTo("schedules", `Read schedule ${instance} (${properties.length} properties).`, "ok");
    } catch (err) {
      properties = null;
      logTo("schedules", `Read failed: ${err}`, "error");
      toast(`Read failed: ${err}`, "error");
    } finally {
      busy = false;
    }
  }

  function buildCommandValue() {
    if (commandKind === "null") return { kind: "null" };
    if (commandKind === "boolean") return { kind: "boolean", value: String(commandValue).toLowerCase() === "true" || commandValue === "1" };
    if (commandKind === "real") return { kind: "real", value: Number(commandValue) };
    return { kind: commandKind, value: Math.trunc(Number(commandValue)) };
  }

  async function commandPresentValue() {
    const svc = scheduleSvc();
    const device = selectedDevice();
    if (!svc || !device) { toast("Pick a discovered device first.", "warn"); return; }
    const prio = priority ? Number(priority) : null;
    const ok = await confirmAction({
      title: "Command schedule",
      message: `Override Schedule ${instance} present-value${prio ? ` at priority ${prio}` : ""}? This writes to the live device.`,
      confirmLabel: "Command",
      danger: true,
    });
    if (!ok) return;
    busy = true;
    try {
      await svc.command({ device, instance: Number(instance), value: buildCommandValue(), priority: prio });
      logTo("schedules", `Commanded schedule ${instance}.`, "ok");
      toast("Command sent.", "ok");
    } catch (err) {
      logTo("schedules", `Command failed: ${err}`, "error");
      toast(`Command failed: ${err}`, "error");
    } finally {
      busy = false;
    }
  }

  function onSelectDevice() {
    patchState({ deviceKey });
  }
  function onInstance() {
    instance = Number(instance);
    patchState({ instance });
  }
  function onCommandKind() {
    patchState({ commandKind });
  }
  function onCommandValue() {
    patchState({ commandValue });
  }
  function onPriority() {
    patchState({ priority });
  }

  function propDisplay(p) {
    return p.error ? `error: ${p.error}` : (p.display || (p.values || []).map((v) => v.value).join(", "));
  }

  function removePlanEntry(day, time) {
    plan = removeEntry(plan, day, time);
    patchState({ plan });
  }

  function addPlanEntry() {
    const num = Number(draft.value);
    const value = draft.value !== "" && !Number.isNaN(num) ? num : draft.value;
    try {
      plan = addEntry(plan, draft.day, draft.time, value);
      patchState({ plan });
    } catch (err) {
      toast(String(err), "error");
    }
  }
</script>

{#if !hasBacnet}
  <div class="plugin-controls">
    <section class="plugin-section">
      <p class="empty-state">BACnet service is not available.</p>
    </section>
  </div>
{:else}
  <div class="plugin-controls">
    <section class="plugin-section">
      <h3 class="sch-h3">Device &amp; schedule object</h3>
      {#if devices().length}
        <div class="sch-row">
          <label class="nm-field"><span class="nm-field-label">Device</span>
            <select class="nm-input" bind:value={deviceKey} onchange={onSelectDevice}>
              <option value="">— select —</option>
              {#each devices() as d}
                <option value={d.key}>{(d.name || "Device")} ({d.instance}) @ {d.address}</option>
              {/each}
            </select></label>
          <label class="nm-field sch-narrow"><span class="nm-field-label">Schedule #</span>
            <input class="nm-input" type="number" bind:value={instance} onchange={onInstance} /></label>
          <button class="btn btn-primary btn-sm" disabled={busy} onclick={readSchedule}>{busy ? "Reading…" : "Read schedule"}</button>
        </div>
      {:else}
        <p class="muted small">No discovered devices yet — run discovery in BACnet Manager first.</p>
      {/if}

      {#if properties}
        <div class="sch-props">
          <table class="sch-table">
            <thead><tr><th>Property</th><th>Value</th></tr></thead>
            <tbody>
              {#each properties as p}
                <tr><td>{p.name || String(p.id)}</td><td>{propDisplay(p)}</td></tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}

      <div class="sch-command">
        <h4 class="sch-h4">Command present-value (override)</h4>
        <div class="sch-row">
          <label class="nm-field sch-narrow"><span class="nm-field-label">Kind</span>
            <select class="nm-input" bind:value={commandKind} onchange={onCommandKind}>
              {#each VALUE_KINDS as k}<option value={k}>{k}</option>{/each}
            </select></label>
          {#if commandKind !== "null"}
            <label class="nm-field sch-narrow"><span class="nm-field-label">Value</span>
              <input class="nm-input" type="text" bind:value={commandValue} onchange={onCommandValue} /></label>
          {/if}
          <label class="nm-field sch-narrow"><span class="nm-field-label">Priority</span>
            <select class="nm-input" bind:value={priority} onchange={onPriority}>
              <option value="">none</option>
              {#each Array.from({ length: 16 }, (_, i) => i + 1) as p}
                <option value={String(p)}>{p}</option>
              {/each}
            </select></label>
          <button class="btn btn-ghost btn-sm" disabled={busy} onclick={commandPresentValue}>Command</button>
        </div>
        <p class="muted small">Commands the schedule's present-value on the live device. Writing the full weekly schedule back to the device is not yet supported.</p>
      </div>
    </section>

    <section class="plugin-section">
      <h3 class="sch-h3">Weekly schedule planner</h3>
      {#if conflicts.length}
        <p class="pill pill-warn sch-conflict">{conflicts.length} duplicate time(s): {conflicts.map((c) => `${c.day} ${c.time}`).join(", ")}</p>
      {/if}
      <div class="sch-week">
        {#each SCHEDULE_DAYS as day, i}
          <div class="sch-day">
            <div class="sch-day-name">{day}</div>
            {#if plan.days[i].length}
              {#each plan.days[i] as entry}
                <div class="sch-entry">
                  <span class="sch-entry-time">{entry.time}</span>
                  <span class="sch-entry-val">{String(entry.value)}</span>
                  <button class="btn btn-ghost btn-sm sch-x" title="Remove" onclick={() => removePlanEntry(day, entry.time)}>×</button>
                </div>
              {/each}
            {:else}
              <span class="muted small">—</span>
            {/if}
          </div>
        {/each}
      </div>

      <div class="sch-row sch-add">
        <label class="nm-field sch-narrow"><span class="nm-field-label">Day</span>
          <select class="nm-input" bind:value={draft.day}>
            {#each SCHEDULE_DAYS as d}<option value={d}>{d}</option>{/each}
          </select></label>
        <label class="nm-field sch-narrow"><span class="nm-field-label">Time</span>
          <input class="nm-input" type="time" bind:value={draft.time} /></label>
        <label class="nm-field sch-narrow"><span class="nm-field-label">Value</span>
          <input class="nm-input" type="text" bind:value={draft.value} /></label>
        <button class="btn btn-primary btn-sm" onclick={addPlanEntry}>Add entry</button>
      </div>
      <p class="muted small">The planner is a local design aid; persist plans with the model and hand off via a report.</p>
    </section>
  </div>
{/if}
