// Network Manager tool page — profiles, adapters, subnet scan.

/**
 * @param {object} deps
 * @param {typeof import("../../platform/tauri.js").invoke} deps.invoke
 * @param {typeof import("../../platform/tauri.js").listen} deps.listen
 * @param {import("../../ui/dom.js").el} deps.el
 * @param {(toolId: string, msg: string, kind?: string) => void} deps.logTo
 * @param {() => void} deps.renderAll
 * @param {object} deps.userState
 * @param {() => void} deps.saveUserState
 * @param {() => string|null} deps.currentPluginId
 */
export function createNetworkManagerUi({
  invoke, listen, el, logTo, renderAll, userState, saveUserState, currentPluginId,
}) {

const nmCachedSnapshot = userState.networkManager?.adapterSnapshot || null;
const nmCachedAdapters = Array.isArray(nmCachedSnapshot?.adapters) ? nmCachedSnapshot.adapters : [];
const nmCachedStateByAdapter = nmCachedSnapshot?.stateByAdapter && typeof nmCachedSnapshot.stateByAdapter === "object"
  ? nmCachedSnapshot.stateByAdapter
  : {};
const nmCachedSelectedAdapter = typeof userState.networkManager?.selectedAdapter === "string" ? userState.networkManager.selectedAdapter : "";

let nm = {
  adapters: nmCachedAdapters, // NetworkAdapterInfo[]
  profiles: [],            // NetworkProfile[]
  selectedId: nmCachedSelectedAdapter ? null : (typeof userState.networkManager?.selectedProfileId === "string" ? userState.networkManager.selectedProfileId : null), // selected profile id (mutually exclusive with selectedAdapter)
  selectedAdapter: nmCachedSelectedAdapter || null, // selected adapter name, when inspecting a live NIC
  stateByAdapter: nmCachedStateByAdapter, // adapterName -> AdapterNetworkState
  matchById: {},           // profileId -> ProfileMatchResult
  busy: false,
  busyLabel: "",
  loaded: nmCachedAdapters.length > 0, // adapters/state read at least once or hydrated from cache
  adapterSnapshotStale: nmCachedAdapters.length > 0,
  adapterSnapshotAt: typeof nmCachedSnapshot?.readAt === "string" ? nmCachedSnapshot.readAt : "",
  autoRefreshAttempted: false,
  tab: userState.networkManager?.tab === "scan" ? "scan" : "configure", // "configure" (merged adapters+profiles) | "scan"
  scan: {
    adapterName: typeof userState.networkManager?.scanAdapterName === "string" ? userState.networkManager.scanAdapterName : "", // adapter whose subnet we sweep
    scanning: false,
    scanned: 0,
    total: 0,
    hosts: [],             // ScanHost[]: { ip, rttMs, mac, hostname }
    filter: "",            // free-text filter over ip/hostname/mac
    sortKey: "ip",         // "ip" | "hostname" | "mac" | "rtt"
    sortDir: "asc",        // "asc" | "desc"
    done: false,
    error: "",
    listenersReady: false,
  },
};

function nmNewId() {
  return (crypto?.randomUUID?.()) || `p${Date.now()}${Math.random().toString(16).slice(2)}`;
}

function nmBlankProfile() {
  return {
    id: nmNewId(),
    name: "New profile",
    adapterName: "",
    ipv4Mode: "dhcp",
    ipAddress: "",
    subnetMask: "255.255.255.0",
    gateway: "",
    dnsMode: "nochange",
    primaryDns: "",
    secondaryDns: "",
    notes: "",
    lastAppliedAt: null,
  };
}

function nmStatusPill() {
  if (nm.busy) return { label: nm.busyLabel || "Working", cls: "pill-running" };
  const n = nm.profiles.length;
  if (n === 0) return { label: "No profiles", cls: "pill-idle" };
  const active = nm.profiles.filter((p) => nm.matchById[p.id]?.isMatch).length;
  return active > 0
    ? { label: `${active}/${n} active`, cls: "pill-running" }
    : { label: `${n} profile${n === 1 ? "" : "s"}`, cls: "pill-muted" };
}

function nmSelected() { return nm.profiles.find((p) => p.id === nm.selectedId) || null; }

function nmMatch(p) {
  return nm.matchById[p.id] || { isMatch: false, status: "Needs refresh", detail: "Refresh adapters to evaluate." };
}

function nmUniqueName(base) {
  const taken = new Set(nm.profiles.map((p) => p.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  let i = 2;
  while (taken.has(`${base} ${i}`.toLowerCase())) i += 1;
  return `${base} ${i}`;
}

function nmIpv4Summary(s) {
  if (!s) return "Unavailable";
  if (s.ipv4Mode === "dhcp") return s.ipAddress ? `DHCP (${s.ipAddress})` : "DHCP";
  return s.ipAddress ? `${s.ipAddress} / ${s.subnetMask || "?"}` : "none";
}

function nmDnsSummary(s) {
  if (!s) return "Unavailable";
  const list = (s.dnsServers || []).join(", ");
  if (s.dnsMode === "manual") return list || "none";
  return list ? `Automatic (${list})` : "Automatic";
}

// ---- data flow ----

let nmSaveTimer = null;
function nmSaveSoon() {
  if (nmSaveTimer) clearTimeout(nmSaveTimer);
  nmSaveTimer = setTimeout(nmSaveNow, 250);
}
async function nmSaveNow() {
  try {
    await invoke("networkmanager_save_profiles", { profiles: nm.profiles });
  } catch (err) {
    logTo("networkmanager", `Could not save profiles: ${err}`, "error");
  }
}

function nmSaveUiState() {
  userState.networkManager = {
    ...(userState.networkManager || {}),
    selectedAdapter: nm.selectedAdapter || "",
    selectedProfileId: nm.selectedId || "",
    tab: nm.tab,
    scanAdapterName: nm.scan.adapterName || "",
    adapterSnapshot: userState.networkManager?.adapterSnapshot || null,
  };
  saveUserState();
}

function nmSaveAdapterSnapshot() {
  const readAt = new Date().toISOString();
  nm.adapterSnapshotAt = readAt;
  userState.networkManager = {
    ...(userState.networkManager || {}),
    selectedAdapter: nm.selectedAdapter || "",
    selectedProfileId: nm.selectedId || "",
    tab: nm.tab,
    scanAdapterName: nm.scan.adapterName || "",
    adapterSnapshot: {
      readAt,
      adapters: nm.adapters,
      stateByAdapter: nm.stateByAdapter,
    },
  };
  saveUserState();
}

async function nmLoadProfiles() {
  try {
    nm.profiles = await invoke("networkmanager_load_profiles");
    if (nm.selectedId && !nm.profiles.some((p) => p.id === nm.selectedId)) nm.selectedId = null;
    if (nm.profiles.length && !nm.selectedId && !nm.selectedAdapter) nm.selectedId = nm.profiles[0].id;
    nmSaveUiState();
  } catch (err) {
    logTo("networkmanager", `Could not load profiles: ${err}`, "error");
  }
}

async function nmRecomputeMatch(p) {
  const state = nm.stateByAdapter[p.adapterName];
  if (!state) {
    nm.matchById[p.id] = {
      isMatch: false,
      status: p.adapterName ? "No adapter" : "Needs setup",
      detail: p.adapterName
        ? `No live snapshot for ${p.adapterName}. Refresh adapters.`
        : "Pick a target adapter for this profile.",
    };
    return;
  }
  try {
    nm.matchById[p.id] = await invoke("networkmanager_compare", { profile: p, state });
  } catch (err) {
    nm.matchById[p.id] = { isMatch: false, status: "Error", detail: String(err) };
  }
}

async function nmRecomputeAll() { await Promise.all(nm.profiles.map(nmRecomputeMatch)); }

async function nmApplyStartupSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.adapters)) return false;
  nm.adapters = snapshot.adapters;
  nm.stateByAdapter = snapshot.stateByAdapter && typeof snapshot.stateByAdapter === "object"
    ? snapshot.stateByAdapter
    : {};
  nm.loaded = true;
  nm.adapterSnapshotStale = false;
  nm.autoRefreshAttempted = true;
  await nmRecomputeAll();
  nmSaveAdapterSnapshot();
  logTo("networkmanager", `Loaded ${nm.adapters.length} adapter${nm.adapters.length === 1 ? "" : "s"} from native startup warmup.`, "ok");
  return true;
}

async function nmRefresh({ automatic = false } = {}) {
  nm.autoRefreshAttempted = true;
  nm.busy = true;
  nm.busyLabel = nm.loaded ? "Refreshing adapters" : "Reading adapters";
  renderAll();
  try {
    nm.adapters = await invoke("networkmanager_list_adapters");
    nm.stateByAdapter = {};
    // Read adapter states concurrently — each shells out to PowerShell (~0.5-1.5s),
    // so a sequential loop would freeze the UI for several seconds on multi-NIC boxes.
    await Promise.all(
      nm.adapters
        .filter((a) => a.status !== "Not Present")
        .map(async (a) => {
          try {
            nm.stateByAdapter[a.name] = await invoke("networkmanager_read_state", { name: a.name });
          } catch (err) {
            logTo("networkmanager", `Could not read ${a.name}: ${err}`, "warn");
          }
        }),
    );
    await nmRecomputeAll();
    nm.loaded = true;
    nm.adapterSnapshotStale = false;
    nmSaveAdapterSnapshot();
    logTo("networkmanager", `Read ${nm.adapters.length} adapter${nm.adapters.length === 1 ? "" : "s"}.`, "ok");
  } catch (err) {
    if (!automatic || !nm.loaded) logTo("networkmanager", `Refresh failed: ${err}`, "error");
    else logTo("networkmanager", `Background adapter refresh failed: ${err}`, "warn");
  } finally {
    nm.busy = false;
    nm.busyLabel = "";
    renderAll();
  }
}

function nmEnsureLoaded() {
  if (!nm.loaded && !nm.busy) nmRefresh();
  else if (nm.adapterSnapshotStale && !nm.busy && !nm.autoRefreshAttempted) nmRefresh({ automatic: true });
}

function nmDefaultAdapter() {
  const sel = nmSelected();
  if (sel?.adapterName) return sel.adapterName;
  const up = nm.adapters.find((a) => a.status === "Up");
  return up?.name || nm.adapters[0]?.name || "";
}

async function nmNew() {
  const p = nmBlankProfile();
  p.name = nmUniqueName("New profile");
  p.adapterName = nmDefaultAdapter();
  nm.profiles.push(p);
  nm.selectedId = p.id;
  nm.selectedAdapter = null;
  await nmRecomputeMatch(p);
  nmSaveSoon();
  nmSaveUiState();
  logTo("networkmanager", `Created "${p.name}".`, "info");
  renderAll();
}

async function nmDuplicate() {
  const sel = nmSelected();
  if (!sel) return;
  const p = { ...sel, id: nmNewId(), name: nmUniqueName(`${sel.name} copy`), lastAppliedAt: null };
  nm.profiles.push(p);
  nm.selectedId = p.id;
  nm.selectedAdapter = null;
  await nmRecomputeMatch(p);
  nmSaveSoon();
  nmSaveUiState();
  renderAll();
}

function nmDelete() {
  const sel = nmSelected();
  if (!sel) return;
  if (!confirm(`Delete profile "${sel.name}"?`)) return;
  const idx = nm.profiles.findIndex((p) => p.id === sel.id);
  nm.profiles = nm.profiles.filter((p) => p.id !== sel.id);
  delete nm.matchById[sel.id];
  const next = nm.profiles[idx] || nm.profiles[idx - 1] || null;
  nm.selectedId = next?.id || null;
  nmSaveSoon();
  nmSaveUiState();
  logTo("networkmanager", `Deleted "${sel.name}".`, "warn");
  renderAll();
}

function nmSelect(id) {
  if (nm.selectedId === id && !nm.selectedAdapter) return;
  nm.selectedId = id;
  nm.selectedAdapter = null;
  nmSaveUiState();
  renderAll();
}

// Select a live adapter (shows its detail in the config panel). Mutually
// exclusive with a profile selection.
function nmSelectAdapter(name) {
  if (nm.selectedAdapter === name) return;
  nm.selectedAdapter = name;
  nm.selectedId = null;
  nmSaveUiState();
  renderAll();
}

let nmFieldTimer = null;
function nmSetText(key, value) {
  const sel = nmSelected();
  if (!sel) return;
  sel[key] = value;
  nmSaveSoon();
  if (nmFieldTimer) clearTimeout(nmFieldTimer);
  nmFieldTimer = setTimeout(async () => {
    await nmRecomputeMatch(sel);
    nmRefreshLiveBits();
  }, 250);
}

// Update only the drift banner + profile list in place, so editing a text field
// never steals focus from the input being typed into.
function nmRefreshLiveBits() {
  if (currentPluginId() !== "networkmanager") return;
  const sel = nmSelected();
  const rail = document.getElementById("nm-config-rail");
  if (rail) rail.replaceChildren(...nmConfigRailContent());
  const drift = document.getElementById("nm-drift");
  if (drift && sel) drift.replaceWith(nmDriftBanner(sel));
  const title = document.getElementById("nm-editor-title");
  if (title && sel) title.textContent = sel.name || "(unnamed)";
}

async function nmSetChoice(key, value) {
  const sel = nmSelected();
  if (!sel) return;
  sel[key] = value;
  nmSaveSoon();
  await nmRecomputeMatch(sel);
  renderAll();
}

async function nmCaptureAdapter(adapterName) {
  if (!adapterName) {
    logTo("networkmanager", "No adapter available to capture.", "warn");
    return;
  }
  nm.busy = true;
  nm.busyLabel = "Capturing";
  renderAll();
  try {
    const p = await invoke("networkmanager_capture_profile", { name: adapterName });
    p.id = nmNewId();
    p.name = nmUniqueName(p.name);
    nm.profiles.push(p);
    nm.selectedId = p.id;
    nm.selectedAdapter = null;   // show the new profile's editor in the config panel
    await nmRecomputeMatch(p);
    nmSaveNow();
    logTo("networkmanager", `Captured "${p.name}" from ${adapterName}.`, "ok");
  } catch (err) {
    logTo("networkmanager", `Capture failed: ${err}`, "error");
  } finally {
    nm.busy = false;
    nm.busyLabel = "";
    renderAll();
  }
}

async function nmOpenDir() {
  try {
    await invoke("networkmanager_open_profiles_dir");
  } catch (err) {
    logTo("networkmanager", `Could not open folder: ${err}`, "error");
  }
}

async function nmApply() {
  const sel = nmSelected();
  if (!sel || nm.busy) return;
  if (!sel.adapterName) {
    logTo("networkmanager", "Pick a target adapter before applying.", "warn");
    return;
  }
  // Snapshot the profile before any await. The user can still edit fields while
  // UAC / apply / re-read is in flight, so we must verify against exactly what we
  // sent — not against a profile that changed underneath us.
  const applied = { ...sel };

  const proceed = confirm(
    `Apply "${applied.name}" to ${applied.adapterName}?\n\n` +
    `This changes Windows IPv4/DNS settings and will prompt for administrator approval.`,
  );
  if (!proceed) return;

  nm.busy = true;
  nm.busyLabel = "Applying";
  renderAll();
  let attempted = false;
  let hadStepIssue = false;
  try {
    const outcome = await invoke("networkmanager_apply_profile", { profile: applied });
    attempted = true;
    hadStepIssue = !outcome.ok;
    for (const s of outcome.steps) {
      logTo("networkmanager", `${s.step}: ${s.detail}`, s.ok ? "ok" : "error");
    }
  } catch (err) {
    logTo("networkmanager", `${err}`, "error");
  } finally {
    // The authoritative "did it work?" signal is the re-read state, NOT the step
    // exit codes — netsh can apply a change and still return non-zero. So always
    // re-read and judge success by whether Windows matches the applied snapshot.
    if (attempted && applied.adapterName) {
      nm.busyLabel = "Verifying";
      renderAll();
      await new Promise((r) => setTimeout(r, 1000));
      let state = null;
      try {
        state = await invoke("networkmanager_read_state", { name: applied.adapterName });
        nm.stateByAdapter[applied.adapterName] = state;
      } catch (err) {
        logTo("networkmanager", `Could not re-read ${applied.adapterName}: ${err}`, "warn");
      }
      let matched = false;
      let detail = "No live snapshot.";
      if (state) {
        try {
          const m = await invoke("networkmanager_compare", { profile: applied, state });
          matched = m.isMatch;
          detail = m.detail;
        } catch (err) {
          detail = String(err);
        }
      }
      if (matched) {
        const live = nm.profiles.find((p) => p.id === applied.id);
        if (live) {
          live.lastAppliedAt = new Date().toISOString();
          nmSaveNow();
        }
        logTo("networkmanager", `Applied "${applied.name}" — Windows now matches.`, "ok");
      } else {
        logTo(
          "networkmanager",
          `Applied, but Windows doesn't match yet: ${detail}`,
          hadStepIssue ? "error" : "warn",
        );
      }
      // Keep the on-screen drift for the currently-selected profile in sync.
      const cur = nmSelected();
      if (cur) await nmRecomputeMatch(cur);
    }
    nm.busy = false;
    nm.busyLabel = "";
    renderAll();
  }
}

// ---- render ----

// Active / Drift / Idle status for a profile, derived from its live-match result:
// Active = currently applied; Drift = its target adapter is present but live config
// differs; Idle = no present target adapter.
function nmProfileStatus(p) {
  if (nmMatch(p).isMatch) return { dot: "nm-dot-active", label: "Active", cls: "nm-nic-active" };
  const present = nm.adapters.some((a) => a.name === p.adapterName && a.status !== "Not Present");
  return present
    ? { dot: "nm-dot-drift", label: "Drift", cls: "nm-state-drift" }
    : { dot: "nm-dot-idle", label: "Idle", cls: "muted" };
}

// A profile row in the grouped config rail (the adapter it targets is implied by
// its group, so the row only carries name + status).
function nmRailProfileRow(p) {
  const active = !nm.selectedAdapter && p.id === nm.selectedId;
  const s = nmProfileStatus(p);
  return el("div", {
    class: `nm-rail-profile ${active ? "selected" : ""}`,
    role: "button",
    tabindex: "0",
    title: p.name || "(unnamed)",
    "aria-pressed": active ? "true" : "false",
    onclick: () => nmSelect(p.id),
    onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); nmSelect(p.id); } },
  },
    el("span", { class: `nm-rail-dot ${s.dot}`, "aria-hidden": "true" }),
    el("span", { class: "nm-rail-pname" }, p.name || "(unnamed)"),
    el("span", { class: `nm-rail-pstate small ${s.cls}` }, s.label),
  );
}

function nmDriftBanner(p) {
  const m = nmMatch(p);
  const state = nm.stateByAdapter[p.adapterName];
  const snapshot = state
    ? `${state.adapterName}: IPv4 ${nmIpv4Summary(state)} · gateway ${state.gateway || "none"} · DNS ${nmDnsSummary(state)}`
    : "No live snapshot yet — use Refresh adapters.";
  return el("div", { id: "nm-drift", class: `nm-drift ${m.isMatch ? "nm-drift-active" : ""}` },
    el("div", { class: "nm-drift-status" }, m.isMatch ? "✓ Active" : (m.status || "Not active")),
    m.detail ? el("div", { class: "muted small" }, m.detail) : null,
    el("div", { class: "muted small nm-drift-snapshot" }, snapshot),
  );
}

function nmTextField(label, key, opts = {}) {
  const sel = nmSelected();
  const input = el("input", {
    class: "nm-input",
    type: "text",
    placeholder: opts.placeholder || "",
    disabled: opts.disabled ? "disabled" : undefined,
    oninput: (e) => nmSetText(key, e.target.value),
  });
  input.value = sel[key] || "";
  return el("label", { class: `nm-field ${opts.disabled ? "nm-field-dim" : ""}` },
    el("span", { class: "nm-field-label" }, label),
    input,
  );
}

function nmSeg(label, key, options) {
  const sel = nmSelected();
  return el("div", { class: "nm-seg-row" },
    el("span", { class: "nm-field-label" }, label),
    el("div", { class: "nm-seg" },
      ...options.map((opt) => el("button", {
        class: `nm-seg-btn ${sel[key] === opt.value ? "nm-seg-on" : ""}`,
        onclick: () => nmSetChoice(key, opt.value),
      }, opt.label)),
    ),
  );
}

function nmEditorContent(sel) {
  const usesStatic = sel.ipv4Mode === "static";
  const usesManual = sel.dnsMode === "manual";

  const adapterSelect = el("select", {
    class: "nm-input",
    onchange: (e) => nmSetChoice("adapterName", e.target.value),
  },
    el("option", { value: "" }, "— choose adapter —"),
    ...nm.adapters.map((a) => el("option", {
      value: a.name,
      selected: a.name === sel.adapterName ? "selected" : undefined,
    }, a.description ? `${a.name} — ${a.description}` : a.name)),
    (sel.adapterName && !nm.adapters.some((a) => a.name === sel.adapterName))
      ? el("option", { value: sel.adapterName, selected: "selected" }, `${sel.adapterName} (not found)`)
      : null,
  );

  const notes = el("textarea", {
    class: "nm-input nm-textarea",
    oninput: (e) => nmSetText("notes", e.target.value),
  });
  notes.value = sel.notes || "";

  const header = el("div", { class: "nm-editor-head" },
    el("h3", { id: "nm-editor-title", class: "nm-editor-title" }, sel.name || "(unnamed)"),
    el("div", { class: "nm-editor-actions" },
      el("button", {
        class: "btn btn-primary nm-apply-btn",
        disabled: nm.busy || !sel.adapterName ? "disabled" : undefined,
        title: "Apply this profile to Windows (prompts for admin)",
        onclick: nmApply,
      }, "Apply"),
      el("button", { class: "btn-ghost", disabled: nm.busy ? "disabled" : undefined, onclick: nmDuplicate }, "Duplicate"),
      el("button", { class: "btn-ghost nm-danger", disabled: nm.busy ? "disabled" : undefined, onclick: nmDelete }, "Delete"),
    ),
  );

  return [
    header,
    el("section", { class: "plugin-section" },
      el("h3", {}, "Profile"),
      el("div", { class: "nm-grid-2" },
        nmTextField("Name", "name"),
        el("label", { class: "nm-field" },
          el("span", { class: "nm-field-label" }, "Target adapter"),
          adapterSelect,
        ),
      ),
      nmDriftBanner(sel),
      el("label", { class: "nm-field" },
        el("span", { class: "nm-field-label" }, "Notes"),
        notes,
      ),
    ),
    el("section", { class: "plugin-section" },
      el("h3", {}, "IPv4"),
      nmSeg("Mode", "ipv4Mode", [
        { value: "dhcp", label: "DHCP" },
        { value: "static", label: "Static" },
      ]),
      el("div", { class: "nm-grid-2" },
        nmTextField("IP address", "ipAddress", { disabled: !usesStatic, placeholder: "192.168.1.50" }),
        nmTextField("Subnet mask", "subnetMask", { disabled: !usesStatic, placeholder: "255.255.255.0" }),
      ),
      nmTextField("Gateway", "gateway", { disabled: !usesStatic, placeholder: "192.168.1.1 (optional)" }),
    ),
    el("section", { class: "plugin-section" },
      el("h3", {}, "DNS"),
      nmSeg("Mode", "dnsMode", [
        { value: "automatic", label: "Automatic" },
        { value: "manual", label: "Manual" },
        { value: "nochange", label: "No change" },
      ]),
      el("div", { class: "nm-grid-2" },
        nmTextField("Primary DNS", "primaryDns", { disabled: !usesManual, placeholder: "8.8.8.8" }),
        nmTextField("Alternate DNS", "secondaryDns", { disabled: !usesManual, placeholder: "8.8.4.4 (optional)" }),
      ),
    ),
    el("p", { class: "muted small nm-readonly-note" },
      "Apply changes Windows IPv4/DNS for the target adapter and prompts for administrator approval. · ",
      el("a", { href: "#", onclick: (e) => { e.preventDefault(); nmOpenDir(); } }, "open profiles folder"),
    ),
  ];
}

// ---- scan (Angry-IP-Scanner-style subnet sweep) ----

// Dotted IPv4 mask -> CIDR prefix length (count of contiguous high bits).
function nmMaskToPrefix(mask) {
  const parts = String(mask || "").split(".").map((n) => parseInt(n, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  let bits = 0;
  for (const oct of parts) bits += (oct >>> 0).toString(2).split("").filter((b) => b === "1").length;
  return bits;
}

// Resolve the subnet we'd sweep for an adapter, from its live state. Returns
// { ip, prefix, network, label } or null when the adapter has no usable IPv4.
function nmScanSubnetFor(adapterName) {
  const st = nm.stateByAdapter[adapterName];
  if (!st || !st.ipAddress) return null;
  const prefix = nmMaskToPrefix(st.subnetMask);
  if (prefix == null || prefix < 16 || prefix > 30) return null;
  const ipParts = st.ipAddress.split(".").map((n) => parseInt(n, 10));
  if (ipParts.length !== 4 || ipParts.some((n) => Number.isNaN(n))) return null;
  const ipNum = ((ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3]) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const net = (ipNum & mask) >>> 0;
  const network = [(net >>> 24) & 255, (net >>> 16) & 255, (net >>> 8) & 255, net & 255].join(".");
  const hostCount = Math.max(0, Math.pow(2, 32 - prefix) - 2);
  return { ip: st.ipAddress, prefix, network, hostCount, label: `${network}/${prefix} · ${hostCount} hosts` };
}

// Pick a sensible default adapter to scan: the current scan target if still valid,
// else the selected profile's adapter, else the first "Up" adapter with an IPv4.
function nmScanDefaultAdapter() {
  if (nm.scan.adapterName && nmScanSubnetFor(nm.scan.adapterName)) return nm.scan.adapterName;
  const sel = nmSelected();
  if (sel?.adapterName && nmScanSubnetFor(sel.adapterName)) return sel.adapterName;
  const up = nm.adapters.find((a) => a.status === "Up" && nmScanSubnetFor(a.name));
  if (up) return up.name;
  const any = nm.adapters.find((a) => nmScanSubnetFor(a.name));
  return any?.name || "";
}

function nmScanInitListeners() {
  if (nm.scan.listenersReady) return;
  nm.scan.listenersReady = true;
  listen("netscan:host", (e) => {
    const h = e.payload;
    if (!nm.scan.hosts.some((x) => x.ip === h.ip)) nm.scan.hosts.push(h);
    nmScanRenderLive();
  }).catch((e) => console.warn("listen netscan:host failed:", e));
  listen("netscan:progress", (e) => {
    nm.scan.scanned = e.payload.scanned;
    nm.scan.total = e.payload.total;
    nmScanRenderLive();
  }).catch((e) => console.warn("listen netscan:progress failed:", e));
  listen("netscan:done", (e) => {
    // Merge rather than replace: streamed `netscan:host` rows may already carry
    // hostnames that arrived first; keep them.
    const byIp = new Map(nm.scan.hosts.map((h) => [h.ip, h]));
    nm.scan.hosts = (e.payload.hosts || []).map((h) => ({ ...h, hostname: h.hostname || byIp.get(h.ip)?.hostname || "" }));
    nm.scan.total = e.payload.total;
    nm.scan.done = true;
    nm.scan.scanning = false;
    renderAll();
  }).catch((e) => console.warn("listen netscan:done failed:", e));
  listen("netscan:hostnames", (e) => {
    const map = new Map((e.payload || []).map((x) => [x.ip, x.hostname]));
    for (const h of nm.scan.hosts) { const n = map.get(h.ip); if (n) h.hostname = n; }
    nmScanRenderLive();
  }).catch((e) => console.warn("listen netscan:hostnames failed:", e));
}

async function nmScanStart() {
  if (nm.scan.scanning) return;
  const adapterName = nmScanDefaultAdapter();
  const subnet = adapterName ? nmScanSubnetFor(adapterName) : null;
  if (!subnet) {
    logTo("networkmanager", "No adapter with a scannable IPv4 subnet. Refresh adapters first.", "warn");
    return;
  }
  nm.scan.adapterName = adapterName;
  nm.scan.scanning = true;
  nm.scan.done = false;
  nm.scan.error = "";
  nm.scan.hosts = [];
  nm.scan.scanned = 0;
  nm.scan.total = subnet.hostCount;
  renderAll();
  try {
    // The `netscan:done` event is authoritative for the host list (and merges
    // streamed hostnames); don't overwrite it from the resolved value here.
    const result = await invoke("netscan_scan", { ip: subnet.ip, prefix: subnet.prefix });
    nm.scan.total = result.total;
    logTo("networkmanager", `Scan complete — ${result.hosts.length} host${result.hosts.length === 1 ? "" : "s"} on ${subnet.network}/${subnet.prefix}.`, "ok");
  } catch (err) {
    nm.scan.error = String(err);
    logTo("networkmanager", `Scan failed: ${err}`, "error");
  } finally {
    nm.scan.scanning = false;
    nm.scan.done = true;
    renderAll();
  }
}

// Patch the live bits (progress + results) in place so streamed events don't
// rebuild the whole page (which would steal focus / flicker the adapter picker).
function nmScanRenderLive() {
  if (currentPluginId() !== "networkmanager" || nm.tab !== "scan") return;
  const prog = document.getElementById("nm-scan-progress");
  if (prog) prog.replaceWith(nmScanProgress());
  nmScanApplyFilter();
}

// Hosts narrowed by the free-text filter (case-insensitive substring over
// IP, hostname, and MAC). Empty filter returns every host.
function nmScanFilteredHosts() {
  const q = nm.scan.filter.trim().toLowerCase();
  if (!q) return nm.scan.hosts;
  return nm.scan.hosts.filter((h) =>
    (h.ip || "").toLowerCase().includes(q) ||
    (h.hostname || "").toLowerCase().includes(q) ||
    (h.mac || "").toLowerCase().includes(q));
}

// Dotted IPv4 -> sortable 32-bit number; -1 for anything unparseable so
// malformed addresses sort to the top in ascending order.
function nmIpToNum(ip) {
  const p = String(ip || "").split(".").map((n) => parseInt(n, 10));
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return -1;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

// Sort a host list by the active column/direction. IP and RTT compare
// numerically; hostname/MAC compare case-insensitively with blanks pinned
// last (regardless of direction). IP is the stable tiebreaker throughout.
function nmScanSortedHosts(hosts) {
  const { sortKey, sortDir } = nm.scan;
  const dir = sortDir === "desc" ? -1 : 1;
  const ipCmp = (a, b) => nmIpToNum(a.ip) - nmIpToNum(b.ip);
  return hosts.slice().sort((a, b) => {
    if (sortKey === "ip") return ipCmp(a, b) * dir;
    if (sortKey === "rtt") {
      const cmp = (a.rttMs ?? Infinity) - (b.rttMs ?? Infinity);
      return (cmp || ipCmp(a, b)) * dir;
    }
    // hostname / mac
    const av = (a[sortKey] || "").toLowerCase();
    const bv = (b[sortKey] || "").toLowerCase();
    if (!av && !bv) return ipCmp(a, b);
    if (!av) return 1;   // blanks always last
    if (!bv) return -1;
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return (cmp || ipCmp(a, b)) * dir;
  });
}

// "N hosts" when unfiltered, "shown of total" when a filter is active.
function nmScanFilterCountText() {
  const total = nm.scan.hosts.length;
  if (!nm.scan.filter.trim()) return `${total} host${total === 1 ? "" : "s"}`;
  return `${nmScanFilteredHosts().length} of ${total} shown`;
}

// Re-render just the results body + count in place so typing in the filter
// box never rebuilds the page (which would steal focus from the input).
function nmScanApplyFilter() {
  if (currentPluginId() !== "networkmanager" || nm.tab !== "scan") return;
  const body = document.getElementById("nm-scan-results");
  if (body) body.replaceChildren(...nmScanResultRows());
  const cnt = document.getElementById("nm-scan-filter-count");
  if (cnt) cnt.textContent = nmScanFilterCountText();
}

// Filter row above the results table. The <input> is left untouched by
// nmScanApplyFilter, so it keeps focus + caret while you type.
function nmScanFilterBar() {
  return el("div", { class: "nm-scan-filter" },
    el("input", {
      type: "search",
      class: "nm-input nm-scan-filter-input",
      placeholder: "Filter by IP, hostname, or MAC…",
      "aria-label": "Filter scan results",
      value: nm.scan.filter,
      oninput: (e) => { nm.scan.filter = e.target.value; nmScanApplyFilter(); },
    }),
    el("span", { id: "nm-scan-filter-count", class: "muted small nm-scan-filter-count" },
      nmScanFilterCountText()),
  );
}

function nmScanProgress() {
  const { scanned, total, scanning, hosts } = nm.scan;
  const pct = total > 0 ? Math.min(100, Math.round((scanned / total) * 100)) : 0;
  let idle = "Pick a subnet to scan.";
  if (!scanning && !nm.scan.done) {
    const a = nmScanDefaultAdapter();
    const sub = a ? nmScanSubnetFor(a) : null;
    idle = sub ? `${sub.hostCount} hosts in range (${sub.network}/${sub.prefix})` : "No scannable subnet — refresh adapters.";
  }
  return el("div", { id: "nm-scan-progress", class: "nm-scan-progress" },
    el("div", { class: "nm-scan-bar" }, el("div", { class: "nm-scan-bar-fill", style: `width:${pct}%` })),
    el("div", { class: "muted small" },
      scanning
        ? `Scanning… ${scanned}/${total} probed · ${hosts.length} found`
        : nm.scan.done
          ? `Done · ${hosts.length} host${hosts.length === 1 ? "" : "s"} of ${total} probed`
          : idle),
  );
}

function nmScanResultRows() {
  const hosts = nmScanSortedHosts(nmScanFilteredHosts());
  if (hosts.length === 0) {
    let msg;
    if (nm.scan.hosts.length > 0) msg = "No hosts match the filter.";
    else if (nm.scan.scanning) msg = "Listening for hosts…";
    else msg = "No hosts yet — run a scan.";
    return [el("tr", {}, el("td", { class: "muted small", colspan: "4" }, msg))];
  }
  return hosts.map((h) => el("tr", { class: "nm-scan-row" },
    el("td", { class: "nm-scan-ip" }, h.ip),
    el("td", {}, h.hostname || el("span", { class: "muted" }, "—")),
    el("td", { class: "nm-scan-mac" }, h.mac || el("span", { class: "muted" }, "—")),
    el("td", { class: "nm-scan-rtt" }, h.rttMs != null ? `${h.rttMs} ms` : "—"),
  ));
}

// Click a column to sort by it; click the active column again to flip
// direction. Re-renders the table in place (header arrows + rows) without a
// full page render, so the filter input keeps its focus/caret.
function nmScanSetSort(key) {
  if (nm.scan.sortKey === key) nm.scan.sortDir = nm.scan.sortDir === "asc" ? "desc" : "asc";
  else { nm.scan.sortKey = key; nm.scan.sortDir = "asc"; }
  const tbl = document.getElementById("nm-scan-table");
  if (tbl) tbl.replaceWith(nmScanTableEl());
}

function nmScanHeaderCell(key, label) {
  const active = nm.scan.sortKey === key;
  const arrow = active ? (nm.scan.sortDir === "asc" ? "▲" : "▼") : "";
  return el("th", {
    class: `nm-scan-th${active ? " nm-scan-th-active" : ""}`,
    role: "button",
    tabindex: "0",
    "aria-sort": active ? (nm.scan.sortDir === "asc" ? "ascending" : "descending") : "none",
    onclick: () => nmScanSetSort(key),
    onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); nmScanSetSort(key); } },
  }, label, el("span", { class: "nm-scan-sort-ind" }, arrow));
}

function nmScanTableEl() {
  return el("table", { id: "nm-scan-table", class: "nm-scan-table" },
    el("thead", {}, el("tr", {},
      nmScanHeaderCell("ip", "IP address"),
      nmScanHeaderCell("hostname", "Hostname"),
      nmScanHeaderCell("mac", "MAC"),
      nmScanHeaderCell("rtt", "RTT"),
    )),
    el("tbody", { id: "nm-scan-results" }, ...nmScanResultRows()),
  );
}

function nmScanTab() {
  nmScanInitListeners();
  const adapterName = nmScanDefaultAdapter();
  const subnet = adapterName ? nmScanSubnetFor(adapterName) : null;

  const candidates = nm.adapters.filter((a) => nmScanSubnetFor(a.name));
  const picker = el("select", {
    class: "nm-input",
    disabled: nm.scan.scanning ? "disabled" : undefined,
    onchange: (e) => { nm.scan.adapterName = e.target.value; nmSaveUiState(); renderAll(); },
  },
    ...candidates.map((a) => el("option", {
      value: a.name,
      selected: a.name === adapterName ? "selected" : undefined,
    }, `${a.name} — ${nmScanSubnetFor(a.name).label}`)),
  );

  const scanBtn = el("button", {
    class: "btn btn-primary",
    disabled: nm.scan.scanning || !subnet ? "disabled" : undefined,
    onclick: nmScanStart,
  }, nm.scan.scanning ? "Scanning…" : "Scan subnet");

  const head = el("section", { class: "plugin-section" },
    el("div", { class: "nm-pane-head" },
      el("div", { class: "nm-pane-head-text" },
        el("h3", {}, "Scan local subnet"),
        el("p", { class: "muted small nm-section-sub" },
          "Ping-sweep the adapter's subnet to find live hosts, their MAC, and hostname. Un-elevated."),
      ),
    ),
    candidates.length === 0
      ? el("p", { class: "muted small" }, nm.loaded ? "No adapter has a scannable IPv4 subnet." : "Reading adapters…")
      : el("div", { class: "nm-scan-controls" },
          el("label", { class: "nm-field nm-scan-pick" },
            el("span", { class: "nm-field-label" }, "Subnet"),
            picker,
          ),
          scanBtn,
        ),
    nmScanProgress(),
  );

  const table = nmScanTableEl();

  const showFilter = nm.scan.scanning || nm.scan.done || nm.scan.hosts.length > 0;

  return el("div", { class: "plugin-controls plugin-controls-fill" },
    head,
    el("section", { class: "plugin-section plugin-section-fill" },
      showFilter ? nmScanFilterBar() : null,
      // Static scroll wrapper; refresh swaps the inner <table> in place (no re-nesting).
      el("div", { class: "table-scroll table-scroll-fill" }, table),
    ),
  );
}

function nmTabBar() {
  const tab = (id, label) => el("button", {
    class: `nm-tab ${nm.tab === id ? "nm-tab-active" : ""}`,
    onclick: () => { nm.tab = id; nmSaveUiState(); renderAll(); },
  }, label);
  return el("div", { class: "nm-tabs" },
    tab("configure", "Configure"),
    tab("scan", "Scan"),
  );
}

function nmAdapterCacheNotice() {
  if (!nm.loaded || !nm.adapterSnapshotStale) return null;
  const readAt = nm.adapterSnapshotAt ? new Date(nm.adapterSnapshotAt) : null;
  const stamp = readAt && !Number.isNaN(readAt.getTime()) ? readAt.toLocaleString() : "a previous session";
  return el("div", { class: "nm-cache-notice" },
    el("span", {}, `Showing cached adapter data from ${stamp}.`),
    el("button", {
      class: "btn-ghost",
      disabled: nm.busy ? "disabled" : undefined,
      onclick: () => nmRefresh(),
    }, nm.busy ? "Refreshing..." : "Refresh now"));
}

// ---- resizable rail (the splitter between the rail and the config panel) ----

function nmRailWidthPx() {
  return Math.max(180, Math.min(440, userState.nmRailWidth || 240));
}
function nmSetRailWidth(px, persist) {
  userState.nmRailWidth = Math.max(180, Math.min(440, Math.round(px)));
  const md = document.getElementById("nm-config-md");
  if (md) md.style.gridTemplateColumns = `${userState.nmRailWidth}px 8px minmax(0, 1fr)`;
  const sep = document.getElementById("nm-splitter");
  if (sep) sep.setAttribute("aria-valuenow", String(userState.nmRailWidth));
  if (persist) saveUserState();
}
// Track the drag on window so it survives the pointer leaving the handle.
// Pointer capture + a pointercancel teardown guard against a "stuck" drag if the
// matching pointerup is ever lost (alt-tab, OS cancel).
function nmStartRailDrag(e) {
  e.preventDefault();
  const startX = e.clientX;
  const startW = nmRailWidthPx();
  const handle = e.currentTarget;
  try { handle.setPointerCapture(e.pointerId); } catch (_) { /* not fatal */ }
  document.body.classList.add("nm-resizing");
  const onMove = (ev) => nmSetRailWidth(startW + (ev.clientX - startX), false);
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    document.body.classList.remove("nm-resizing");
    try { handle.releasePointerCapture(e.pointerId); } catch (_) { /* already released */ }
    saveUserState();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}
function nmRailKeyResize(e) {
  if (e.key === "ArrowLeft") { e.preventDefault(); nmSetRailWidth(nmRailWidthPx() - 16, true); }
  else if (e.key === "ArrowRight") { e.preventDefault(); nmSetRailWidth(nmRailWidthPx() + 16, true); }
}

// ---- merged Configure view (adapters + profiles, master/detail) ----

// The grouped rail: each present adapter is a header (selectable → live detail)
// with its saved profiles nested beneath; profiles whose target adapter isn't
// present fall into an "Other" group.
function nmConfigRailContent() {
  const children = [];
  const present = nm.adapters.filter((a) => a.status !== "Not Present");
  const byAdapter = new Map();
  for (const p of nm.profiles) {
    const key = p.adapterName || "";
    if (!byAdapter.has(key)) byAdapter.set(key, []);
    byAdapter.get(key).push(p);
  }
  for (const a of present) {
    children.push(nmRailAdapterHeader(a));
    for (const p of (byAdapter.get(a.name) || [])) children.push(nmRailProfileRow(p));
    byAdapter.delete(a.name);
  }
  const others = [];
  for (const ps of byAdapter.values()) others.push(...ps);
  if (others.length) {
    children.push(el("div", { class: "nm-rail-other-head" }, "Other profiles"));
    for (const p of others) children.push(nmRailProfileRow(p));
  }
  if (!children.length) {
    children.push(el("p", { class: "muted small nm-rail-empty" },
      nm.loaded ? "No adapters or profiles yet." : "Reading adapters…"));
  }
  return children;
}

function nmRailAdapterHeader(a) {
  const st = nm.stateByAdapter[a.name];
  const selected = nm.selectedAdapter === a.name;
  return el("div", { class: `nm-rail-adapter ${selected ? "selected" : ""}` },
    el("div", { class: "nm-rail-adapter-head" },
      // The name is the selectable region; Save is a SIBLING (not a nested button),
      // so keyboard Enter/Space on Save can't trigger the adapter selection.
      el("span", {
        class: "nm-rail-adapter-name",
        role: "button",
        tabindex: "0",
        title: a.description || a.name,
        "aria-pressed": selected ? "true" : "false",
        onclick: () => nmSelectAdapter(a.name),
        onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); nmSelectAdapter(a.name); } },
      }, a.name),
      el("button", {
        class: "btn-ghost nm-rail-save",
        title: "Save this adapter as a profile",
        "aria-label": `Save ${a.name} as a profile`,
        disabled: nm.busy ? "disabled" : undefined,
        onclick: () => nmCaptureAdapter(a.name),
      }, "Save"),
    ),
    el("div", { class: "nm-rail-summary" },
      st ? `IPv4 ${nmIpv4Summary(st)} · gw ${st.gateway || "none"}` : (nm.loaded ? "no live state" : "reading…")),
  );
}

// Config panel when a live adapter (not a profile) is selected.
function nmAdapterDetail(a) {
  const st = nm.stateByAdapter[a.name];
  const matching = nm.profiles.filter((p) => p.adapterName === a.name);
  const profilesList = el("div", { class: "nm-rail-list" });
  if (matching.length) for (const p of matching) profilesList.appendChild(nmRailProfileRow(p));
  else profilesList.appendChild(el("p", { class: "muted small" }, "No profiles yet — save this adapter to make one."));

  return el("div", { class: "nm-editor-pane" },
    el("div", { class: "nm-editor-head" },
      el("h3", { class: "nm-editor-title" }, a.name),
      el("div", { class: "nm-editor-actions" },
        el("button", {
          class: "btn btn-primary",
          disabled: nm.busy ? "disabled" : undefined,
          onclick: () => nmCaptureAdapter(a.name),
        }, "Save as profile"),
      ),
    ),
    el("section", { class: "plugin-section" },
      el("h3", {}, "Live adapter"),
      el("p", { class: "muted small" }, a.description || ""),
      el("div", { class: "muted small" }, `Status: ${a.status}`),
      el("div", { class: "muted small" }, st ? `IPv4 ${nmIpv4Summary(st)}` : "No live snapshot — use Refresh adapters."),
      st ? el("div", { class: "muted small" }, `Gateway ${st.gateway || "none"} · DNS ${nmDnsSummary(st)}`) : null,
    ),
    el("section", { class: "plugin-section" },
      el("h3", {}, "Profiles for this adapter"),
      profilesList,
    ),
  );
}

function nmConfigEmpty() {
  return el("div", { class: "nm-editor-pane nm-editor-empty" },
    el("div", { class: "nm-empty" },
      el("p", { class: "nm-empty-title" }, "Select an adapter or profile"),
      el("p", { class: "muted small" },
        "Pick a NIC on the left to see its live config and save it as a profile, or pick a profile to edit and apply it."),
    ),
  );
}

function nmConfigureTab() {
  const railList = el("div", { id: "nm-config-rail", class: "nm-rail-list" }, ...nmConfigRailContent());
  const rail = el("div", { class: "nm-rail" },
    railList,
    el("button", {
      class: "btn btn-primary nm-new-btn",
      disabled: nm.busy ? "disabled" : undefined,
      onclick: nmNew,
    }, "+ New profile"),
  );

  let panel;
  if (nm.selectedAdapter) {
    const a = nm.adapters.find((x) => x.name === nm.selectedAdapter);
    panel = a ? nmAdapterDetail(a) : nmConfigEmpty();
  } else {
    const sel = nmSelected();
    panel = sel ? el("div", { class: "nm-editor-pane" }, ...nmEditorContent(sel)) : nmConfigEmpty();
  }

  const splitter = el("div", {
    id: "nm-splitter",
    class: "nm-splitter",
    role: "separator",
    tabindex: "0",
    "aria-orientation": "vertical",
    "aria-label": "Resize the configuration panel",
    "aria-valuemin": "180",
    "aria-valuemax": "440",
    "aria-valuenow": String(nmRailWidthPx()),
    title: "Drag to resize · double-click to reset",
    onpointerdown: nmStartRailDrag,
    ondblclick: () => nmSetRailWidth(240, true),
    onkeydown: nmRailKeyResize,
  });

  const md = el("div", { id: "nm-config-md", class: "nm-config-md" }, rail, splitter, panel);
  md.style.gridTemplateColumns = `${nmRailWidthPx()}px 8px minmax(0, 1fr)`;

  return el("div", { class: "plugin-controls plugin-controls-fill" },
    el("div", { class: "nm-config-head" },
      el("button", {
        class: "btn-ghost",
        disabled: nm.busy ? "disabled" : undefined,
        onclick: nmRefresh,
      }, nm.busy ? "Reading…" : "Refresh adapters"),
    ),
    md,
  );
}

function renderNetworkManagerPage() {
  nmEnsureLoaded();
  const body = nm.tab === "scan" ? nmScanTab() : nmConfigureTab();
  return el("div", { class: "plugin-controls plugin-controls-fill nm-root" },
    nmTabBar(),
    nmAdapterCacheNotice(),
    body,
  );
}


function flushPendingSave() {
  if (!nmSaveTimer) return Promise.resolve();
  clearTimeout(nmSaveTimer);
  nmSaveTimer = null;
  return nmSaveNow().catch((err) => {
    console.warn("[networkmanager] final profile save failed:", err);
  });
}

function getAdapterSnapshot() {
  return {
    loaded: nm.loaded,
    adapters: nm.adapters,
    stateByAdapter: nm.stateByAdapter,
  };
}

function selectedAdapterName() {
  return nm.selectedAdapter || nmSelected()?.adapterName || nm.scan.adapterName || "";
}

function focusConfigure(adapterName = "") {
  nm.tab = "configure";
  const target = adapterName || nmScanDefaultAdapter();
  if (target) {
    nm.selectedAdapter = target;
    nm.selectedId = null;
  }
  nmSaveUiState();
}

return {
  renderStatusPill: nmStatusPill,
  renderPage: renderNetworkManagerPage,
  ensureLoaded: nmEnsureLoaded,
  applyStartupSnapshot: nmApplyStartupSnapshot,
  loadProfiles: nmLoadProfiles,
  flushPendingSave,
  getAdapterSnapshot,
  maskToPrefix: nmMaskToPrefix,
  scanSubnetFor: nmScanSubnetFor,
  scanDefaultAdapter: nmScanDefaultAdapter,
  refreshAdapters: nmRefresh,
  selectedAdapterName,
  focusConfigure,
};
}
