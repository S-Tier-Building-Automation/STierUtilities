// Small canvas line chart for in-app trend views (historian + BACnet trend-log).

/** Compute a padded y-axis extent; flat lines get symmetric padding. */
export function niceExtent(values) {
  if (!values.length) return { min: 0, max: 1 };
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    const pad = min === 0 ? 1 : Math.abs(min) * 0.1 || 1;
    return { min: min - pad, max: max + pad };
  }
  const range = max - min;
  const pad = range * 0.05;
  return { min: min - pad, max: max + pad };
}

/** Map `{ ts, value }` samples to canvas coordinates within the plot area. */
export function projectSamples(samples, w, h, extent, padding = { top: 10, right: 10, bottom: 22, left: 44 }) {
  const plotW = w - padding.left - padding.right;
  const plotH = h - padding.top - padding.bottom;
  if (!samples.length || plotW <= 0 || plotH <= 0) return [];
  const tsMin = samples[0].ts;
  const tsMax = samples[samples.length - 1].ts;
  const tsRange = tsMax - tsMin || 1;
  const valRange = extent.max - extent.min || 1;
  return samples.map((s) => ({
    x: padding.left + ((s.ts - tsMin) / tsRange) * plotW,
    y: padding.top + plotH - ((s.value - extent.min) / valRange) * plotH,
    ts: s.ts,
    value: s.value,
  }));
}

function chartCssVar(name, fallback) {
  if (typeof document === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function formatAxisValue(v, format) {
  if (typeof format === "function") return format(v);
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toFixed(0);
  if (abs >= 100) return n.toFixed(1);
  if (abs >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

/**
 * Draw a value-vs-time line chart on a DPR-scaled canvas.
 * @param {{ samples: { ts: number, value: number }[], width?: number, height?: number, format?: (n: number) => string }} opts
 */
export function lineChartCanvas({ samples = [], width = 480, height = 140, format } = {}) {
  const canvas = document.createElement("canvas");
  canvas.className = "line-chart-canvas";
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  // Bitmap pixels must match the CSS layout size (× DPR) — stretching via width:100%
  // with a smaller backing store is the usual cause of blurry canvas charts.
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  canvas.style.display = "block";
  canvas.style.maxWidth = "100%";

  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  ctx.scale(dpr, dpr);

  const accent = chartCssVar("--accent", "#4a9eff");
  const dim = chartCssVar("--text-dim", "#888");
  const border = chartCssVar("--border", "#333");
  const text = chartCssVar("--text", "#ddd");

  ctx.fillStyle = "transparent";
  ctx.clearRect(0, 0, w, h);

  if (samples.length < 2) {
    ctx.fillStyle = dim;
    ctx.font = "12px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(samples.length === 0 ? "No samples yet — collecting…" : "Collecting… (need 2+ samples)", w / 2, h / 2);
    return canvas;
  }

  const padding = { top: 10, right: 10, bottom: 22, left: 44 };
  const extent = niceExtent(samples.map((s) => s.value));
  const pts = projectSamples(samples, w, h, extent, padding);

  // Grid + y-axis labels
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padding.left, padding.top);
  ctx.lineTo(padding.left, h - padding.bottom);
  ctx.lineTo(w - padding.right, h - padding.bottom);
  ctx.stroke();

  ctx.fillStyle = dim;
  ctx.font = "10px system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillText(formatAxisValue(extent.max, format), padding.left - 4, padding.top + 4);
  ctx.fillText(formatAxisValue(extent.min, format), padding.left - 4, h - padding.bottom);

  // Line
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.stroke();

  // Latest value badge
  const latest = samples[samples.length - 1];
  const label = formatAxisValue(latest.value, format);
  ctx.fillStyle = text;
  ctx.font = "11px system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillText(label, w - padding.right, 2);

  return canvas;
}
