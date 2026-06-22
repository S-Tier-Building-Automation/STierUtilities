import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { findForbiddenChromeInSource } from "./plugin-chrome-lint.js";

const UI_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "tools", "ui");

function toolUiSources() {
  return readdirSync(UI_ROOT)
    .filter((name) => (name.endsWith(".js") || name.endsWith(".svelte")) && !name.endsWith(".test.js"))
    .map((name) => ({
      file: join(UI_ROOT, name),
      rel: relative(join(UI_ROOT, "..", ".."), join(UI_ROOT, name)).replace(/\\/g, "/"),
    }));
}

test("tool UI sources do not duplicate plugin shell chrome", () => {
  const all = [];
  for (const { file, rel } of toolUiSources()) {
    const source = readFileSync(file, "utf8");
    all.push(...findForbiddenChromeInSource(source, { file: rel }));
  }

  if (all.length) {
    const detail = all
      .map((v) => `  ${v.file}:${v.line} — ${v.detail}`)
      .join("\n");
    assert.fail(
      `Tool UI must not re-render plugin shell chrome.\n`
      + `Use headerAddonFor for context-only rows; see docs/rendering-standards.md.\n`
      + `${detail}`,
    );
  }
});

test("plugin chrome lint catches known duplicate header patterns", () => {
  const sample = `
    function renderPage() {
      return el("header", { class: "bw-page-header" },
        el("h2", { class: "plugin-title" }, tool.name),
      );
    }
  `;
  const hits = findForbiddenChromeInSource(sample, { file: "example.js" });
  assert.ok(hits.some((h) => h.detail.includes("plugin-title")));
  assert.ok(hits.some((h) => h.detail.includes("bw-page-header")));
});
