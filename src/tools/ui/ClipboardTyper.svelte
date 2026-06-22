<script module>
  // Status pill is read synchronously by the shell (plugin-page header) and by
  // getSystemStatus, so it stays a plain exported sync function. The live state
  // (running/armed) is held by a module-scoped snapshot that the mounted
  // component keeps current; the shell calls statusPill() with no args.
  let liveState = { running: false, armed: false };

  export function statusPill() {
    if (!liveState.running) return { label: "Idle", cls: "pill-idle" };
    if (liveState.armed) return { label: "Armed", cls: "pill-running" };
    return { label: "Standby", cls: "pill-muted" };
  }

  // Internal: the component pushes its current live snapshot here so the shell's
  // synchronous statusPill() reflects the latest backend state.
  export function __setLiveState(running, armed) {
    liveState = { running, armed };
  }
</script>

<script>
  // ClipboardTyper — middle-click types your clipboard into the focused local
  // window. Local-first: settings live in the backend (persisted to APPDATA);
  // this page edits a draft and debounce-pushes it. Reactivity replaces renderAll.
  import { onMount } from "svelte";

  let { invoke, logTo, listen } = $props();

  const DEFAULT_SETTINGS = {
    type_delay_ms: 60,
    modifier_hold_ms: 40,
    start_delay_ms: 40,
    trailing_tab: false,
    newline_as_tab: false,
    column_major: false,
    rules: [],
  };

  function clonePending(settings) {
    return { ...settings, rules: (settings.rules || []).map((r) => ({ ...r })) };
  }

  // Live backend state (running/armed) + the editable draft of settings.
  let running = $state(false);
  let armed = $state(false);
  let pending = $state(clonePending(DEFAULT_SETTINGS));

  // Keep the module-scoped statusPill snapshot in sync with live state.
  $effect(() => {
    __setLiveState(running, armed);
  });

  let pushTimer = null;

  function pushSettings() {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(async () => {
      try {
        await invoke("clipboardtyper_set_settings", { settings: clonePending(pending) });
      } catch (err) {
        logTo("clipboardtyper", `Failed to update settings: ${err}`, "error");
      }
    }, 100);
  }

  async function toggleEnabled() {
    try {
      if (running) {
        await invoke("clipboardtyper_stop");
        logTo("clipboardtyper", "Disabled. Middle-click is back to normal.", "warn");
      } else {
        await invoke("clipboardtyper_start");
        logTo("clipboardtyper", "Enabled. Middle-click anywhere to type your clipboard.", "ok");
      }
    } catch (err) {
      logTo("clipboardtyper", `${err}`, "error");
    }
  }

  async function setArmed(value) {
    try {
      await invoke("clipboardtyper_set_armed", { armed: value });
      logTo("clipboardtyper", value ? "Armed." : "Disarmed (hook still installed).", "info");
    } catch (err) {
      logTo("clipboardtyper", `Failed to set armed: ${err}`, "error");
    }
  }

  function onTrailingTab() {
    pushSettings();
    logTo(
      "clipboardtyper",
      pending.trailing_tab ? "Trailing Tab on: a Tab is sent after the last cell." : "Trailing Tab off.",
      "info",
    );
  }

  function onNewlineAsTab() {
    pushSettings();
    logTo(
      "clipboardtyper",
      pending.newline_as_tab
        ? "New line → Tab on: line breaks advance with Tab (good for copied columns)."
        : "New line → Tab off: line breaks press Enter.",
      "info",
    );
  }

  function onColumnMajor() {
    pushSettings();
    logTo(
      "clipboardtyper",
      pending.column_major
        ? "Column order on: a copied block types each column top-to-bottom (Tab-separated)."
        : "Column order off: types in Excel's left-to-right, row-by-row order.",
      "info",
    );
  }

  function addRule() {
    pending.rules = [...(pending.rules || []), { match: "", output: "" }];
    pushSettings();
  }

  function removeRule(index) {
    pending.rules = (pending.rules || []).filter((_, i) => i !== index);
    pushSettings();
  }

  // Slider definitions — same keys/ranges/steps/suffixes as the original.
  const SLIDERS = [
    { key: "type_delay_ms", label: "Type delay", min: 0, max: 200, step: 5, suffix: "ms" },
    { key: "modifier_hold_ms", label: "Modifier hold", min: 0, max: 200, step: 5, suffix: "ms" },
    { key: "start_delay_ms", label: "Start delay", min: 0, max: 500, step: 10, suffix: "ms" },
  ];

  onMount(() => {
    let disposed = false;
    const unlisteners = [];

    // Hydrate current backend state.
    invoke("clipboardtyper_get_state")
      .then((state) => {
        if (disposed || !state) return;
        running = !!state.running;
        armed = !!state.armed;
        pending = clonePending(state.settings || DEFAULT_SETTINGS);
      })
      .catch(() => {});

    listen("clipboardtyper:state", (event) => {
      const p = event.payload;
      // Always reflect live status.
      running = !!p.running;
      armed = !!p.armed;
      // Re-seed the editable draft ONLY when the backend's settings differ from
      // the current draft, so a mid-edit user is not clobbered.
      if (JSON.stringify(p.settings) !== JSON.stringify(pending)) {
        pending = clonePending(p.settings);
      }
    }).then((un) => {
      if (disposed) un();
      else unlisteners.push(un);
    });

    listen("clipboardtyper:typed", (event) => {
      const { chars, error } = event.payload;
      if (error) logTo("clipboardtyper", `Typing failed: ${error}`, "error");
      else logTo("clipboardtyper", `Sent ${chars} char${chars === 1 ? "" : "s"} locally.`, "ok");
    }).then((un) => {
      if (disposed) un();
      else unlisteners.push(un);
    });

    return () => {
      disposed = true;
      if (pushTimer) clearTimeout(pushTimer);
      unlisteners.forEach((un) => un());
    };
  });
</script>

<div class="plugin-controls">
  <section class="plugin-section">
    <div class="action-row">
      <button class={running ? "btn btn-danger" : "btn btn-primary"} onclick={toggleEnabled}>
        {running ? "Disable" : "Enable"}
      </button>
      <label class="toggle {armed ? 'toggle-on' : ''} {!running ? 'toggle-disabled' : ''}">
        <input
          type="checkbox"
          checked={armed}
          disabled={!running}
          onchange={(e) => setArmed(e.target.checked)}
        />
        <span class="toggle-track"><span class="toggle-knob"></span></span>
        <span class="toggle-label">Armed</span>
      </label>
    </div>
    <p class="muted small">
      {#if running}
        {#if armed}
          Middle-click anywhere - clipboard text will be sent to the focused local window.
        {:else}
          Hook installed but disarmed. Toggle Armed to react to middle-clicks.
        {/if}
      {:else}
        Click Enable to install the mouse hook.
      {/if}
    </p>
  </section>

  <section class="plugin-section">
    <h3>Behavior</h3>
    <label class="toggle {pending.trailing_tab ? 'toggle-on' : ''}">
      <input type="checkbox" bind:checked={pending.trailing_tab} onchange={onTrailingTab} />
      <span class="toggle-track"><span class="toggle-knob"></span></span>
      <span class="toggle-label">Trailing Tab</span>
    </label>
    <p class="muted small">
      Press Tab once more after the last cell, so you can type a copied Excel row and land on the
      next field (or next row) without advancing manually.
    </p>
    <label class="toggle {pending.newline_as_tab ? 'toggle-on' : ''}">
      <input type="checkbox" bind:checked={pending.newline_as_tab} onchange={onNewlineAsTab} />
      <span class="toggle-track"><span class="toggle-knob"></span></span>
      <span class="toggle-label">New line → Tab</span>
    </label>
    <p class="muted small">
      Treat line breaks as a Tab instead of Enter. A column copied from Excel is new-line separated
      (no tabs), so turn this on to advance field-to-field.
    </p>
    <label class="toggle {pending.column_major ? 'toggle-on' : ''}">
      <input type="checkbox" bind:checked={pending.column_major} onchange={onColumnMajor} />
      <span class="toggle-track"><span class="toggle-knob"></span></span>
      <span class="toggle-label">Column order (top → bottom)</span>
    </label>
    <p class="muted small">
      When you copy a block of several columns, type each column top-to-bottom instead of Excel's
      left-to-right, row-by-row order. Values are Tab-separated, so this covers the "New line → Tab"
      case on its own.
    </p>
  </section>

  <section class="plugin-section">
    <h3>Cell Rules</h3>
    <p class="muted small rule-tokens">
      When a cell matches (case-insensitive), send the output instead of typing it. Output can mix
      text with key tokens:
      <code>{"{space}"}</code> <code>{"{tab}"}</code> <code>{"{enter}"}</code>
      <code>{"{esc}"}</code> <code>{"{up}"}</code> <code>{"{down}"}</code>
      <code>{"{left}"}</code> <code>{"{right}"}</code> <code>{"{bksp}"}</code>
      <code>{"{del}"}</code>. Leave the output blank to skip the cell (just advance).
    </p>
    {#each pending.rules || [] as rule, i (i)}
      <div class="rule-row">
        <input
          type="text"
          class="rule-input rule-match"
          placeholder="when cell is…"
          bind:value={rule.match}
          oninput={pushSettings}
        />
        <span class="rule-arrow">→</span>
        <input
          type="text"
          class="rule-input rule-output"
          placeholder="send instead (e.g. {'{space}'})"
          bind:value={rule.output}
          oninput={pushSettings}
        />
        <button class="btn btn-ghost rule-remove" title="Remove rule" onclick={() => removeRule(i)}>✕</button>
      </div>
    {/each}
    <button class="btn btn-ghost" onclick={addRule}>+ Add rule</button>
  </section>

  <section class="plugin-section">
    <h3>Timing</h3>
    {#each SLIDERS as s (s.key)}
      <div class="slider-row">
        <label>{s.label}</label>
        <input
          type="range"
          min={s.min}
          max={s.max}
          step={s.step}
          bind:value={pending[s.key]}
          oninput={pushSettings}
        />
        <span class="slider-value">{pending[s.key]} {s.suffix}</span>
      </div>
    {/each}
    <p class="muted small">
      Modifier hold can help when a remote tool forwards injected input but drops shifted characters.
      If DeskIn receives nothing at all, it is likely blocking injected input before timing matters.
    </p>
  </section>
</div>
