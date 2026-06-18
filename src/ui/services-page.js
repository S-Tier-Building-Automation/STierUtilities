// Services & Capabilities developer reference page.

import { buildServiceCatalog } from "../platform/service-catalog.js";

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const prev = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => { btn.textContent = prev; }, 1200);
    }
  } catch (err) {
    console.warn("copyText failed:", err);
  }
}

function serviceBadge(provider) {
  if (provider.category === "service") return { label: "Service", cls: "svc-badge-service" };
  if (provider.category === "app") return { label: "App", cls: "svc-badge-app" };
  return { label: "Provider", cls: "" };
}

function renderCapabilityCard(el, e) {
  const methods = (e.doc ? e.doc.methods : []).map((m) =>
    el("div", { class: "svc-method" },
      el("code", { class: "svc-method-sig" }, m.sig),
      el("span", { class: "svc-method-ret muted small" }, `→ ${m.returns}`),
      el("p", { class: "svc-method-desc muted small" }, m.desc),
    ),
  );

  const consumers = e.consumers.length
    ? `Used by: ${e.consumers.map((c) => c.name + (c.optional ? " (optional)" : "")).join(", ")}`
    : "Not yet consumed by any tool.";

  return el("div", { class: "svc-cap" },
    el("div", { class: "svc-cap-head" },
      el("code", { class: "svc-cap-ref" }, e.ref),
      el("span", { class: "svc-cap-ver muted small" }, `contract v${e.version}`),
      el("button", {
        class: "btn-ghost svc-copy", title: "Copy the consume-this-capability snippet",
        onclick: (ev) => copyText(e.usage, ev.currentTarget),
      }, "Copy"),
    ),
    e.doc
      ? el("p", { class: "svc-cap-summary" }, e.doc.summary)
      : el("p", { class: "muted small" }, "No contract docs yet — see the provider's source."),
    methods.length ? el("div", { class: "svc-methods" }, ...methods) : null,
    e.doc && e.doc.notes ? el("p", { class: "svc-note small muted" }, `ℹ ${e.doc.notes}`) : null,
    el("details", { class: "svc-usage" },
      el("summary", {}, "How to use"),
      el("pre", { class: "svc-usage-code" }, el("code", {}, e.usage)),
    ),
    el("p", { class: "svc-consumers muted small" }, consumers),
  );
}

function renderServiceProvider(el, provider, caps) {
  const badge = serviceBadge(provider);
  const head = el("div", { class: "svc-provider-head" },
    el("span", { class: "svc-provider-icon" }, provider.emoji),
    el("div", { class: "svc-provider-titles" },
      el("h3", { class: "svc-provider-name" }, provider.name),
      el("span", { class: `pill svc-badge ${badge.cls}` }, badge.label),
    ),
    provider.permissions.length
      ? el("span", { class: "svc-perms muted small", title: "Permissions this provider holds" },
          `🔑 ${provider.permissions.join(", ")}`)
      : null,
  );
  return el("section", { class: "svc-provider" }, head, ...caps.map((cap) => renderCapabilityCard(el, cap)));
}

/**
 * @param {object} deps
 * @param {import("./dom.js").el} deps.el
 * @param {() => Array<object>} deps.getAllManifests
 */
export function createServicesPageUi({ el, getAllManifests }) {
  function renderPage() {
    const root = document.getElementById("view-root");
    root.replaceChildren();

    const { entries } = buildServiceCatalog(getAllManifests());

    root.appendChild(el("div", { class: "view-header" },
      el("h2", {}, "Services & Capabilities"),
      el("span", { class: "muted small" }, `${entries.length} capabilities`),
    ));
    root.appendChild(el("p", { class: "services-intro muted" },
      "Every capability a tool exposes is a versioned contract any app or connector can build against. ",
      "Declare it in your manifest's ", el("code", {}, "requires"),
      ", then resolve it from your scoped host with ", el("code", {}, "host.use()"),
      " — you never reach into another tool directly. Provider, version and consumers below are read live from the capability graph.",
    ));

    if (entries.length === 0) {
      root.appendChild(el("p", { class: "empty-state" }, "No capabilities are registered."));
      return;
    }

    const byProvider = new Map();
    for (const e of entries) {
      if (!byProvider.has(e.provider.id)) byProvider.set(e.provider.id, { provider: e.provider, caps: [] });
      byProvider.get(e.provider.id).caps.push(e);
    }
    const rank = (p) => (p.category === "service" ? 0 : 1);
    const groups = [...byProvider.values()].sort((a, b) =>
      rank(a.provider) - rank(b.provider) || a.provider.name.localeCompare(b.provider.name),
    );
    for (const g of groups) root.appendChild(renderServiceProvider(el, g.provider, g.caps));
  }

  return { renderPage };
}
