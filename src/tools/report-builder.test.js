import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderReportHtml,
  reportFromRuleRun,
  reportFromValidation,
  reportFromCommissioning,
} from "./report-builder.js";

test("renderReportHtml produces a branded, escaped, self-contained document", () => {
  const html = renderReportHtml({
    title: "Site <Report>",
    subtitle: "HQ",
    brand: { name: "Acme Controls", color: "#ff0000" },
    generatedAt: "2026-01-01T00:00:00Z",
    sections: [
      { heading: "Overview", paragraphs: ["All <good>."] },
      { heading: "Points", table: { columns: ["Name", "Value"], rows: [["RAT & flow", 72]] } },
    ],
  });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /Acme Controls/);
  assert.match(html, /#ff0000/);
  assert.match(html, /Site &lt;Report&gt;/, "title is escaped");
  assert.match(html, /RAT &amp; flow/, "cell content is escaped");
  assert.match(html, /<th>Name<\/th>/);
});

test("reportFromRuleRun summarizes findings into a table", () => {
  const run = {
    name: "VAV scan",
    findings: [
      { equipName: "VAV-1", rule: "Low airflow", status: "fail", message: "below min" },
      { equipName: "VAV-2", rule: "DAT range", status: "pass", message: "" },
    ],
  };
  const report = reportFromRuleRun(run, { brand: { name: "X" } });
  assert.equal(report.title, "Analytics Findings Report");
  const html = renderReportHtml(report);
  assert.match(html, /1 failing/);
  assert.match(html, /VAV-1/);
  assert.match(html, /Low airflow/);
});

test("validation and commissioning adapters render", () => {
  const v = renderReportHtml(reportFromValidation({ coverage: { templated: 3, total: 5 }, findings: [{ severity: "warn", entityId: "equip:1", message: "no template" }] }));
  assert.match(v, /Templated equipment: 3 \/ 5/);
  assert.match(v, /no template/);

  const c = renderReportHtml(reportFromCommissioning({ steps: [{ name: "Heat call", expected: 1, actual: 1, status: "pass" }] }));
  assert.match(c, /1\/1 steps passed/);
  assert.match(c, /Heat call/);
});
