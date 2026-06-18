// ClipboardTyper tool page — state, renderers, and Tauri event wiring.

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

/**
 * @param {object} deps
 * @param {typeof import("../../platform/tauri.js").invoke} deps.invoke
 * @param {import("../../ui/dom.js").el} deps.el
 * @param {(toolId: string, msg: string, kind?: string) => void} deps.logTo
 * @param {() => void} deps.renderAll
 */
export function createClipboardTyperUi({ invoke, el, logTo, renderAll }) {
  let ct = { running: false, armed: false, settings: { ...DEFAULT_SETTINGS } };
  let ctPending = clonePending(ct.settings);
  let ctPushTimer = null;

  function ctPushSettings() {
    if (ctPushTimer) clearTimeout(ctPushTimer);
    ctPushTimer = setTimeout(async () => {
      try {
        await invoke("clipboardtyper_set_settings", { settings: { ...ctPending } });
      } catch (err) {
        logTo("clipboardtyper", `Failed to update settings: ${err}`, "error");
      }
    }, 100);
  }

  async function ctToggleEnabled() {
    try {
      if (ct.running) {
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

  async function ctSetArmed(armed) {
    try {
      await invoke("clipboardtyper_set_armed", { armed });
      logTo("clipboardtyper", armed ? "Armed." : "Disarmed (hook still installed).", "info");
    } catch (err) {
      logTo("clipboardtyper", `Failed to set armed: ${err}`, "error");
    }
  }

  function ctSetTrailingTab(value) {
    ctPending.trailing_tab = value;
    ctPushSettings();
    logTo(
      "clipboardtyper",
      value ? "Trailing Tab on: a Tab is sent after the last cell." : "Trailing Tab off.",
      "info",
    );
    renderAll();
  }

  function ctSetNewlineAsTab(value) {
    ctPending.newline_as_tab = value;
    ctPushSettings();
    logTo(
      "clipboardtyper",
      value
        ? "New line → Tab on: line breaks advance with Tab (good for copied columns)."
        : "New line → Tab off: line breaks press Enter.",
      "info",
    );
    renderAll();
  }

  function ctSetColumnMajor(value) {
    ctPending.column_major = value;
    ctPushSettings();
    logTo(
      "clipboardtyper",
      value
        ? "Column order on: a copied block types each column top-to-bottom (Tab-separated)."
        : "Column order off: types in Excel's left-to-right, row-by-row order.",
      "info",
    );
    renderAll();
  }

  function ctAddRule() {
    ctPending.rules = [...(ctPending.rules || []), { match: "", output: "" }];
    ctPushSettings();
    renderAll();
  }

  function ctRemoveRule(index) {
    ctPending.rules = (ctPending.rules || []).filter((_, i) => i !== index);
    ctPushSettings();
    renderAll();
  }

  function ctUpdateRule(index, field, value) {
    if (!ctPending.rules || !ctPending.rules[index]) return;
    ctPending.rules[index][field] = value;
    ctPushSettings();
  }

  function ctSlider(key, label, min, max, step, suffix) {
    const valueEl = el("span", { class: "slider-value" }, `${ctPending[key]} ${suffix}`);
    const input = el("input", {
      type: "range",
      min: String(min),
      max: String(max),
      step: String(step),
      value: String(ctPending[key]),
      oninput: (e) => {
        ctPending[key] = Number(e.target.value);
        valueEl.textContent = `${ctPending[key]} ${suffix}`;
        ctPushSettings();
      },
    });
    return el("div", { class: "slider-row" },
      el("label", {}, label),
      input,
      valueEl,
    );
  }

  function renderStatusPill() {
    if (!ct.running) return { label: "Idle", cls: "pill-idle" };
    if (ct.armed) return { label: "Armed", cls: "pill-running" };
    return { label: "Standby", cls: "pill-muted" };
  }

  function renderPage() {
    const enableBtn = el("button", {
      class: ct.running ? "btn btn-danger" : "btn btn-primary",
      onclick: ctToggleEnabled,
    }, ct.running ? "Disable" : "Enable");

    const armToggle = el("label",
      {
        class: `toggle ${ct.armed ? "toggle-on" : ""} ${!ct.running ? "toggle-disabled" : ""}`,
      },
      el("input", {
        type: "checkbox",
        checked: ct.armed ? "checked" : undefined,
        disabled: !ct.running ? "disabled" : undefined,
        onchange: (e) => ctSetArmed(e.target.checked),
      }),
      el("span", { class: "toggle-track" }, el("span", { class: "toggle-knob" })),
      el("span", { class: "toggle-label" }, "Armed"),
    );

    return el("div", { class: "plugin-controls" },
      el("section", { class: "plugin-section" },
        el("div", { class: "action-row" }, enableBtn, armToggle),
        el("p", { class: "muted small" },
          ct.running
            ? (ct.armed
                ? "Middle-click anywhere - clipboard text will be sent to the focused local window."
                : "Hook installed but disarmed. Toggle Armed to react to middle-clicks.")
            : "Click Enable to install the mouse hook.",
        ),
      ),

      el("section", { class: "plugin-section" },
        el("h3", {}, "Behavior"),
        el("label",
          { class: `toggle ${ctPending.trailing_tab ? "toggle-on" : ""}` },
          el("input", {
            type: "checkbox",
            checked: ctPending.trailing_tab ? "checked" : undefined,
            onchange: (e) => ctSetTrailingTab(e.target.checked),
          }),
          el("span", { class: "toggle-track" }, el("span", { class: "toggle-knob" })),
          el("span", { class: "toggle-label" }, "Trailing Tab"),
        ),
        el("p", { class: "muted small" },
          "Press Tab once more after the last cell, so you can type a copied Excel ",
          "row and land on the next field (or next row) without advancing manually.",
        ),
        el("label",
          { class: `toggle ${ctPending.newline_as_tab ? "toggle-on" : ""}` },
          el("input", {
            type: "checkbox",
            checked: ctPending.newline_as_tab ? "checked" : undefined,
            onchange: (e) => ctSetNewlineAsTab(e.target.checked),
          }),
          el("span", { class: "toggle-track" }, el("span", { class: "toggle-knob" })),
          el("span", { class: "toggle-label" }, "New line → Tab"),
        ),
        el("p", { class: "muted small" },
          "Treat line breaks as a Tab instead of Enter. A column copied from Excel is ",
          "new-line separated (no tabs), so turn this on to advance field-to-field.",
        ),
        el("label",
          { class: `toggle ${ctPending.column_major ? "toggle-on" : ""}` },
          el("input", {
            type: "checkbox",
            checked: ctPending.column_major ? "checked" : undefined,
            onchange: (e) => ctSetColumnMajor(e.target.checked),
          }),
          el("span", { class: "toggle-track" }, el("span", { class: "toggle-knob" })),
          el("span", { class: "toggle-label" }, "Column order (top → bottom)"),
        ),
        el("p", { class: "muted small" },
          "When you copy a block of several columns, type each column top-to-bottom ",
          "instead of Excel's left-to-right, row-by-row order. Values are Tab-separated, ",
          "so this covers the \"New line → Tab\" case on its own.",
        ),
      ),

      el("section", { class: "plugin-section" },
        el("h3", {}, "Cell Rules"),
        el("p", { class: "muted small rule-tokens" },
          "When a cell matches (case-insensitive), send the output instead of typing it. ",
          "Output can mix text with key tokens: ",
          el("code", {}, "{space}"), " ", el("code", {}, "{tab}"), " ", el("code", {}, "{enter}"), " ",
          el("code", {}, "{esc}"), " ", el("code", {}, "{up}"), " ", el("code", {}, "{down}"), " ",
          el("code", {}, "{left}"), " ", el("code", {}, "{right}"), " ", el("code", {}, "{bksp}"), " ",
          el("code", {}, "{del}"), ". Leave the output blank to skip the cell (just advance).",
        ),
        ...(ctPending.rules || []).map((rule, i) =>
          el("div", { class: "rule-row" },
            el("input", {
              type: "text",
              class: "rule-input rule-match",
              placeholder: "when cell is…",
              value: rule.match ?? "",
              oninput: (e) => ctUpdateRule(i, "match", e.target.value),
            }),
            el("span", { class: "rule-arrow" }, "→"),
            el("input", {
              type: "text",
              class: "rule-input rule-output",
              placeholder: "send instead (e.g. {space})",
              value: rule.output ?? "",
              oninput: (e) => ctUpdateRule(i, "output", e.target.value),
            }),
            el("button", { class: "btn btn-ghost rule-remove", title: "Remove rule", onclick: () => ctRemoveRule(i) }, "✕"),
          ),
        ),
        el("button", { class: "btn btn-ghost", onclick: ctAddRule }, "+ Add rule"),
      ),

      el("section", { class: "plugin-section" },
        el("h3", {}, "Timing"),
        ctSlider("type_delay_ms", "Type delay", 0, 200, 5, "ms"),
        ctSlider("modifier_hold_ms", "Modifier hold", 0, 200, 5, "ms"),
        ctSlider("start_delay_ms", "Start delay", 0, 500, 10, "ms"),
        el("p", { class: "muted small" },
          "Modifier hold can help when a remote tool forwards injected input but ",
          "drops shifted characters. If DeskIn receives nothing at all, it is likely ",
          "blocking injected input before timing matters.",
        ),
      ),
    );
  }

  function hydrate(state) {
    ct = state;
    ctPending = clonePending(state.settings);
  }

  function bindEvents(listen) {
    listen("clipboardtyper:state", (event) => {
      const p = event.payload;
      const settingsSame = JSON.stringify(p.settings) === JSON.stringify(ctPending);
      const liveSame = p.running === ct.running && p.armed === ct.armed;
      ct = p;
      if (!settingsSame) ctPending = clonePending(p.settings);
      if (!settingsSame || !liveSame) renderAll();
    });

    listen("clipboardtyper:typed", (event) => {
      const { chars, error } = event.payload;
      if (error) logTo("clipboardtyper", `Typing failed: ${error}`, "error");
      else logTo("clipboardtyper", `Sent ${chars} char${chars === 1 ? "" : "s"} locally.`, "ok");
    });
  }

  return { renderStatusPill, renderPage, hydrate, bindEvents };
}
