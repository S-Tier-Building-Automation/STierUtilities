// Design System — a living reference for the S-Tier control-room brand: logo,
// color tokens, typography, spacing, components, motion, and voice. Doubles as a
// visual-QA surface. Follows the no-chrome rule (the shell owns the header).

import { brandMark, BRAND } from "../../ui/brand.js";
import { toast } from "../../ui/toast.js";

const COLORS = [
  { name: "--accent", hex: "#14B8A6", intent: "Signal teal — primary action, focus" },
  { name: "--accent-2", hex: "#2DD4BF", intent: "Teal highlight, borders, glow" },
  { name: "--signal-amber", hex: "#FBBF24", intent: "Manual / override / commanded" },
  { name: "--ok", hex: "#34D399", intent: "Healthy / running" },
  { name: "--warn", hex: "#FBBF24", intent: "Caution / attention" },
  { name: "--error", hex: "#F87171", intent: "Fault / failed" },
  { name: "--info", hex: "#38BDF8", intent: "Informational" },
  { name: "--bg", hex: "#0C0F14", intent: "App canvas" },
  { name: "--bg-elev", hex: "#141821", intent: "Panels / cards" },
  { name: "--bg-elev-2", hex: "#1B212D", intent: "Raised / inputs" },
  { name: "--border", hex: "#2A3140", intent: "Hairlines" },
  { name: "--text", hex: "#E8EDF4", intent: "Primary text" },
  { name: "--text-dim", hex: "#93A0B4", intent: "Secondary text" },
];

const SPACING = ["--sp-1", "--sp-2", "--sp-3", "--sp-4", "--sp-5", "--sp-6"];
const RADII = ["--r-sm", "--r-md", "--r-lg", "--r-pill"];

export function createDesignSystemUi({ el }) {

  function section(title, ...children) {
    return el("section", { class: "plugin-section ds-section" },
      el("h3", { class: "ds-section-title" }, title), ...children);
  }

  function brandSection() {
    return section("Brand",
      el("div", { class: "ds-brand-row" },
        el("div", { class: "ds-logo-chip" }, brandMark({ size: 56 })),
        el("div", {},
          el("div", { class: "ds-h1" }, BRAND.name),
          el("p", { class: "muted" }, BRAND.tagline),
          el("div", { class: "ds-voice" }, ...BRAND.voice.map((w) => el("span", { class: "home-chip" }, w))),
        ),
      ),
      el("p", { class: "muted small" }, `${BRAND.org}. The mark is an ascending tier / signal-level motif — keep clear space equal to one tier around it; never recolor the amber top tier except to mono.`),
    );
  }

  function swatch(c) {
    return el("div", { class: "ds-swatch" },
      el("div", { class: "ds-swatch-chip", style: `background: var(${c.name});` }),
      el("div", { class: "ds-swatch-meta" },
        el("span", { class: "ds-token-var" }, c.name),
        el("span", { class: "muted small" }, c.hex),
        el("span", { class: "small" }, c.intent),
      ),
    );
  }

  function colorSection() {
    return section("Color", el("div", { class: "ds-swatches" }, ...COLORS.map(swatch)));
  }

  function typeSection() {
    return section("Typography",
      el("div", { class: "ds-type-row" },
        el("span", { class: "ds-token-var" }, "--font-display · Archivo"),
        el("div", { class: "ds-type-sample ds-type-display" }, "Discover. Model. Commission.")),
      el("div", { class: "ds-type-row" },
        el("span", { class: "ds-token-var" }, "--font-ui · IBM Plex Sans"),
        el("div", { class: "ds-type-sample" }, "The integrator's building-automation workspace — body and controls.")),
      el("div", { class: "ds-type-row" },
        el("span", { class: "ds-token-var" }, "--font-mono · IBM Plex Mono"),
        el("div", { class: "ds-type-sample mono" }, "bacnet:1001:0:4   72.4 °F   2026-06-22T08:30:00Z")),
    );
  }

  function scaleSection() {
    return section("Spacing & radius",
      el("div", { class: "ds-scale" }, ...SPACING.map((s) =>
        el("div", { class: "ds-scale-row" },
          el("span", { class: "ds-token-var" }, s),
          el("span", { class: "ds-scale-bar", style: `width: var(${s});` })))),
      el("div", { class: "ds-radii" }, ...RADII.map((r) =>
        el("div", { class: "ds-radius-box", style: `border-radius: var(${r});` }, el("span", { class: "ds-token-var" }, r)))),
    );
  }

  function componentSection() {
    return section("Components",
      el("div", { class: "ds-group" },
        el("button", { class: "btn btn-primary" }, "Primary"),
        el("button", { class: "btn btn-ghost" }, "Ghost"),
        el("button", { class: "btn btn-ghost btn-sm" }, "Ghost sm"),
        el("button", { class: "btn btn-ghost btn-danger btn-sm" }, "Danger"),
        el("button", { class: "btn btn-ghost btn-sm", onclick: () => toast("Instrument toast — ok", "ok") }, "Toast"),
      ),
      el("div", { class: "ds-group" },
        el("span", { class: "pill pill-running" }, "Running"),
        el("span", { class: "pill pill-idle" }, "Idle"),
        el("span", { class: "pill pill-muted" }, "Muted"),
        el("span", { class: "pill pill-warn" }, "Warn"),
        el("span", { class: "pill pill-error" }, "Error"),
      ),
      el("label", { class: "nm-field ds-input" },
        el("span", { class: "nm-field-label" }, "Input"),
        el("input", { class: "nm-input", type: "text", value: "192.168.1.100", placeholder: "host" })),
    );
  }

  function motionSection() {
    return section("Motion",
      el("p", { class: "muted small" }, "Instrument motion is restrained: one staggered page-load reveal, soft state glows, no gratuitous movement. All animation respects prefers-reduced-motion."),
      el("div", { class: "ds-group" },
        el("span", { class: "home-chip home-chip-ok" }, el("span", { class: "home-dot dot-ok" }), "live pulse"),
        el("span", { class: "home-chip" }, "focus glow uses --glow")),
    );
  }

  function renderPage() {
    return el("div", { class: "plugin-controls ds-page" },
      brandSection(), colorSection(), typeSection(), scaleSection(), componentSection(), motionSection());
  }

  function renderStatusPill() {
    return { label: "Reference", cls: "pill-idle" };
  }

  return { renderPage, renderStatusPill };
}
