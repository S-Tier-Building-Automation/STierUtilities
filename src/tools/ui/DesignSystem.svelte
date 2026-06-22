<script>
  // Living brand/design-system reference. First Svelte tool (Phase 3 canary):
  // zero state, proves the mount seam + the no-chrome rule (shell owns the header).
  import { BRAND } from "../../ui/brand.js";
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
</script>

<div class="plugin-controls ds-page">
  <section class="plugin-section ds-section">
    <h3 class="ds-section-title">Brand</h3>
    <div class="ds-brand-row">
      <div class="ds-logo-chip">
        <svg width="56" height="56" viewBox="0 0 32 32" role="img" aria-label="S-Tier" class="brand-logo">
          <rect x="1" y="1" width="30" height="30" rx="7" fill="var(--bg-elev-2)" stroke="var(--border-strong)" stroke-width="1" />
          <rect x="7" y="19" width="3" height="7" rx="1.5" fill="var(--accent-2)" />
          <rect x="13" y="15" width="3" height="11" rx="1.5" fill="var(--accent-2)" />
          <rect x="19" y="11" width="3" height="15" rx="1.5" fill="var(--accent-2)" />
          <rect x="25" y="7" width="3" height="19" rx="1.5" fill="var(--signal-amber)" />
        </svg>
      </div>
      <div>
        <div class="ds-h1">{BRAND.name}</div>
        <p class="muted">{BRAND.tagline}</p>
        <div class="ds-voice">
          {#each BRAND.voice as w}<span class="home-chip">{w}</span>{/each}
        </div>
      </div>
    </div>
    <p class="muted small">{BRAND.org}. The mark is an ascending tier / signal-level motif — keep clear space equal to one tier around it; never recolor the amber top tier except to mono.</p>
  </section>

  <section class="plugin-section ds-section">
    <h3 class="ds-section-title">Color</h3>
    <div class="ds-swatches">
      {#each COLORS as c}
        <div class="ds-swatch">
          <div class="ds-swatch-chip" style="background: var({c.name});"></div>
          <div class="ds-swatch-meta">
            <span class="ds-token-var">{c.name}</span>
            <span class="muted small">{c.hex}</span>
            <span class="small">{c.intent}</span>
          </div>
        </div>
      {/each}
    </div>
  </section>

  <section class="plugin-section ds-section">
    <h3 class="ds-section-title">Typography</h3>
    <div class="ds-type-row">
      <span class="ds-token-var">--font-display · Archivo</span>
      <div class="ds-type-sample ds-type-display">Discover. Model. Commission.</div>
    </div>
    <div class="ds-type-row">
      <span class="ds-token-var">--font-ui · IBM Plex Sans</span>
      <div class="ds-type-sample">The integrator's building-automation workspace — body and controls.</div>
    </div>
    <div class="ds-type-row">
      <span class="ds-token-var">--font-mono · IBM Plex Mono</span>
      <div class="ds-type-sample mono">bacnet:1001:0:4   72.4 °F   2026-06-22T08:30:00Z</div>
    </div>
  </section>

  <section class="plugin-section ds-section">
    <h3 class="ds-section-title">Spacing &amp; radius</h3>
    <div class="ds-scale">
      {#each SPACING as s}
        <div class="ds-scale-row">
          <span class="ds-token-var">{s}</span>
          <span class="ds-scale-bar" style="width: var({s});"></span>
        </div>
      {/each}
    </div>
    <div class="ds-radii">
      {#each RADII as r}
        <div class="ds-radius-box" style="border-radius: var({r});"><span class="ds-token-var">{r}</span></div>
      {/each}
    </div>
  </section>

  <section class="plugin-section ds-section">
    <h3 class="ds-section-title">Components</h3>
    <div class="ds-group">
      <button class="btn btn-primary">Primary</button>
      <button class="btn btn-ghost">Ghost</button>
      <button class="btn btn-ghost btn-sm">Ghost sm</button>
      <button class="btn btn-ghost btn-danger btn-sm">Danger</button>
      <button class="btn btn-ghost btn-sm" onclick={() => toast("Instrument toast — ok", "ok")}>Toast</button>
    </div>
    <div class="ds-group">
      <span class="pill pill-running">Running</span>
      <span class="pill pill-idle">Idle</span>
      <span class="pill pill-muted">Muted</span>
      <span class="pill pill-warn">Warn</span>
      <span class="pill pill-error">Error</span>
    </div>
    <label class="nm-field ds-input">
      <span class="nm-field-label">Input</span>
      <input class="nm-input" type="text" value="192.168.1.100" placeholder="host" />
    </label>
  </section>

  <section class="plugin-section ds-section">
    <h3 class="ds-section-title">Motion</h3>
    <p class="muted small">Instrument motion is restrained: one staggered page-load reveal, soft state glows, no gratuitous movement. All animation respects prefers-reduced-motion.</p>
    <div class="ds-group">
      <span class="home-chip home-chip-ok"><span class="home-dot dot-ok"></span>live pulse</span>
      <span class="home-chip">focus glow uses --glow</span>
    </div>
  </section>
</div>
