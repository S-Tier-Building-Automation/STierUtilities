// Branded report builder — renders a report model into a self-contained,
// print-ready HTML document for owner/commissioning handoff. In a Tauri webview
// the realistic "PDF" path is print-to-PDF: render this HTML in a window and
// call window.print() (the OS print dialog offers "Save as PDF").
//
// Pure HTML generation (no DOM/Tauri imports) so it is unit-tested; adapters turn
// the existing rule-run / validation / commissioning shapes into a report model.

const DEFAULT_BRAND = { name: "S-Tier Utilities", color: "#14b8a6" };

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderTable(table) {
  if (!table || !Array.isArray(table.columns) || !Array.isArray(table.rows)) return "";
  const head = table.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("");
  const body = table.rows
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`)
    .join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function renderSection(section) {
  const parts = [`<section><h2>${escapeHtml(section.heading || "")}</h2>`];
  for (const p of section.paragraphs || []) parts.push(`<p>${escapeHtml(p)}</p>`);
  if (section.table) parts.push(renderTable(section.table));
  parts.push("</section>");
  return parts.join("");
}

/**
 * Render a report model to a complete HTML document string.
 * @param {object} report
 * @param {string} report.title
 * @param {string} [report.subtitle]
 * @param {{name?:string,color?:string,logoText?:string}} [report.brand]
 * @param {string} [report.generatedAt]
 * @param {Array<{heading:string, paragraphs?:string[], table?:{columns:string[],rows:any[][]}}>} report.sections
 */
export function renderReportHtml(report = {}) {
  const brand = { ...DEFAULT_BRAND, ...(report.brand || {}) };
  const generatedAt = report.generatedAt || new Date().toISOString();
  const sections = (report.sections || []).map(renderSection).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<title>${escapeHtml(report.title || "Report")}</title>
<style>
  :root { --brand: ${escapeHtml(brand.color)}; }
  * { box-sizing: border-box; }
  body { font: 14px/1.5 -apple-system, Segoe UI, Roboto, sans-serif; color: #111; margin: 0; padding: 32px; }
  header.brand { border-bottom: 3px solid var(--brand); padding-bottom: 12px; margin-bottom: 24px; }
  header.brand .name { color: var(--brand); font-weight: 700; letter-spacing: .02em; }
  h1 { font-size: 22px; margin: 4px 0; }
  h2 { font-size: 16px; border-left: 4px solid var(--brand); padding-left: 8px; margin-top: 28px; }
  .muted { color: #666; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 13px; }
  th, td { border: 1px solid #ddd; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #f4f6f8; }
  @media print { body { padding: 0; } h2 { break-after: avoid; } table { break-inside: auto; } }
</style></head>
<body>
<header class="brand">
  <div class="name">${escapeHtml(brand.logoText || brand.name)}</div>
  <h1>${escapeHtml(report.title || "Report")}</h1>
  ${report.subtitle ? `<div class="muted">${escapeHtml(report.subtitle)}</div>` : ""}
  <div class="muted">Generated ${escapeHtml(generatedAt)}</div>
</header>
${sections}
</body></html>`;
}

/** Turn a rules-service run into a report model (findings table + summary). */
export function reportFromRuleRun(run = {}, { brand, title } = {}) {
  const findings = Array.isArray(run.findings) ? run.findings : [];
  const failed = findings.filter((f) => f.status === "fail").length;
  return {
    title: title || "Analytics Findings Report",
    subtitle: run.name || run.id || "",
    brand,
    generatedAt: run.ranAt || run.exportedAt,
    sections: [
      {
        heading: "Summary",
        paragraphs: [
          `${findings.length} finding(s), ${failed} failing.`,
          run.scope ? `Scope: ${run.scope}.` : "Scope: entire model.",
        ],
      },
      {
        heading: "Findings",
        table: {
          columns: ["Equipment", "Rule", "Status", "Detail"],
          rows: findings.map((f) => [f.equipName || f.equipId || "", f.rule || f.ruleId || "", f.status || "", f.message || ""]),
        },
      },
    ],
  };
}

/** Turn a model-validation result into a report model. */
export function reportFromValidation(result = {}, { brand, title } = {}) {
  const findings = Array.isArray(result.findings) ? result.findings : [];
  return {
    title: title || "Model Validation Report",
    brand,
    generatedAt: result.ranAt,
    sections: [
      {
        heading: "Coverage",
        paragraphs: [
          result.coverage
            ? `Templated equipment: ${result.coverage.templated ?? "?"} / ${result.coverage.total ?? "?"}.`
            : "Coverage summary unavailable.",
        ],
      },
      {
        heading: "Findings",
        table: {
          columns: ["Severity", "Entity", "Detail"],
          rows: findings.map((f) => [f.severity || "", f.entityId || f.id || "", f.message || ""]),
        },
      },
    ],
  };
}

/** Turn a commissioning run into a report model. */
export function reportFromCommissioning(run = {}, { brand, title } = {}) {
  const steps = Array.isArray(run.steps) ? run.steps : [];
  const pass = steps.filter((s) => s.status === "pass").length;
  return {
    title: title || "Commissioning Report",
    subtitle: run.name || run.id || "",
    brand,
    generatedAt: run.ranAt,
    sections: [
      { heading: "Summary", paragraphs: [`${pass}/${steps.length} steps passed.`] },
      {
        heading: "Steps",
        table: {
          columns: ["Step", "Expected", "Actual", "Status"],
          rows: steps.map((s) => [s.name || "", s.expected ?? "", s.actual ?? "", s.status || ""]),
        },
      },
    ],
  };
}

/**
 * Open the rendered HTML in a print window and trigger the print dialog (where
 * the user picks "Save as PDF"). Browser/Tauri-only; no-op without a document.
 */
export function printReport(html) {
  if (typeof document === "undefined" || typeof window === "undefined") return false;
  const win = window.open("", "_blank");
  if (!win) return false;
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.focus();
  // Defer so styles/layout settle before the print dialog opens.
  setTimeout(() => win.print(), 250);
  return true;
}
