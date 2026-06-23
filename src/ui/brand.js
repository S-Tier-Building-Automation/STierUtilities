// Brand assets — the S-Tier logo mark and brand constants. The mark is an
// ascending tiered "signal level" motif (reads as S-Tier and as an instrument
// level meter), in signal teal with an amber top tier.

import { svgEl } from "./dom.js";

export const BRAND = {
  name: "S-Tier Utilities",
  org: "S-Tier Building Automation",
  tagline: "The integrator's building-automation workspace",
  voice: ["Precise.", "Field-ready.", "Open."],
};

/**
 * Build the logo mark as an inline SVG element.
 * @param {{ size?: number, mono?: boolean }} [opts]
 */
export function brandMark({ size = 30, mono = false } = {}) {
  const teal = mono ? "currentColor" : "var(--accent-2)";
  const amber = mono ? "currentColor" : "var(--signal-amber)";
  const svg = svgEl("svg", {
    width: String(size), height: String(size), viewBox: "0 0 32 32",
    role: "img", "aria-label": "S-Tier", class: "brand-logo",
  });
  // Chip backdrop.
  svg.appendChild(svgEl("rect", {
    x: "1", y: "1", width: "30", height: "30", rx: "7",
    fill: mono ? "none" : "var(--bg-elev-2)", stroke: mono ? "currentColor" : "var(--border-strong)", "stroke-width": "1",
  }));
  // Four ascending tiers (level meter); top tier amber.
  const bars = [
    { x: 7, h: 7, fill: teal },
    { x: 13, h: 11, fill: teal },
    { x: 19, h: 15, fill: teal },
    { x: 25, h: 19, fill: amber },
  ];
  for (const b of bars) {
    svg.appendChild(svgEl("rect", {
      x: String(b.x), y: String(26 - b.h), width: "3", height: String(b.h), rx: "1.5", fill: b.fill,
    }));
  }
  return svg;
}

/** Mount the mark into the static sidebar brand slot (called once at startup). */
export function mountSidebarBrand() {
  const host = document.querySelector(".sidebar-brand .brand-mark");
  if (host) host.replaceChildren(brandMark({ size: 30 }));
}
