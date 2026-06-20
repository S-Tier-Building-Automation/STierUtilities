/** Simplified isometric VAV schematic for device-level graphics (SVG string). */
export const VAV_REHEAT_SERIES_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 420" class="bw-graphic-svg" aria-hidden="true">
  <defs>
    <linearGradient id="vav-body" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="var(--bg-elev, #2a2d35)"/>
      <stop offset="100%" stop-color="var(--bg, #1e2128)"/>
    </linearGradient>
    <linearGradient id="vav-accent" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="var(--accent, #4a9eff)" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="var(--accent, #4a9eff)" stop-opacity="0.08"/>
    </linearGradient>
  </defs>
  <ellipse cx="320" cy="360" rx="200" ry="28" fill="none" stroke="var(--border, #3a3f4b)" stroke-width="1.5" stroke-dasharray="6 8" opacity="0.7"/>
  <path d="M120 280 L220 220 L420 220 L520 280 L520 320 L420 360 L220 360 L120 320 Z" fill="url(#vav-body)" stroke="var(--border, #4a5060)" stroke-width="2"/>
  <path d="M220 220 L220 160 L360 120 L420 220 Z" fill="url(#vav-accent)" stroke="var(--border, #4a5060)" stroke-width="1.5"/>
  <path d="M360 120 L460 160 L420 220 Z" fill="var(--bg-elev, #2a2d35)" stroke="var(--border, #4a5060)" stroke-width="1.5"/>
  <rect x="248" y="248" width="144" height="56" rx="6" fill="var(--bg, #1e2128)" stroke="var(--accent, #4a9eff)" stroke-width="1.5" opacity="0.9"/>
  <circle cx="280" cy="276" r="14" fill="none" stroke="var(--text-dim, #8b919c)" stroke-width="2"/>
  <path d="M280 262 L280 290 M266 276 L294 276" stroke="var(--text-dim, #8b919c)" stroke-width="2" stroke-linecap="round"/>
  <rect x="332" y="258" width="48" height="36" rx="4" fill="var(--accent, #4a9eff)" opacity="0.25" stroke="var(--accent, #4a9eff)" stroke-width="1"/>
  <path d="M180 300 L260 300 L300 340" fill="none" stroke="var(--text-dim, #8b919c)" stroke-width="2" stroke-linecap="round"/>
  <path d="M460 300 L380 300 L340 340" fill="none" stroke="var(--text-dim, #8b919c)" stroke-width="2" stroke-linecap="round"/>
  <path d="M320 220 L320 180" stroke="var(--border, #4a5060)" stroke-width="3" stroke-linecap="round"/>
  <rect x="300" y="148" width="40" height="32" rx="4" fill="var(--bg-elev, #2a2d35)" stroke="var(--border, #4a5060)" stroke-width="1.5"/>
</svg>`;
