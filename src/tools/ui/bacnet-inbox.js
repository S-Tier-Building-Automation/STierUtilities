// BACnet Manager — device list panel (inventory status + import actions).
import {
  bwDeviceInboxCandidates,
  bwImportDevicesToFloor,
  bwResolveDeviceConflict,
} from "../building-workspace.js";

export function createBacnetInboxUi(deps) {
  const {
    el, logTo, renderScoped, renderAll, userState, saveUserState,
    getInventory, discovery, networkManager, setView, pluginView, currentPluginId,
    breadcrumbItems, selectDeviceForBrowse, getBrowseDeviceKey,
    getDeviceFilter, setDeviceFilter, onCopyDevices, onExportDevices,
  } = deps;

  function inventoryInstance() {
    return getInventory ? getInventory() : null;
  }

  function bmStripQueuedCandidates(candidates = {}) {
    const next = {};
    for (const [key, candidate] of Object.entries(candidates)) {
      if (candidate?.status === "queued") continue;
      next[key] = candidate;
    }
    return next;
  }

  function bmNormalizeDeviceInboxState(saved = {}) {
    const inbox = saved.deviceInbox && typeof saved.deviceInbox === "object" ? saved.deviceInbox : {};
    const rawCandidates = inbox.candidates && typeof inbox.candidates === "object" && !Array.isArray(inbox.candidates)
      ? inbox.candidates : {};
    return {
      selectedKeys: Array.isArray(inbox.selectedKeys) ? inbox.selectedKeys : [],
      anchorKey: inbox.anchorKey || "",
      candidates: bmStripQueuedCandidates(rawCandidates),
      importSiteId: saved.importSiteId || "",
      importBuildingId: saved.importBuildingId || "",
      importFloorId: saved.importFloorId || "",
      legacyFilter: typeof inbox.filter === "string" ? inbox.filter : "",
    };
  }

  function bmNormalizeInboxView(saved = {}) {
    const view = saved && typeof saved === "object" ? saved : {};
    const sortKey = ["instance", "name", "address"].includes(view.sortKey) ? view.sortKey : "instance";
    const sortDir = view.sortDir === "desc" ? "desc" : "asc";
    return { sortKey, sortDir, groupByNetwork: view.groupByNetwork !== false };
  }

  function bmStateFromUserState() {
    const saved = userState.bacnetManager || {};
    if (!saved.deviceInbox && userState.buildingWorkspace?.deviceInbox) {
      saved.deviceInbox = userState.buildingWorkspace.deviceInbox;
    }
    const normalized = bmNormalizeDeviceInboxState(saved);
    return {
      deviceInbox: {
        selectedKeys: normalized.selectedKeys,
        anchorKey: normalized.anchorKey,
        candidates: normalized.candidates,
      },
      inboxMenu: null,
      importSiteId: normalized.importSiteId || saved.importSiteId || "",
      importBuildingId: normalized.importBuildingId || saved.importBuildingId || "",
      importFloorId: normalized.importFloorId || saved.importFloorId || "",
      legacyFilter: normalized.legacyFilter,
      view: bmNormalizeInboxView(saved.inboxView),
    };
  }

  let bm = bmStateFromUserState();

  function saveState() {
    userState.bacnetManager = {
      ...(userState.bacnetManager || {}),
      deviceInbox: bm.deviceInbox,
      importSiteId: bm.importSiteId,
      importBuildingId: bm.importBuildingId,
      importFloorId: bm.importFloorId,
      inboxView: bm.view,
    };
    saveUserState();
  }

  function renderDevicesScope() {
    if (currentPluginId() !== "bacnet-manager") {
      renderScoped("bacnet-manager:devices");
      return;
    }
    bmPatchDevicePanelLive();
  }

  function bmInboxPathLabel(inv, entity) {
    return inv && entity ? breadcrumbItems(inv, entity).map((item) => item.name || item.id).join(" > ") : "";
  }

  function bmBacnetDeviceInstance(device) {
    const n = Number(device?.instance ?? device?.deviceInstance);
    return Number.isFinite(n) ? n : null;
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
    const q = String(getDeviceFilter?.() || "").trim().toLowerCase();
    const devices = discovery.getDevices() || [];
    if (!q) return devices;
    return devices.filter((d) =>
      String(d.instance ?? "").includes(q) ||
      (d.name || "").toLowerCase().includes(q) ||
      discovery.addressText(d).toLowerCase().includes(q) ||
      discovery.vendorText(d).toLowerCase().includes(q) ||
      (d.modelName || "").toLowerCase().includes(q));
  }

  // Network bucket used both for grouping and as the primary sort key when
  // grouping is on. Local (no routing) sorts first; routed networks ascend.
  function bmDeviceNetwork(device) {
    const n = Number(device?.network);
    return Number.isFinite(n) ? n : -1;
  }

  function bmCompareCandidates(a, b) {
    const da = a.device || {}, db = b.device || {};
    if (bm.view.groupByNetwork) {
      const na = bmDeviceNetwork(da), nb = bmDeviceNetwork(db);
      if (na !== nb) return na - nb;
    }
    const dir = bm.view.sortDir === "desc" ? -1 : 1;
    let r;
    if (bm.view.sortKey === "name") {
      // Keep unnamed devices at the bottom regardless of sort direction.
      const an = (da.name || "").trim(), bn = (db.name || "").trim();
      if (!an !== !bn) return an ? -1 : 1;
      r = an.localeCompare(bn, undefined, { sensitivity: "base" });
    } else if (bm.view.sortKey === "address") {
      r = String(da.address || "").localeCompare(String(db.address || ""), undefined, { numeric: true });
    } else {
      r = (Number(da.instance) || 0) - (Number(db.instance) || 0);
    }
    if (r === 0) r = (Number(da.instance) || 0) - (Number(db.instance) || 0);
    return r * dir;
  }

  function bmDeviceInboxCandidateList(inv) {
    return bwDeviceInboxCandidates({
      devices: bmFilteredDiscoveredDevices(),
      modeledDevices: inv ? inv.listEntities({ type: "equip" }) : [],
      candidates: bm.deviceInbox?.candidates || {},
    }).filter((c) => c.status !== "ignored").sort(bmCompareCandidates);
  }

  function bmSetSort(key) {
    if (bm.view.sortKey === key) {
      bm.view.sortDir = bm.view.sortDir === "asc" ? "desc" : "asc";
    } else {
      bm.view.sortKey = key;
      bm.view.sortDir = "asc";
    }
    saveState();
    renderAll?.();
  }

  function bmToggleGroupByNetwork() {
    bm.view.groupByNetwork = !bm.view.groupByNetwork;
    saveState();
    renderAll?.();
  }

  function bmInboxSelection() {
    return bm.deviceInbox?.selectedKeys || [];
  }

  function bmSetInboxSelection(keys, anchorKey = "") {
    bm.deviceInbox.selectedKeys = [...new Set(keys.filter(Boolean))];
    bm.deviceInbox.anchorKey = anchorKey || bm.deviceInbox.selectedKeys.at(-1) || "";
  }

  function bmSelectInboxCandidate(item, event = null) {
    if (!item) return;
    const inv = inventoryInstance();
    if (event?.shiftKey || event?.ctrlKey || event?.metaKey) {
      if (item.selectable === false) return;
      const order = bmDeviceInboxCandidateList(inv)
        .filter((c) => c.selectable !== false)
        .map((c) => c.key);
      if (!order.includes(item.key)) return;
      const selected = bmInboxSelection();
      if (event.shiftKey) {
        const anchor = bm.deviceInbox.anchorKey && order.includes(bm.deviceInbox.anchorKey)
          ? bm.deviceInbox.anchorKey
          : (selected.at(-1) || item.key);
        const a = order.indexOf(anchor);
        const b = order.indexOf(item.key);
        bmSetInboxSelection(a >= 0 && b >= 0 ? order.slice(Math.min(a, b), Math.max(a, b) + 1) : [item.key], item.key);
      } else {
        const current = new Set(selected);
        if (current.has(item.key)) current.delete(item.key);
        else current.add(item.key);
        bmSetInboxSelection([...current], item.key);
      }
      saveState();
      bmSyncDevicePanelUi();
      return;
    }
    selectDeviceForBrowse?.(item.key);
    if (item.selectable !== false) {
      bmSetInboxSelection([item.key], item.key);
    } else {
      bmSetInboxSelection([], "");
    }
    saveState();
    bmSyncDevicePanelUi();
  }

  // Close the context menu on any outside pointer-down or Escape, no matter
  // where on the page it happens (the panel-level onclick alone missed clicks
  // landing on the browse pane or chrome).
  function bmInboxMenuDocHandler(e) {
    if (e.type === "keydown") {
      if (e.key === "Escape") { e.preventDefault(); bmCloseInboxMenu(); }
      return;
    }
    if (!e.target?.closest?.(".bw-inbox-menu")) bmCloseInboxMenu();
  }

  let bmMenuDismissBound = false;
  function bmBindMenuDismiss() {
    if (bmMenuDismissBound) return;
    bmMenuDismissBound = true;
    document.addEventListener("mousedown", bmInboxMenuDocHandler, true);
    document.addEventListener("keydown", bmInboxMenuDocHandler, true);
  }
  function bmUnbindMenuDismiss() {
    if (!bmMenuDismissBound) return;
    bmMenuDismissBound = false;
    document.removeEventListener("mousedown", bmInboxMenuDocHandler, true);
    document.removeEventListener("keydown", bmInboxMenuDocHandler, true);
  }

  function bmOpenInboxMenu(event, item) {
    event.preventDefault();
    event.stopPropagation();
    if (!item) return;
    const selected = bmInboxSelection();
    if (!selected.includes(item.key)) {
      bmSetInboxSelection([item.key], item.key);
    }
    bm.inboxMenu = { x: event.clientX, y: event.clientY, key: item.key, item };
    saveState();
    bmSyncDevicePanelUi();
    bmRenderInboxMenu();
    bmClampInboxMenu();
    bmBindMenuDismiss();
  }

  function bmCloseInboxMenu() {
    bmUnbindMenuDismiss();
    if (!bm.inboxMenu) return;
    bm.inboxMenu = null;
    document.querySelector(".bw-inbox-menu")?.remove();
  }

  function bmClampInboxMenu() {
    setTimeout(() => {
      const menu = document.querySelector(".bw-inbox-menu");
      if (!menu || !bm.inboxMenu) return;
      const margin = 8;
      const rect = menu.getBoundingClientRect();
      // Clamp from the stored viewport coords; rect.left/top can double-offset
      // under a non-viewport offset parent or when the page is scrolled.
      const x = Math.max(margin, Math.min(bm.inboxMenu.x, window.innerWidth - rect.width - margin));
      const y = Math.max(margin, Math.min(bm.inboxMenu.y, window.innerHeight - rect.height - margin));
      menu.style.left = `${x}px`;
      menu.style.top = `${y}px`;
    }, 0);
  }

  function bmInboxMenuButton(label, onclick, danger = false) {
    return el("button", {
      class: `bw-menu-item ${danger ? "bw-menu-danger" : ""}`,
      role: "menuitem",
      onclick: (e) => {
        e.stopPropagation();
        bmCloseInboxMenu();
        onclick();
      },
    }, label);
  }

  function bmListFloors(inv) {
    const floors = [];
    if (!inv) return floors;
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
    renderDevicesScope();
  }

  function bmImportableKeys(inv, keys) {
    const byKey = new Map(bmDeviceInboxCandidateList(inv).map((c) => [c.key, c]));
    return keys.filter((key) => byKey.get(key)?.status === "new");
  }

  function bmAddSelectedToFloor(floorId = null, keys = null) {
    const inv = inventoryInstance();
    if (!inv) return;
    const floor = floorId ? inv.getEntity(floorId) : bmCurrentFloorForInbox(inv);
    if (!floor || floor.type !== "floor") {
      logTo("bacnet-manager", "Choose a target floor first.", "warn");
      return;
    }
    const building = inv.getEntity(floor.buildingId || floor.parentId);
    const site = building ? inv.getEntity(floor.siteId || building.siteId) : null;
    if (!site || !building) {
      logTo("bacnet-manager", "Target floor is missing site/building context.", "error");
      return;
    }
    const selectedKeys = Array.isArray(keys) && keys.length ? keys : bmInboxSelection();
    const importKeys = bmImportableKeys(inv, selectedKeys);
    if (!importKeys.length) {
      logTo("bacnet-manager", "Select new devices to add to the building model.", "warn");
      return;
    }
    const result = bwImportDevicesToFloor({
      inventory: inv,
      devices: discovery.getDevices() || [],
      keys: importKeys,
      candidates: bm.deviceInbox.candidates || {},
      floor,
      site,
      building,
      makeEntity: bmDeviceEntityFromBacnet,
    });
    bm.deviceInbox.candidates = result.candidates;
    bmSetInboxSelection([]);
    saveState();
    const imported = result.imported || [];
    logTo("bacnet-manager",
      `Added ${imported.length} device${imported.length === 1 ? "" : "s"} to ${floor.name}.${result.skipped ? ` Skipped ${result.skipped}.` : ""}`,
      imported.length ? "ok" : "warn");
    renderDevicesScope();
  }

  function bmInboxContextMenu(inv) {
    const menu = bm.inboxMenu;
    if (!menu) return null;
    const selected = bmInboxSelection();
    const selectedCount = selected.length || 1;
    const item = menu.item;
    const items = [];
    if (item?.status === "changed" && item.modeledDevice) {
      items.push(bmInboxMenuButton("Update binding from discovery", () => bmUpdateDeviceBinding(item)));
    }
    const importable = bmImportableKeys(inv, selected.length ? selected : [item.key]);
    if (importable.length) {
      for (const { floor } of bmListFloors(inv)) {
        items.push(bmInboxMenuButton(
          selectedCount > 1 ? `Add ${importable.length} to ${floor.name}` : `Add to ${floor.name}`,
          () => bmAddSelectedToFloor(floor.id, importable),
        ));
      }
    }
    items.push(bmInboxMenuButton(`Ignore ${selectedCount}`, bmIgnoreSelectedInboxDevices, true));
    return el("div", {
      class: "bw-context-menu bw-inbox-menu",
      role: "menu",
      "aria-label": "Device actions",
      style: `left:${menu.x}px; top:${menu.y}px`,
      onclick: (e) => e.stopPropagation(),
    }, ...items);
  }

  function bmRenderInboxMenu() {
    document.querySelector(".bw-inbox-menu")?.remove();
    const inv = inventoryInstance();
    if (!inv || !bm.inboxMenu) return;
    const menu = bmInboxContextMenu(inv);
    if (menu) document.body.appendChild(menu);
  }

  function bmSyncDevicePanelUi() {
    const selected = new Set(bmInboxSelection());
    const browseKey = getBrowseDeviceKey?.() || null;
    document.querySelectorAll("[data-bw-inbox-key]").forEach((row) => {
      const on = selected.has(row.dataset.bwInboxKey);
      const browsing = row.dataset.bwInboxKey === browseKey;
      row.classList.toggle("bw-inbox-row-selected", on);
      row.classList.toggle("bac-row-active", browsing);
      row.setAttribute("aria-selected", on || browsing ? "true" : "false");
    });
    const inv = inventoryInstance();
    const importable = inv ? bmImportableKeys(inv, [...selected]).length : 0;
    const floor = inv ? bmCurrentFloorForInbox(inv) : null;
    const ignore = document.getElementById("bw-inbox-ignore-selected");
    if (ignore) ignore.disabled = selected.size === 0 ? "disabled" : undefined;
    const add = document.getElementById("bw-inbox-add-selected");
    if (add) {
      add.disabled = importable === 0 || !floor ? "disabled" : undefined;
      add.textContent = floor
        ? (selected.size > 1 ? `Add ${importable} to ${floor.name}` : `Add to ${floor.name}`)
        : "Add to floor";
    }
    const updateBinding = document.getElementById("bw-inbox-update-binding");
    if (updateBinding) updateBinding.disabled = selected.size === 0 ? "disabled" : undefined;
  }

  function bmApplyDeviceFilter() {
    const inv = inventoryInstance();
    if (!inv) return;
    bmRefillDeviceTbodyFromDom(inv);
    bmSyncDevicePanelUi();
  }

  function bmIgnoreSelectedInboxDevices() {
    const selected = bmInboxSelection();
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
    bmSetInboxSelection([]);
    saveState();
    renderDevicesScope();
  }

  function bmClearDeviceDiscovery() {
    discovery.clearDiscovery();
    bm.deviceInbox.candidates = {};
    bmSetInboxSelection([]);
    saveState();
    renderAll?.();
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
    return "No devices yet — run Discover above, then click a row to browse objects.";
  }

  function bmPatchDevicePanelLive() {
    const inv = inventoryInstance();
    const panel = document.getElementById("bm-device-panel");
    if (!inv || !panel) {
      renderAll?.();
      return;
    }
    const floor = bmCurrentFloorForInbox(inv);
    const discovered = bmDeviceInboxCandidateList(inv);
    const discoverySelected = bmInboxSelection().length;
    const scrollNode = panel.querySelector(".bm-inbox-pane-body");
    const scrollTop = scrollNode?.scrollTop || 0;

    bmRefillDeviceTbodyFromDom(inv);

    const count = document.getElementById("bac-device-count");
    if (count) {
      count.textContent = discovery.isDiscovering()
        ? `Listening… ${discovered.length} device${discovered.length === 1 ? "" : "s"} so far`
        : `${discovered.length} device${discovered.length === 1 ? "" : "s"}`;
    }
    const floorSelect = panel.querySelector(".bw-import-target-select");
    if (floorSelect && floorSelect.value !== (bm.importFloorId || "")) {
      floorSelect.value = bm.importFloorId || "";
    }
    const ignore = document.getElementById("bw-inbox-ignore-selected");
    if (ignore) ignore.disabled = discoverySelected ? false : true;
    const clear = document.getElementById("bw-inbox-clear");
    if (clear) clear.disabled = discovery.getDevices().length ? false : true;
    const importable = bmImportableKeys(inv, bmInboxSelection());
    const add = document.getElementById("bw-inbox-add-selected");
    if (add) {
      add.disabled = importable.length > 0 && floor ? false : true;
      add.textContent = floor
        ? (discoverySelected > 1 ? `Add ${importable.length} to ${floor.name}` : `Add to ${floor.name}`)
        : "Add to floor";
    }
    bmSyncDevicePanelUi();
    if (scrollNode) scrollNode.scrollTop = scrollTop;
  }

  function bmInboxStatusLabel(inv, item, floor = null) {
    const existing = item.modeledDevice;
    if (item.status === "changed") return "Changed";
    if (item.status === "conflict") return item.conflict || "Conflict";
    if (existing) {
      const existingFloor = inv ? inv.getEntity(existing.floorId || existing.parentId) : null;
      return existing.floorId === floor?.id ? "Here" : (existingFloor?.name ? `On ${existingFloor.name}` : "Modeled");
    }
    return "New";
  }

  function bmInboxStatusClass(status) {
    if (status === "new") return "pill-running";
    if (status === "changed") return "pill-warn";
    if (status === "conflict") return "pill-error";
    return "pill-muted";
  }

  function bmDeviceSubtitle(device) {
    if (!device) return "";
    return [discovery.vendorText(device), device.modelName].filter(Boolean).join(" · ");
  }

  function bmInboxCellStack(primary, secondary = "", title = "") {
    const label = primary || "Unnamed";
    return el("div", {
      class: "bm-inbox-cell-stack",
      title: title || [label, secondary].filter(Boolean).join(" · "),
    },
      el("span", { class: "bm-inbox-cell-primary" }, primary || el("span", { class: "muted" }, "Unnamed")),
      // Always render the secondary line (placeholder when empty) so every
      // device row keeps the same two-line height the windowed scroller assumes.
      el("span", { class: "bm-inbox-cell-secondary muted" }, secondary || "\u00a0"));
  }

  function bmInboxStatusTitle(inv, item, floor = null) {
    if (item.status === "conflict") return item.conflict || "Address or instance conflict";
    if (item.modeledDevice) {
      const path = bmInboxPathLabel(inv, item.modeledDevice);
      return path ? `Already modeled: ${path}` : "Already in building model";
    }
    if (item.status === "changed") return "Device details changed since last import";
    const drift = item.device?.key ? discovery.getDeviceDriftStatus?.(item.device.key) : null;
    if (drift === "new") return "Not seen in the previous discovery scan";
    if (drift === "changed") return "Address, vendor, or model changed since the previous scan";
    return "New to the building model";
  }

  function bmInboxStatusPill(inv, item, floor = null) {
    const label = bmInboxStatusLabel(inv, item, floor);
    return el("span", {
      class: `pill pill-compact ${bmInboxStatusClass(item.status)}`,
      title: bmInboxStatusTitle(inv, item, floor),
    }, label);
  }

  function bmInboxStatusCell(inv, item, floor, device = null) {
    const dev = device || item.device || null;
    const drift = dev?.key ? discovery.getDeviceDriftStatus?.(dev.key) : null;
    const driftEl = drift && drift !== "returning" ? discovery.deviceDriftBadge?.(dev) : null;
    const pill = bmInboxStatusPill(inv, item, floor);
    const overlap = (item.status === "new" && drift === "new")
      || (item.status === "changed" && drift === "changed");
    const hideDrift = overlap || (item.modeledDevice && drift === "new");
    const kids = hideDrift ? [pill] : [pill, driftEl].filter(Boolean);
    return el("span", { class: "bw-inbox-status-cell" }, ...kids);
  }

  // Keyboard support for the discovered-device rows: Enter/Space activates a
  // row (same as a click, so Shift/Ctrl multi-select still work via modifiers),
  // and Arrow Up/Down move focus between rows for no-mouse triage.
  function bmInboxRowKeydown(e, item) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      bmSelectInboxCandidate(item, e);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const dir = e.key === "ArrowDown" ? 1 : -1;
      if (bmVirtual?.enabled) {
        bmVirtualFocusAdjacentDevice(item.key, dir);
        return;
      }
      const rows = [...document.querySelectorAll("#bw-discovered-device-rows tr[data-bw-inbox-key]")];
      const idx = rows.findIndex((r) => r.dataset.bwInboxKey === item.key);
      if (idx < 0) return;
      const next = rows[idx + dir];
      if (next) next.focus();
    }
  }

  function bmNetworkGroupLabel(network) {
    return network == null ? "Local network" : `Network ${network}`;
  }

  // ---- device table rendering (with windowed virtualization for big sites) ----

  // Flat, ordered list of "visual rows" — group headers interleaved with device
  // rows — that both the full and the virtualized renderers consume.
  function bmBuildVisualRows(inv) {
    const items = bmDeviceInboxCandidateList(inv);
    const distinctNetworks = new Set(items.map((it) => bmDeviceNetwork(it.device)));
    const showGroups = bm.view.groupByNetwork && distinctNetworks.size > 1;
    const out = [];
    let lastGroup = null;
    for (const item of items) {
      if (showGroups) {
        const g = bmDeviceNetwork(item.device);
        if (g !== lastGroup) {
          lastGroup = g;
          const count = items.filter((it) => bmDeviceNetwork(it.device) === g).length;
          out.push({ kind: "group", networkVal: item.device.network ?? null, count });
        }
      }
      out.push({ kind: "device", item });
    }
    return out;
  }

  function bmRowContext(inv) {
    return {
      inv,
      floor: bmCurrentFloorForInbox(inv),
      selected: new Set(bmInboxSelection()),
      browseKey: getBrowseDeviceKey?.() || null,
    };
  }

  function bmRenderVisualRow(desc, ctx, index) {
    if (desc.kind === "group") {
      return el("tr", { class: "bm-inbox-group-row", "data-bw-index": String(index) },
        el("td", { colspan: "4" },
          el("span", {}, bmNetworkGroupLabel(desc.networkVal)),
          el("span", { class: "muted small" }, String(desc.count))));
    }
    const { inv, floor, selected, browseKey } = ctx;
    const item = desc.item;
    const device = item.device;
    const browsing = item.key === browseKey;
    const ariaLabel = `Device ${device.instance ?? "?"}${device.name ? `, ${device.name}` : ""}, ${discovery.addressText(device)}`;
    return el("tr", {
      class: `bw-inbox-row bac-device-row ${selected.has(item.key) ? "bw-inbox-row-selected" : ""} ${browsing ? "bac-row-active" : ""} ${item.selectable === false ? "bw-inbox-row-disabled" : ""}`,
      "data-bw-inbox-key": item.key,
      "data-bw-index": String(index),
      tabindex: "0",
      "aria-label": ariaLabel,
      "aria-selected": selected.has(item.key) || browsing ? "true" : "false",
      onclick: (e) => bmSelectInboxCandidate(item, e),
      oncontextmenu: (e) => bmOpenInboxMenu(e, item),
      onkeydown: (e) => bmInboxRowKeydown(e, item),
    },
      el("td", { class: "bac-num bm-inbox-col-inst", title: String(device.instance ?? "") },
        String(device.instance ?? "")),
      el("td", { class: "bm-inbox-col-name" },
        bmInboxCellStack(device.name, bmDeviceSubtitle(device))),
      el("td", { class: "bac-mono bm-inbox-col-addr", title: discovery.addressText(device) },
        discovery.addressText(device)),
      el("td", { class: "bm-inbox-col-status" },
        bmInboxStatusCell(inv, item, floor, device)),
    );
  }

  function bmEmptyRow() {
    return el("tr", {}, el("td", { class: "muted small bm-inbox-empty", colspan: "4" }, bmDeviceInboxEmptyMessage()));
  }

  // --- windowed virtualization: only render rows near the viewport so a site
  // with thousands of devices scrolls smoothly. Variable row heights (device
  // rows are two lines, group headers one) are handled with a prefix-sum offset
  // table and binary search, so alignment stays exact. ---
  const VIRTUAL_THRESHOLD = 120; // below this, render everything (no windowing)
  const VIRTUAL_OVERSCAN = 8;    // rows rendered beyond the viewport each side
  let bmDeviceRowH = 44;         // measured at runtime; sensible defaults first
  let bmGroupRowH = 28;
  let bmVirtual = null;          // active virtual state, or { enabled:false }
  let bmScrollRaf = 0;

  function bmVisualRowHeight(kind) {
    return kind === "group" ? bmGroupRowH : bmDeviceRowH;
  }

  function bmComputeOffsets(visual) {
    const offsets = new Array(visual.length + 1);
    let acc = 0;
    for (let i = 0; i < visual.length; i++) {
      offsets[i] = acc;
      acc += bmVisualRowHeight(visual[i].kind);
    }
    offsets[visual.length] = acc;
    return offsets;
  }

  // Largest index i with offsets[i] <= y (the row containing vertical offset y).
  function bmRowAtOffset(offsets, y) {
    let lo = 0;
    let hi = offsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offsets[mid] <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  function bmSpacerRow(height) {
    return el("tr", { class: "bm-virtual-spacer", "aria-hidden": "true" },
      el("td", { colspan: "4", style: `height:${Math.max(0, height)}px` }));
  }

  function bmVirtualRenderWindow() {
    const v = bmVirtual;
    if (!v || !v.enabled || !v.tbody.isConnected) return;
    const { scrollEl, tbody, visual, offsets } = v;
    const total = offsets[visual.length];
    const top = scrollEl.scrollTop;
    const viewH = scrollEl.clientHeight || 480;
    let start = Math.max(0, bmRowAtOffset(offsets, top) - VIRTUAL_OVERSCAN);
    let end = Math.min(visual.length, bmRowAtOffset(offsets, top + viewH) + 1 + VIRTUAL_OVERSCAN);
    const ctx = bmRowContext(v.inv);
    const children = [bmSpacerRow(offsets[start])];
    for (let i = start; i < end; i++) children.push(bmRenderVisualRow(visual[i], ctx, i));
    children.push(bmSpacerRow(total - offsets[end]));
    tbody.replaceChildren(...children);
    v.rendered = { start, end };
  }

  // After the first paint, replace the height estimates with measured values so
  // the scroll geometry is exact, then re-render if anything moved.
  function bmVirtualMeasure() {
    const v = bmVirtual;
    if (!v || !v.enabled || !v.tbody.isConnected) return;
    const dev = v.tbody.querySelector(".bw-inbox-row");
    const grp = v.tbody.querySelector(".bm-inbox-group-row");
    let changed = false;
    if (dev && dev.offsetHeight && Math.abs(dev.offsetHeight - bmDeviceRowH) > 1) { bmDeviceRowH = dev.offsetHeight; changed = true; }
    if (grp && grp.offsetHeight && Math.abs(grp.offsetHeight - bmGroupRowH) > 1) { bmGroupRowH = grp.offsetHeight; changed = true; }
    if (changed) { v.offsets = bmComputeOffsets(v.visual); bmVirtualRenderWindow(); }
  }

  function bmVirtualOnScroll() {
    if (!bmVirtual?.enabled || bmScrollRaf) return;
    bmScrollRaf = requestAnimationFrame(() => { bmScrollRaf = 0; bmVirtualRenderWindow(); });
  }

  // Fill (or refill) the device tbody, choosing virtualized vs. full rendering
  // by row count. Safe to call repeatedly on the same nodes (live patching).
  function bmFillDeviceTbody(inv, scrollEl, tbody) {
    const visual = bmBuildVisualRows(inv);
    if (visual.length <= VIRTUAL_THRESHOLD) {
      bmVirtual = { enabled: false };
      if (visual.length === 0) tbody.replaceChildren(bmEmptyRow());
      else {
        const ctx = bmRowContext(inv);
        tbody.replaceChildren(...visual.map((d, i) => bmRenderVisualRow(d, ctx, i)));
      }
      return;
    }
    bmVirtual = { enabled: true, inv, scrollEl, tbody, visual, offsets: bmComputeOffsets(visual), rendered: null };
    // If the tbody is already mounted (live refill) paint now; otherwise defer to
    // the next frame, when layout (clientHeight, row heights) is available.
    if (tbody.isConnected) {
      bmVirtualRenderWindow();
      requestAnimationFrame(bmVirtualMeasure);
    } else {
      requestAnimationFrame(() => { bmVirtualRenderWindow(); bmVirtualMeasure(); });
    }
  }

  // Keyboard arrow nav across the virtualized list: step to the adjacent device
  // (skipping group headers), scroll it into view, render, then focus it.
  function bmVirtualFocusAdjacentDevice(key, dir) {
    const v = bmVirtual;
    if (!v?.enabled) return;
    const cur = v.visual.findIndex((d) => d.kind === "device" && d.item.key === key);
    if (cur < 0) return;
    let i = cur + dir;
    while (i >= 0 && i < v.visual.length && v.visual[i].kind !== "device") i += dir;
    if (i < 0 || i >= v.visual.length) return;
    const targetTop = v.offsets[i];
    const targetBottom = v.offsets[i + 1];
    const viewH = v.scrollEl.clientHeight || 480;
    if (targetTop < v.scrollEl.scrollTop) v.scrollEl.scrollTop = targetTop;
    else if (targetBottom > v.scrollEl.scrollTop + viewH) v.scrollEl.scrollTop = targetBottom - viewH;
    bmVirtualRenderWindow();
    const nextKey = v.visual[i].item.key;
    v.tbody.querySelector(`tr[data-bw-inbox-key="${CSS.escape(nextKey)}"]`)?.focus();
  }

  // Re-fill the live device tbody from current data, keeping the virtual window
  // (and scroll position) when it's already active on these same nodes.
  function bmRefillDeviceTbodyFromDom(inv) {
    const tbody = document.getElementById("bw-discovered-device-rows");
    const scrollEl = document.getElementById("bm-device-panel")?.querySelector(".bm-inbox-pane-body");
    if (!tbody || !scrollEl) return;
    if (bmVirtual?.enabled && bmVirtual.tbody === tbody && bmVirtual.scrollEl === scrollEl) {
      bmVirtual.inv = inv;
      bmVirtual.visual = bmBuildVisualRows(inv);
      bmVirtual.offsets = bmComputeOffsets(bmVirtual.visual);
      bmVirtualRenderWindow();
    } else {
      bmFillDeviceTbody(inv, scrollEl, tbody);
    }
  }

  // Devices seen in the previous scan but absent from the latest one. Surfaced
  // as a collapsible list so an operator can see exactly which gear went dark,
  // not just a "N missing" count in the drift summary.
  function bmDriftMissingEl() {
    const missing = discovery.getDriftMissing?.() || [];
    if (!missing.length) return null;
    return el("details", { class: "bm-inbox-missing" },
      el("summary", {},
        `${missing.length} device${missing.length === 1 ? "" : "s"} missing since last scan`),
      el("ul", { class: "bm-inbox-missing-list" },
        ...missing.map((d) => el("li", { class: "bm-inbox-missing-item" },
          el("span", { class: "bac-num" }, `#${d.instance ?? "?"}`),
          el("span", { class: "bm-inbox-missing-name" }, d.name || el("span", { class: "muted" }, "Unnamed")),
          el("span", { class: "muted small bac-mono" }, discovery.addressText(d)),
        ))));
  }

  function bmDevicePanel(inv, floor = null) {
    const discovered = bmDeviceInboxCandidateList(inv);
    const selectedKeys = bmInboxSelection();
    const selectedDiscoveryItems = discovered.filter((item) => selectedKeys.includes(item.key));
    const canUpdateBinding = selectedDiscoveryItems.some((item) => item.status === "changed" && item.modeledDevice);
    const importable = bmImportableKeys(inv, selectedKeys);
    const hasDevices = (discovery.getDevices() || []).length > 0;

    return el("section", {
      id: "bm-device-panel",
      class: "bm-device-panel plugin-section plugin-section-fill",
      onclick: () => { if (bm.inboxMenu) bmCloseInboxMenu(); },
    },
      el("div", { class: "section-head bm-pane-head" },
        el("h3", {}, "Devices"),
        el("span", { id: "bac-device-count", class: "muted small" },
          discovery.isDiscovering()
            ? `Listening… ${discovered.length} device${discovered.length === 1 ? "" : "s"} so far`
            : `${discovered.length} device${discovered.length === 1 ? "" : "s"}`),
        discovery.driftSummaryEl?.() || null,
        bmDeviceOverflowMenu(hasDevices)),
      bmDriftMissingEl(),
      el("div", { class: "bm-inbox-filter-row" },
        el("input", {
          class: "nm-input bw-device-filter",
          placeholder: "Filter instance, name, address, vendor, model…",
          value: getDeviceFilter?.() || "",
          oninput: (e) => {
            setDeviceFilter?.(e.target.value);
            bmApplyDeviceFilter();
          },
        })),
      bmBuildDeviceTable(inv),
      selectedKeys.length
        ? bmImportActionBar(inv, floor, selectedKeys, selectedDiscoveryItems, canUpdateBinding, importable)
        : null,
      bmInboxContextMenu(inv));
  }

  // Header overflow ("...") for secondary device actions kept off the main
  // surface: group-by-network, copy/export, and clear.
  function bmDeviceOverflowMenu(hasDevices) {
    const close = (e) => e.currentTarget.closest("details")?.removeAttribute("open");
    return el("details", { class: "bm-pane-menu" },
      el("summary", { class: "bm-pane-menu-summary", title: "More actions", "aria-label": "More actions" }, "⋯"),
      el("div", { class: "bm-pane-menu-list", role: "menu" },
        el("button", {
          class: `bw-menu-item${bm.view.groupByNetwork ? " bw-menu-on" : ""}`,
          role: "menuitemcheckbox",
          "aria-checked": bm.view.groupByNetwork ? "true" : "false",
          onclick: (e) => { close(e); bmToggleGroupByNetwork(); },
        }, `${bm.view.groupByNetwork ? "✓ " : ""}Group by network`),
        onCopyDevices
          ? el("button", { class: "bw-menu-item", role: "menuitem", disabled: hasDevices ? undefined : "disabled", onclick: (e) => { close(e); onCopyDevices(); } }, "Copy as CSV")
          : null,
        onExportDevices
          ? el("button", { class: "bw-menu-item", role: "menuitem", disabled: hasDevices ? undefined : "disabled", onclick: (e) => { close(e); onExportDevices(); } }, "Export CSV")
          : null,
        el("button", {
          id: "bw-inbox-clear",
          class: "bw-menu-item bw-menu-danger", role: "menuitem",
          disabled: hasDevices ? undefined : "disabled",
          onclick: (e) => { close(e); bmClearDeviceDiscovery(); },
        }, "Clear discovery"),
      ));
  }

  // Selection-contextual import bar: hidden during normal browsing, shown only
  // once one or more devices are selected (the commissioning workflow).
  function bmImportActionBar(inv, floor, selectedKeys, selectedDiscoveryItems, canUpdateBinding, importable) {
    return el("div", { class: "bm-inbox-import-bar" },
      el("span", { class: "muted small bm-import-count" }, `${selectedKeys.length} selected`),
      el("select", {
        class: "nm-input bw-import-target-select",
        "aria-label": "Target floor",
        onchange: (e) => { bm.importFloorId = e.target.value; saveState(); renderDevicesScope(); },
      }, ...bmFloorSelectOptions(inv, bm.importFloorId || floor?.id || "")),
      el("button", {
        id: "bw-inbox-add-selected",
        class: "btn",
        disabled: importable.length > 0 && floor ? undefined : "disabled",
        onclick: () => bmAddSelectedToFloor(floor?.id || bm.importFloorId || null),
      }, floor
        ? (selectedKeys.length > 1 ? `Add ${importable.length} to ${floor.name}` : `Add to ${floor.name}`)
        : "Add to floor"),
      el("button", {
        id: "bw-inbox-ignore-selected",
        class: "btn-ghost",
        disabled: selectedKeys.length ? undefined : "disabled",
        onclick: bmIgnoreSelectedInboxDevices,
      }, "Ignore"),
      canUpdateBinding
        ? el("button", {
            id: "bw-inbox-update-binding",
            class: "btn-ghost",
            onclick: () => {
              for (const item of selectedDiscoveryItems) {
                if (item.status === "changed" && item.modeledDevice) bmUpdateDeviceBinding(item);
              }
            },
          }, "Update binding")
        : null,
    );
  }

  // Builds the scrollable device table and wires the virtual scroller. The
  // initial fill is deferred to bmFillDeviceTbody so large lists window from the
  // start; row heights are measured on the next frame for exact geometry.
  function bmBuildDeviceTable(inv) {
    const tbody = el("tbody", { id: "bw-discovered-device-rows" });
    const scrollEl = el("div", {
      class: "bm-inbox-pane-body bw-device-inbox-scroll table-scroll-fill",
      onscroll: bmVirtualOnScroll,
    },
      el("table", { class: "bac-table bw-device-inbox-table bm-inbox-table bw-discovery-table" },
        el("thead", {}, el("tr", {},
          bmSortableHeader("#", "instance", "bm-inbox-col-inst"),
          bmSortableHeader("Name", "name", "bm-inbox-col-name"),
          bmSortableHeader("Address", "address", "bm-inbox-col-addr"),
          el("th", { class: "bm-inbox-col-status" }, "Status"))),
        tbody));
    bmFillDeviceTbody(inv, scrollEl, tbody);
    return scrollEl;
  }

  // A clickable, sortable column header with an asc/desc indicator and aria-sort.
  function bmSortableHeader(label, key, cls) {
    const active = bm.view.sortKey === key;
    const arrow = active ? (bm.view.sortDir === "asc" ? " ▲" : " ▼") : "";
    return el("th", {
      class: `${cls} bm-inbox-th-sort${active ? " bm-inbox-th-active" : ""}`,
      role: "button",
      tabindex: "0",
      "aria-sort": active ? (bm.view.sortDir === "asc" ? "ascending" : "descending") : "none",
      title: `Sort by ${label.replace("#", "instance")}`,
      onclick: () => bmSetSort(key),
      onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); bmSetSort(key); } },
    }, `${label}${arrow}`);
  }

  return {
    restoreState: () => {
      bm = bmStateFromUserState();
      if (bm.legacyFilter && setDeviceFilter && !getDeviceFilter?.()) {
        setDeviceFilter(bm.legacyFilter);
      }
    },
    renderDevicePanel: (inv) => bmDevicePanel(inv, bmCurrentFloorForInbox(inv)),
    patchDevicePanelLive: bmPatchDevicePanelLive,
    renderDevicesScope,
    renderInboxScope: renderDevicesScope,
  };
}
