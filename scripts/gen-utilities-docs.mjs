// Sync the Utilities Platform capability reference into the Mintlify docs repo
// (the site Mintlify deploys from). Single source of truth = the live capability
// catalog (src/platform/service-catalog.js). Run after a capability changes:
//
//   npm run docs:gen                 # writes into ../docs (sibling checkout)
//   node scripts/gen-utilities-docs.mjs <path-to-docs-repo>
//
// It OWNS the generated reference pages (utilities/reference/*.mdx) and the
// "Utilities Platform" tab in docs.json. It does NOT touch the hand-authored
// guides (utilities/introduction.mdx, utilities/authoring.mdx) — those are
// maintained directly in the docs repo and just referenced in the nav here.
// After running, commit + push in the docs repo; Mintlify deploys on merge.

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildServiceCatalog } from "../src/platform/service-catalog.js";
import { TOOL_MANIFESTS } from "../src/tools/manifests.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.argv[2] || join(ROOT, "..", "docs");

const slug = (cap) => cap.replace(/\./g, "-");
const esc = (s) => String(s).replace(/[<{}]/g, (c) => "\\" + c);
const firstSentence = (s) => { const i = String(s).indexOf(". "); return i === -1 ? String(s) : String(s).slice(0, i + 1); };
const badgeOf = (p) => (p.category === "service" ? "Service" : p.category === "app" ? "App" : "Provider");

function frontmatter({ title, description, icon }) {
  const lines = ["---", `title: ${JSON.stringify(title)}`, `description: ${JSON.stringify(description)}`];
  if (icon) lines.push(`icon: ${JSON.stringify(icon)}`);
  lines.push("---", "");
  return lines.join("\n");
}

function capabilityBody(e) {
  const out = [];
  out.push(`<Note>Provided by **${e.provider.name}** — contract v${e.version} — ${badgeOf(e.provider)}</Note>`, "");
  if (e.doc) out.push(esc(e.doc.summary), "");
  out.push("## Consume it", "", "```js", e.usage, "```", "");
  if (e.doc && e.doc.methods.length) {
    out.push("## Methods", "");
    for (const m of e.doc.methods) out.push(`### \`${m.sig}\``, "", `Returns \`${m.returns}\`.`, "", esc(m.desc), "");
  }
  if (e.doc && e.doc.notes) out.push("## Notes", "", `<Note>${esc(e.doc.notes)}</Note>`, "");
  if (e.provider.permissions.length) {
    out.push("## Provider permissions", "", "The provider holds these platform permissions on your behalf:", "");
    out.push(e.provider.permissions.map((p) => `\`${p}\``).join(" · "), "");
  }
  out.push("## Used by", "");
  out.push(
    e.consumers.length
      ? e.consumers.map((c) => `- ${c.name}${c.optional ? " *(optional)*" : ""}`).join("\n")
      : "_Not yet consumed by any tool._",
    "",
  );
  return out.join("\n");
}

function groupByCategory(entries) {
  const order = ["service", "app"];
  const labels = { service: "Services", app: "Apps" };
  const byCat = new Map();
  for (const e of entries) { const c = e.provider.category || "other"; (byCat.get(c) || byCat.set(c, []).get(c)).push(e); }
  const cats = [...byCat.keys()].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99) || a.localeCompare(b));
  return cats.map((c) => [labels[c] || "Other", byCat.get(c)]);
}

function overviewBody(catalog) {
  const out = [
    "Every capability is a **versioned contract**. Declare it in your tool manifest's `requires`, then resolve it from your scoped host with `host.use(\"<capability>.v<major>\")` — you never reach into another tool directly.",
    "",
  ];
  for (const [label, entries] of groupByCategory(catalog.entries)) {
    out.push(`## ${label}`, "", "<CardGroup cols={2}>");
    for (const e of entries) {
      out.push(`  <Card title=${JSON.stringify(e.capability)} href=${JSON.stringify("/utilities/reference/" + slug(e.capability))}>`);
      out.push(`    ${esc(e.doc ? firstSentence(e.doc.summary) : "")}`, "  </Card>");
    }
    out.push("</CardGroup>", "");
  }
  return out.join("\n");
}

// ---- run ----
const catalog = buildServiceCatalog(TOOL_MANIFESTS);
const refDir = join(OUT, "utilities", "reference");
mkdirSync(refDir, { recursive: true });

const write = (rel, body) => writeFileSync(join(OUT, rel + ".mdx"), body, "utf8");

write("utilities/reference/overview",
  frontmatter({ title: "Capability reference", description: "Every capability tools on the platform expose, with the contract you build against.", icon: "book" }) + overviewBody(catalog));

let n = 0;
for (const e of catalog.entries) {
  write(`utilities/reference/${slug(e.capability)}`,
    frontmatter({ title: e.capability, description: e.doc ? firstSentence(e.doc.summary) : `The ${e.capability} capability.` }) + capabilityBody(e));
  n++;
}

// Patch docs.json: rebuild the "Utilities Platform" tab, preserve everything else.
const docsJsonPath = join(OUT, "docs.json");
const config = JSON.parse(readFileSync(docsJsonPath, "utf8"));
const groups = [
  { group: "Get started", pages: ["utilities/introduction", "utilities/authoring"] },
  { group: "Capability reference", pages: ["utilities/reference/overview"] },
  ...groupByCategory(catalog.entries).map(([label, entries]) => ({
    group: label, pages: entries.map((e) => `utilities/reference/${slug(e.capability)}`),
  })),
];
const utilTab = { tab: "Utilities Platform", icon: "blocks", groups };
config.navigation.tabs = config.navigation.tabs.filter((t) => t.tab !== "Utilities Platform").concat([utilTab]);
writeFileSync(docsJsonPath, JSON.stringify(config, null, 2) + "\n", "utf8");

console.log(`Wrote ${n} capability pages + overview into ${join(OUT, "utilities/reference")}`);
console.log(`Patched ${docsJsonPath} (Utilities Platform tab)`);
console.log(`Note: authored guides (utilities/introduction.mdx, utilities/authoring.mdx) are not generated — maintained in the docs repo.`);
