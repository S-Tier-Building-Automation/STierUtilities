// BACnet Manager — device inbox and import plan (extracted from Building Workspace).
import {
  bwDeviceInboxCandidates,
  bwFindModeledDeviceForBacnet,
  bwImportPlanItems,
  bwModelQueuedDevices,
  bwQueueInboxDevices,
  bwRemoveQueuedDevices,
  bwResolveDeviceConflict,
  bwSetQueuedTargetFloor,
} from "../building-workspace.js";

export function createBacnetInboxUi(deps) {
  const {
    el, logTo, renderAll, renderScoped, userState, saveUserState,
    getInventory, discovery, networkManager, setView, pluginView, currentPluginId,
    breadcrumbItems,
  } = deps;

  function inventoryInstance() {
    return getInventory ? getInventory() : null;
  }

  function bmNormalizeDeviceInboxState(saved = {}) {
    const inbox = saved.deviceInbox && typeof saved.deviceInbox === "object" ? saved.deviceInbox : {};
    const phase = inbox.phase === "modeling" ? "modeling" : "discovery";
    return {
      phase,
      selectedKeys: Array.isArray(inbox.selectedKeys) ? inbox.selectedKeys : [],
      anchorKey: inbox.anchorKey || "",
      filter: typeof inbox.filter === "string" ? inbox.filter : "",
      candidates: inbox.candidates && typeof inbox.candidates === "object" && !Array.isArray(inbox.candidates)
        ? inbox.candidates : {},
      importSiteId: saved.importSiteId || "",
      importBuildingId: saved.importBuildingId || "",
      importFloorId: saved.importFloorId || "",
    };
  }

  function bmStateFromUserState() {
    const saved = userState.bacnetManager || {};
    if (!saved.deviceInbox && userState.buildingWorkspace?.deviceInbox) {
      saved.deviceInbox = userState.buildingWorkspace.deviceInbox;
    }
    const normalized = bmNormalizeDeviceInboxState(saved);
    return {
      deviceInbox: {
        phase: normalized.phase,
        selectedKeys: normalized.selectedKeys,
        anchorKey: normalized.anchorKey,
        filter: normalized.filter,
        candidates: normalized.candidates,
      },
      inboxMenu: null,
      importSiteId: normalized.importSiteId || saved.importSiteId || "",
      importBuildingId: normalized.importBuildingId || saved.importBuildingId || "",
      importFloorId: normalized.importFloorId || saved.importFloorId || "",
      _importTargetFloorId: saved._importTargetFloorId || normalized.importFloorId || "",
    };
  }

  let bm = bmStateFromUserState();

  function saveState() {
    userState.bacnetManager = {
      deviceInbox: bm.deviceInbox,
      importSiteId: bm.importSiteId,
      importBuildingId: bm.importBuildingId,
      importFloorId: bm.importFloorId,
    };
    saveUserState();
  }

  function renderInboxScope() {
    if (currentPluginId() !== "bacnet-manager") {
      renderScoped("bacnet-manager:inbox");
      return;
    }
    bmPatchDeviceInboxLive();
  }

  function bmInboxPathLabel(inv, entity) {
    return entity ? breadcrumbItems(inv, entity).map((item) => item.name || item.id).join(" > ") : "";
  }

function bmBacnetDeviceInstance(device) {
  const n = Number(device?.instance ?? device?.deviceInstance);
  return Number.isFinite(n) ? n : null;
}

function bmModeledDeviceForBacnet(inv, device) {
  if (!inv) return null;
  return bwFindModeledDeviceForBacnet(inv.listEntities({ type: "equip" }), device);
}

function bmDeviceEntityFromBacnet({ site, building, floor, device }) {
  const instance = bmBacnetDeviceInstance(device);
  const ref = discovery.deviceRef(device);
  return {
    type: "equip",
    siteId: site.id,
    buildingId: building.id,
    floorId: floor.id,
    parentId: floor.id,
    name: device.name || `Device ${instance}`,
    deviceInstance: instance,
    deviceRef: { ...ref, deviceInstance: instance },
    address: device.address || "",
    network: device.network ?? null,
    mac: device.mac ?? null,
    vendorId: device.vendorId ?? null,
    vendorName: device.vendorName || "",
    modelName: device.modelName || "",
    tags: { equip: true, device: true, bacnet: true },
  };
}

function bmFilteredDiscoveredDevices() {
  const q = String(bm.deviceInbox?.filter || "").trim().toLowerCase();
  const devices = discovery.getDevices() || [];
  if (!q) return devices;
  return devices.filter((d) =>
    String(d.instance ?? "").includes(q) ||
    (d.name || "").toLowerCase().includes(q) ||
    discovery.addressText(d).toLowerCase().includes(q) ||
    discovery.vendorText(d).toLowerCase().includes(q) ||
    (d.modelName || "").toLowerCase().includes(q));
}

function bmDeviceInboxCandidateList(inv) {
  return bwDeviceInboxCandidates({
    devices: bmFilteredDiscoveredDevices(),
    modeledDevices: inv ? inv.listEntities({ type: "equip" }) : [],
    candidates: bm.deviceInbox?.candidates || {},
  }).filter((c) => c.status !== "ignored");
}

function bmDeviceInboxQueueList(inv) {
  return bwImportPlanItems({
    devices: discovery.getDevices() || [],
    modeledDevices: inv ? inv.listEntities({ type: "equip" }) : [],
    candidates: bm.deviceInbox?.candidates || {},
  });
}

function bmInboxSelectionFor(phase) {
  return bm.deviceInbox?.phase === phase ? (bm.deviceInbox.selectedKeys || []) : [];
}

function bmSetInboxSelection(phase, keys, anchorKey = "") {
  bm.deviceInbox.phase = phase;
  bm.deviceInbox.selectedKeys = [...new Set(keys.filter(Boolean))];
  bm.deviceInbox.anchorKey = anchorKey || bm.deviceInbox.selectedKeys.at(-1) || "";
}

function bmSelectInboxCandidate(phase, item, event = null) {
  if (!item || item.selectable === false) return;
  const inv = inventoryInstance();
  const order = (phase === "modeling" ? bmDeviceInboxQueueList(inv) : bmDeviceInboxCandidateList(inv))
    .filter((c) => c.selectable !== false)
    .map((c) => c.key);
  if (!order.includes(item.key)) return;
  const selected = bmInboxSelectionFor(phase);
  if (event?.shiftKey) {
    const anchor = bm.deviceInbox.anchorKey && order.includes(bm.deviceInbox.anchorKey)
      ? bm.deviceInbox.anchorKey
      : (selected.at(-1) || item.key);
    const a = order.indexOf(anchor);
    const b = order.indexOf(item.key);
    bmSetInboxSelection(phase, a >= 0 && b >= 0 ? order.slice(Math.min(a, b), Math.max(a, b) + 1) : [item.key], item.key);
  } else if (event?.ctrlKey || event?.metaKey) {
    const current = new Set(selected);
    if (current.has(item.key)) current.delete(item.key);
    else current.add(item.key);
    bmSetInboxSelection(phase, [...current], item.key);
  } else {
    bmSetInboxSelection(phase, [item.key], item.key);
  }
  saveState();
  bmSyncInboxSelectionUi();
}

function bmOpenInboxMenu(event, phase, item) {
  event.preventDefault();
  event.stopPropagation();
  if (!item || item.selectable === false) return;
  const selected = bmInboxSelectionFor(phase);
  if (bm.deviceInbox.phase !== phase || !selected.includes(item.key)) {
    bmSetInboxSelection(phase, [item.key], item.key);
  }
  bm.inboxMenu = { x: event.clientX, y: event.clientY, phase, key: item.key, item };
  saveState();
  bmSyncInboxSelectionUi();
  bmRenderInboxMenu();
  bmClampInboxMenu();
}

function bmCloseInboxMenu() {
  if (!bm.inboxMenu) return;
  bm.inboxMenu = null;
  document.querySelector(".bw-inbox-menu")?.remove();
}

function bmClampInboxMenu() {
  setTimeout(() => {
    const menu = document.querySelector(".bw-inbox-menu");
    if (!menu) return;
    const margin = 8;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(margin, Math.min(rect.left, window.innerWidth - rect.width - margin))}px`;
    menu.style.top = `${Math.max(margin, Math.min(rect.top, window.innerHeight - rect.height - margin))}px`;
  }, 0);
}

function bmInboxMenuButton(label, onclick, danger = false) {
  return el("button", {
    class: `bw-menu-item ${danger ? "bw-menu-danger" : ""}`,
    onclick: (e) => {
      e.stopPropagation();
      bm.inboxMenu = null;
      document.querySelector(".bw-inbox-menu")?.remove();
      onclick();
    },
  }, label);
}

function bmListFloors(inv) {
  const floors = [];
  for (const site of inv.listEntities({ type: "site" })) {
    for (const building of inv.listEntities({ type: "building", siteId: site.id })) {
      for (const floor of inv.listEntities({ type: "floor", buildingId: building.id })) {
        floors.push({ site, building, floor });
      }
    }
  }
  return floors;
}

function bmFloorSelectOptions(inv, selectedId = "") {
  const options = [el("option", { value: "" }, "Choose floor…")];
  for (const { site, building, floor } of bmListFloors(inv)) {
    options.push(el("option", {
      value: floor.id,
      selected: floor.id === selectedId ? "selected" : undefined,
    }, `${site.name} / ${building.name} / ${floor.name}`));
  }
  return options;
}

function bmApplyQueuedTargetFloor(floorId, keys = null) {
  const inv = inventoryInstance();
  if (!inv || !floorId) return;
  const selected = keys || bmInboxSelectionFor("modeling");
  bm.deviceInbox.candidates = bwSetQueuedTargetFloor(
    bm.deviceInbox.candidates || {},
    selected.length ? selected : null,
    floorId,
  );
  const floor = inv.getEntity(floorId);
  logTo("bacnet-manager", `Set import target to ${floor?.name || floorId} for ${selected.length || "all queued"} device(s).`, "ok");
  saveState();
  renderInboxScope();
}

function bmUpdateDeviceBinding(item) {
  const inv = inventoryInstance();
  if (!inv || !item?.device || !item?.modeledDevice) return;
  const points = inv.listEntities({ type: "point" }).filter(
    (p) => Number(p.deviceInstance) === Number(item.modeledDevice.deviceInstance),
  );
  const { updated } = bwResolveDeviceConflict({
    action: "replace",
    modeledDevice: item.modeledDevice,
    device: item.device,
    points,
  });
  if (!updated.length) {
    logTo("bacnet-manager", "No binding changes were applied.", "warn");
    return;
  }
  for (const entity of updated) inv.upsertEntity(entity);
  saveState();
  logTo("bacnet-manager",
    `Updated binding for ${item.modeledDevice.name || item.modeledDevice.id} from latest discovery.`,
    "ok");
  renderInboxScope();
}

function bmDriftMissingEl() {
  const missing = discovery.getDriftMissing?.() || [];
  if (!missing.length) return null;
  const labels = missing.slice(0, 5).map((d) => d.instance ?? d.key).join(", ");
  const suffix = missing.length > 5 ? ` (+${missing.length - 5} more)` : "";
  return el("p", {
    class: "muted small bw-drift-missing",
    title: "Devices seen in the previous scan but not in the latest discovery",
  }, `${missing.length} missing since last scan: ${labels}${suffix}`);
}

function bmInboxContextMenu(inv, floor = null) {
  const menu = bm.inboxMenu;
  if (!menu) return null;
  const selected = bmInboxSelectionFor(menu.phase);
  const selectedCount = selected.length || 1;
  const items = [];
  if (menu.phase === "discovery") {
    const item = menu.item;
    if (item?.status === "changed" && item.modeledDevice) {
      items.push(bmInboxMenuButton("Update binding from discovery", () => bmUpdateDeviceBinding(item)));
    }
    if (item?.queueable !== false) {
      items.push(bmInboxMenuButton(`Add ${selectedCount} to Import Plan`, bmQueueSelectedInboxDevices));
    }
    items.push(bmInboxMenuButton(`Ignore ${selectedCount}`, bmIgnoreSelectedInboxDevices, true));
  } else {
    if (floor) items.push(bmInboxMenuButton(selectedCount > 1 ? `Add selected to ${floor.name}` : `Add to ${floor.name}`, () => bmModelQueuedDevicesToFloor(floor.id)));
    items.push(bmInboxMenuButton("Remove from Import Plan", () => bmRemoveQueuedInboxDevices(), true));
  }
  return el("div", {
    class: "bw-context-menu bw-inbox-menu",
    style: `left:${menu.x}px; top:${menu.y}px`,
    onclick: (e) => e.stopPropagation(),
  }, ...items);
}

function bmRenderInboxMenu() {
  document.querySelector(".bw-inbox-menu")?.remove();
  const inv = inventoryInstance();
  if (!inv || !bm.inboxMenu) return;
  const menu = bmInboxContextMenu(inv, bmCurrentFloorForInbox(inv));
  if (menu) document.body.appendChild(menu);
}

function bmSyncInboxSelectionUi() {
  const selected = new Set(bm.deviceInbox?.selectedKeys || []);
  const phase = bm.deviceInbox?.phase || "discovery";
  document.querySelectorAll("[data-bw-inbox-key]").forEach((row) => {
    const on = row.dataset.bwInboxPhase === phase && selected.has(row.dataset.bwInboxKey);
    row.classList.toggle("bw-inbox-row-selected", on);
    row.setAttribute("aria-selected", on ? "true" : "false");
  });
  const queue = document.getElementById("bw-inbox-queue-selected");
  if (queue) queue.disabled = phase !== "discovery" || selected.size === 0;
  const ignore = document.getElementById("bw-inbox-ignore-selected");
  if (ignore) ignore.disabled = phase !== "discovery" || selected.size === 0;
  const remove = document.getElementById("bw-inbox-remove-queued");
  if (remove) remove.disabled = phase !== "modeling" || selected.size === 0;
  const add = document.getElementById("bw-inbox-model-selected");
  if (add) {
    const queuedCount = Number(add.dataset.queuedCount || 0);
    const hasFloor = Boolean(add.dataset.floorId);
    const hasPerRow = add.dataset.hasPerRowTargets === "1";
    add.disabled = queuedCount === 0 || (!hasFloor && !hasPerRow) ? "disabled" : undefined;
  }
  const updateBinding = document.getElementById("bw-inbox-update-binding");
  if (updateBinding) updateBinding.disabled = phase !== "discovery" || selected.size === 0 ? "disabled" : undefined;
}

function bmApplyDeviceInboxFilter() {
  saveState();
  const inv = inventoryInstance();
  const body = document.getElementById("bw-discovered-device-rows");
  if (!inv || !body) return;
  body.replaceChildren(...bmDiscoveredDeviceRows(inv));
  bmSyncInboxSelectionUi();
}

function bmDiscoveryDragAttrs(item, canDrag) {
  if (!canDrag) return {};
  return {
    draggable: "true",
    title: "Drag to Import Plan",
    ondragstart: (e) => bmDragDiscoveryDevices(item, e),
    ondragend: () => { bmInboxDragKeys = []; },
  };
}

function bmQueueSelectedInboxDevices() {
  const inv = inventoryInstance();
  if (!inv) return;
  const selected = bmInboxSelectionFor("discovery");
  const floor = bmCurrentFloorForInbox(inv);
  bm.deviceInbox.candidates = bwQueueInboxDevices({
    candidates: bm.deviceInbox.candidates || {},
    keys: selected,
    devices: discovery.getDevices() || [],
    modeledDevices: inv.listEntities({ type: "equip" }),
    targetFloorId: floor?.id || "",
  });
  const queued = selected.filter((key) => bm.deviceInbox.candidates[key]?.status === "queued");
  bmSetInboxSelection("modeling", queued, queued.at(-1) || "");
  logTo("bacnet-manager", `Queued ${queued.length} device${queued.length === 1 ? "" : "s"} for modeling.`, queued.length ? "ok" : "warn");
  saveState();
  renderInboxScope();
}

let bmInboxDragKeys = [];

function bmDragDiscoveryDevices(item, event) {
  const selected = bmInboxSelectionFor("discovery");
  const keys = bm.deviceInbox.phase === "discovery" && selected.includes(item.key) ? selected : [item.key];
  bmSetInboxSelection("discovery", keys, item.key);
  bm.inboxMenu = null;
  bmInboxDragKeys = keys;
  event.stopPropagation();
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData("application/x-stier-bacnet-device-keys", JSON.stringify(keys));
  event.dataTransfer.setData("text/plain", keys.join(","));
  bmSyncInboxSelectionUi();
}

function bmImportPlanDragOver(event) {
  const types = Array.from(event.dataTransfer.types || []);
  if (!bmInboxDragKeys.length && !types.includes("application/x-stier-bacnet-device-keys") && !types.includes("text/plain")) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  event.currentTarget.classList.add("bw-import-plan-drop");
}

function bmImportPlanDragLeave(event) {
  event.currentTarget.classList.remove("bw-import-plan-drop");
}

function bmImportPlanDrop(event) {
  event.preventDefault();
  event.currentTarget.classList.remove("bw-import-plan-drop");
  const raw = event.dataTransfer.getData("application/x-stier-bacnet-device-keys");
  try {
    const keys = raw ? JSON.parse(raw) : bmInboxDragKeys;
    if (Array.isArray(keys) && keys.length) {
      bmSetInboxSelection("discovery", keys, keys.at(-1));
      bmQueueSelectedInboxDevices();
    }
  } catch (_) {
    // Ignore malformed drag payloads from outside the app.
  } finally {
    bmInboxDragKeys = [];
  }
}

function bmIgnoreSelectedInboxDevices() {
  const selected = bmInboxSelectionFor("discovery");
  if (!selected.length) return;
  const next = { ...(bm.deviceInbox.candidates || {}) };
  for (const key of selected) {
    next[key] = {
      ...(next[key] || {}),
      key,
      status: "ignored",
      discoveredAt: next[key]?.discoveredAt || new Date().toISOString(),
    };
  }
  bm.deviceInbox.candidates = next;
  bmSetInboxSelection("discovery", []);
  saveState();
  renderInboxScope();
}

function bmRemoveQueuedInboxDevices(keys = bmInboxSelectionFor("modeling")) {
  bm.deviceInbox.candidates = bwRemoveQueuedDevices(bm.deviceInbox.candidates || {}, keys);
  bmSetInboxSelection("modeling", []);
  saveState();
  renderInboxScope();
}

function bmClearDeviceDiscovery() {
  discovery.clearDiscovery();
  bm.deviceInbox.candidates = {};
  bmSetInboxSelection("discovery", []);
  saveState();
  renderInboxScope();
}

function bmModelQueuedDevicesToFloor(floorId, keys = null) {
  const inv = inventoryInstance();
  if (!inv) return;
  const floor = floorId ? inv.getEntity(floorId) : bmCurrentFloorForInbox(inv);
  const building = floor ? inv.getEntity(floor.buildingId || floor.parentId) : null;
  const site = building ? inv.getEntity(floor.siteId || building?.siteId) : null;
  const selectedKeys = Array.isArray(keys)
    ? keys
    : (bm.deviceInbox.phase === "modeling" ? bmInboxSelectionFor("modeling") : []);
  const modelKeys = selectedKeys.length
    ? selectedKeys
    : Object.values(bm.deviceInbox.candidates || {}).filter((c) => c?.status === "queued").map((c) => c.key);
  const result = bwModelQueuedDevices({
    inventory: inv,
    devices: discovery.getDevices() || [],
    candidates: bm.deviceInbox.candidates || {},
    floor: floor || null,
    site: site || null,
    building: building || null,
    makeEntity: bmDeviceEntityFromBacnet,
    keys: modelKeys,
  });
  bm.deviceInbox.candidates = result.candidates;
  const imported = result.imported || [];
  bmSetInboxSelection("modeling", []);
  saveState();
  const targetNames = [...new Set(imported.map((d) => inv.getEntity(d.floorId)?.name).filter(Boolean))];
  const where = targetNames.length ? ` on ${targetNames.join(", ")}` : "";
  logTo("bacnet-manager",
    `Added ${imported.length} queued device${imported.length === 1 ? "" : "s"}${where}.${result.skipped ? ` Skipped ${result.skipped}.` : ""}`,
    imported.length ? "ok" : "warn");
  renderInboxScope();
}

function bmImportDiscoveredDevicesToFloor(floorId, keys = null) {
  const inv = inventoryInstance();
  if (!inv) return;
  const importKeys = Array.isArray(keys) && keys.length ? keys : bmInboxSelectionFor("discovery");
  bm.deviceInbox.candidates = bwQueueInboxDevices({
    candidates: bm.deviceInbox.candidates || {},
    keys: importKeys,
    devices: discovery.getDevices() || [],
    modeledDevices: inv.listEntities({ type: "equip" }),
    targetFloorId: floorId,
  });
  bmModelQueuedDevicesToFloor(floorId, importKeys);
}

function bmCurrentFloorForInbox(inv) {
  if (!inv) return null;
  if (bm.importFloorId) {
    const floor = inv.getEntity(bm.importFloorId);
    if (floor?.type === "floor") return floor;
  }
  return null;
}

function openAdapterSelection(adapterName = "") {
  networkManager.focusConfigure(adapterName || networkManager.selectedAdapterName() || networkManager.scanDefaultAdapter());
  setView(pluginView("networkmanager"));
}

async function bmDiscoverDevices() {
  const target = discovery.adapterTarget();
  if (target) discovery.setTarget(target.value);
  await discovery.discover();
}

function bmDeviceInboxEmptyMessage() {
  if (discovery.isDiscovering()) return "Listening for I-Am replies...";
  if (discovery.getDiscoveryRan() && discovery.getLastDiscoveryCount() === 0) {
    const selectedAdapter = networkManager.selectedAdapterName();
    const subnet = selectedAdapter ? networkManager.scanSubnetFor(selectedAdapter) : null;
    const target = discovery.adapterTarget(selectedAdapter);
    const { loaded: nmLoaded } = networkManager.getAdapterSnapshot();
    const adapterMessage = !nmLoaded
      ? "Network adapters have not been read yet. Open Network Manager to verify the active BAS/NIC adapter."
      : !selectedAdapter
        ? "No Network Manager adapter is selected. Choose the active BAS/NIC adapter, then run discovery again."
        : !subnet
          ? `${selectedAdapter} is selected, but it does not have a usable IPv4 subnet. Check its IP configuration or choose another adapter.`
          : `${selectedAdapter} is selected (${subnet.label}). Tried ${target?.label || discovery.getTarget()}. Check VPN/firewall rules, BBMD/foreign-device routing, or try a known device IP directly.`;
    return el("div", { class: "bw-empty-action" },
      el("span", {}, `Discovery finished with no BACnet devices found. ${adapterMessage}`),
      el("button", { class: "btn-ghost", onclick: () => openAdapterSelection(selectedAdapter) }, "Open adapter selection"));
  }
  return "No discovered devices yet. Run discovery to populate the inbox.";
}

function renderDeviceInboxLive() {
  const inv = inventoryInstance();
  const node = document.getElementById("bw-device-inbox");
  if (!inv || !node) return;
  node.replaceWith(bmDeviceInbox(inv, bmCurrentFloorForInbox(inv)));
}

function bmInboxScrollState() {
  return [...document.querySelectorAll("#bw-device-inbox .bw-device-inbox-scroll")]
    .map((node, index) => ({ index, top: node.scrollTop, left: node.scrollLeft }));
}

function bmRestoreInboxScrollState(state) {
  for (const item of state || []) {
    const node = document.querySelectorAll("#bw-device-inbox .bw-device-inbox-scroll")[item.index];
    if (!node) continue;
    node.scrollTop = item.top;
    node.scrollLeft = item.left;
  }
}

function bmPatchDeviceInboxLive() {
  const inv = inventoryInstance();
  const inbox = document.getElementById("bw-device-inbox");
  if (!inv || !inbox) {
    renderDeviceInboxLive();
    return;
  }
  const floor = bmCurrentFloorForInbox(inv);
  const discovered = bmDeviceInboxCandidateList(inv);
  const queued = bmDeviceInboxQueueList(inv);
  const discoverySelected = bmInboxSelectionFor("discovery").length;
  const modelingSelected = bmInboxSelectionFor("modeling").length;
  const scrollState = bmInboxScrollState();

  document.getElementById("bw-discovered-device-rows")?.replaceChildren(...bmDiscoveredDeviceRows(inv));
  document.getElementById("bw-modeling-queue-rows")?.replaceChildren(...bmModelingQueueRows(inv, floor));

  const count = document.getElementById("bw-device-inbox-count");
  if (count) count.textContent = discovery.isDiscovering() ? "Discovering..." : `${discovered.length} shown · ${queued.length} queued`;
  const ignore = document.getElementById("bw-inbox-ignore-selected");
  if (ignore) ignore.disabled = discoverySelected ? false : true;
  const clear = document.getElementById("bw-inbox-clear");
  if (clear) clear.disabled = discovery.getDevices().length || queued.length ? false : true;
  const model = document.getElementById("bw-inbox-model-selected");
  if (model) {
    model.dataset.floorId = floor?.id || "";
    model.dataset.queuedCount = String(queued.length);
    model.disabled = floor && queued.length ? false : true;
    model.textContent = floor ? (modelingSelected ? `Add selected to ${floor.name}` : `Add queue to ${floor.name}`) : "Select a floor";
  }
  const remove = document.getElementById("bw-inbox-remove-queued");
  if (remove) remove.disabled = modelingSelected ? false : true;
  bmSyncInboxSelectionUi();
  bmRestoreInboxScrollState(scrollState);
  requestAnimationFrame(() => bmRestoreInboxScrollState(scrollState));
}

function bmInboxStatusLabel(inv, item, floor = null) {
  const existing = item.modeledDevice;
  if (item.status === "queued") return "Queued";
  if (item.status === "changed") return "Changed";
  if (item.status === "conflict") return item.conflict || "Conflict";
  if (existing) {
    const existingFloor = inv.getEntity(existing.floorId || existing.parentId);
    return existing.floorId === floor?.id ? "Modeled here" : `Modeled on ${existingFloor?.name || "another floor"}`;
  }
  return "New";
}

function bmInboxStatusClass(status) {
  if (status === "new") return "pill-running";
  if (status === "queued") return "pill-info";
  if (status === "changed") return "pill-warn";
  if (status === "conflict") return "pill-error";
  return "pill-muted";
}

function bmDiscoveredDeviceRows(inv) {
  const items = bmDeviceInboxCandidateList(inv);
  const floor = bmCurrentFloorForInbox(inv);
  const selected = new Set(bmInboxSelectionFor("discovery"));
  const rows = items.map((item) => {
    const device = item.device;
    const canDrag = item.selectable !== false;
    const dragAttrs = bmDiscoveryDragAttrs(item, canDrag);
    return el("tr", {
      class: `bw-inbox-row ${selected.has(item.key) ? "bw-inbox-row-selected" : ""} ${item.selectable === false ? "bw-inbox-row-disabled" : ""}`,
      "data-bw-inbox-key": item.key,
      "data-bw-inbox-phase": "discovery",
      "aria-selected": selected.has(item.key) ? "true" : "false",
      ...dragAttrs,
      onclick: (e) => bmSelectInboxCandidate("discovery", item, e),
      oncontextmenu: (e) => bmOpenInboxMenu(e, "discovery", item),
    },
      el("td", { class: "bac-num", ...dragAttrs }, String(device.instance ?? "")),
      el("td", { ...dragAttrs }, device.name || el("span", { class: "muted" }, "Unnamed")),
      el("td", { class: "bac-mono", ...dragAttrs }, discovery.addressText(device)),
      el("td", { ...dragAttrs }, discovery.vendorText(device) || el("span", { class: "muted" }, "-")),
      el("td", { ...dragAttrs }, device.modelName || el("span", { class: "muted" }, "-")),
      el("td", { ...dragAttrs }, el("span", { class: "bw-inbox-status-cell" },
        el("span", { class: `pill ${bmInboxStatusClass(item.status)}` }, bmInboxStatusLabel(inv, item, floor)),
        discovery.deviceDriftBadge?.(device) || null)),
    );
  });
  return rows.length ? rows : [el("tr", {}, el("td", { class: "muted small", colspan: "6" }, bmDeviceInboxEmptyMessage()))];
}

function bmModelingQueueRows(inv, floor = null) {
  const items = bmDeviceInboxQueueList(inv);
  const selected = new Set(bmInboxSelectionFor("modeling"));
  const rows = items.map((item) => {
    const device = item.device;
    const targetFloor = inv.getEntity(item.candidate?.targetFloorId || floor?.id);
    const instance = device ? String(device.instance ?? "") : item.key.replace(/^bacnet-device:/, "");
    const match = item.modeledDevice ? bmInboxPathLabel(inv, item.modeledDevice) : (item.conflict || "");
    return el("tr", {
      class: `bw-inbox-row ${selected.has(item.key) ? "bw-inbox-row-selected" : ""}`,
      "data-bw-inbox-key": item.key,
      "data-bw-inbox-phase": "modeling",
      "aria-selected": selected.has(item.key) ? "true" : "false",
      onclick: (e) => bmSelectInboxCandidate("modeling", item, e),
      oncontextmenu: (e) => bmOpenInboxMenu(e, "modeling", item),
    },
      el("td", {}, item.proposedName || device?.name || "Unnamed"),
      el("td", { class: "bac-num" }, instance),
      el("td", { class: "bac-mono" }, device ? discovery.addressText(device) : "not in current discovery"),
      el("td", {}, device ? discovery.vendorText(device) || "-" : "-"),
      el("td", {}, device?.modelName || "-"),
      el("td", {}, targetFloor?.name || "Selected floor"),
      el("td", {}, match || el("span", { class: "muted" }, "-")),
      el("td", {}, item.action === "skip" ? "Skip" : "Add"),
      el("td", {}, el("span", { class: `pill ${bmInboxStatusClass(item.status)}` }, bmInboxStatusLabel(inv, item, floor))));
  });
  return rows.length ? rows : [el("tr", {}, el("td", { class: "muted small", colspan: "9" }, "No queued devices. Highlight discovered rows and queue them for modeling."))];
}

function bmDeviceInbox(inv, floor = null) {
  const discovered = bmDeviceInboxCandidateList(inv);
  const queued = bmDeviceInboxQueueList(inv);
  const discoverySelectedKeys = bmInboxSelectionFor("discovery");
  const discoverySelected = discoverySelectedKeys.length;
  const modelingSelected = bmInboxSelectionFor("modeling").length;
  const selectedDiscoveryItems = discovered.filter((item) => discoverySelectedKeys.includes(item.key));
  const canUpdateBinding = selectedDiscoveryItems.some((item) => item.status === "changed" && item.modeledDevice);
  const adapterTarget = discovery.adapterTarget();
  const hasPerRowTargets = queued.some((item) => item.candidate?.targetFloorId);
  const canModel = queued.length > 0 && (floor || hasPerRowTargets);
  return el("div", {
    id: "bw-device-inbox",
    class: "bw-device-inbox",
    onclick: () => { if (bm.inboxMenu) bmCloseInboxMenu(); },
  },
    el("div", { class: "bw-inbox-grid" },
    el("div", { class: "bw-inbox-stage bw-inbox-stage-discovery" },
      el("div", { class: "section-head bw-inbox-stage-head" },
        el("h4", {}, "BACnet Device Inbox"),
        el("span", { id: "bw-device-inbox-count", class: "muted small" },
          discovery.isDiscovering() ? "Discovering..." : `${discovered.length} shown · ${queued.length} queued`,
          discovery.driftSummaryEl?.() || null)),
      bmDriftMissingEl(),
      adapterTarget
        ? el("p", { class: "muted small bw-inbox-target" }, `Discovery target: ${adapterTarget.label}`)
        : null,
      discovery.isDiscovering() ? discovery.discoveryProgressEl("bw-discovery-progress") : null,
      el("div", { class: "tool-actions" },
        el("button", {
          class: "btn btn-primary",
          disabled: discovery.isDiscovering() ? "disabled" : undefined,
          onclick: bmDiscoverDevices,
        }, discovery.isDiscovering() ? "Discovering..." : "Discover devices"),
        el("button", {
          id: "bw-inbox-ignore-selected",
          class: "btn-ghost",
          disabled: discoverySelected ? undefined : "disabled",
          onclick: bmIgnoreSelectedInboxDevices,
        }, "Ignore"),
        el("button", {
          id: "bw-inbox-update-binding",
          class: "btn-ghost",
          disabled: canUpdateBinding ? undefined : "disabled",
          onclick: () => {
            for (const item of selectedDiscoveryItems) {
              if (item.status === "changed" && item.modeledDevice) bmUpdateDeviceBinding(item);
            }
          },
        }, "Update binding"),
        el("button", { id: "bw-inbox-clear", class: "btn-ghost", disabled: discovery.getDevices().length || queued.length ? undefined : "disabled", onclick: bmClearDeviceDiscovery }, "Clear")),
      el("input", {
        class: "nm-input bw-device-filter",
        placeholder: "Filter by instance, name, address, vendor, model",
        value: bm.deviceInbox?.filter || "",
        oninput: (e) => { bm.deviceInbox.filter = e.target.value; bmApplyDeviceInboxFilter(); },
      }),
      el("div", { class: "bw-device-inbox-scroll" },
        el("table", { class: "bac-table bw-device-inbox-table bw-discovery-table" },
          el("thead", {}, el("tr", {},
            el("th", {}, "Instance"),
            el("th", {}, "Name"),
            el("th", {}, "Address"),
            el("th", {}, "Vendor"),
            el("th", {}, "Model"),
            el("th", {}, "Status"))),
          el("tbody", { id: "bw-discovered-device-rows" }, ...bmDiscoveredDeviceRows(inv))))),
    el("div", { class: "bw-inbox-stage bw-inbox-stage-queue" },
      el("div", { class: "section-head bw-inbox-stage-head" },
        el("h4", {}, "Import Plan"),
        el("span", { class: "muted small" }, floor
          ? `Default target: ${floor.name}${hasPerRowTargets ? " · some rows have custom targets" : ""}`
          : hasPerRowTargets ? "Using per-row target floors" : "Select a floor or assign targets below")),
      el("div", { class: "tool-actions bw-import-plan-actions" },
      el("select", {
        class: "nm-input bw-import-target-select",
        onchange: (e) => {
          bm.importFloorId = e.target.value;
          bm._importTargetFloorId = e.target.value;
          saveState();
          renderInboxScope();
        },
      }, ...bmFloorSelectOptions(inv, bm.importFloorId || bm._importTargetFloorId || floor?.id || "")),
        el("button", {
          class: "btn-ghost",
          disabled: modelingSelected ? undefined : "disabled",
          onclick: () => bmApplyQueuedTargetFloor(bm._importTargetFloorId),
        }, "Set target for selected"),
        el("button", {
          id: "bw-inbox-model-selected",
          class: "btn-ghost",
          "data-floor-id": floor?.id || "",
          "data-queued-count": String(queued.length),
          "data-has-per-row-targets": hasPerRowTargets ? "1" : "0",
          disabled: canModel ? undefined : "disabled",
          onclick: () => bmModelQueuedDevicesToFloor(floor?.id || null),
        }, floor
          ? (modelingSelected ? `Add selected to ${floor.name}` : `Add queue to ${floor.name}`)
          : (hasPerRowTargets ? "Add queue (per-row targets)" : "Select a floor")),
        el("button", {
          id: "bw-inbox-remove-queued",
          class: "btn-ghost",
          disabled: modelingSelected ? undefined : "disabled",
          onclick: () => bmRemoveQueuedInboxDevices(),
        }, "Remove from queue")),
      el("div", {
        class: "bw-device-inbox-scroll bw-queue-scroll bw-import-plan-dropzone",
        ondragover: bmImportPlanDragOver,
        ondragleave: bmImportPlanDragLeave,
        ondrop: bmImportPlanDrop,
      },
        el("table", { class: "bac-table bw-device-inbox-table bw-import-plan-table" },
          el("thead", {}, el("tr", {},
            el("th", {}, "Proposed Equip"),
            el("th", {}, "Instance"),
            el("th", {}, "Address"),
            el("th", {}, "Vendor"),
            el("th", {}, "Model"),
            el("th", {}, "Target"),
            el("th", {}, "Match / Issue"),
            el("th", {}, "Action"),
            el("th", {}, "Status"))),
          el("tbody", { id: "bw-modeling-queue-rows" }, ...bmModelingQueueRows(inv, floor)))))),
    bmInboxContextMenu(inv, floor));
}

  return {
    restoreState: () => { bm = bmStateFromUserState(); },
    renderDeviceInbox: (inv) => bmDeviceInbox(inv, bmCurrentFloorForInbox(inv)),
    renderDeviceInboxLive,
    patchDeviceInboxLive: bmPatchDeviceInboxLive,
    renderInboxScope,
    getInboxQueuedCount: () => Object.values(bm.deviceInbox?.candidates || {}).filter((c) => c?.status === "queued").length,
    discoverDevices: bmDiscoverDevices,
  };
}
