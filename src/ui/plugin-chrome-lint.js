// Static checks that tool pages do not duplicate plugin shell chrome.
// See docs/rendering-standards.md § Tool page chrome ownership.

/** Class tokens owned by src/ui/plugin-page.js — must not appear in tool renderPage output. */
export const FORBIDDEN_TOOL_CHROME_CLASSES = [
  "plugin-title",
  "plugin-tagline",
  "plugin-header",
  "plugin-header-left",
  "plugin-header-right",
  "plugin-header-copy",
  "plugin-title-row",
  "plugin-icon",
  "bw-page-header",
  "bw-page-title",
];

/** Element ids that indicate a second tool page header block. */
export const FORBIDDEN_TOOL_CHROME_IDS = [
  "bw-page-header",
];

const CLASS_ATTR_RE = /class:\s*(["'`])([^"'`]*)\1/g;

/**
 * @param {string} source
 * @param {{ file?: string }} [opts]
 * @returns {{ file: string, line: number, rule: string, detail: string }[]}
 */
export function findForbiddenChromeInSource(source, { file = "" } = {}) {
  const violations = [];

  for (const match of source.matchAll(CLASS_ATTR_RE)) {
    const classValue = match[2];
    const line = source.slice(0, match.index).split("\n").length;
    for (const cls of FORBIDDEN_TOOL_CHROME_CLASSES) {
      if (classTokens(classValue).includes(cls)) {
        violations.push({
          file,
          line,
          rule: "forbidden-class",
          detail: `class "${cls}" is owned by plugin-page.js`,
        });
      }
    }
  }

  for (const id of FORBIDDEN_TOOL_CHROME_IDS) {
    const re = new RegExp(`id:\\s*(["'\`])${id}\\1`, "g");
    for (const match of source.matchAll(re)) {
      const line = source.slice(0, match.index).split("\n").length;
      violations.push({
        file,
        line,
        rule: "forbidden-id",
        detail: `id "${id}" duplicates plugin shell chrome`,
      });
    }
  }

  return violations;
}

/**
 * DOM guard for tool bodies mounted under plugin-page.js (requires a document).
 *
 * @param {ParentNode} root Tool renderPage() output
 * @param {{ toolId?: string }} [opts]
 * @returns {string[]} Human-readable violations
 */
export function findForbiddenChromeInDom(root, { toolId = "tool" } = {}) {
  if (!root || typeof root.querySelectorAll !== "function") return [];
  const violations = [];

  for (const cls of FORBIDDEN_TOOL_CHROME_CLASSES) {
    const nodes = root.querySelectorAll(`.${cssEscape(cls)}`);
    if (nodes.length) {
      violations.push(`${toolId}: found .${cls} (${nodes.length}) inside tool body`);
    }
  }
  for (const id of FORBIDDEN_TOOL_CHROME_IDS) {
    if (root.querySelector(`#${cssEscape(id)}`)) {
      violations.push(`${toolId}: found #${id} inside tool body`);
    }
  }
  if (root.querySelector("header.plugin-header")) {
    violations.push(`${toolId}: found header.plugin-header inside tool body`);
  }

  return violations;
}

function classTokens(value) {
  return String(value || "").trim().split(/\s+/).filter(Boolean);
}

function cssEscape(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}
