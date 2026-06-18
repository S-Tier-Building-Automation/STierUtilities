// Building Workspace — model tree, device inbox, commissioning, dashboards.

import {
  bwClassifyDiscovery,
  bwDeviceInboxCandidates,
  bwDeviceKey,
  bwFindModeledDeviceForBacnet,
  bwImportPlanItems,
  bwModelObjectsBatch,
  bwModelQueuedDevices,
  bwPlanDeviceObjects,
  bwQueueInboxDevices,
  bwRemoveQueuedDevices,
  commissioningValueMatches,
  exportCommissioningCsv,
  exportCommissioningMarkdown,
  generateBuildingDashboard,
  historianPointFromEntity,
  interpretStatusFlags,
  parsePriorityArray,
  pointEntityFromBacnet,
  runCommissioning,
  suggestEquipmentName,
} from "../building-workspace.js";
import { closeModal, openModal } from "../../ui/modal.js";
import { toast } from "../../ui/toast.js";

/**
 * @param {object} deps
 * @param {typeof import("../../platform/tauri.js").invoke} deps.invoke
 * @param {import("../../ui/dom.js").el} deps.el
 * @param {(toolId: string, msg: string, kind?: string) => void} deps.logTo
 * @param {() => void} deps.renderAll
 * @param {(scope?: string) => void} deps.renderScoped
 * @param {object} deps.userState
 * @param {() => void} deps.saveUserState
 * @param {() => object|null} deps.getPlatform
 * @param {ReturnType<typeof import("./networkmanager.js").createNetworkManagerUi>} deps.networkManager
 * @param {ReturnType<typeof import("./bacnet.js").createBacnetUi>} deps.bacnet
 * @param {(view: string) => void} deps.setView
 * @param {(id: string) => string} deps.pluginView
 * @param {() => string|null} deps.currentPluginId
 * @param {() => import("../../platform/services/pack-controller.js").createPackController extends Function ? ReturnType<import("../../platform/services/pack-controller.js").createPackController> : object|null} deps.getPack
 * @param {() => object|null} [deps.getTelemetry]
 * @param {() => object|null} deps.getHistorian
 * @param {() => number} deps.histSyncFromInventory
 * @param {() => void} deps.histPersist
 */
export function createBuildingWorkspaceUi(deps) {
  const {
    invoke, el, logTo, renderAll, renderScoped, userState, saveUserState, getPlatform, networkManager, bacnet,
    setView, pluginView, getPack, getTelemetry = () => null, getHistorian, currentPluginId,
    histSyncFromInventory, histPersist,
  } = deps;

  function platformHost(toolId) {
    const platform = getPlatform();
    return platform ? platform.hostFor(toolId) : null;
  }

  function inventoryInstance() {
    const platform = getPlatform();
    return platform ? platform.capability("inventory.v1") : null;
  }

  function historianInstance() {
    return getHistorian();
  }

// ============================================================================

let bw = bwStateFromUserState();

function bwNormalizeDeviceInboxState(saved = {}) {
  const inbox = saved.deviceInbox && typeof saved.deviceInbox === "object" ? saved.deviceInbox : {};
  const phase = inbox.phase === "modeling" ? "modeling" : "discovery";
  return {
    phase,
    selectedKeys: Array.isArray(inbox.selectedKeys)
      ? inbox.selectedKeys
      : (Array.isArray(saved.deviceInboxSelectedKeys) ? saved.deviceInboxSelectedKeys : []),
    anchorKey: inbox.anchorKey || saved.deviceInboxSelectionAnchorKey || "",
    filter: typeof inbox.filter === "string" ? inbox.filter : (saved.deviceInboxFilter || ""),
    candidates: inbox.candidates && typeof inbox.candidates === "object" && !Array.isArray(inbox.candidates)
      ? inbox.candidates
      : {},
  };
}

function bwStateFromUserState() {
  const saved = userState.buildingWorkspace || {};
  return {
    tab: saved.tab || "model",
    filter: saved.filter || "",
    template: saved.template || "vav",
    selectedSiteId: saved.selectedSiteId || "",
    selectedBuildingId: saved.selectedBuildingId || "",
    selectedFloorId: saved.selectedFloorId || "",
    selectedEntityId: saved.selectedEntityId || "",
    selectedEntityIds: Array.isArray(saved.selectedEntityIds) ? saved.selectedEntityIds : [],
    selectionAnchorId: saved.selectionAnchorId || "",
    collapsedNodeIds: Array.isArray(saved.collapsedNodeIds) ? saved.collapsedNodeIds : [],
    contextMenu: null,
    inboxMenu: null,
    draft: null,
    busy: false,
    lastRunId: saved.lastRunId || null,
    dashboardJson: "",
    floorBatchPattern: "Floor {n}",
    floorBatchStart: "1",
    floorBatchCount: "3",
    deviceInbox: bwNormalizeDeviceInboxState(saved),
    cxMin: "",
    cxMax: "",
    cxNotes: "",
    cxCommand: "",
    cxPriority: "8",
    cxVerify: false,
    cxToggle: false,
  };
}

function bwRestoreState() {
  bw = bwStateFromUserState();
}

function bwSaveState() {
  userState.buildingWorkspace = {
    tab: bw.tab,
    filter: bw.filter,
    template: bw.template,
    selectedSiteId: bw.selectedSiteId,
    selectedBuildingId: bw.selectedBuildingId,
    selectedFloorId: bw.selectedFloorId,
    selectedEntityId: bw.selectedEntityId,
    selectedEntityIds: bw.selectedEntityIds,
    selectionAnchorId: bw.selectionAnchorId,
    collapsedNodeIds: bw.collapsedNodeIds,
    lastRunId: bw.lastRunId,
    deviceInbox: bw.deviceInbox,
  };
  saveUserState();
}

function bwStatusPill() {
  const inv = inventoryInstance();
  if (!inv) return { label: "Off", cls: "pill-muted" };
  const points = inv.listEntities({ type: "point" }).length;
  return points ? { label: `${points} point${points === 1 ? "" : "s"}`, cls: "pill-running" } : { label: "Ready", cls: "pill-idle" };
}

function bwTemplateForName(name) {
  const s = String(name || "").toLowerCase();
  if (s.includes("ahu")) return "ahu";
  if (s.includes("meter") || s.includes("mtr")) return "meter";
  if (s.includes("zone")) return "zone";
  return "vav";
}

function bwNodeCollapsed(id) {
  return bw.collapsedNodeIds.includes(id);
}

function bwSetNodeCollapsed(id, collapsed) {
  const current = new Set(bw.collapsedNodeIds);
  if (collapsed) current.add(id);
  else current.delete(id);
  bw.collapsedNodeIds = [...current];
  bwSaveState();
}

function bwToggleNodeCollapsed(id) {
  bwSetNodeCollapsed(id, !bwNodeCollapsed(id));
  bwRenderModelScope({ tree: true, details: false, header: false });
}

function bwExpandNode(id) {
  if (!id || !bwNodeCollapsed(id)) return;
  bwSetNodeCollapsed(id, false);
}

function bwActiveSite(inv) {
  if (String(bw.selectedSiteId || "").startsWith("__new_")) return null;
  return inv.getEntity(bw.selectedSiteId) || inv.listEntities({ type: "site" })[0] || null;
}

function bwActiveBuilding(inv, siteId) {
  if (String(bw.selectedBuildingId || "").startsWith("__new_")) return null;
  const selected = inv.getEntity(bw.selectedBuildingId);
  if (selected && (!siteId || selected.siteId === siteId)) return selected;
  const buildings = siteId ? inv.listEntities({ type: "building", siteId }) : inv.listEntities({ type: "building" });
  return buildings[0] || null;
}

function bwActiveFloor(inv, buildingId) {
  if (String(bw.selectedFloorId || "").startsWith("__new_")) return null;
  const selected = inv.getEntity(bw.selectedFloorId);
  if (selected && (!buildingId || selected.buildingId === buildingId || selected.parentId === buildingId)) return selected;
  const floors = buildingId ? inv.listEntities({ type: "floor", buildingId }) : inv.listEntities({ type: "floor" });
  return floors[0] || null;
}

function bwEnsureSite(inv) {
  const existing = bwActiveSite(inv);
  if (existing) {
    bw.selectedSiteId = existing.id;
    return existing;
  }
  const site = inv.upsertEntity({
    type: "site",
    name: "Default Site",
    tags: { site: true, haystack: "4" },
  });
  bw.selectedSiteId = site.id;
  return site;
}

function bwEnsureBuilding(inv, site) {
  const existing = bwActiveBuilding(inv, site.id);
  if (existing) {
    bw.selectedBuildingId = existing.id;
    return existing;
  }
  const building = inv.upsertEntity({
    type: "building",
    siteId: site.id,
    parentId: site.id,
    name: "Main Building",
    tags: { building: true },
  });
  bw.selectedBuildingId = building.id;
  return building;
}

function bwEnsureFloor(inv, site, building) {
  const existing = bwActiveFloor(inv, building.id);
  if (existing) {
    bw.selectedFloorId = existing.id;
    return existing;
  }
  const floor = inv.upsertEntity({
    type: "floor",
    siteId: site.id,
    buildingId: building.id,
    parentId: building.id,
    name: "Floor 1",
    tags: { floor: true },
  });
  bw.selectedFloorId = floor.id;
  return floor;
}

function bwEnsureLocation(inv) {
  const site = bwEnsureSite(inv);
  const building = bwEnsureBuilding(inv, site);
  const floor = bwEnsureFloor(inv, site, building);
  bwSaveState();
  return { site, building, floor };
}

function bwPromptName(label, fallback) {
  const value = prompt(label, fallback || "");
  return value == null ? "" : String(value).trim();
}

function bwDefaultName(type) {
  return {
    site: "New Site",
    building: "New Building",
    floor: "New Floor",
    equip: "New Device",
    point: "New Point",
  }[type] || "New Item";
}

function bwFocusDraftName() {
  setTimeout(() => {
    const input = document.querySelector("[data-bw-draft-name='1']");
    if (!input) return;
    input.focus();
    input.select();
  }, 0);
}

function bwStartDraft(type, parentId = "") {
  bw.contextMenu = null;
  bwExpandNode(parentId);
  bw.draft = {
    id: `draft:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    type,
    parentId,
    name: bwDefaultName(type),
  };
  bwRenderModelScope({ tree: true, details: true, header: true });
  bwFocusDraftName();
}

function bwCancelDraft() {
  if (!bw.draft) return;
  bw.draft = null;
  bwRenderModelScope({ tree: true, details: true, header: true });
}

function bwEntityByName(inv, filter, name) {
  const target = String(name || "").trim().toLowerCase();
  return inv.listEntities(filter).find((e) => String(e.name || "").trim().toLowerCase() === target) || null;
}

function bwBacnetDeviceInstance(device) {
  const n = Number(device?.instance ?? device?.deviceInstance);
  return Number.isFinite(n) ? n : null;
}

function bwModeledDeviceForBacnet(inv, device) {
  if (!inv) return null;
  return bwFindModeledDeviceForBacnet(inv.listEntities({ type: "equip" }), device);
}

function bwDeviceEntityFromBacnet({ site, building, floor, device }) {
  const instance = bwBacnetDeviceInstance(device);
  const ref = bacDeviceRef(device);
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

function bwFilteredDiscoveredDevices() {
  const q = String(bw.deviceInbox?.filter || "").trim().toLowerCase();
  const devices = bacnet.getDevices() || [];
  if (!q) return devices;
  return devices.filter((d) =>
    String(d.instance ?? "").includes(q) ||
    (d.name || "").toLowerCase().includes(q) ||
    bacnet.addressText(d).toLowerCase().includes(q) ||
    bacnet.vendorText(d).toLowerCase().includes(q) ||
    (d.modelName || "").toLowerCase().includes(q));
}

function bwDeviceInboxCandidateList(inv) {
  return bwDeviceInboxCandidates({
    devices: bwFilteredDiscoveredDevices(),
    modeledDevices: inv ? inv.listEntities({ type: "equip" }) : [],
    candidates: bw.deviceInbox?.candidates || {},
  }).filter((c) => c.status !== "ignored");
}

function bwDeviceInboxQueueList(inv) {
  return bwImportPlanItems({
    devices: bacnet.getDevices() || [],
    modeledDevices: inv ? inv.listEntities({ type: "equip" }) : [],
    candidates: bw.deviceInbox?.candidates || {},
  });
}

function bwInboxSelectionFor(phase) {
  return bw.deviceInbox?.phase === phase ? (bw.deviceInbox.selectedKeys || []) : [];
}

function bwSetInboxSelection(phase, keys, anchorKey = "") {
  bw.deviceInbox.phase = phase;
  bw.deviceInbox.selectedKeys = [...new Set(keys.filter(Boolean))];
  bw.deviceInbox.anchorKey = anchorKey || bw.deviceInbox.selectedKeys.at(-1) || "";
}

function bwSelectInboxCandidate(phase, item, event = null) {
  if (!item || item.selectable === false) return;
  const inv = inventoryInstance();
  const order = (phase === "modeling" ? bwDeviceInboxQueueList(inv) : bwDeviceInboxCandidateList(inv))
    .filter((c) => c.selectable !== false)
    .map((c) => c.key);
  if (!order.includes(item.key)) return;
  const selected = bwInboxSelectionFor(phase);
  if (event?.shiftKey) {
    const anchor = bw.deviceInbox.anchorKey && order.includes(bw.deviceInbox.anchorKey)
      ? bw.deviceInbox.anchorKey
      : (selected.at(-1) || item.key);
    const a = order.indexOf(anchor);
    const b = order.indexOf(item.key);
    bwSetInboxSelection(phase, a >= 0 && b >= 0 ? order.slice(Math.min(a, b), Math.max(a, b) + 1) : [item.key], item.key);
  } else if (event?.ctrlKey || event?.metaKey) {
    const current = new Set(selected);
    if (current.has(item.key)) current.delete(item.key);
    else current.add(item.key);
    bwSetInboxSelection(phase, [...current], item.key);
  } else {
    bwSetInboxSelection(phase, [item.key], item.key);
  }
  bwSaveState();
  bwSyncInboxSelectionUi();
}

function bwOpenInboxMenu(event, phase, item) {
  event.preventDefault();
  event.stopPropagation();
  if (!item || item.selectable === false) return;
  const selected = bwInboxSelectionFor(phase);
  if (bw.deviceInbox.phase !== phase || !selected.includes(item.key)) {
    bwSetInboxSelection(phase, [item.key], item.key);
  }
  bw.inboxMenu = { x: event.clientX, y: event.clientY, phase, key: item.key };
  bwSaveState();
  bwSyncInboxSelectionUi();
  bwRenderInboxMenu();
  bwClampInboxMenu();
}

function bwCloseInboxMenu() {
  if (!bw.inboxMenu) return;
  bw.inboxMenu = null;
  document.querySelector(".bw-inbox-menu")?.remove();
}

function bwClampInboxMenu() {
  setTimeout(() => {
    const menu = document.querySelector(".bw-inbox-menu");
    if (!menu) return;
    const margin = 8;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(margin, Math.min(rect.left, window.innerWidth - rect.width - margin))}px`;
    menu.style.top = `${Math.max(margin, Math.min(rect.top, window.innerHeight - rect.height - margin))}px`;
  }, 0);
}

function bwInboxMenuButton(label, onclick, danger = false) {
  return el("button", {
    class: `bw-menu-item ${danger ? "bw-menu-danger" : ""}`,
    onclick: (e) => {
      e.stopPropagation();
      bw.inboxMenu = null;
      document.querySelector(".bw-inbox-menu")?.remove();
      onclick();
    },
  }, label);
}

function bwInboxContextMenu(inv, floor = null) {
  const menu = bw.inboxMenu;
  if (!menu) return null;
  const selected = bwInboxSelectionFor(menu.phase);
  const selectedCount = selected.length || 1;
  const items = [];
  if (menu.phase === "discovery") {
    items.push(bwInboxMenuButton(`Add ${selectedCount} to Import Plan`, bwQueueSelectedInboxDevices));
    items.push(bwInboxMenuButton(`Ignore ${selectedCount}`, bwIgnoreSelectedInboxDevices, true));
  } else {
    if (floor) items.push(bwInboxMenuButton(selectedCount > 1 ? `Add selected to ${floor.name}` : `Add to ${floor.name}`, () => bwModelQueuedDevicesToFloor(floor.id)));
    items.push(bwInboxMenuButton("Remove from Import Plan", () => bwRemoveQueuedInboxDevices(), true));
  }
  return el("div", {
    class: "bw-context-menu bw-inbox-menu",
    style: `left:${menu.x}px; top:${menu.y}px`,
    onclick: (e) => e.stopPropagation(),
  }, ...items);
}

function bwRenderInboxMenu() {
  document.querySelector(".bw-inbox-menu")?.remove();
  const inv = inventoryInstance();
  if (!inv || !bw.inboxMenu) return;
  const menu = bwInboxContextMenu(inv, bwCurrentFloorForInbox(inv));
  if (menu) document.body.appendChild(menu);
}

function bwEntityContext(inv, entity) {
  if (!entity) return {};
  const equip = entity.type === "equip" ? entity : inv.getEntity(entity.equipId);
  const floor = entity.type === "floor" ? entity : inv.getEntity(entity.floorId || equip?.floorId || equip?.parentId);
  const building = entity.type === "building" ? entity : inv.getEntity(entity.buildingId || floor?.buildingId || floor?.parentId);
  const site = entity.type === "site" ? entity : inv.getEntity(entity.siteId || building?.siteId || building?.parentId);
  return { site, building, floor, equip };
}

function bwTreeEntityOrder(inv) {
  const out = [];
  const pushEquip = (equip) => {
    out.push(equip);
    out.push(...inv.listEntities({ type: "point", equipId: equip.id }));
  };
  for (const site of inv.listEntities({ type: "site" })) {
    out.push(site);
    for (const building of inv.listEntities({ type: "building", siteId: site.id })) {
      out.push(building);
      for (const floor of inv.listEntities({ type: "floor", buildingId: building.id })) {
        out.push(floor);
        for (const equip of inv.listEntities({ type: "equip", floorId: floor.id })) pushEquip(equip);
        out.push(...inv.listEntities({ type: "point", floorId: floor.id }).filter((p) => !p.equipId));
      }
      for (const equip of inv.listEntities({ type: "equip", buildingId: building.id }).filter((e) => !e.floorId)) pushEquip(equip);
      out.push(...inv.listEntities({ type: "point", buildingId: building.id }).filter((p) => !p.floorId && !p.equipId));
    }
    for (const equip of inv.listEntities({ type: "equip", siteId: site.id }).filter((e) => !e.buildingId && !e.floorId)) pushEquip(equip);
    out.push(...inv.listEntities({ type: "point", siteId: site.id }).filter((p) => !p.buildingId && !p.floorId && !p.equipId));
  }
  return out;
}

function bwSetSelection(ids, primaryId = ids.at(-1) || "") {
  const unique = [...new Set(ids.filter(Boolean))];
  bw.selectedEntityIds = unique;
  bw.selectedEntityId = primaryId || unique.at(-1) || "";
}

function bwSelectTreeEntity(entity, event = null) {
  const inv = inventoryInstance();
  if (!inv) return;
  bw.contextMenu = null;
  if (!entity) {
    bwSetSelection([]);
    bw.selectionAnchorId = "";
    bwSaveState();
    bwRenderModelScope({ tree: true, details: true, header: true });
    return;
  }
  if (event?.shiftKey) {
    const order = bwTreeEntityOrder(inv).map((e) => e.id);
    const anchor = bw.selectionAnchorId && order.includes(bw.selectionAnchorId) ? bw.selectionAnchorId : bw.selectedEntityId;
    const a = order.indexOf(anchor);
    const b = order.indexOf(entity.id);
    if (a >= 0 && b >= 0) bwSetSelection(order.slice(Math.min(a, b), Math.max(a, b) + 1), entity.id);
    else bwSetSelection([entity.id], entity.id);
  } else if (event?.ctrlKey || event?.metaKey) {
    const current = new Set(bw.selectedEntityIds);
    if (current.has(entity.id)) current.delete(entity.id);
    else current.add(entity.id);
    bwSetSelection([...current], entity.id);
    bw.selectionAnchorId = entity.id;
  } else {
    bwSetSelection([entity.id], entity.id);
    bw.selectionAnchorId = entity.id;
  }
  const { site, building, floor } = bwEntityContext(inv, entity);
  bw.selectedSiteId = site?.id || "";
  bw.selectedBuildingId = building?.id || "";
  bw.selectedFloorId = floor?.id || "";
  if (entity.type === "site") {
    bw.selectedSiteId = entity.id;
    bw.selectedBuildingId = "";
    bw.selectedFloorId = "";
  } else if (entity.type === "building") {
    bw.selectedBuildingId = entity.id;
    bw.selectedFloorId = "";
  } else if (entity.type === "floor") {
    bw.selectedFloorId = entity.id;
  }
  bwSaveState();
  bwRenderModelScope({ tree: true, details: true, header: true });
}

function bwOpenTreeMenu(event, kind, entityId = "") {
  event.preventDefault();
  event.stopPropagation();
  bw.contextMenu = { x: event.clientX, y: event.clientY, kind, entityId };
  bwRenderTreeMenu();
  bwClampTreeMenu();
}

function bwCloseTreeMenu() {
  if (!bw.contextMenu) return;
  bw.contextMenu = null;
  document.querySelector(".bw-tree-menu")?.remove();
}

function bwClampTreeMenu() {
  setTimeout(() => {
    const menu = document.querySelector(".bw-context-menu");
    if (!menu) return;
    const margin = 8;
    const rect = menu.getBoundingClientRect();
    const left = Math.max(margin, Math.min(rect.left, window.innerWidth - rect.width - margin));
    const top = Math.max(margin, Math.min(rect.top, window.innerHeight - rect.height - margin));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.maxHeight = `${Math.max(140, window.innerHeight - (margin * 2))}px`;
  }, 0);
}

function bwAddSite() {
  bwStartDraft("site");
}

function bwCommitDraft(nameValue) {
  const inv = inventoryInstance();
  const draft = bw.draft;
  if (!inv || !draft) return null;
  const name = String(nameValue || "").trim();
  bw.draft = null;
  if (!name) {
    bwRenderModelScope({ tree: true, details: true, header: true });
    return null;
  }
  let entity = null;
  if (draft.type === "site") {
    entity = inv.upsertEntity({
      type: "site",
      name,
      tags: { site: true, haystack: "4" },
    });
  } else if (draft.type === "building") {
    const site = inv.getEntity(draft.parentId) || bwEnsureSite(inv);
    entity = inv.upsertEntity({
      type: "building",
      siteId: site.id,
      parentId: site.id,
      name,
      tags: { building: true },
    });
  } else if (draft.type === "floor") {
    const building = inv.getEntity(draft.parentId);
    if (!building) {
      bwRenderModelScope({ tree: true, details: true, header: true });
      return null;
    }
    const site = inv.getEntity(building.siteId || building.parentId);
    entity = inv.upsertEntity({
      type: "floor",
      siteId: site?.id || building.siteId,
      buildingId: building.id,
      parentId: building.id,
      name,
      tags: { floor: true },
    });
  } else if (draft.type === "equip") {
    const floor = inv.getEntity(draft.parentId);
    if (!floor) {
      bwRenderModelScope({ tree: true, details: true, header: true });
      return null;
    }
    const building = inv.getEntity(floor.buildingId || floor.parentId);
    entity = inv.upsertEntity({
      type: "equip",
      siteId: floor.siteId || building?.siteId,
      buildingId: building?.id || floor.buildingId,
      floorId: floor.id,
      parentId: floor.id,
      name,
      tags: { equip: true, device: true },
    });
  } else if (draft.type === "point") {
    const parent = inv.getEntity(draft.parentId);
    if (!parent) {
      bwRenderModelScope({ tree: true, details: true, header: true });
      return null;
    }
    const ctx = bwEntityContext(inv, parent);
    const floor = parent.type === "floor" ? parent : ctx.floor;
    const equip = parent.type === "equip" ? parent : ctx.equip;
    entity = inv.upsertEntity({
      type: "point",
      siteId: ctx.site?.id || parent.siteId,
      buildingId: ctx.building?.id || parent.buildingId,
      floorId: floor?.id || parent.floorId,
      equipId: equip?.id || "",
      parentId: equip?.id || floor?.id,
      name,
      tags: { point: true },
    });
  }
  if (!entity) {
    bwRenderModelScope({ tree: true, details: true, header: true });
    return null;
  }
  logTo("building-workspace", `Added ${bwTreeNodeLabel(entity).toLowerCase()} ${entity.name}.`, "ok");
  bwSelectTreeEntity(entity);
  return entity;
}

function bwAddBuilding(siteId) {
  bwStartDraft("building", siteId);
}

function bwAddFloor(buildingId) {
  bwStartDraft("floor", buildingId);
}

function bwBatchFloorName(pattern, n) {
  const p = String(pattern || "").trim() || "Floor {n}";
  return /(\{n\}|#)/.test(p) ? p.replace(/\{n\}|#/g, String(n)) : `${p} ${n}`;
}

function bwBatchFloorNumber(startText, offset) {
  const raw = String(startText || "").trim();
  const n = Number.parseInt(raw, 10) + offset;
  if (!Number.isFinite(n)) return "";
  const width = /^\d+$/.test(raw) && raw.length > 1 && raw.startsWith("0") ? raw.length : 0;
  return width ? String(n).padStart(width, "0") : String(n);
}

function bwFocusBatchFloors() {
  setTimeout(() => {
    const input = document.querySelector("[data-bw-floor-batch-pattern='1']");
    if (!input) return;
    input.focus();
    input.select();
  }, 0);
}

function bwPrepareBatchFloors(building) {
  const inv = inventoryInstance();
  const floors = inv && building ? inv.listEntities({ type: "floor", buildingId: building.id }) : [];
  bw.floorBatchStart = String(floors.length + 1);
  bwSelectTreeEntity(building);
  bwFocusBatchFloors();
}

function bwBatchAddFloors(buildingId) {
  const inv = inventoryInstance();
  const building = inv && inv.getEntity(buildingId);
  if (!inv || !building) return;
  const site = inv.getEntity(building.siteId || building.parentId);
  const startText = String(bw.floorBatchStart || "").trim();
  const start = Number.parseInt(startText, 10);
  const count = Number.parseInt(bw.floorBatchCount, 10);
  if (!Number.isFinite(start) || !Number.isFinite(count) || count < 1) {
    logTo("building-workspace", "Batch floors need a valid start number and count.", "warn");
    bwRenderModelScope({ tree: true, details: true });
    return;
  }
  const total = Math.min(count, 200);
  const created = [];
  const skipped = [];
  for (let i = 0; i < total; i++) {
    const n = bwBatchFloorNumber(startText, i);
    const name = bwBatchFloorName(bw.floorBatchPattern, n);
    if (bwEntityByName(inv, { type: "floor", buildingId: building.id }, name)) {
      skipped.push(name);
      continue;
    }
    created.push(inv.upsertEntity({
      type: "floor",
      siteId: site?.id || building.siteId,
      buildingId: building.id,
      parentId: building.id,
      name,
      tags: { floor: true },
    }));
  }
  if (created.length) {
    const last = created.at(-1);
    bwSetSelection([last.id], last.id);
    bw.selectionAnchorId = last.id;
    bw.selectedSiteId = last.siteId || "";
    bw.selectedBuildingId = building.id;
    bw.selectedFloorId = last.id;
    bwSaveState();
  }
  const skippedMsg = skipped.length ? ` Skipped ${skipped.length} duplicate${skipped.length === 1 ? "" : "s"}.` : "";
  logTo("building-workspace", `Added ${created.length} floor${created.length === 1 ? "" : "s"} to ${building.name}.${skippedMsg}`, created.length ? "ok" : "warn");
  bwRenderModelScope({ tree: true, details: true, header: true });
}

function bwSyncInboxSelectionUi() {
  const selected = new Set(bw.deviceInbox?.selectedKeys || []);
  const phase = bw.deviceInbox?.phase || "discovery";
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
  if (add) add.disabled = !add.dataset.floorId || Number(add.dataset.queuedCount || 0) === 0;
}

function bwApplyDeviceInboxFilter() {
  bwSaveState();
  const inv = inventoryInstance();
  const body = document.getElementById("bw-discovered-device-rows");
  if (!inv || !body) return;
  body.replaceChildren(...bwDiscoveredDeviceRows(inv));
  bwSyncInboxSelectionUi();
}

function bwDiscoveryDragAttrs(item, canDrag) {
  if (!canDrag) return {};
  return {
    draggable: "true",
    title: "Drag to Import Plan",
    ondragstart: (e) => bwDragDiscoveryDevices(item, e),
    ondragend: () => { bwInboxDragKeys = []; },
  };
}

function bwQueueSelectedInboxDevices() {
  const inv = inventoryInstance();
  if (!inv) return;
  const selected = bwInboxSelectionFor("discovery");
  const floor = bwCurrentFloorForInbox(inv);
  bw.deviceInbox.candidates = bwQueueInboxDevices({
    candidates: bw.deviceInbox.candidates || {},
    keys: selected,
    devices: bacnet.getDevices() || [],
    modeledDevices: inv.listEntities({ type: "equip" }),
    targetFloorId: floor?.id || "",
  });
  const queued = selected.filter((key) => bw.deviceInbox.candidates[key]?.status === "queued");
  bwSetInboxSelection("modeling", queued, queued.at(-1) || "");
  logTo("building-workspace", `Queued ${queued.length} device${queued.length === 1 ? "" : "s"} for modeling.`, queued.length ? "ok" : "warn");
  bwSaveState();
  bwRenderInboxScope();
}

let bwInboxDragKeys = [];

function bwDragDiscoveryDevices(item, event) {
  const selected = bwInboxSelectionFor("discovery");
  const keys = bw.deviceInbox.phase === "discovery" && selected.includes(item.key) ? selected : [item.key];
  bwSetInboxSelection("discovery", keys, item.key);
  bw.inboxMenu = null;
  bwInboxDragKeys = keys;
  event.stopPropagation();
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData("application/x-stier-bacnet-device-keys", JSON.stringify(keys));
  event.dataTransfer.setData("text/plain", keys.join(","));
  bwSyncInboxSelectionUi();
}

function bwImportPlanDragOver(event) {
  const types = Array.from(event.dataTransfer.types || []);
  if (!bwInboxDragKeys.length && !types.includes("application/x-stier-bacnet-device-keys") && !types.includes("text/plain")) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  event.currentTarget.classList.add("bw-import-plan-drop");
}

function bwImportPlanDragLeave(event) {
  event.currentTarget.classList.remove("bw-import-plan-drop");
}

function bwImportPlanDrop(event) {
  event.preventDefault();
  event.currentTarget.classList.remove("bw-import-plan-drop");
  const raw = event.dataTransfer.getData("application/x-stier-bacnet-device-keys");
  try {
    const keys = raw ? JSON.parse(raw) : bwInboxDragKeys;
    if (Array.isArray(keys) && keys.length) {
      bwSetInboxSelection("discovery", keys, keys.at(-1));
      bwQueueSelectedInboxDevices();
    }
  } catch (_) {
    // Ignore malformed drag payloads from outside the app.
  } finally {
    bwInboxDragKeys = [];
  }
}

function bwIgnoreSelectedInboxDevices() {
  const selected = bwInboxSelectionFor("discovery");
  if (!selected.length) return;
  const next = { ...(bw.deviceInbox.candidates || {}) };
  for (const key of selected) {
    next[key] = {
      ...(next[key] || {}),
      key,
      status: "ignored",
      discoveredAt: next[key]?.discoveredAt || new Date().toISOString(),
    };
  }
  bw.deviceInbox.candidates = next;
  bwSetInboxSelection("discovery", []);
  bwSaveState();
  bwRenderInboxScope();
}

function bwRemoveQueuedInboxDevices(keys = bwInboxSelectionFor("modeling")) {
  bw.deviceInbox.candidates = bwRemoveQueuedDevices(bw.deviceInbox.candidates || {}, keys);
  bwSetInboxSelection("modeling", []);
  bwSaveState();
  bwRenderInboxScope();
}

function bwClearDeviceDiscovery() {
  bacnet.clearDiscovery();
  bw.deviceInbox.candidates = {};
  bwSetInboxSelection("discovery", []);
  bwSaveState();
  bwRenderInboxScope();
}

function bwModelQueuedDevicesToFloor(floorId, keys = null) {
  const inv = inventoryInstance();
  const floor = inv && inv.getEntity(floorId);
  if (!inv || !floor) return;
  const building = inv.getEntity(floor.buildingId || floor.parentId);
  const site = inv.getEntity(floor.siteId || building?.siteId);
  if (!site || !building) return;
  const selectedKeys = Array.isArray(keys)
    ? keys
    : (bw.deviceInbox.phase === "modeling" ? bwInboxSelectionFor("modeling") : []);
  const modelKeys = selectedKeys.length
    ? selectedKeys
    : Object.values(bw.deviceInbox.candidates || {}).filter((c) => c?.status === "queued").map((c) => c.key);
  const result = bwModelQueuedDevices({
    inventory: inv,
    devices: bacnet.getDevices() || [],
    candidates: bw.deviceInbox.candidates || {},
    floor,
    site,
    building,
    makeEntity: bwDeviceEntityFromBacnet,
    keys: modelKeys,
  });
  bw.deviceInbox.candidates = result.candidates;
  const imported = result.imported || [];
  if (imported.length) {
    bwSetSelection(imported.map((d) => d.id), imported.at(-1).id);
    bw.selectionAnchorId = imported.at(-1).id;
    bw.selectedSiteId = site.id;
    bw.selectedBuildingId = building.id;
    bw.selectedFloorId = floor.id;
  }
  bwSetInboxSelection("modeling", []);
  bwSaveState();
  logTo("building-workspace",
    `Added ${imported.length} queued device${imported.length === 1 ? "" : "s"} to ${floor.name}.${result.skipped ? ` Skipped ${result.skipped}.` : ""}`,
    imported.length ? "ok" : "warn");
  bwRenderInboxScope();
}

function bwImportDiscoveredDevicesToFloor(floorId, keys = null) {
  const inv = inventoryInstance();
  if (!inv) return;
  const importKeys = Array.isArray(keys) && keys.length ? keys : bwInboxSelectionFor("discovery");
  bw.deviceInbox.candidates = bwQueueInboxDevices({
    candidates: bw.deviceInbox.candidates || {},
    keys: importKeys,
    devices: bacnet.getDevices() || [],
    modeledDevices: inv.listEntities({ type: "equip" }),
    targetFloorId: floorId,
  });
  bwModelQueuedDevicesToFloor(floorId, importKeys);
}

// State for the Building Workspace "Discover & import points" review modal.
let bwPointImport = null;

async function bwDiscoverDevicePoints(equipId) {
  const inv = inventoryInstance();
  const equip = inv && inv.getEntity(equipId);
  if (!inv || !equip) return;
  const site = inv.getEntity(equip.siteId);
  const building = inv.getEntity(equip.buildingId);
  const floor = inv.getEntity(equip.floorId || equip.parentId);
  const deviceRef = equip.deviceRef || { deviceInstance: equip.deviceInstance };
  const deviceInstance = Number(equip.deviceInstance ?? deviceRef.deviceInstance ?? deviceRef.instance);
  if (!Number.isFinite(deviceInstance)) {
    logTo("building-workspace", `${equip.name} is missing a BACnet device instance.`, "warn");
    return;
  }
  bw.busy = true;
  bwRenderModelScope({ details: true });
  try {
    const bacnetApi = getPlatform() ? getPlatform().capability("bacnet.read.v1") : bacnet.bacnetRead();
    const objects = (await bacnetApi.listObjects(deviceRef, deviceInstance)) || [];
    const device = { ...deviceRef, instance: deviceInstance, deviceInstance };
    // Pre-skip objects already modeled as points under this equip.
    const existing = new Set(
      inv.listEntities({ type: "point", equipId: equip.id }).flatMap((p) => p.sourceRefs || []),
    );
    const refOf = (o) => `bacnet:${deviceInstance}:${o.objectType}:${o.instance}`;
    bwPointImport = {
      equip, site, building, floor, device, objects, existing,
      selection: new Set(objects.filter((o) => !existing.has(refOf(o))).map((o) => `${o.objectType}:${o.instance}`)),
      q: "", typeFilter: new Set(), typesOpen: false, min: "", max: "", template: "",
    };
    if (!objects.length) {
      logTo("building-workspace", `No objects returned from ${equip.name}.`, "warn");
    }
    bwOpenPointImportModal();
  } catch (err) {
    logTo("building-workspace", `Point discovery failed for ${equip.name}: ${err}`, "error");
  } finally {
    bw.busy = false;
    bwRenderModelScope({ tree: true, details: true, header: true });
  }
}

function bwPointImportRefOf(o) {
  return `bacnet:${bwPointImport.device.deviceInstance}:${o.objectType}:${o.instance}`;
}

function bwPointImportFiltered() {
  const s = bwPointImport;
  return s.objects.filter((o) => bacObjectMatches(o, { q: s.q, types: s.typeFilter, min: s.min, max: s.max }));
}

function bwOpenPointImportModal() {
  const s = bwPointImport;
  if (!s) return;
  openModal({ title: `Discover & import points — ${s.equip.name}`, body: bwPointImportBody() });
}

function bwPointImportBody() {
  const s = bwPointImport;
  return el("div", { class: "bw-import" },
    el("p", { class: "muted small" },
      `${s.objects.length} object${s.objects.length === 1 ? "" : "s"} on device ${s.device.deviceInstance}. `
      + `Importing into ${s.floor?.name || "this floor"} under ${s.equip.name}. Already-modeled objects start unticked.`),
    bwPointImportToolbar(),
    el("div", { class: "bw-import-listwrap" },
      el("ul", { id: "bw-import-list", class: "bac-object-list" }, ...bwPointImportRows())),
    bwPointImportFooter(),
  );
}

function bwPointImportToolbar() {
  const s = bwPointImport;
  const types = [...new Set(s.objects.map((o) => o.typeName))].sort((a, b) => String(a).localeCompare(String(b)));
  return el("div", { class: "bac-object-toolbar" },
    el("input", {
      type: "search", class: "nm-input bac-object-filter", placeholder: "Filter objects…",
      "aria-label": "Filter objects", value: s.q,
      oninput: (e) => { s.q = e.target.value; bwPointImportRefresh(); },
    }),
    el("div", { class: "bac-object-range" },
      el("span", { class: "muted small" }, "Instance"),
      el("input", { type: "number", class: "nm-input bac-range-input", placeholder: "min", "aria-label": "Minimum instance", value: s.min, oninput: (e) => { s.min = e.target.value; bwPointImportRefresh(); } }),
      el("span", { class: "muted small" }, "–"),
      el("input", { type: "number", class: "nm-input bac-range-input", placeholder: "max", "aria-label": "Maximum instance", value: s.max, oninput: (e) => { s.max = e.target.value; bwPointImportRefresh(); } }),
    ),
    types.length
      ? el("details", {
          class: "bac-type-filter", open: s.typesOpen ? "open" : undefined,
          ontoggle: (e) => { s.typesOpen = e.target.open; },
        },
          el("summary", {}, `Types${s.typeFilter.size ? ` (${s.typeFilter.size})` : ""}`),
          el("div", { class: "bac-type-chips" }, ...types.map((t) => {
            const on = s.typeFilter.has(t);
            return el("button", {
              type: "button", class: `bac-type-chip${on ? " bac-type-chip-on" : ""}`,
              onclick: () => { if (s.typeFilter.has(t)) s.typeFilter.delete(t); else s.typeFilter.add(t); bwOpenPointImportModal(); },
            }, t);
          })),
        )
      : null,
  );
}

function bwPointImportRows() {
  const s = bwPointImport;
  const objects = bwPointImportFiltered();
  if (!objects.length) {
    return [el("li", { class: "muted small bac-object-empty" }, s.objects.length ? "No objects match the filter." : "No objects on this device.")];
  }
  const sorted = [...objects].sort((a, b) =>
    String(a.typeName).localeCompare(String(b.typeName)) || Number(a.instance) - Number(b.instance));
  const countByType = sorted.reduce((m, o) => m.set(o.typeName, (m.get(o.typeName) || 0) + 1), new Map());
  const rows = [];
  let lastType = null;
  for (const o of sorted) {
    if (o.typeName !== lastType) {
      lastType = o.typeName;
      rows.push(el("li", { class: "bac-object-group", role: "presentation" },
        el("span", {}, lastType), el("span", { class: "muted small" }, String(countByType.get(lastType)))));
    }
    const key = `${o.objectType}:${o.instance}`;
    const checked = s.selection.has(key);
    const already = s.existing.has(bwPointImportRefOf(o));
    rows.push(el("li", { class: `bac-object-row bw-import-row${checked ? " bac-object-checked" : ""}` },
      el("input", {
        type: "checkbox", class: "bac-object-check", checked: checked ? "checked" : undefined,
        "aria-label": `Import ${o.typeName}:${o.instance}`,
        onclick: (e) => { if (e.target.checked) s.selection.add(key); else s.selection.delete(key); bwPointImportRefresh(); },
      }),
      el("span", { class: "bac-object-type" }, `${o.typeName}:${o.instance}`),
      el("span", { class: "bac-object-name" }, o.name || "", already ? el("span", { class: "muted small bw-import-already" }, " · modeled") : null),
    ));
  }
  return rows;
}

function bwPointImportFooter() {
  const s = bwPointImport;
  const n = s.selection.size;
  const visible = bwPointImportFiltered();
  return el("div", { id: "bw-import-footer", class: "bw-import-footer" },
    el("input", {
      type: "text", class: "nm-input bac-name-template",
      placeholder: "Name template (optional), e.g. {equip}-{type}{instance}",
      title: "Tokens: {equip} {type} {instance} {name}. Blank keeps each object's own name.",
      "aria-label": "Point name template", value: s.template,
      oninput: (e) => { s.template = e.target.value; },
    }),
    el("button", { type: "button", class: "btn-ghost", onclick: () => { for (const o of visible) s.selection.add(`${o.objectType}:${o.instance}`); bwPointImportRefresh(); } }, `Select all (${visible.length})`),
    el("button", { type: "button", class: "btn-ghost", onclick: () => { s.selection.clear(); bwPointImportRefresh(); } }, "Select none"),
    el("button", {
      type: "button", class: "btn bac-bulk-import", disabled: n ? undefined : "disabled",
      onclick: bwImportSelectedPoints,
    }, n ? `Import ${n} point${n === 1 ? "" : "s"}` : "Import points"),
  );
}

function bwPointImportRefresh() {
  const list = document.getElementById("bw-import-list");
  if (list) list.replaceChildren(...bwPointImportRows());
  const footer = document.getElementById("bw-import-footer");
  if (footer) footer.replaceWith(bwPointImportFooter());
}

function bwImportSelectedPoints() {
  const s = bwPointImport;
  const inv = inventoryInstance();
  if (!s || !inv) return;
  const chosen = s.objects.filter((o) => s.selection.has(`${o.objectType}:${o.instance}`));
  if (!chosen.length) { toast("Select one or more objects first.", "warn"); return; }
  // Every object belongs to this one device → model all points under the selected equip.
  const plan = bwPlanDeviceObjects({ device: s.device, objects: chosen, template: s.template });
  const points = bwModelObjectsBatch({
    siteId: s.equip.siteId, buildingId: s.equip.buildingId,
    floorId: s.equip.floorId || s.equip.parentId, device: s.device, items: plan.items,
  }).map((p) => ({ ...p, equipId: s.equip.id }));
  const saved = inv.upsertMany(points);
  bwSaveState();
  closeModal();
  logTo("building-workspace", `Imported ${saved.length} point${saved.length === 1 ? "" : "s"} into ${s.equip.name}.`, "ok");
  toast(`Imported ${saved.length} point${saved.length === 1 ? "" : "s"} into ${s.equip.name}.`, "ok");
  const refreshed = bwRefreshHistorianForEntity(inv, inv.getEntity(s.equip.id) || s.equip);
  if (refreshed) histPersist();
  bwSelectTreeEntity(inv.getEntity(s.equip.id) || s.equip);
}

function bwAddDevice(floorId) {
  bwStartDraft("equip", floorId);
}

function bwAddPoint(parentId) {
  bwStartDraft("point", parentId);
}

function bwRenameEntity(entityId) {
  const inv = inventoryInstance();
  const entity = inv && inv.getEntity(entityId);
  if (!entity) return;
  const name = bwPromptName(`${entity.type[0].toUpperCase() + entity.type.slice(1)} name`, entity.name);
  if (!name) return;
  const renamed = inv.upsertEntity({ ...entity, name });
  const refreshed = bwRefreshHistorianForEntity(inv, renamed);
  logTo("building-workspace", `Renamed ${entity.type} to ${renamed.name}${refreshed ? ` and refreshed ${refreshed} historian point${refreshed === 1 ? "" : "s"}` : ""}.`, "ok");
  bwSelectTreeEntity(renamed);
}

function bwAffectedPoints(inv, entity) {
  if (!entity) return [];
  if (entity.type === "point") return [entity];
  if (entity.type === "site") return inv.listEntities({ type: "point", siteId: entity.id });
  if (entity.type === "building") return inv.listEntities({ type: "point", buildingId: entity.id });
  if (entity.type === "floor") return inv.listEntities({ type: "point", floorId: entity.id });
  if (entity.type === "equip") return inv.listEntities({ type: "point", equipId: entity.id });
  return [];
}

function bwHistorianKey(point) {
  const device = point.device || {};
  return `${device.deviceInstance ?? device.instance ?? device.id ?? "?"}:${point.objectType}:${point.instance}`;
}

function bwHistorianRecordForPoint(inv, point) {
  const site = inv.getEntity(point.siteId);
  const building = inv.getEntity(point.buildingId);
  const floor = inv.getEntity(point.floorId);
  const equip = inv.getEntity(point.equipId);
  return historianPointFromEntity(point, { site, building, floor, equip });
}

function bwRefreshHistorianForEntity(inv, entity) {
  const hist = historianInstance();
  if (!hist) return 0;
  const tracked = new Set(hist.points().map(bwHistorianKey));
  let refreshed = 0;
  for (const point of bwAffectedPoints(inv, entity)) {
    try {
      const record = bwHistorianRecordForPoint(inv, point);
      if (!tracked.has(bwHistorianKey(record))) continue;
      hist.addPoint(record);
      refreshed++;
    } catch (_) {
      // Manual/unbound points do not have BACnet historian records yet.
    }
  }
  if (refreshed) histPersist();
  return refreshed;
}

function bwDescendantIds(inv, entity) {
  if (!entity) return [];
  const entities = inv.listEntities();
  const directChildren = (parent) => entities.filter((e) =>
    e.parentId === parent.id ||
    (parent.type === "site" && e.siteId === parent.id && e.id !== parent.id) ||
    (parent.type === "building" && e.buildingId === parent.id && e.id !== parent.id) ||
    (parent.type === "floor" && e.floorId === parent.id && e.id !== parent.id) ||
    (parent.type === "equip" && e.equipId === parent.id && e.id !== parent.id));
  const out = [];
  const visit = (parent) => {
    for (const child of directChildren(parent)) {
      if (out.includes(child.id)) continue;
      out.push(child.id);
      visit(child);
    }
  };
  visit(entity);
  return out;
}

function bwRemoveEntityTree(entityId) {
  const inv = inventoryInstance();
  const entity = inv && inv.getEntity(entityId);
  if (!entity) return;
  const ids = [...bwDescendantIds(inv, entity).reverse(), entity.id];
  if (!confirm(`Remove ${entity.name} and ${ids.length - 1} descendant item(s)?`)) return;
  for (const id of ids) inv.removeEntity(id);
  bwSetSelection([]);
  bw.selectionAnchorId = "";
  logTo("building-workspace", `Removed ${entity.name}.`, "warn");
  bwRenderModelScope({ tree: true, details: true, header: true });
}

function bwHistorizeEquipPoints(equipId) {
  const inv = inventoryInstance();
  if (!inv) return;
  const points = inv.listEntities({ type: "point", equipId });
  points.forEach((p) => bwHistorizePoint(p.id));
}

function bwPointsForEntities(inv, entities) {
  const points = new Map();
  const add = (rows) => rows.forEach((p) => points.set(p.id, p));
  for (const entity of entities) {
    if (entity.type === "point") points.set(entity.id, entity);
    else if (entity.type === "equip") add(inv.listEntities({ type: "point", equipId: entity.id }));
    else if (entity.type === "floor") add(inv.listEntities({ type: "point", floorId: entity.id }));
    else if (entity.type === "building") add(inv.listEntities({ type: "point", buildingId: entity.id }));
    else if (entity.type === "site") add(inv.listEntities({ type: "point", siteId: entity.id }));
  }
  return [...points.values()];
}

function bwHistorizeSelectedEntities() {
  const inv = inventoryInstance();
  if (!inv) return;
  const points = bwPointsForEntities(inv, bwSelectedEntities(inv));
  points.forEach((p) => bwHistorizePoint(p.id));
  if (!points.length) {
    logTo("building-workspace", "Selection has no points to historize.", "warn");
    bwRenderModelScope({ details: true });
  }
}

function bwApplyTemplateToSelected(templateId = bw.template) {
  const inv = inventoryInstance();
  if (!inv) return;
  const devices = bwSelectedEntities(inv).filter((e) => e.type === "equip");
  for (const device of devices) inv.applyTemplate(device.id, templateId);
  logTo("building-workspace", devices.length
    ? `Applied ${templateId} template to ${devices.length} device${devices.length === 1 ? "" : "s"}.`
    : "Selection has no devices to template.",
    devices.length ? "ok" : "warn");
  bwRenderModelScope({ tree: true, details: true });
}

function bwRemoveSelectedEntities() {
  const inv = inventoryInstance();
  if (!inv) return;
  const selected = bwSelectedEntities(inv);
  if (!selected.length) return;
  const ids = new Set();
  for (const entity of selected) {
    ids.add(entity.id);
    for (const id of bwDescendantIds(inv, entity)) ids.add(id);
  }
  if (!confirm(`Remove ${selected.length} selected item(s) and ${ids.size - selected.length} descendant item(s)?`)) return;
  for (const id of [...ids].reverse()) inv.removeEntity(id);
  bwSetSelection([]);
  bw.selectionAnchorId = "";
  logTo("building-workspace", `Removed ${ids.size} model item${ids.size === 1 ? "" : "s"}.`, "warn");
  bwRenderModelScope({ tree: true, details: true, header: true });
}

function bwTreeNodeLabel(entity) {
  if (!entity) return "Model";
  if (entity.type === "equip") return entity.tags?.device ? "Device" : "Equipment";
  return entity.type[0].toUpperCase() + entity.type.slice(1);
}

function bwDraftBelongs(type, parentId = "") {
  return bw.draft && bw.draft.type === type && (bw.draft.parentId || "") === (parentId || "");
}

function bwDraftNode(type, depth, parentId = "") {
  const draft = bwDraftBelongs(type, parentId) ? bw.draft : null;
  if (!draft) return null;
  const onCommit = (input) => bwCommitDraft(input.value);
  return el("li", { class: "bw-tree-item" },
    el("div", {
      class: "bw-tree-node bw-tree-node-on bw-tree-draft-node",
      style: `--depth:${depth}`,
      onclick: (e) => e.stopPropagation(),
      oncontextmenu: (e) => e.preventDefault(),
    },
      el("span", { class: "bw-tree-toggle bw-tree-toggle-empty", "aria-hidden": "true" }),
      el("span", { class: `bw-tree-kind bw-tree-kind-${type}` }, bwTreeNodeLabel({ type, tags: type === "equip" ? { device: true } : {} })[0]),
      el("input", {
        class: "bw-tree-name-input",
        value: draft.name,
        "data-bw-draft-name": "1",
        onkeydown: (e) => {
          if (e.key === "Enter") onCommit(e.currentTarget);
          if (e.key === "Escape") bwCancelDraft();
        },
        onblur: (e) => onCommit(e.currentTarget),
      })));
}

function bwTreeNode(inv, entity, depth, children = []) {
  const selected = bw.selectedEntityIds.includes(entity.id) || bw.selectedEntityId === entity.id;
  const primary = bw.selectedEntityId === entity.id;
  const hasChildren = children.length > 0;
  const collapsed = hasChildren && bwNodeCollapsed(entity.id);
  return el("li", { class: "bw-tree-item" },
    el("button", {
      class: `bw-tree-node ${selected ? "bw-tree-node-on" : ""} ${selected && !primary ? "bw-tree-node-multi" : ""}`,
      style: `--depth:${depth}`,
      title: entity.id,
      onclick: (e) => { e.stopPropagation(); bwSelectTreeEntity(entity, e); },
      oncontextmenu: (e) => bwOpenTreeMenu(e, entity.type, entity.id),
    },
      hasChildren
        ? el("span", {
            class: `bw-tree-toggle ${collapsed ? "" : "bw-tree-toggle-open"}`,
            role: "button",
            "aria-label": collapsed ? `Expand ${entity.name || entity.id}` : `Collapse ${entity.name || entity.id}`,
            "aria-expanded": collapsed ? "false" : "true",
            onclick: (e) => { e.stopPropagation(); bwToggleNodeCollapsed(entity.id); },
          }, "›")
        : el("span", { class: "bw-tree-toggle bw-tree-toggle-empty", "aria-hidden": "true" }),
      el("span", { class: `bw-tree-kind bw-tree-kind-${entity.type}` }, bwTreeNodeLabel(entity)[0]),
      el("span", { class: "bw-tree-name" }, entity.name || entity.id),
      entity.type === "point" && !(entity.sourceRefs || []).length ? el("span", { class: "bw-tree-meta" }, "manual") : null),
    hasChildren && !collapsed ? el("ol", { class: "bw-tree-list" }, ...children) : null);
}

function bwTreePanel(inv) {
  const sites = inv.listEntities({ type: "site" });
  const childrenForSite = (site) => {
    const buildings = inv.listEntities({ type: "building", siteId: site.id });
    const legacyEquips = inv.listEntities({ type: "equip", siteId: site.id }).filter((e) => !e.buildingId && !e.floorId);
    const legacyPoints = inv.listEntities({ type: "point", siteId: site.id }).filter((p) => !p.buildingId && !p.floorId && !p.equipId);
    return [
      ...buildings.map((building) => {
        const floors = inv.listEntities({ type: "floor", buildingId: building.id });
        const buildingEquips = inv.listEntities({ type: "equip", buildingId: building.id }).filter((e) => !e.floorId);
        const buildingPoints = inv.listEntities({ type: "point", buildingId: building.id }).filter((p) => !p.floorId && !p.equipId);
        return bwTreeNode(inv, building, 1, [
          ...floors.map((floor) => {
            const equips = inv.listEntities({ type: "equip", floorId: floor.id });
            const directPoints = inv.listEntities({ type: "point", floorId: floor.id }).filter((p) => !p.equipId);
            const floorChildren = [
              ...equips.map((equip) => bwTreeNode(inv, equip, 3, [
                ...inv.listEntities({ type: "point", equipId: equip.id }).map((p) => bwTreeNode(inv, p, 4)),
                bwDraftNode("point", 4, equip.id),
              ].filter(Boolean))),
              ...directPoints.map((p) => bwTreeNode(inv, p, 3)),
              bwDraftNode("equip", 3, floor.id),
            ];
            return bwTreeNode(inv, floor, 2, floorChildren.filter(Boolean));
          }),
          ...buildingEquips.map((equip) => bwTreeNode(inv, equip, 2, [
            ...inv.listEntities({ type: "point", equipId: equip.id }).map((p) => bwTreeNode(inv, p, 3)),
            bwDraftNode("point", 3, equip.id),
          ].filter(Boolean))),
          ...buildingPoints.map((p) => bwTreeNode(inv, p, 2)),
          bwDraftNode("floor", 2, building.id),
        ].filter(Boolean));
      }),
      ...legacyEquips.map((equip) => bwTreeNode(inv, equip, 1, [
        ...inv.listEntities({ type: "point", equipId: equip.id }).map((p) => bwTreeNode(inv, p, 2)),
        bwDraftNode("point", 2, equip.id),
      ].filter(Boolean))),
      ...legacyPoints.map((p) => bwTreeNode(inv, p, 1)),
      bwDraftNode("building", 1, site.id),
    ];
  };
  const siteNodes = [
    ...sites.map((site) => bwTreeNode(inv, site, 0, childrenForSite(site).filter(Boolean))),
    bwDraftNode("site", 0),
  ].filter(Boolean);
  return el("section", {
    id: "bw-model-tree-panel",
    class: "plugin-section bw-tree-section",
    onclick: bwCloseTreeMenu,
    oncontextmenu: (e) => bwOpenTreeMenu(e, "root"),
  },
    el("div", { class: "section-head" },
      el("h3", {}, "Model Tree"),
      el("span", { class: "muted small" }, `${sites.length} site${sites.length === 1 ? "" : "s"}`)),
    el("div", { class: "bw-tree-scroll" },
      el("button", {
        class: `bw-tree-node bw-tree-root ${!bw.selectedEntityId && bw.selectedEntityIds.length === 0 ? "bw-tree-node-on" : ""}`,
        style: "--depth:0",
        onclick: (e) => { e.stopPropagation(); bwSelectTreeEntity(null); },
      oncontextmenu: (e) => bwOpenTreeMenu(e, "root"),
    },
        el("span", { class: "bw-tree-toggle bw-tree-toggle-empty", "aria-hidden": "true" }),
        el("span", { class: "bw-tree-kind" }, "M"),
        el("span", { class: "bw-tree-name" }, "Model")),
      siteNodes.length
        ? el("ol", { class: "bw-tree-list bw-tree-list-root" },
            ...siteNodes)
        : el("p", { class: "muted small" }, "Right-click Model to add a site.")),
    bwTreeContextMenu(inv));
}

function bwMenuButton(label, action, danger = false) {
  return el("button", {
    class: danger ? "bw-menu-item bw-menu-danger" : "bw-menu-item",
    onclick: (e) => {
      e.stopPropagation();
      bw.contextMenu = null;
      document.querySelector(".bw-tree-menu")?.remove();
      action();
    },
  }, label);
}

function bwTreeContextMenu(inv) {
  const menu = bw.contextMenu;
  if (!menu) return null;
  const entity = menu.entityId ? inv.getEntity(menu.entityId) : null;
  const items = [];
  const selected = bwSelectedEntities(inv);
  if (entity && selected.length > 1 && selected.some((e) => e.id === entity.id)) {
    items.push(bwMenuButton("Historize selection", bwHistorizeSelectedEntities));
    items.push(bwMenuButton("Apply template to devices", () => bwApplyTemplateToSelected(bw.template)));
    items.push(bwMenuButton("Clear selection", () => { bwSetSelection([]); bw.selectionAnchorId = ""; bwSaveState(); bwRenderModelScope({ tree: true, details: true, header: true }); }));
    items.push(bwMenuButton("Remove selection", bwRemoveSelectedEntities, true));
    return el("div", {
      class: "bw-context-menu bw-tree-menu",
      style: `left:${menu.x}px; top:${menu.y}px`,
      onclick: (e) => e.stopPropagation(),
    }, ...items);
  }
  if (menu.kind === "root") {
    items.push(bwMenuButton("Add site", bwAddSite));
  } else if (entity?.type === "site") {
    items.push(bwMenuButton("Add building", () => bwAddBuilding(entity.id)));
    items.push(bwMenuButton("Rename site", () => bwRenameEntity(entity.id)));
    items.push(bwMenuButton("Remove site", () => bwRemoveEntityTree(entity.id), true));
  } else if (entity?.type === "building") {
    items.push(bwMenuButton("Add floor", () => bwAddFloor(entity.id)));
    items.push(bwMenuButton("Batch add floors", () => bwPrepareBatchFloors(entity)));
    items.push(bwMenuButton("Rename building", () => bwRenameEntity(entity.id)));
    items.push(bwMenuButton("Remove building", () => bwRemoveEntityTree(entity.id), true));
  } else if (entity?.type === "floor") {
    items.push(bwMenuButton("Add device", () => bwAddDevice(entity.id)));
    items.push(bwMenuButton("Rename floor", () => bwRenameEntity(entity.id)));
    items.push(bwMenuButton("Remove floor", () => bwRemoveEntityTree(entity.id), true));
  } else if (entity?.type === "equip") {
    items.push(bwMenuButton("Add point", () => bwAddPoint(entity.id)));
    items.push(bwMenuButton("Apply template", () => bwApplyTemplate(entity.id, bw.template)));
    items.push(bwMenuButton("Historize points", () => bwHistorizeEquipPoints(entity.id)));
    items.push(bwMenuButton("Rename device", () => bwRenameEntity(entity.id)));
    items.push(bwMenuButton("Remove device", () => bwRemoveEntityTree(entity.id), true));
  } else if (entity?.type === "point") {
    items.push(bwMenuButton("Historize point", () => bwHistorizePoint(entity.id)));
    items.push(bwMenuButton("Rename point", () => bwRenameEntity(entity.id)));
    items.push(bwMenuButton("Remove point", () => bwRemoveEntityTree(entity.id), true));
  }
  return el("div", {
    class: "bw-context-menu bw-tree-menu",
    style: `left:${menu.x}px; top:${menu.y}px`,
    onclick: (e) => e.stopPropagation(),
  }, ...items);
}

function bwRenderTreeMenu() {
  document.querySelector(".bw-tree-menu")?.remove();
  const inv = inventoryInstance();
  if (!inv || !bw.contextMenu) return;
  const menu = bwTreeContextMenu(inv);
  if (menu) document.body.appendChild(menu);
}

function bwPointRows(inv) {
  return inv.listEntities({ type: "point" });
}

function bwSetTab(tab) {
  bw.tab = tab;
  bwSaveState();
  bwRenderWorkspaceScope();
  setTimeout(bwSyncLivePoll, 0); // start/stop live poll for the new tab (after it mounts)
}

function bwTabs() {
  const tabs = [
    ["model", "Model"],
    ["bacnet", "BACnet"],
    ["historian", "Historian"],
    ["dashboard", "Dashboard"],
    ["commissioning", "Commissioning"],
    ["reports", "Reports"],
  ];
  return el("div", { class: "bw-tabs" },
    ...tabs.map(([tab, label]) =>
      el("button", {
        class: `bw-tab ${bw.tab === tab ? "bw-tab-on" : ""}`,
        onclick: () => bwSetTab(tab),
      }, label)));
}

function bwDownload(filename, text, type = "text/plain;charset=utf-8") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function bwHistorizePoint(pointId) {
  const inv = inventoryInstance();
  const hist = historianInstance();
  if (!inv || !hist) return;
  const point = inv.getEntity(pointId);
  if (!point) return;
  const site = inv.getEntity(point.siteId);
  const building = inv.getEntity(point.buildingId);
  const floor = inv.getEntity(point.floorId);
  const equip = inv.getEntity(point.equipId);
  try {
    hist.addPoint(historianPointFromEntity(point, { site, building, floor, equip }));
    histPersist();
    logTo("building-workspace", `Historizing ${point.name}.`, "ok");
    bwRenderTabScope();
  } catch (err) {
    logTo("building-workspace", `Could not historize ${point.name}: ${err}`, "error");
  }
}

function bwHistorizeSelectedObject(obj) {
  const inv = inventoryInstance();
  const dev = bacnet.getSelectedDevice();
  if (!inv || !dev || !obj) return;
  const { site, building, floor } = bwEnsureLocation(inv);
  const equipName = suggestEquipmentName(obj.name || "", `Device ${dev.instance}`);
  let equip = bwEntityByName(inv, { type: "equip", floorId: floor.id }, equipName)
    || inv.upsertEntity({
      type: "equip",
      siteId: site.id,
      buildingId: building.id,
      floorId: floor.id,
      parentId: floor.id,
      name: equipName,
      tags: { equip: true },
    });
  equip = inv.applyTemplate(equip.id, bwTemplateForName(equipName));
  const point = inv.upsertEntity(pointEntityFromBacnet({
    siteId: site.id,
    buildingId: building.id,
    floorId: floor.id,
    equipId: equip.id,
    device: dev,
    object: obj,
    props: bacnet.getPropsForObject(obj),
  }));
  bwHistorizePoint(point.id);
}

function bwApplyTemplate(entityId, templateId) {
  const inv = inventoryInstance();
  if (!inv) return;
  inv.applyTemplate(entityId, templateId);
  logTo("building-workspace", `Applied ${templateId} template.`, "ok");
  bwRenderModelScope({ tree: true, details: true });
}

function bwSelectedEntity(inv) {
  if (!bw.selectedEntityId) return null;
  const entity = inv.getEntity(bw.selectedEntityId);
  if (!entity) {
    bwSetSelection([]);
    bwSaveState();
    return null;
  }
  return entity;
}

function bwSelectedEntities(inv) {
  const ids = bw.selectedEntityIds.length ? bw.selectedEntityIds : (bw.selectedEntityId ? [bw.selectedEntityId] : []);
  const entities = ids.map((id) => inv.getEntity(id)).filter(Boolean);
  if (entities.length !== ids.length) {
    bwSetSelection(entities.map((e) => e.id), entities.at(-1)?.id || "");
    bwSaveState();
  }
  return entities;
}

function bwScopeCounts(inv, entity = null) {
  const inScope = (e) => {
    if (!entity) return true;
    if (entity.type === "site") return e.siteId === entity.id || e.id === entity.id;
    if (entity.type === "building") return e.buildingId === entity.id || e.parentId === entity.id || e.id === entity.id;
    if (entity.type === "floor") return e.floorId === entity.id || e.parentId === entity.id || e.id === entity.id;
    if (entity.type === "equip") return e.equipId === entity.id || e.parentId === entity.id || e.id === entity.id;
    return e.id === entity.id;
  };
  const rows = inv.listEntities().filter(inScope);
  return {
    sites: rows.filter((e) => e.type === "site").length,
    buildings: rows.filter((e) => e.type === "building").length,
    floors: rows.filter((e) => e.type === "floor").length,
    devices: rows.filter((e) => e.type === "equip").length,
    points: rows.filter((e) => e.type === "point").length,
  };
}

function bwCountTile(label, value) {
  return el("div", { class: "bw-count-tile" },
    el("span", { class: "bw-count-value" }, String(value)),
    el("span", { class: "bw-count-label" }, label));
}

function bwDetailRow(label, value) {
  if (value == null || value === "") return null;
  return el("div", { class: "bw-detail-row" },
    el("span", { class: "bw-detail-label" }, label),
    el("span", { class: "bw-detail-value" }, String(value)));
}

function bwBreadcrumbItems(inv, entity) {
  if (!entity) return [];
  const { site, building, floor, equip } = bwEntityContext(inv, entity);
  const items = [];
  for (const candidate of [site, building, floor, equip]) {
    if (candidate && !items.some((item) => item.id === candidate.id)) items.push(candidate);
  }
  if (!items.some((item) => item.id === entity.id)) items.push(entity);
  return items;
}

function bwBreadcrumb(inv, entity) {
  const items = bwBreadcrumbItems(inv, entity);
  if (!items.length) return null;
  return el("nav", { class: "bw-breadcrumb", "aria-label": "Model path" },
    ...items.flatMap((item, i) => [
      i ? el("span", { class: "bw-breadcrumb-sep" }, ">") : null,
      el("button", {
        class: `bw-breadcrumb-item ${item.id === entity.id ? "bw-breadcrumb-current" : ""}`,
        onclick: (e) => { e.stopPropagation(); bwSelectTreeEntity(item); },
      }, item.name || item.id),
    ]));
}

function bwHeaderBreadcrumb() {
  const inv = inventoryInstance();
  if (!inv) return null;
  const selected = bwSelectedEntities(inv);
  if (selected.length > 1) {
    return el("div", { id: "bw-header-breadcrumb-addon", class: "bw-breadcrumb bw-breadcrumb-summary" }, `${selected.length} selected`);
  }
  const entity = selected.length === 1 ? selected[0] : bwSelectedEntity(inv);
  const crumb = entity ? bwBreadcrumb(inv, entity) : el("div", { class: "bw-breadcrumb bw-breadcrumb-summary" });
  crumb.id = "bw-header-breadcrumb-addon";
  return crumb;
}

function bwCurrentFloorForInbox(inv) {
  const selected = bwSelectedEntity(inv);
  if (!selected) return null;
  if (selected.type === "floor") return selected;
  const { floor } = bwEntityContext(inv, selected);
  return floor || null;
}

function openAdapterSelection(adapterName = "") {
  networkManager.focusConfigure(adapterName || networkManager.selectedAdapterName() || networkManager.scanDefaultAdapter());
  setView(pluginView("networkmanager"));
}

async function bwDiscoverDevices() {
  const target = bacnet.adapterTarget();
  if (target) bacnet.setTarget(target.value);
  await bacnet.discover();
}

function bwDeviceInboxEmptyMessage() {
  if (bacnet.isDiscovering()) return "Listening for I-Am replies...";
  if (bacnet.getDiscoveryRan() && bacnet.getLastDiscoveryCount() === 0) {
    const selectedAdapter = networkManager.selectedAdapterName();
    const subnet = selectedAdapter ? networkManager.scanSubnetFor(selectedAdapter) : null;
    const target = bacnet.adapterTarget(selectedAdapter);
    const { loaded: nmLoaded } = networkManager.getAdapterSnapshot();
    const adapterMessage = !nmLoaded
      ? "Network adapters have not been read yet. Open Network Manager to verify the active BAS/NIC adapter."
      : !selectedAdapter
        ? "No Network Manager adapter is selected. Choose the active BAS/NIC adapter, then run discovery again."
        : !subnet
          ? `${selectedAdapter} is selected, but it does not have a usable IPv4 subnet. Check its IP configuration or choose another adapter.`
          : `${selectedAdapter} is selected (${subnet.label}). Tried ${target?.label || bacnet.getTarget()}. Check VPN/firewall rules, BBMD/foreign-device routing, or try a known device IP with the advanced BACnet Inspector.`;
    return el("div", { class: "bw-empty-action" },
      el("span", {}, `Discovery finished with no BACnet devices found. ${adapterMessage}`),
      el("button", { class: "btn-ghost", onclick: () => openAdapterSelection(selectedAdapter) }, "Open adapter selection"));
  }
  return "No discovered devices yet. Run discovery to populate the inbox.";
}

function bwRenderDeviceInboxLive() {
  const inv = inventoryInstance();
  const node = document.getElementById("bw-device-inbox");
  if (!inv || !node) return;
  node.replaceWith(bwDeviceInbox(inv, bwCurrentFloorForInbox(inv)));
}

function bwInboxScrollState() {
  return [...document.querySelectorAll("#bw-device-inbox .bw-device-inbox-scroll")]
    .map((node, index) => ({ index, top: node.scrollTop, left: node.scrollLeft }));
}

function bwRestoreInboxScrollState(state) {
  for (const item of state || []) {
    const node = document.querySelectorAll("#bw-device-inbox .bw-device-inbox-scroll")[item.index];
    if (!node) continue;
    node.scrollTop = item.top;
    node.scrollLeft = item.left;
  }
}

function bwPatchDeviceInboxLive() {
  const inv = inventoryInstance();
  const inbox = document.getElementById("bw-device-inbox");
  if (!inv || !inbox) {
    bwRenderDeviceInboxLive();
    return;
  }
  const floor = bwCurrentFloorForInbox(inv);
  const discovered = bwDeviceInboxCandidateList(inv);
  const queued = bwDeviceInboxQueueList(inv);
  const discoverySelected = bwInboxSelectionFor("discovery").length;
  const modelingSelected = bwInboxSelectionFor("modeling").length;
  const scrollState = bwInboxScrollState();

  document.getElementById("bw-discovered-device-rows")?.replaceChildren(...bwDiscoveredDeviceRows(inv));
  document.getElementById("bw-modeling-queue-rows")?.replaceChildren(...bwModelingQueueRows(inv, floor));

  const count = document.getElementById("bw-device-inbox-count");
  if (count) count.textContent = bacnet.isDiscovering() ? "Discovering..." : `${discovered.length} shown · ${queued.length} queued`;
  const ignore = document.getElementById("bw-inbox-ignore-selected");
  if (ignore) ignore.disabled = discoverySelected ? false : true;
  const clear = document.getElementById("bw-inbox-clear");
  if (clear) clear.disabled = bacnet.getDevices().length || queued.length ? false : true;
  const model = document.getElementById("bw-inbox-model-selected");
  if (model) {
    model.dataset.floorId = floor?.id || "";
    model.dataset.queuedCount = String(queued.length);
    model.disabled = floor && queued.length ? false : true;
    model.textContent = floor ? (modelingSelected ? `Add selected to ${floor.name}` : `Add queue to ${floor.name}`) : "Select a floor";
  }
  const remove = document.getElementById("bw-inbox-remove-queued");
  if (remove) remove.disabled = modelingSelected ? false : true;
  bwSyncInboxSelectionUi();
  bwRestoreInboxScrollState(scrollState);
  requestAnimationFrame(() => bwRestoreInboxScrollState(scrollState));
}

function bwRenderHeaderAddon() {
  const node = document.getElementById("bw-header-breadcrumb-addon");
  if (!node) return;
  const next = bwHeaderBreadcrumb();
  if (next) node.replaceWith(next);
}

function bwRenderWorkspaceScope() {
  const node = document.getElementById("bw-root");
  if (!node || currentPluginId() !== "building-workspace") {
    renderScoped("page");
    return;
  }
  node.replaceWith(renderBuildingWorkspacePage());
  bwRenderHeaderAddon();
}

function bwRenderTabScope() {
  const inv = inventoryInstance();
  const body = document.getElementById("bw-tab-body");
  if (!inv || !body || currentPluginId() !== "building-workspace") {
    bwRenderWorkspaceScope();
    return;
  }
  body.replaceChildren(bwCurrentTabBody(inv));
  bwRenderHeaderAddon();
}

function bwRenderModelScope({ tree = false, details = false, header = false } = {}) {
  const inv = inventoryInstance();
  if (!inv || currentPluginId() !== "building-workspace") {
    bwStopLivePoll();
    renderScoped("page");
    return;
  }
  if (bw.tab !== "model") {
    bwStopLivePoll();
    bwRenderTabScope();
    return;
  }
  const treeNode = document.getElementById("bw-model-tree-panel");
  const detailsNode = document.getElementById("bw-model-details");
  if (tree && treeNode) treeNode.replaceWith(bwTreePanel(inv));
  if (details && detailsNode) detailsNode.replaceWith(bwModelDetails(inv));
  if (header) bwRenderHeaderAddon();
  if ((tree && !treeNode) || (details && !detailsNode)) bwRenderTabScope();
  bwSyncLivePoll(); // start/stop the live poll to match the current selection
}

function bwRenderInboxScope() {
  if (currentPluginId() !== "building-workspace") {
    renderScoped("page");
    return;
  }
  if (bw.tab === "bacnet") bwPatchDeviceInboxLive();
  else bwRenderTabScope();
  bwRenderHeaderAddon();
}

function bwInboxStatusLabel(inv, item, floor = null) {
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

function bwInboxStatusClass(status) {
  if (status === "new") return "pill-running";
  if (status === "queued") return "pill-info";
  if (status === "changed") return "pill-warn";
  if (status === "conflict") return "pill-error";
  return "pill-muted";
}

function bwDiscoveredDeviceRows(inv) {
  const items = bwDeviceInboxCandidateList(inv);
  const floor = bwCurrentFloorForInbox(inv);
  const selected = new Set(bwInboxSelectionFor("discovery"));
  const rows = items.map((item) => {
    const device = item.device;
    const canDrag = item.selectable !== false;
    const dragAttrs = bwDiscoveryDragAttrs(item, canDrag);
    return el("tr", {
      class: `bw-inbox-row ${selected.has(item.key) ? "bw-inbox-row-selected" : ""} ${item.selectable === false ? "bw-inbox-row-disabled" : ""}`,
      "data-bw-inbox-key": item.key,
      "data-bw-inbox-phase": "discovery",
      "aria-selected": selected.has(item.key) ? "true" : "false",
      ...dragAttrs,
      onclick: (e) => bwSelectInboxCandidate("discovery", item, e),
      oncontextmenu: (e) => bwOpenInboxMenu(e, "discovery", item),
    },
      el("td", { class: "bac-num", ...dragAttrs }, String(device.instance ?? "")),
      el("td", { ...dragAttrs }, device.name || el("span", { class: "muted" }, "Unnamed")),
      el("td", { class: "bac-mono", ...dragAttrs }, bacnet.addressText(device)),
      el("td", { ...dragAttrs }, bacnet.vendorText(device) || el("span", { class: "muted" }, "-")),
      el("td", { ...dragAttrs }, device.modelName || el("span", { class: "muted" }, "-")),
      el("td", { ...dragAttrs }, el("span", { class: `pill ${bwInboxStatusClass(item.status)}` }, bwInboxStatusLabel(inv, item, floor))));
  });
  return rows.length ? rows : [el("tr", {}, el("td", { class: "muted small", colspan: "6" }, bwDeviceInboxEmptyMessage()))];
}

function bwModelingQueueRows(inv, floor = null) {
  const items = bwDeviceInboxQueueList(inv);
  const selected = new Set(bwInboxSelectionFor("modeling"));
  const rows = items.map((item) => {
    const device = item.device;
    const targetFloor = inv.getEntity(item.candidate?.targetFloorId || floor?.id);
    const instance = device ? String(device.instance ?? "") : item.key.replace(/^bacnet-device:/, "");
    const match = item.modeledDevice ? bwInboxPathLabel(inv, item.modeledDevice) : (item.conflict || "");
    return el("tr", {
      class: `bw-inbox-row ${selected.has(item.key) ? "bw-inbox-row-selected" : ""}`,
      "data-bw-inbox-key": item.key,
      "data-bw-inbox-phase": "modeling",
      "aria-selected": selected.has(item.key) ? "true" : "false",
      onclick: (e) => bwSelectInboxCandidate("modeling", item, e),
      oncontextmenu: (e) => bwOpenInboxMenu(e, "modeling", item),
    },
      el("td", {}, item.proposedName || device?.name || "Unnamed"),
      el("td", { class: "bac-num" }, instance),
      el("td", { class: "bac-mono" }, device ? bacnet.addressText(device) : "not in current discovery"),
      el("td", {}, device ? bacnet.vendorText(device) || "-" : "-"),
      el("td", {}, device?.modelName || "-"),
      el("td", {}, targetFloor?.name || "Selected floor"),
      el("td", {}, match || el("span", { class: "muted" }, "-")),
      el("td", {}, item.action === "skip" ? "Skip" : "Add"),
      el("td", {}, el("span", { class: `pill ${bwInboxStatusClass(item.status)}` }, bwInboxStatusLabel(inv, item, floor))));
  });
  return rows.length ? rows : [el("tr", {}, el("td", { class: "muted small", colspan: "9" }, "No queued devices. Highlight discovered rows and queue them for modeling."))];
}

function bwInboxPathLabel(inv, entity) {
  return entity ? bwBreadcrumbItems(inv, entity).map((item) => item.name || item.id).join(" > ") : "";
}

function bwDeviceInbox(inv, floor = null) {
  const discovered = bwDeviceInboxCandidateList(inv);
  const queued = bwDeviceInboxQueueList(inv);
  const discoverySelected = bwInboxSelectionFor("discovery").length;
  const modelingSelected = bwInboxSelectionFor("modeling").length;
  const adapterTarget = bacnet.adapterTarget();
  const canModel = Boolean(floor && queued.length);
  return el("div", {
    id: "bw-device-inbox",
    class: "bw-device-inbox",
    onclick: () => { if (bw.inboxMenu) bwCloseInboxMenu(); },
  },
    el("div", { class: "bw-inbox-grid" },
    el("div", { class: "bw-inbox-stage bw-inbox-stage-discovery" },
      el("div", { class: "section-head bw-inbox-stage-head" },
        el("h4", {}, "BACnet Device Inbox"),
        el("span", { id: "bw-device-inbox-count", class: "muted small" }, bacnet.isDiscovering() ? "Discovering..." : `${discovered.length} shown · ${queued.length} queued`)),
      adapterTarget
        ? el("p", { class: "muted small bw-inbox-target" }, `Discovery target: ${adapterTarget.label}`)
        : null,
      bacnet.isDiscovering() ? bacnet.discoveryProgressEl("bw-discovery-progress") : null,
      el("div", { class: "tool-actions" },
        el("button", {
          class: "btn btn-primary",
          disabled: bacnet.isDiscovering() ? "disabled" : undefined,
          onclick: bwDiscoverDevices,
        }, bacnet.isDiscovering() ? "Discovering..." : "Discover devices"),
        el("button", {
          id: "bw-inbox-ignore-selected",
          class: "btn-ghost",
          disabled: discoverySelected ? undefined : "disabled",
          onclick: bwIgnoreSelectedInboxDevices,
        }, "Ignore"),
        el("button", { id: "bw-inbox-clear", class: "btn-ghost", disabled: bacnet.getDevices().length || queued.length ? undefined : "disabled", onclick: bwClearDeviceDiscovery }, "Clear")),
      el("input", {
        class: "nm-input bw-device-filter",
        placeholder: "Filter by instance, name, address, vendor, model",
        value: bw.deviceInbox?.filter || "",
        oninput: (e) => { bw.deviceInbox.filter = e.target.value; bwApplyDeviceInboxFilter(); },
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
          el("tbody", { id: "bw-discovered-device-rows" }, ...bwDiscoveredDeviceRows(inv))))),
    el("div", { class: "bw-inbox-stage bw-inbox-stage-queue" },
      el("div", { class: "section-head bw-inbox-stage-head" },
        el("h4", {}, "Import Plan"),
        el("span", { class: "muted small" }, floor ? `Target: ${floor.name}` : "Select a floor in the Model Tree")),
      el("div", { class: "tool-actions" },
        el("button", {
          id: "bw-inbox-model-selected",
          class: "btn-ghost",
          "data-floor-id": floor?.id || "",
          "data-queued-count": String(queued.length),
          disabled: canModel ? undefined : "disabled",
          onclick: () => bwModelQueuedDevicesToFloor(floor.id),
        }, floor ? (modelingSelected ? `Add selected to ${floor.name}` : `Add queue to ${floor.name}`) : "Select a floor"),
        el("button", {
          id: "bw-inbox-remove-queued",
          class: "btn-ghost",
          disabled: modelingSelected ? undefined : "disabled",
          onclick: () => bwRemoveQueuedInboxDevices(),
        }, "Remove from queue")),
      el("div", {
        class: "bw-device-inbox-scroll bw-queue-scroll bw-import-plan-dropzone",
        ondragover: bwImportPlanDragOver,
        ondragleave: bwImportPlanDragLeave,
        ondrop: bwImportPlanDrop,
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
          el("tbody", { id: "bw-modeling-queue-rows" }, ...bwModelingQueueRows(inv, floor)))))),
    bwInboxContextMenu(inv, floor));
}

function bwRootDetails(inv) {
  const counts = bwScopeCounts(inv);
  return [
    el("div", { class: "bw-count-grid" },
      bwCountTile("Sites", counts.sites),
      bwCountTile("Buildings", counts.buildings),
      bwCountTile("Floors", counts.floors),
      bwCountTile("Devices", counts.devices),
      bwCountTile("Points", counts.points)),
    el("div", { class: "bw-context-summary" },
      el("h4", {}, "Model overview"),
      el("p", { class: "muted small" }, "Select a site, building, floor, device, or point to inspect modeled context. Protocol discovery and imports live in the BACnet tab.")),
  ];
}

function bwSiteDetails(inv, site) {
  const counts = bwScopeCounts(inv, site);
  return [
    el("div", { class: "bw-count-grid" },
      bwCountTile("Buildings", counts.buildings),
      bwCountTile("Floors", counts.floors),
      bwCountTile("Devices", counts.devices),
      bwCountTile("Points", counts.points)),
    el("div", { class: "bw-context-summary" },
      el("h4", {}, "Site context"),
      el("div", { class: "bw-detail-grid" },
        bwDetailRow("Name", site.name),
        bwDetailRow("Tags", Object.keys(site.tags || {}).join(", ")))),
  ];
}

function bwBuildingDetails(inv, building) {
  const counts = bwScopeCounts(inv, building);
  const floors = inv.listEntities({ type: "floor", buildingId: building.id });
  if (!String(bw.floorBatchStart || "").trim()) bw.floorBatchStart = String(floors.length + 1);
  return [
    el("div", { class: "bw-count-grid" },
      bwCountTile("Floors", counts.floors),
      bwCountTile("Devices", counts.devices),
      bwCountTile("Points", counts.points)),
    el("div", { class: "bw-batch-floor-form" },
      el("label", { class: "nm-field" },
        el("span", { class: "nm-field-label" }, "Floor name pattern"),
        el("input", {
          class: "nm-input",
          value: bw.floorBatchPattern,
          "data-bw-floor-batch-pattern": "1",
          placeholder: "Floor {n}",
          oninput: (e) => { bw.floorBatchPattern = e.target.value; },
        })),
      el("label", { class: "nm-field bw-batch-small" },
        el("span", { class: "nm-field-label" }, "Start"),
        el("input", {
          class: "nm-input",
          inputmode: "numeric",
          pattern: "[0-9]*",
          value: bw.floorBatchStart,
          oninput: (e) => { bw.floorBatchStart = e.target.value; },
        })),
      el("label", { class: "nm-field bw-batch-small" },
        el("span", { class: "nm-field-label" }, "Count"),
        el("input", {
          class: "nm-input",
          type: "number",
          min: "1",
          max: "200",
          value: bw.floorBatchCount,
          oninput: (e) => { bw.floorBatchCount = e.target.value; },
        })),
      el("button", { class: "btn-ghost bw-batch-action", onclick: () => bwBatchAddFloors(building.id) }, "Add batch")),
  ];
}

function bwFloorDetails(inv, floor) {
  const counts = bwScopeCounts(inv, floor);
  return [
    el("div", { class: "bw-count-grid" },
      bwCountTile("Devices", counts.devices),
      bwCountTile("Points", counts.points)),
    el("div", { class: "bw-context-summary" },
      el("h4", {}, "Floor context"),
      el("div", { class: "bw-detail-grid" },
        bwDetailRow("Name", floor.name),
        bwDetailRow("Building", inv.getEntity(floor.buildingId || floor.parentId)?.name || ""),
        bwDetailRow("Site", inv.getEntity(floor.siteId)?.name || ""),
        bwDetailRow("Tags", Object.keys(floor.tags || {}).join(", ")))),
  ];
}

function bwDeviceDetails(inv, equip) {
  const templates = inv.listEntities({ type: "template" });
  const points = inv.listEntities({ type: "point", equipId: equip.id });
  return [
    el("div", { class: "bw-count-grid" }, bwCountTile("Points", points.length)),
    el("div", { class: "bw-detail-grid" },
      bwDetailRow("Template", equip.templateId || ""),
      bwDetailRow("Tags", Object.keys(equip.tags || {}).join(", "))),
    el("div", { class: "tool-actions" },
      equip.tags?.bacnet || equip.deviceInstance != null
        ? el("button", { class: "btn-ghost", disabled: bw.busy ? "disabled" : undefined, onclick: () => bwDiscoverDevicePoints(equip.id) }, bw.busy ? "Discovering..." : "Discover points")
        : null,
      el("select", { class: "nm-input bw-template-select", onchange: (e) => { bw.template = e.target.value; bwSaveState(); } },
        ...templates.map((t) => el("option", { value: t.id, selected: bw.template === t.id || bw.template === t.id.replace("template:", "") ? "selected" : undefined }, t.name)))),
    bwDeviceLivePanel(inv, equip),
  ];
}

// ---- Phase 2: live control for a modeled point (present-value, status flags,
// 16-slot priority array, inline write / relinquish / write+verify) ----

// Auto-poll live data for the currently-selected point/device on the Model tab. The
// poll updates only its own display container in place, so write inputs keep focus.
let bwLive = null;          // point poll: { props } | { props:null, error }
let bwDeviceLive = null;    // device poll: { values: Map(pointId -> { value, display } | { error }) }
let bwLivePoll = null;      // { kind: "point" | "device", id }
let bwLiveTimer = null;
let bwLivePaused = false;
let bwLiveBusyWrite = false;
let bwLiveBusyPoll = false;  // guards against overlapping async ticks
const BW_POINT_POLL_MS = 4000;
const BW_DEVICE_POLL_MS = 12000;
const BW_DEVICE_POLL_CAP = 60; // don't hammer a big device every tick

function bwBacnetCap() {
  return getPlatform() ? getPlatform().capability("bacnet.read.v1") : bacnet.bacnetRead();
}

// Build the BACnet object reference straight from the modeled point's own fields.
function bwPointRef(point) {
  const objectType = Number(point.objectType);
  const instance = Number(point.instance);
  if (!Number.isFinite(objectType) || !Number.isFinite(instance)) return null;
  return { device: point.deviceRef || { deviceInstance: point.deviceInstance }, objectType, instance };
}

// Encode a write value by object type: binary -> enumerated 0/1, multistate -> unsigned, else real.
function bwBacnetWriteValue(objectType, raw) {
  const t = Number(objectType);
  if ([3, 4, 5].includes(t)) return { kind: "enumerated", value: Number(raw) ? 1 : 0 };
  if ([13, 14, 19].includes(t)) return { kind: "unsigned", value: Math.max(0, Math.round(Number(raw) || 0)) };
  return { kind: "real", value: Number(raw) };
}

function bwPropEntry(props, id, name) {
  return (props || []).find((p) => p && (p.id === id || p.name === name)) || null;
}

function bwLivePresentValue(props) {
  const e = bwPropEntry(props, 85, "present-value");
  if (!e || e.error || !Array.isArray(e.values) || !e.values.length) return { value: null, display: null };
  return { value: e.values[0]?.value ?? null, display: e.display ?? String(e.values[0]?.value ?? "") };
}

function bwStopLivePoll() {
  if (bwLiveTimer) { clearInterval(bwLiveTimer); bwLiveTimer = null; }
  bwLivePoll = null;
  bwLive = null;
  bwDeviceLive = null;
}

function bwArmLiveTimer(ms) {
  if (bwLiveTimer) { clearInterval(bwLiveTimer); bwLiveTimer = null; }
  if (!bwLivePaused) bwLiveTimer = setInterval(bwLiveTick, ms);
}

// Start/stop the live poll to match the current single selection on the Model tab.
// Idempotent: re-selecting the same entity does not restart the timer or drop data.
function bwSyncLivePoll() {
  const inv = inventoryInstance();
  if (!inv || currentPluginId() !== "building-workspace" || bw.tab !== "model") { bwStopLivePoll(); return; }
  const sel = bwSelectedEntities(inv);
  const entity = sel.length === 1 ? sel[0] : null;
  let target = null;
  if (entity && entity.type === "point" && bwPointRef(entity)) target = { kind: "point", id: entity.id };
  else if (entity && entity.type === "equip" && (entity.deviceInstance != null || entity.deviceRef)) target = { kind: "device", id: entity.id };
  if (!target) { bwStopLivePoll(); return; }
  if (bwLivePoll && bwLivePoll.kind === target.kind && bwLivePoll.id === target.id) return; // already live
  bwStopLivePoll();
  bwLivePoll = target;
  bwLiveTick(); // immediate first read
  bwArmLiveTimer(target.kind === "point" ? BW_POINT_POLL_MS : BW_DEVICE_POLL_MS);
}

function bwToggleLivePause() {
  bwLivePaused = !bwLivePaused;
  if (bwLivePaused) {
    if (bwLiveTimer) { clearInterval(bwLiveTimer); bwLiveTimer = null; }
  } else if (bwLivePoll) {
    bwLiveTick();
    bwArmLiveTimer(bwLivePoll.kind === "point" ? BW_POINT_POLL_MS : BW_DEVICE_POLL_MS);
  }
  const ind = document.getElementById("bw-live-indicator");
  if (ind) ind.replaceWith(bwLiveIndicator());
  const btn = document.getElementById("bw-live-pause");
  if (btn) btn.textContent = bwLivePaused ? "Resume" : "Pause";
}

async function bwLiveTick() {
  // Ticks run sequential async reads that can exceed the poll interval; the busy
  // guard stops setInterval from stacking concurrent polling loops.
  if (bwLiveBusyPoll) return;
  const poll = bwLivePoll;
  if (!poll) return;
  const inv = inventoryInstance();
  // Self-guard: stop if we navigated away or the target is no longer the lone selection.
  if (!inv || currentPluginId() !== "building-workspace" || bw.tab !== "model") { bwStopLivePoll(); return; }
  const entity = inv.getEntity(poll.id);
  if (!entity) { bwStopLivePoll(); return; }
  bwLiveBusyPoll = true;
  try {
    if (poll.kind === "point") {
      const ref = bwPointRef(entity);
      if (!ref) { bwStopLivePoll(); return; }
      try {
        const props = await bwBacnetCap().readPoint(ref.device, ref.objectType, ref.instance);
        if (bwLivePoll !== poll) return; // selection moved mid-read
        bwLive = { props };
      } catch (err) {
        if (bwLivePoll !== poll) return;
        bwLive = { props: null, error: String(err) };
      }
      bwUpdateLiveDisplay(entity);
    } else {
      const points = inv.listEntities({ type: "point", equipId: entity.id }).slice(0, BW_DEVICE_POLL_CAP);
      const values = bwDeviceLive?.values || new Map();
      for (const p of points) {
        if (bwLivePoll !== poll) return; // bail if selection moved
        const ref = bwPointRef(p);
        if (!ref) { values.set(p.id, { error: "no ref" }); continue; }
        try {
          const props = await bwBacnetCap().readPoint(ref.device, ref.objectType, ref.instance);
          if (bwLivePoll !== poll) return; // stale read for a superseded selection
          const pv = bwLivePresentValue(props);
          values.set(p.id, { value: pv.value, display: pv.display });
        } catch (err) {
          if (bwLivePoll !== poll) return;
          values.set(p.id, { error: String(err) });
        }
        bwDeviceLive = { values };
        bwUpdateDeviceLive(entity); // progressive update as each point comes back
      }
    }
  } finally {
    bwLiveBusyPoll = false;
  }
}

function bwLiveIndicator() {
  return bwLivePaused
    ? el("span", { id: "bw-live-indicator", class: "muted small bw-live-ind" }, "paused")
    : el("span", { id: "bw-live-indicator", class: "bw-live-ind" }, el("span", { class: "bw-live-dot", title: "Polling live" }), el("span", { class: "muted small" }, "live"));
}

function bwLiveControls() {
  return el("div", { class: "section-head bw-live-head" },
    el("h4", {}, "Live"),
    el("div", { class: "bw-live-head-right" },
      bwLiveIndicator(),
      el("button", { id: "bw-live-pause", class: "btn-ghost", onclick: bwToggleLivePause }, bwLivePaused ? "Resume" : "Pause"),
    ),
  );
}

function bwUpdateLiveDisplay(point) {
  const node = document.getElementById("bw-live-display");
  if (node) node.replaceChildren(...bwLiveDisplayChildren(point));
  const ind = document.getElementById("bw-live-indicator");
  if (ind) ind.replaceWith(bwLiveIndicator());
}

function bwUpdateDeviceLive(equip) {
  const node = document.getElementById("bw-device-live");
  if (node) node.replaceChildren(...bwDeviceLiveRows(equip));
  const ind = document.getElementById("bw-live-indicator");
  if (ind) ind.replaceWith(bwLiveIndicator());
}

function bwLiveDisplayChildren(point) {
  const live = bwLive;
  if (!live) return [el("p", { class: "muted small" }, "Reading…")];
  if (!live.props) return [el("p", { class: "muted small" }, live.error ? `Read failed: ${live.error}` : "No data.")];
  const pv = bwLivePresentValue(live.props);
  const flagsEntry = bwPropEntry(live.props, 111, "status-flags");
  const flags = flagsEntry ? interpretStatusFlags(flagsEntry.values?.[0]) : null;
  const prioEntry = bwPropEntry(live.props, 87, "priority-array");
  const parsed = prioEntry && Array.isArray(prioEntry.values) && prioEntry.values.length ? parsePriorityArray(prioEntry.values) : null;
  const out = [
    el("div", { class: "bw-live-pv" },
      el("span", { class: "bw-live-pv-val" }, pv.display ?? String(pv.value ?? "—")),
      flags && flags.raised.length
        ? el("span", { class: "bw-live-flags" }, ...flags.raised.map((f) => el("span", { class: `bw-flag bw-flag-${f.replace(/[^a-z]/g, "")}` }, f)))
        : el("span", { class: "muted small" }, "no active alarms"),
    ),
  ];
  if (parsed) out.push(el("div", { class: "bw-prio-wrap" }, el("span", { class: "muted small" }, "Priority array (1 = highest)"), bwPriorityRibbon(point, parsed)));
  return out;
}

function bwDeviceLiveRows(equip) {
  const inv = inventoryInstance();
  if (!inv) return [];
  const points = inv.listEntities({ type: "point", equipId: equip.id });
  if (!points.length) return [el("tr", {}, el("td", { class: "muted small", colspan: "3" }, "No modeled points yet — use Discover points."))];
  const values = bwDeviceLive?.values || new Map();
  const shown = points.slice(0, BW_DEVICE_POLL_CAP);
  const rows = shown.map((p) => {
    const v = values.get(p.id);
    const cell = !v ? el("span", { class: "muted small" }, "…")
      : v.error ? el("span", { class: "bw-live-err", title: v.error }, "err")
      : el("span", { class: "bw-live-val" }, v.display ?? String(v.value ?? "—"));
    return el("tr", { class: "bw-dlive-row", onclick: () => bwSelectTreeEntity(p) },
      el("td", {}, p.name || p.id),
      el("td", { class: "muted small" }, p.objectType != null && p.instance != null ? `${p.objectType}:${p.instance}` : ""),
      el("td", { class: "bw-dlive-val" }, cell));
  });
  if (points.length > shown.length) {
    rows.push(el("tr", {}, el("td", { class: "muted small", colspan: "3" }, `+${points.length - shown.length} more not polled (cap ${BW_DEVICE_POLL_CAP})`)));
  }
  return rows;
}

async function bwWritePoint(point, { value, priority, relinquish = false, verify = false }) {
  const ref = bwPointRef(point);
  if (!ref || bwLiveBusyWrite) return;
  const pr = priority === "" || priority == null ? null : parseInt(priority, 10);
  if (relinquish && pr == null) { toast("Relinquish needs a priority (the slot to release).", "warn"); return; }
  // Guard against blank/invalid input silently coercing to 0 — a real hazard for
  // setpoints and commandable outputs. Only relinquish (null write) is exempt.
  if (!relinquish && (value === "" || value == null || !Number.isFinite(Number(value)))) {
    toast("Enter a numeric value to write.", "warn");
    return;
  }
  const writeVal = relinquish ? { kind: "null" } : bwBacnetWriteValue(ref.objectType, value);
  bwLiveBusyWrite = true;
  try {
    const cap = bwBacnetCap();
    await cap.writeProperty({ device: ref.device, objectType: ref.objectType, instance: ref.instance, property: 85, value: writeVal, priority: pr });
    const label = relinquish ? `Released priority ${pr}` : `Wrote ${value}${pr != null ? ` @ p${pr}` : ""}`;
    logTo("building-workspace", `${label} on ${point.name}.`, "ok");
    if (verify && !relinquish) {
      // Read back and confirm the command actually landed.
      const props = await cap.readPoint(ref.device, ref.objectType, ref.instance);
      bwLive = { props };
      bwUpdateLiveDisplay(point);
      const got = bwLivePresentValue(props).value;
      const ok = commissioningValueMatches(got, writeVal.value);
      toast(
        ok ? `Verified: ${point.name} now reads ${got}` : `Write did NOT land — read back ${got ?? "—"} (stuck output or higher-priority override?)`,
        ok ? "ok" : "error", ok ? 4000 : 7000,
      );
    } else {
      toast(label, "ok");
    }
  } catch (err) {
    toast(`Write failed: ${err}`, "error");
    logTo("building-workspace", `Write failed on ${point.name}: ${err}`, "error");
  } finally {
    bwLiveBusyWrite = false;
    // The next poll refreshes the ribbon; nudge one now so the slot updates immediately.
    if (!bwLivePaused && bwLivePoll && bwLivePoll.kind === "point") bwLiveTick();
  }
}

function bwPriorityRibbon(point, parsed) {
  return el("div", { class: "bw-prio" },
    ...parsed.slots.map((s) => el("div", {
      class: `bw-prio-slot${s.active ? " bw-prio-on" : ""}${parsed.activeLevel === s.level ? " bw-prio-active" : ""}`,
      title: s.active ? `Priority ${s.level} = ${s.value}${parsed.activeLevel === s.level ? " (commanding)" : ""}` : `Priority ${s.level} — empty`,
    },
      el("span", { class: "bw-prio-level" }, String(s.level)),
      el("span", { class: "bw-prio-val" }, s.active ? String(s.value) : "—"),
      s.active ? el("button", { class: "bw-prio-release", title: `Release priority ${s.level}`, onclick: () => bwWritePoint(point, { priority: s.level, relinquish: true }) }, "×") : null,
    )),
  );
}

function bwWriteControls(point, ref) {
  const binary = [3, 4, 5].includes(Number(ref.objectType));
  const valueInput = binary
    ? el("select", { id: "bw-write-value", class: "nm-input bw-write-value" },
        el("option", { value: "0" }, "inactive (0)"), el("option", { value: "1" }, "active (1)"))
    : el("input", { id: "bw-write-value", type: "number", class: "nm-input bw-write-value", placeholder: "value", step: "any" });
  const prioritySelect = el("select", { id: "bw-write-priority", class: "nm-input bw-write-priority", title: "Command priority (8 = manual operator)" },
    ...Array.from({ length: 16 }, (_, i) => el("option", { value: String(i + 1), selected: i + 1 === 8 ? "selected" : undefined }, `priority ${i + 1}`)));
  const readVal = () => document.getElementById("bw-write-value")?.value;
  const readPrio = () => document.getElementById("bw-write-priority")?.value;
  return el("div", { class: "bw-write-row" },
    el("label", { class: "nm-field" }, el("span", { class: "nm-field-label" }, "Value"), valueInput),
    el("label", { class: "nm-field" }, el("span", { class: "nm-field-label" }, "Priority"), prioritySelect),
    el("button", { class: "btn", disabled: bw.busy ? "disabled" : undefined, onclick: () => bwWritePoint(point, { value: readVal(), priority: readPrio() }) }, "Write"),
    el("button", { class: "btn btn-primary", disabled: bw.busy ? "disabled" : undefined, title: "Write, then read back and confirm it landed", onclick: () => bwWritePoint(point, { value: readVal(), priority: readPrio(), verify: true }) }, "Write & verify"),
    el("button", { class: "btn-ghost", disabled: bw.busy ? "disabled" : undefined, title: "Release the selected priority slot", onclick: () => bwWritePoint(point, { priority: readPrio(), relinquish: true }) }, "Relinquish"),
  );
}

// Auto-polling live panel for a selected point. The #bw-live-display container is what
// the poll refreshes; write controls live outside it so typed values keep focus.
function bwLivePanel(inv, point) {
  const ref = bwPointRef(point);
  if (!ref) return null;
  const children = [
    bwLiveControls(),
    el("div", { id: "bw-live-display", class: "bw-live-display" }, ...bwLiveDisplayChildren(point)),
  ];
  if (point.tags?.writable) children.push(bwWriteControls(point, ref));
  else children.push(el("p", { class: "muted small" }, "Read-only object (not commandable)."));
  return el("div", { class: "bw-live" }, ...children);
}

// Auto-polling live values for every modeled point under a selected device.
function bwDeviceLivePanel(inv, equip) {
  if (!(equip.deviceInstance != null || equip.deviceRef)) return null;
  return el("div", { class: "bw-live" },
    bwLiveControls(),
    el("div", { class: "table-scroll" },
      el("table", { class: "bac-table bw-dlive-table" },
        el("thead", {}, el("tr", {}, el("th", {}, "Point"), el("th", {}, "Object"), el("th", {}, "Live value"))),
        el("tbody", { id: "bw-device-live" }, ...bwDeviceLiveRows(equip)))),
  );
}

function bwPointDetails(inv, point) {
  return [
    el("div", { class: "bw-detail-grid" },
      bwDetailRow("Unit", point.unit),
      bwDetailRow("Device instance", point.deviceInstance),
      bwDetailRow("Object", point.objectType != null && point.instance != null ? `${point.objectType}:${point.instance}` : ""),
      bwDetailRow("Source", (point.sourceRefs || []).join(", ")),
      bwDetailRow("Tags", Object.keys(point.tags || {}).join(", "))),
    bwLivePanel(inv, point),
  ];
}

function bwSelectionDetails(inv, entities) {
  const counts = {
    site: entities.filter((e) => e.type === "site").length,
    building: entities.filter((e) => e.type === "building").length,
    floor: entities.filter((e) => e.type === "floor").length,
    equip: entities.filter((e) => e.type === "equip").length,
    point: entities.filter((e) => e.type === "point").length,
  };
  const points = bwPointsForEntities(inv, entities);
  const devices = entities.filter((e) => e.type === "equip");
  const templates = inv.listEntities({ type: "template" });
  return [
    el("p", { class: "muted small bw-selection-hint" }, "Ctrl-click toggles nodes. Shift-click selects a range from the last clicked node."),
    el("div", { class: "bw-count-grid" },
      bwCountTile("Sites", counts.site),
      bwCountTile("Buildings", counts.building),
      bwCountTile("Floors", counts.floor),
      bwCountTile("Devices", counts.equip),
      bwCountTile("Points", counts.point)),
    el("div", { class: "tool-actions" },
      el("button", { class: "btn btn-primary", disabled: points.length ? undefined : "disabled", onclick: bwHistorizeSelectedEntities }, `Historize ${points.length} point${points.length === 1 ? "" : "s"}`),
      el("select", {
        class: "nm-input bw-template-select",
        disabled: devices.length ? undefined : "disabled",
        onchange: (e) => { bw.template = e.target.value; bwSaveState(); },
      },
        ...templates.map((t) => el("option", { value: t.id, selected: bw.template === t.id || bw.template === t.id.replace("template:", "") ? "selected" : undefined }, t.name))),
      el("button", { class: "btn-ghost", disabled: devices.length ? undefined : "disabled", onclick: () => bwApplyTemplateToSelected(bw.template) }, `Apply to ${devices.length} device${devices.length === 1 ? "" : "s"}`),
      el("button", { class: "btn-ghost", onclick: () => { bwSetSelection([]); bw.selectionAnchorId = ""; bwSaveState(); bwRenderModelScope({ tree: true, details: true, header: true }); } }, "Clear"),
      el("button", { class: "btn-ghost danger", onclick: bwRemoveSelectedEntities }, "Remove selected")),
    el("ol", { class: "plugin-log bw-selection-list" },
      ...entities.map((entity) => el("li", { class: "log-info" },
        el("span", { class: "log-time" }, bwTreeNodeLabel(entity)),
        el("span", { class: "log-msg" }, entity.name || entity.id)))),
  ];
}

function bwModelDetails(inv) {
  const selected = bwSelectedEntities(inv);
  if (selected.length > 1) return el("section", { id: "bw-model-details", class: "plugin-section bw-detail-panel" }, ...bwSelectionDetails(inv, selected));
  const entity = selected.length === 1 ? selected[0] : bwSelectedEntity(inv);
  const content = !entity ? bwRootDetails(inv)
    : entity.type === "site" ? bwSiteDetails(inv, entity)
    : entity.type === "building" ? bwBuildingDetails(inv, entity)
    : entity.type === "floor" ? bwFloorDetails(inv, entity)
    : entity.type === "equip" ? bwDeviceDetails(inv, entity)
    : entity.type === "point" ? bwPointDetails(inv, entity)
    : bwRootDetails(inv);
  return el("section", { id: "bw-model-details", class: "plugin-section bw-detail-panel" }, ...content);
}

function bwModelTab(inv) {
  return el("div", { id: "bw-model-tab", class: "bw-model-layout", onclick: () => { if (bw.contextMenu) bwCloseTreeMenu(); } },
    bwTreePanel(inv),
    el("div", { class: "bw-model-main" }, bwModelDetails(inv)),
  );
}

function bwBacnetTab(inv) {
  const floor = bwCurrentFloorForInbox(inv);
  return el("section", { class: "plugin-section bw-detail-panel bw-protocol-panel" },
    el("div", { class: "section-head" },
      el("h3", {}, "BACnet Device Management"),
      el("span", { class: "muted small" }, floor ? `Import target: ${bwInboxPathLabel(inv, floor)}` : "Select a floor in Model to set the import target")),
    bwDeviceInbox(inv, floor));
}

function bwHistorianTab(inv) {
  const hist = historianInstance();
  const pts = hist ? hist.points() : [];
  const modelPoints = bwPointRows(inv);
  return el("section", { class: "plugin-section" },
    el("div", { class: "section-head" },
      el("h3", {}, "Historian"),
      el("span", { class: `pill ${hist && hist.isRunning() ? "pill-running" : "pill-idle"}` }, hist && hist.isRunning() ? "Logging" : "Idle")),
    el("p", { class: "muted small" }, "Historize modeled points with site/equipment/point tags. Existing manual Historian controls remain available."),
    el("div", { class: "tool-actions" },
      el("button", { class: "btn btn-primary", disabled: modelPoints.length ? undefined : "disabled", onclick: () => modelPoints.forEach((p) => bwHistorizePoint(p.id)) }, "Historize modeled points"),
      el("button", { class: "btn-ghost", onclick: () => setView(pluginView("bacnet-historian")) }, "Open BACnet Historian")),
    pts.length
      ? el("ol", { class: "plugin-log" },
          ...pts.map((p) => el("li", { class: p.lastError ? "log-error" : "log-info" },
            el("span", { class: "log-msg" }, `${[p.site, p.building, p.floor, p.equip].filter(Boolean).join(" · ")}${p.site || p.building || p.floor || p.equip ? " · " : ""}${p.label || p.pointId || `${p.objectType}:${p.instance}`} → ${p.lastError ? "ERR " + p.lastError : (p.lastValue ?? "—")}`))))
      : el("p", { class: "muted small" }, "No historian points yet."));
}

function bwDashboardTab(inv) {
  const snapshot = inv.exportSnapshot();
  const site = bwActiveSite(inv);
  const building = bwActiveBuilding(inv, site?.id);
  const floor = bwActiveFloor(inv, building?.id);
  const dashboardScope = {
    siteId: site?.id || null,
    buildingId: building?.id || null,
    floorId: floor?.id || null,
  };
  const points = inv.listEntities({ type: "point", ...dashboardScope });
  const ts = getTelemetry();
  const dashboardUrl = ts ? ts.panelUrl({ dashboard: "stier-building-workspace" }) : null;
  const json = bw.dashboardJson || JSON.stringify(generateBuildingDashboard(snapshot, dashboardScope), null, 2);
  return el("section", { class: "plugin-section" },
    el("div", { class: "section-head" },
      el("h3", {}, "Template Dashboard"),
      el("span", { class: "muted small" }, `${points.length} modeled point${points.length === 1 ? "" : "s"}${floor ? ` on ${floor.name}` : ""}`)),
    el("p", { class: "muted small" },
      dashboardUrl ? "Observability is connected; open Grafana to view provisioned dashboards." : "Ready to chart after the Observability Pack starts; metrics stay in the local ring buffer until then."),
    el("div", { class: "tool-actions" },
      el("button", {
        class: "btn btn-primary",
        onclick: () => {
          bw.dashboardJson = JSON.stringify(generateBuildingDashboard(snapshot, dashboardScope), null, 2);
          logTo("building-workspace", "Generated dashboard JSON from the current model.", "ok");
          bwRenderTabScope();
        },
      }, "Generate dashboard JSON"),
      el("button", { class: "btn-ghost", onclick: () => bwDownload(`building-dashboard-${bacTimestamp()}.json`, json, "application/json;charset=utf-8") }, "Export JSON"),
      dashboardUrl ? el("button", { class: "btn-ghost", onclick: () => openExternal(dashboardUrl) }, "Open Grafana dashboard") : null),
    el("textarea", { class: "nm-input bw-json", rows: "12", readonly: "readonly" }, json));
}

async function bwRunCommissioning(inv) {
  const bacnetApi = getPlatform() ? getPlatform().capability("bacnet.read.v1") : null;
  if (!bacnet) return;
  bw.busy = true;
  bwRenderTabScope();
  try {
    const points = inv.listEntities({ type: "point" });
    const run = await runCommissioning({
      points,
      bacnet,
      writeProperty: async ({ point, ref, value, priority, relinquish }) => bacnet.writeProperty({
        device: point.deviceRef || { deviceInstance: ref.deviceInstance },
        objectType: ref.objectType,
        instance: ref.instance,
        property: 85,
        arrayIndex: null,
        priority,
        value: relinquish ? { kind: "null" } : bwBacnetWriteValue(ref.objectType, value),
      }),
      options: {
        min: bw.cxMin,
        max: bw.cxMax,
        notes: bw.cxNotes,
        commandValue: String(bw.cxCommand ?? "").trim() === "" ? null : Number(bw.cxCommand),
        verify: Boolean(bw.cxVerify),
        toggleVerify: Boolean(bw.cxToggle),
        priority: parseInt(bw.cxPriority, 10) || 8,
      },
    });
    const saved = inv.recordCommissioningRun(run);
    bw.lastRunId = saved.id;
    bwSaveState();
    logTo("building-workspace", `Commissioning finished: ${saved.status}.`, saved.status === "fail" ? "warn" : "ok");
  } catch (err) {
    logTo("building-workspace", `Commissioning failed: ${err}`, "error");
  } finally {
    bw.busy = false;
    bwRenderTabScope();
  }
}

function bwCommissioningTab(inv) {
  const points = bwPointRows(inv);
  const run = bw.lastRunId ? inv.getEntity(bw.lastRunId) : null;
  return el("section", { class: "plugin-section" },
    el("div", { class: "section-head" },
      el("h3", {}, "Commissioning"),
      el("span", { class: "muted small" }, `${points.length} point${points.length === 1 ? "" : "s"} in scope`)),
    el("div", { class: "bac-discover-controls" },
      el("label", { class: "nm-field" }, el("span", { class: "nm-field-label" }, "Min"), el("input", { class: "nm-input bac-range-input", value: bw.cxMin, oninput: (e) => { bw.cxMin = e.target.value; } })),
      el("label", { class: "nm-field" }, el("span", { class: "nm-field-label" }, "Max"), el("input", { class: "nm-input bac-range-input", value: bw.cxMax, oninput: (e) => { bw.cxMax = e.target.value; } })),
      el("button", { class: "btn btn-primary", disabled: bw.busy || points.length === 0 ? "disabled" : undefined, onclick: () => bwRunCommissioning(inv) }, bw.busy ? "Running…" : "Run checks")),
    el("div", { class: "bac-discover-controls bw-cx-command" },
      el("label", { class: "nm-field" }, el("span", { class: "nm-field-label" }, "Command (optional)"),
        el("input", { class: "nm-input bac-range-input", placeholder: "value", value: bw.cxCommand || "", oninput: (e) => { bw.cxCommand = e.target.value; } })),
      el("label", { class: "nm-field" }, el("span", { class: "nm-field-label" }, "Priority"),
        el("select", { class: "nm-input bw-write-priority", onchange: (e) => { bw.cxPriority = e.target.value; } },
          ...Array.from({ length: 16 }, (_, i) => el("option", { value: String(i + 1), selected: String(i + 1) === String(bw.cxPriority || "8") ? "selected" : undefined }, `p${i + 1}`)))),
      el("label", { class: "bw-cx-check" }, el("input", { type: "checkbox", checked: bw.cxVerify ? "checked" : undefined, onchange: (e) => { bw.cxVerify = e.target.checked; } }), el("span", {}, "Verify writes (read back)")),
      el("label", { class: "bw-cx-check" }, el("input", { type: "checkbox", checked: bw.cxToggle ? "checked" : undefined, onchange: (e) => { bw.cxToggle = e.target.checked; } }), el("span", {}, "Toggle binary outputs")),
    ),
    el("p", { class: "muted small" }, "Checks read present-value + range. A command value (or toggle) writes to writable points at the chosen priority, optionally verifies the read-back, then relinquishes."),
    el("textarea", { class: "nm-input bw-notes", rows: "3", placeholder: "Operator notes", oninput: (e) => { bw.cxNotes = e.target.value; } }, bw.cxNotes),
    run
      ? el("ol", { class: "plugin-log" },
          ...(run.steps || []).map((s) => el("li", { class: s.status === "fail" ? "log-error" : s.status === "warn" ? "log-warn" : "log-info" },
            el("span", { class: "log-time" }, s.status),
            el("span", { class: "log-msg" }, `${s.pointName || s.pointId} · ${s.check}${s.value != null ? ` · ${s.value}` : ""}${s.error ? ` · ${s.error}` : ""}`))))
      : el("p", { class: "muted small" }, "No run yet."));
}

function bwReportsTab(inv) {
  const runs = inv.listEntities({ type: "commissioningRun" });
  const run = bw.lastRunId ? inv.getEntity(bw.lastRunId) : runs.at(-1);
  const snapshot = inv.exportSnapshot();
  const md = run ? exportCommissioningMarkdown(snapshot, run) : "";
  const csv = run ? exportCommissioningCsv(run) : "";
  return el("section", { class: "plugin-section" },
    el("div", { class: "section-head" },
      el("h3", {}, "Reports"),
      el("span", { class: "muted small" }, `${runs.length} run${runs.length === 1 ? "" : "s"}`)),
    run
      ? el("div", { class: "tool-actions" },
          el("button", { class: "btn btn-primary", onclick: () => bwDownload(`commissioning-${bacTimestamp()}.md`, md, "text/markdown;charset=utf-8") }, "Export Markdown"),
          el("button", { class: "btn-ghost", onclick: () => bwDownload(`commissioning-${bacTimestamp()}.csv`, csv, "text/csv;charset=utf-8") }, "Export CSV"),
          el("button", { class: "btn-ghost", onclick: () => copyText(md) }, "Copy Markdown"))
      : el("p", { class: "muted small" }, "Run commissioning checks to create a report."),
    run ? el("textarea", { class: "nm-input bw-json", rows: "16", readonly: "readonly" }, md) : null);
}

function bwCurrentTabBody(inv) {
  return bw.tab === "bacnet" ? bwBacnetTab(inv)
    : bw.tab === "historian" ? bwHistorianTab(inv)
    : bw.tab === "dashboard" ? bwDashboardTab(inv)
    : bw.tab === "commissioning" ? bwCommissioningTab(inv)
    : bw.tab === "reports" ? bwReportsTab(inv)
    : bwModelTab(inv);
}

function renderBuildingWorkspacePage() {
  const inv = inventoryInstance();
  const synced = histSyncFromInventory();
  if (synced) histPersist();
  if (!inv) {
    return el("div", { class: "plugin-controls" },
      el("section", { class: "plugin-section" },
        el("p", { class: "muted" }, "Building Workspace unavailable — the platform kernel did not resolve inventory dependencies.")));
  }
  const body = bwCurrentTabBody(inv);
  setTimeout(bwSyncLivePoll, 0); // after this page mounts, sync the live poll to the selection
  return el("div", { id: "bw-root", class: "plugin-controls bw-root" },
    bwTabs(),
    el("div", { id: "bw-tab-body" }, body),
  );
}

// ============================================================================

return {
  renderStatusPill: bwStatusPill,
  renderPage: renderBuildingWorkspacePage,
  restoreState: bwRestoreState,
  stopLivePoll: bwStopLivePoll,
  renderDeviceInboxLive: bwRenderDeviceInboxLive,
  headerBreadcrumb: bwHeaderBreadcrumb,
  renderWorkspaceScope: bwRenderWorkspaceScope,
  renderTabScope: bwRenderTabScope,
  renderModelScope: bwRenderModelScope,
  renderInboxScope: bwRenderInboxScope,
  ensureLocation: bwEnsureLocation,
  entityByName: bwEntityByName,
  templateForName: bwTemplateForName,
  saveState: bwSaveState,
  getInboxQueuedCount: () => Object.values(bw.deviceInbox?.candidates || {}).filter((c) => c?.status === "queued").length,
  historianRecordForPoint: bwHistorianRecordForPoint,
  historizeObject: bwHistorizeSelectedObject,
};
}
