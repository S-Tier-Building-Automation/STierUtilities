// Building Workspace — model tree, commissioning, dashboards.

import {
  commissioningValueMatches,
  exportCommissioningCsv,
  exportCommissioningMarkdown,
  generateBuildingDashboard,
  historianPointFromEntity,
  interpretStatusFlags,
  parsePriorityArray,
  runCommissioning,
} from "../building-workspace.js";
import { confirmAction } from "../../ui/modal.js";
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
 * @param {(view: string) => void} deps.setView
 * @param {(id: string) => string} deps.pluginView
 * @param {() => string|null} deps.currentPluginId
 * @param {() => import("../../platform/services/pack-controller.js").createPackController extends Function ? ReturnType<import("../../platform/services/pack-controller.js").createPackController> : object|null} deps.getPack
 * @param {() => object|null} [deps.getTelemetry]
 * @param {() => object|null} deps.getHistorian
 * @param {() => number} deps.histSyncFromInventory
 * @param {() => void} deps.histPersist
 * @param {typeof import("../../platform/tauri.js").listen} [deps.listen]
 */
export function createBuildingWorkspaceUi(deps) {
  const {
    invoke, el, logTo, renderAll, renderScoped, userState, saveUserState, getPlatform, networkManager,
    setView, pluginView, getPack, getTelemetry = () => null, getHistorian, currentPluginId, listen,
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
    draft: null,
    busy: false,
    lastRunId: saved.lastRunId || null,
    dashboardJson: "",
    floorBatchPattern: "Floor {n}",
    floorBatchStart: "1",
    floorBatchCount: "3",
    cxMin: "",
    cxMax: "",
    cxNotes: "",
    cxCommand: "",
    cxPriority: "8",
    cxVerify: false,
    cxToggle: false,
    liveUseCov: Boolean(saved.liveUseCov),
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
    liveUseCov: bw.liveUseCov,
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
      el("p", { class: "muted small" }, "Select a site, building, floor, device, or point to inspect modeled context. Protocol discovery and imports live in BACnet Manager."),
      el("button", { class: "btn-ghost", onclick: () => setView(pluginView("bacnet-manager")) }, "Open BACnet Manager")),
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
        ? el("button", { class: "btn-ghost", onclick: () => setView(pluginView("bacnet-manager")) }, "Open BACnet Manager")
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
/** @type {Map<string, { processId: number, device: object, objectType: number, instance: number }>} */
let bwCovSubs = new Map();
let bwCovListenerReady = false;
const BW_POINT_POLL_MS = 4000;
const BW_DEVICE_POLL_MS = 12000;
const BW_DEVICE_POLL_CAP = 60; // don't hammer a big device every tick

function bwBacnetCap() {
  return getPlatform() ? getPlatform().capability("bacnet.read.v1") : null;
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
  void bwUnsubscribeAllCov();
}

function ensureBwCovListener() {
  if (bwCovListenerReady || !listen) return;
  bwCovListenerReady = true;
  listen("bacnet:cov", (event) => bwHandleCovEvent(event.payload)).catch((err) => {
    console.warn("listen bacnet:cov (building-workspace) failed:", err);
  });
}

async function bwUnsubscribeAllCov() {
  const cap = bwBacnetCap();
  const pending = [];
  for (const [, sub] of bwCovSubs) {
    if (!cap.unsubscribeCov) continue;
    pending.push(cap.unsubscribeCov({
      device: sub.device,
      objectType: sub.objectType,
      instance: sub.instance,
      processId: sub.processId,
    }).catch(() => {}));
  }
  bwCovSubs.clear();
  await Promise.allSettled(pending);
}

async function bwSubscribeLiveCov(inv, poll) {
  await bwUnsubscribeAllCov();
  if (!bw.liveUseCov || bwLivePaused) return;
  const cap = bwBacnetCap();
  if (!cap.subscribeCov) return;
  if (poll.kind === "point") {
    const entity = inv.getEntity(poll.id);
    const ref = bwPointRef(entity);
    if (!ref) return;
    const deviceInstance = Number(entity.deviceInstance ?? ref.device.deviceInstance);
    try {
      const processId = await cap.subscribeCov({
        device: ref.device,
        deviceInstance,
        objectType: ref.objectType,
        instance: ref.instance,
      });
      bwCovSubs.set(poll.id, { processId, device: ref.device, objectType: ref.objectType, instance: ref.instance });
    } catch (err) {
      bwLive = { props: null, error: String(err) };
    }
    return;
  }
  const equip = inv.getEntity(poll.id);
  const points = inv.listEntities({ type: "point", equipId: equip.id }).slice(0, BW_DEVICE_POLL_CAP);
  for (const point of points) {
    const ref = bwPointRef(point);
    if (!ref) continue;
    const deviceInstance = Number(point.deviceInstance ?? ref.device.deviceInstance);
    try {
      const processId = await cap.subscribeCov({
        device: ref.device,
        deviceInstance,
        objectType: ref.objectType,
        instance: ref.instance,
      });
      bwCovSubs.set(point.id, { processId, device: ref.device, objectType: ref.objectType, instance: ref.instance });
    } catch (err) {
      if (!bwDeviceLive) bwDeviceLive = { values: new Map() };
      bwDeviceLive.values.set(point.id, { error: String(err) });
    }
  }
}

function bwHandleCovEvent(payload) {
  if (!payload || !bwLivePoll || bwLivePaused || !bw.liveUseCov) return;
  const inv = inventoryInstance();
  if (!inv || currentPluginId() !== "building-workspace" || bw.tab !== "model") return;
  for (const [pointId, sub] of bwCovSubs) {
    if (Number(sub.processId) !== Number(payload.processId)) continue;
    if (Number(payload.objectType) !== Number(sub.objectType) || Number(payload.instance) !== Number(sub.instance)) continue;
    if (bwLivePoll.kind === "point") {
      if (bwLivePoll.id !== pointId) return;
      const entity = inv.getEntity(pointId);
      if (!entity) return;
      bwLive = { props: payload.values || [], cov: true };
      bwUpdateLiveDisplay(entity);
      return;
    }
    const equip = inv.getEntity(bwLivePoll.id);
    if (!equip) return;
    const pv = bwLivePresentValue(payload.values || []);
    if (!bwDeviceLive) bwDeviceLive = { values: new Map() };
    bwDeviceLive.values.set(pointId, { value: pv.value, display: pv.display, cov: true });
    bwUpdateDeviceLive(equip);
    return;
  }
}

function bwToggleLiveCov(checked) {
  bw.liveUseCov = Boolean(checked);
  bwSaveState();
  bwStopLivePoll();
  bwSyncLivePoll();
}

function bwArmLiveTimer(ms) {
  if (bwLiveTimer) { clearInterval(bwLiveTimer); bwLiveTimer = null; }
  if (!bwLivePaused) bwLiveTimer = setInterval(bwLiveTick, ms);
}

// Start/stop the live poll to match the current single selection on the Model tab.
// Idempotent: re-selecting the same entity does not restart the timer or drop data.
function bwSyncLivePoll() {
  ensureBwCovListener();
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
  if (bw.liveUseCov) {
    void bwSubscribeLiveCov(inv, target);
    return;
  }
  bwArmLiveTimer(target.kind === "point" ? BW_POINT_POLL_MS : BW_DEVICE_POLL_MS);
}

function bwToggleLivePause() {
  bwLivePaused = !bwLivePaused;
  if (bwLivePaused) {
    if (bwLiveTimer) { clearInterval(bwLiveTimer); bwLiveTimer = null; }
    void bwUnsubscribeAllCov();
  } else if (bwLivePoll) {
    bwLiveTick();
    if (bw.liveUseCov) {
      const inv = inventoryInstance();
      if (inv) void bwSubscribeLiveCov(inv, bwLivePoll);
    } else {
      bwArmLiveTimer(bwLivePoll.kind === "point" ? BW_POINT_POLL_MS : BW_DEVICE_POLL_MS);
    }
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
  const mode = bw.liveUseCov ? "COV" : "poll";
  return bwLivePaused
    ? el("span", { id: "bw-live-indicator", class: "muted small bw-live-ind" }, "paused")
    : el("span", { id: "bw-live-indicator", class: "bw-live-ind" },
        el("span", { class: "bw-live-dot", title: bw.liveUseCov ? "COV live" : "Polling live" }),
        el("span", { class: "muted small" }, `live · ${mode}`));
}

function bwLiveControls() {
  return el("div", { class: "section-head bw-live-head" },
    el("h4", {}, "Live"),
    el("div", { class: "bw-live-head-right" },
      bwLiveIndicator(),
      el("label", { class: "bac-cov-toggle small" },
        el("input", {
          type: "checkbox",
          checked: bw.liveUseCov ? "checked" : undefined,
          onchange: (e) => bwToggleLiveCov(e.target.checked),
        }),
        "COV"),
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
  if (!points.length) return [el("tr", {}, el("td", { class: "muted small", colspan: "3" }, "No modeled points yet — import points in BACnet Manager."))];
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
  if (!bacnetApi) return;
  bw.busy = true;
  bwRenderTabScope();
  try {
    const points = inv.listEntities({ type: "point" });
    const run = await runCommissioning({
      points,
      bacnet: bacnetApi,
      writeProperty: async ({ point, ref, value, priority, relinquish }) => bacnetApi.writeProperty({
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
  return bw.tab === "historian" ? bwHistorianTab(inv)
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

// ============================================================================

return {
  renderStatusPill: bwStatusPill,
  renderPage: renderBuildingWorkspacePage,
  restoreState: bwRestoreState,
  stopLivePoll: bwStopLivePoll,
  headerBreadcrumb: bwHeaderBreadcrumb,
  renderWorkspaceScope: bwRenderWorkspaceScope,
  renderTabScope: bwRenderTabScope,
  renderModelScope: bwRenderModelScope,
  ensureLocation: bwEnsureLocation,
  entityByName: bwEntityByName,
  templateForName: bwTemplateForName,
  saveState: bwSaveState,
  historianRecordForPoint: bwHistorianRecordForPoint,
};
}
