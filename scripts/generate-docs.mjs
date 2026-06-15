// Generate the Mintlify documentation site from the single source of truth —
// the live capability catalog (src/platform/service-catalog.js). Run after
// changing a capability or its CAPABILITY_DOCS entry:
//
//   npm run docs:gen
//
// It writes docs-site/reference/*.mdx (one page per capability) + the capability
// overview, and rebuilds docs-site/docs.json's navigation. Hand-authored pages
// (index.mdx, concepts/*) are listed in STATIC_GROUPS below and never touched.
//
// Wire `npm run docs:gen` into CI so the published reference can't drift from the
// code; service-catalog.test.js already fails if a capability lacks docs.

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildServiceCatalog } from "../src/platform/service-catalog.js";
import { TOOL_MANIFESTS } from "../src/tools/manifests.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "docs-site");
const REF = join(SITE, "reference");

// Hand-authored pages that the generator preserves and includes in the nav.
const STATIC_GROUPS = [
  { group: "Get started", pages: ["index", "concepts/authoring"] },
];

const slug = (cap) => cap.replace(/\./g, "-");
// Escape MDX-significant characters in PROSE (code spans/fences are left alone).
const esc = (s) => String(s).replace(/[<{}]/g, (c) => "\\" + c);
const firstSentence = (s) => {
  const i = String(s).indexOf(". ");
  return i === -1 ? String(s) : String(s).slice(0, i + 1);
};
const badgeOf = (p) => (p.category === "service" ? "Service" : p.category === "app" ? "App" : "Provider");

function frontmatter(title, description) {
  return ["---", `title: ${JSON.stringify(title)}`, `description: ${JSON.stringify(description)}`, "---", ""].join("\n");
}

function capabilityPage(e) {
  const out = [];
  out.push(frontmatter(e.capability, e.doc ? firstSentence(e.doc.summary) : `The ${e.capability} capability.`));
  out.push(`<Note>Provided by **${e.provider.name}** — contract v${e.version} — ${badgeOf(e.provider)}</Note>`);
  out.push("");
  if (e.doc) out.push(esc(e.doc.summary), "");

  out.push("## Consume it", "");
  out.push("```js", e.usage, "```", "");

  if (e.doc && e.doc.methods.length) {
    out.push("## Methods", "");
    for (const m of e.doc.methods) {
      out.push(`### \`${m.sig}\``, "");
      out.push(`Returns \`${m.returns}\`.`, "");
      out.push(esc(m.desc), "");
    }
  }

  if (e.doc && e.doc.notes) out.push("## Notes", "", `<Note>${esc(e.doc.notes)}</Note>`, "");

  if (e.provider.permissions.length) {
    out.push("## Provider permissions", "");
    out.push("The provider holds these platform permissions on your behalf:", "");
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
  for (const e of entries) {
    const cat = e.provider.category || "other";
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(e);
  }
  const cats = [...byCat.keys()].sort((a, b) => {
    const ra = order.indexOf(a), rb = order.indexOf(b);
    return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb) || a.localeCompare(b);
  });
  return cats.map((cat) => [labels[cat] || "Other providers", byCat.get(cat)]);
}

function overviewPage(catalog) {
  const out = [];
  out.push(frontmatter("Capability reference", "Every capability tools on the platform expose, with the contract you build against."));
  out.push(
    "Every capability is a **versioned contract**. Declare it in your tool manifest's `requires`, then resolve it from your scoped host with `host.use(\"<capability>.v<major>\")` — you never reach into another tool directly.",
    "",
  );
  for (const [label, entries] of groupByCategory(catalog.entries)) {
    out.push(`## ${label}`, "", "<CardGroup cols={2}>");
    for (const e of entries) {
      out.push(`  <Card title=${JSON.stringify(e.capability)} href=${JSON.stringify("/reference/" + slug(e.capability))}>`);
      out.push(`    ${esc(e.doc ? firstSentence(e.doc.summary) : "")}`);
      out.push("  </Card>");
    }
    out.push("</CardGroup>", "");
  }
  return out.join("\n");
}

function docsJson(catalog) {
  const groups = [...STATIC_GROUPS];
  groups.push({ group: "Capability reference", pages: ["reference/overview"] });
  for (const [label, entries] of groupByCategory(catalog.entries)) {
    groups.push({ group: label, pages: entries.map((e) => `reference/${slug(e.capability)}`) });
  }
  return {
    $schema: "https://mintlify.com/docs.json",
    name: "S-Tier Utilities Platform",
    theme: "mint",
    colors: { primary: "#6366f1", light: "#818cf8", dark: "#6366f1" },
    navigation: { tabs: [{ tab: "Documentation", groups }] },
    footer: { socials: { github: "https://github.com/S-Tier-Building-Automation/STierUtilities" } },
  };
}

// ---- run ----
const catalog = buildServiceCatalog(TOOL_MANIFESTS);
mkdirSync(REF, { recursive: true });

let n = 0;
for (const e of catalog.entries) {
  writeFileSync(join(REF, `${slug(e.capability)}.mdx`), capabilityPage(e), "utf8");
  n++;
}
writeFileSync(join(REF, "overview.mdx"), overviewPage(catalog), "utf8");
writeFileSync(join(SITE, "docs.json"), JSON.stringify(docsJson(catalog), null, 2) + "\n", "utf8");

console.log(`Generated ${n} capability pages + overview + docs.json into docs-site/`);
for (const e of catalog.entries) console.log(`  reference/${slug(e.capability)}.mdx  (${e.provider.name})`);
