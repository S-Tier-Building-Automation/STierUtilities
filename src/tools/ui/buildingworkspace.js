// Building Workspace — model tree, commissioning, dashboards.

import {
  commissioningValueMatches,
  exportCommissioningCsv,
  exportCommissioningMarkdown,
  bacnetUnitSymbol,
  bwRegroupPointsUnderDevices,
  formatModeledValue,
  generateBuildingDashboard,
  groupObjectProperties,
  humanizePropName,
  historianPointFromEntity,
  interpretStatusFlags,
  parsePriorityArray,
  runCommissioning,
} from "../building-workspace.js";
import { confirmAction } from "../../ui/modal.js";
import { lineChartCanvas } from "../../ui/chart.js";
import {
  attachPaneDrag,
  attachPaneDragRight,
  buildGridColumns,
  clampPaneWidth,
  createPaneSplitter,
  paneSplitterKeyHandler,
  updateSplitterAria,
} from "../../ui/split-pane.js";
import { toast } from "../../ui/toast.js";
import { setAppIntent, takeAppIntent } from "../../ui/app-intent.js";
import {
  patchDeviceGraphicValues,
  renderDeviceGraphic,
  renderDeviceViewToggle,
  renderGraphicBindingCard,
  renderGraphicStatusRow,
  renderMonitoringParameters,
} from "./device-graphic.js";

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
    lastRuleRunId: saved.lastRuleRunId || null,
    rulesDatMin: saved.rulesDatMin ?? "45",
    rulesDatMax: saved.rulesDatMax ?? "120",
    rulesFlowMin: saved.rulesFlowMin ?? "50",
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
    propsFilter: "",
    // Optional (toggleable) device-table columns the user has chosen to show.
    // The "point" column is always shown and is not stored here.
    dliveCols: Array.isArray(saved.dliveCols) ? saved.dliveCols.slice() : ["object", "value"],
    deviceView: saved.deviceView || "auto",
    showGraphicUpdated: Boolean(saved.showGraphicUpdated),
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
    lastRuleRunId: bw.lastRuleRunId,
    rulesDatMin: bw.rulesDatMin,
    rulesDatMax: bw.rulesDatMax,
    rulesFlowMin: bw.rulesFlowMin,
    liveUseCov: bw.liveUseCov,
    dliveCols: bw.dliveCols,
    deviceView: bw.deviceView,
    showGraphicUpdated: bw.showGraphicUpdated,
  };
  saveUserState();
}

function bwTabPanelHead({ title, meta = null, desc = null, actions = null }) {
  return el("div", { class: "bw-tab-panel-head" },
    el("div", { class: "section-head bw-panel-title-row" },
      el("h3", {}, title),
      meta ? el("span", { class: "muted small bw-panel-meta" }, meta) : null),
    desc ? el("p", { class: "muted small bw-panel-desc" }, desc) : null,
    actions ? el("div", { class: "tool-actions bw-panel-actions" }, ...(Array.isArray(actions) ? actions : [actions])) : null);
}

function bwPluginHeaderAddon() {
  const inv = inventoryInstance();
  const breadcrumb = inv ? bwHeaderBreadcrumb() : null;
  const liveSlot = bw.tab === "model"
    ? el("div", { id: "bw-header-live-slot", class: "bw-header-live" }, bwLivePoll ? bwLiveIndicator() : null)
    : null;
  if (!breadcrumb && !liveSlot) return null;
  return el("div", { id: "bw-plugin-header-addon", class: "bw-plugin-addon" },
    breadcrumb,
    liveSlot,
  );
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
  const sameDevicePoint = entity.type === "point" && bwPointSelectedOnSameDeviceCenter(inv, entity);
  if (sameDevicePoint) {
    // Clear the previous point's live props so the right-pane inspector shows
    // "Reading…" until the next poll tick lands the new point's values.
    bwLive = null;
    bwRenderModelScope({ tree: true, properties: true, header: true });
    bwHighlightDeviceLiveRow(entity.id);
    return;
  }
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
  const graphics = bwGraphicsCap();
  let taggedTotal = 0;
  for (const device of devices) {
    inv.applyTemplate(device.id, templateId);
    if (graphics) taggedTotal += graphics.applyAutoTags(device.id);
  }
  logTo("building-workspace", devices.length
    ? `Applied ${templateId} template to ${devices.length} device${devices.length === 1 ? "" : "s"}${taggedTotal ? `; auto-tagged ${taggedTotal} point${taggedTotal === 1 ? "" : "s"}.` : "."}`
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
    ["alerts", "Alerts"],
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
  const graphics = bwGraphicsCap();
  if (graphics) {
    const tagged = graphics.applyAutoTags(entityId);
    if (tagged) logTo("building-workspace", `Auto-tagged ${tagged} point${tagged === 1 ? "" : "s"} for device graphic.`, "ok");
  }
  logTo("building-workspace", `Applied ${templateId} template.`, "ok");
  bwRenderModelScope({ tree: true, details: true });
}

function bwGraphicsCap() {
  return getPlatform() ? getPlatform().capability("graphics.v1") : null;
}

function bwGraphicContext(inv, equip) {
  const template = equip.templateId ? inv.getEntity(equip.templateId) : null;
  const graphics = bwGraphicsCap();
  const points = inv.listEntities({ type: "point", equipId: equip.id });
  if (!graphics) return { template, graphic: null, points, bindings: null, view: "table" };
  const graphic = graphics.graphicForEquip(equip, template);
  const bindings = graphic
    ? graphics.resolveBindings({
        equip,
        graphic,
        points,
        liveValues: bwDeviceLive?.values,
        formatValue: formatModeledValue,
      })
    : null;
  const view = graphics.effectiveDeviceView({ deviceView: bw.deviceView, graphic, bindings });
  return { template, graphic, points, bindings, view };
}

function bwSetDeviceView(mode) {
  bw.deviceView = mode;
  bwSaveState();
  bwRenderModelScope({ center: true, properties: true });
}

function bwBindGraphicSlot(pointId, role) {
  const graphics = bwGraphicsCap();
  if (!graphics) return;
  try {
    const point = graphics.setPointGraphicRole(pointId, role);
    logTo("building-workspace", `Bound ${point.name} to graphic slot ${role}.`, "ok");
  } catch (err) {
    logTo("building-workspace", `Bind failed: ${err}`, "error");
  }
  bwRenderModelScope({ center: true, properties: true });
}

function bwAutoTagGraphicRoles(equip) {
  const graphics = bwGraphicsCap();
  if (!graphics) return;
  const tagged = graphics.applyAutoTags(equip.id);
  logTo(
    "building-workspace",
    tagged ? `Auto-tagged ${tagged} point${tagged === 1 ? "" : "s"} for device graphic.` : "No new graphic tags to apply.",
    tagged ? "ok" : "info",
  );
  bwRenderModelScope({ center: true, properties: true });
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

function bwRootCenter(inv) {
  return [
    el("div", { class: "bw-card bw-context-summary" },
      el("h4", { class: "bw-card-title" }, "Model overview"),
      el("p", { class: "muted small" }, "Select a site, building, floor, device, or point in the tree. Live values appear in the center pane; metadata and BACnet properties live in Properties."),
      el("button", { class: "btn-ghost", onclick: () => setView(pluginView("bacnet-manager")) }, "Open BACnet Manager")),
  ];
}

function bwRootProperties(inv) {
  const counts = bwScopeCounts(inv);
  return [
    el("div", { class: "bw-count-grid" },
      bwCountTile("Sites", counts.sites),
      bwCountTile("Buildings", counts.buildings),
      bwCountTile("Floors", counts.floors),
      bwCountTile("Devices", counts.devices),
      bwCountTile("Points", counts.points)),
  ];
}

function bwHierarchyCenter(kind) {
  return el("div", { class: "bw-center-empty" },
    el("p", { class: "muted small" }, `Select a device or point under this ${kind} to view live BACnet values here.`));
}

function bwSiteProperties(inv, site) {
  const counts = bwScopeCounts(inv, site);
  return [
    el("div", { class: "bw-count-grid" },
      bwCountTile("Buildings", counts.buildings),
      bwCountTile("Floors", counts.floors),
      bwCountTile("Devices", counts.devices),
      bwCountTile("Points", counts.points)),
    el("div", { class: "bw-card bw-detail-card" },
      el("h4", { class: "bw-card-title" }, "Site"),
      el("div", { class: "bw-detail-grid" },
        bwDetailRow("Name", site.name),
        bwDetailRow("Tags", Object.keys(site.tags || {}).join(", ")))),
  ];
}

function bwBuildingProperties(inv, building) {
  const counts = bwScopeCounts(inv, building);
  const floors = inv.listEntities({ type: "floor", buildingId: building.id });
  if (!String(bw.floorBatchStart || "").trim()) bw.floorBatchStart = String(floors.length + 1);
  return [
    el("div", { class: "bw-count-grid" },
      bwCountTile("Floors", counts.floors),
      bwCountTile("Devices", counts.devices),
      bwCountTile("Points", counts.points)),
    el("div", { class: "bw-card bw-detail-card" },
      el("h4", { class: "bw-card-title" }, "Building"),
      el("div", { class: "bw-detail-grid" },
        bwDetailRow("Name", building.name),
        bwDetailRow("Site", inv.getEntity(building.siteId)?.name || ""),
        bwDetailRow("Tags", Object.keys(building.tags || {}).join(", ")))),
    el("div", { class: "bw-card bw-batch-card" },
      el("h4", { class: "bw-card-title" }, "Add floors"),
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
    ),
  ];
}

function bwFloorProperties(inv, floor) {
  const counts = bwScopeCounts(inv, floor);
  return [
    el("div", { class: "bw-count-grid" },
      bwCountTile("Devices", counts.devices),
      bwCountTile("Points", counts.points)),
    el("div", { class: "bw-card bw-detail-card" },
      el("h4", { class: "bw-card-title" }, "Floor"),
      el("div", { class: "bw-detail-grid" },
        bwDetailRow("Name", floor.name),
        bwDetailRow("Building", inv.getEntity(floor.buildingId || floor.parentId)?.name || ""),
        bwDetailRow("Site", inv.getEntity(floor.siteId)?.name || ""),
        bwDetailRow("Tags", Object.keys(floor.tags || {}).join(", ")))),
  ];
}

function bwDeviceProperties(inv, equip) {
  const templates = inv.listEntities({ type: "template" });
  const points = inv.listEntities({ type: "point", equipId: equip.id });
  const hasBinding = equip.tags?.bacnet || equip.deviceInstance != null;
  const ctx = bwGraphicContext(inv, equip);
  const graphicSections = ctx.graphic
    ? [
        renderMonitoringParameters(el, {
          bindings: ctx.bindings,
          showUpdated: bw.showGraphicUpdated,
          onToggleUpdated: (on) => {
            bw.showGraphicUpdated = on;
            bwSaveState();
            bwRenderModelScope({ properties: true });
          },
          onBindSlot: (slotId, pointId) => bwBindGraphicSlot(pointId, slotId),
          points: ctx.points,
        }),
        renderGraphicBindingCard(el, {
          graphic: ctx.graphic,
          unboundSlots: ctx.bindings.unboundSlots,
          points: ctx.points,
          onBindSlot: (slotId, pointId) => bwBindGraphicSlot(pointId, slotId),
          onAutoTag: () => bwAutoTagGraphicRoles(equip),
        }),
      ].filter(Boolean)
    : [];
  return [
    el("div", { class: "bw-count-grid" }, bwCountTile("Points", points.length)),
    el("div", { class: "bw-card bw-detail-card" },
      el("h4", { class: "bw-card-title" }, "Model"),
      el("div", { class: "bw-detail-grid" },
        bwDetailRow("Name", equip.name),
        bwDetailRow("Device instance", equip.deviceInstance),
        bwDetailRow("Template", equip.templateId || ""),
        bwDetailRow("Graphic", ctx.graphic?.title || "—"),
        bwDetailRow("Tags", Object.keys(equip.tags || {}).join(", "))),
      el("div", { class: "tool-actions" },
        hasBinding
          ? el("button", { class: "btn-ghost", onclick: () => setView(pluginView("bacnet-manager")) }, "Open BACnet Manager")
          : null,
        ctx.graphic
          ? el("button", { class: "btn-ghost", onclick: () => bwOpenApp("device-graphics", { equipId: equip.id }) }, "Open Graphics")
          : null,
        el("select", { class: "nm-input bw-template-select", onchange: (e) => { bw.template = e.target.value; bwSaveState(); } },
          ...templates.map((t) => el("option", { value: t.id, selected: bw.template === t.id || bw.template === t.id.replace("template:", "") ? "selected" : undefined }, t.name)))),
    ),
    ...graphicSections,
    hasBinding
      ? bwObjectPropsPanel({
          props: bwDeviceObjLive?.props,
          filter: bw.propsFilter,
          loading: !bwDeviceObjLive,
          error: bwDeviceObjLive?.error || null,
        })
      : el("p", { class: "muted small" }, "No BACnet binding — live device properties unavailable."),
  ];
}

function bwDeviceCenter(inv, equip) {
  const live = bwDeviceLivePanel(inv, equip);
  if (!live) return [el("p", { class: "muted small" }, "This device has no BACnet binding for live reads.")];
  const ctx = bwGraphicContext(inv, equip);
  if (!ctx.graphic) return [live];

  const boundCallouts = ctx.bindings.callouts.filter((b) => b.pointId).length;
  const toggle = renderDeviceViewToggle(el, {
    mode: bw.deviceView,
    activeMode: ctx.view,
    boundCount: boundCallouts,
    totalSlots: (ctx.graphic.slots || []).length,
    onChange: bwSetDeviceView,
  });

  if (ctx.view === "table") {
    return [el("div", { class: "bw-device-center-wrap bw-device-center-table", "data-bw-device-id": equip.id },
      el("div", { class: "bw-device-center-toolbar" }, toggle),
      live,
    )];
  }

  return [el("div", { class: "bw-device-center-wrap bw-device-center-graphic", "data-bw-device-id": equip.id },
    el("div", { class: "bw-device-center-toolbar" }, toggle, bwLiveControls()),
    renderGraphicStatusRow(el, { bindings: ctx.bindings }),
    el("div", { class: "bw-device-center-body pane-fill-body" },
      renderDeviceGraphic(el, { equip, graphic: ctx.graphic, bindings: ctx.bindings }),
    ),
    boundCallouts === 0
      ? el("p", { class: "muted small bw-graphic-hint" }, "Bind points in Properties (Auto-tag or manual) to populate callouts.")
      : null,
  )];
}

// ---- Phase 2: live control for a modeled point (present-value, status flags,
// 16-slot priority array, inline write / relinquish / write+verify) ----

// Auto-poll live data for the currently-selected point/device on the Model tab. The
// poll updates only its own display container in place, so write inputs keep focus.
let bwLive = null;          // point poll: { props } | { props:null, error }
let bwDeviceLive = null;    // device poll: { values: Map(pointId -> { value, display, props } | { error }) }
let bwDeviceObjLive = null; // device object poll: { props } | { props:null, error }
// Union of live BACnet properties seen across the current device's points,
// used to populate the optional property columns in the Columns menu.
/** @type {Map<string, { id: number|null, label: string }>} */
let bwDlivePropCatalog = new Map();
let bwLivePoll = null;      // { kind: "point"|"device", id, focusPointId?, tick? }
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
const BW_DEVICE_OBJECT_TYPE = 8;

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

function bwEquipHasBinding(equip) {
  return !!(equip && (equip.tags?.bacnet || equip.deviceInstance != null || equip.deviceRef));
}

function bwParentEquipForPoint(inv, point) {
  return point?.equipId ? inv.getEntity(point.equipId) : null;
}

function bwResolvePollTarget(inv) {
  const sel = bwSelectedEntities(inv);
  const entity = sel.length === 1 ? sel[0] : null;
  if (!entity) return null;
  if (entity.type === "equip" && bwEquipHasBinding(entity)) {
    return { kind: "device", id: entity.id, focusPointId: null };
  }
  if (entity.type === "point" && bwPointRef(entity)) {
    const parent = bwParentEquipForPoint(inv, entity);
    if (parent && bwEquipHasBinding(parent)) {
      return { kind: "device", id: parent.id, focusPointId: entity.id };
    }
    return { kind: "point", id: entity.id, focusPointId: null };
  }
  return null;
}

function bwPollTargetsEqual(a, b) {
  if (!a || !b) return false;
  return a.kind === b.kind && a.id === b.id && (a.focusPointId || null) === (b.focusPointId || null);
}

function bwCenterDeviceId() {
  return document.querySelector("#bw-model-center [data-bw-device-id]")?.dataset?.bwDeviceId || "";
}

function bwPointSelectedOnSameDeviceCenter(inv, point) {
  if (!point || point.type !== "point" || !point.equipId) return false;
  const parent = bwParentEquipForPoint(inv, point);
  return bwCenterDeviceId() === point.equipId && bwEquipHasBinding(parent);
}

function bwHighlightDeviceLiveRow(pointId) {
  document.querySelectorAll(".bw-dlive-row").forEach((row) => {
    row.classList.toggle("bw-dlive-row-active", row.dataset.pointId === pointId);
  });
}

function bwPollIntervalMs(poll) {
  if (!poll) return BW_DEVICE_POLL_MS;
  if (poll.focusPointId || poll.kind === "point") return BW_POINT_POLL_MS;
  return BW_DEVICE_POLL_MS;
}

const BW_DEVICE_SWEEP_EVERY = Math.max(1, Math.round(BW_DEVICE_POLL_MS / BW_POINT_POLL_MS));

function bwStopLivePoll() {
  if (bwLiveTimer) { clearInterval(bwLiveTimer); bwLiveTimer = null; }
  bwLivePoll = null;
  bwLive = null;
  bwDeviceLive = null;
  bwDeviceObjLive = null;
  bwDlivePropCatalog = new Map();
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
    const prev = bwDeviceLive.values.get(pointId);
    bwDeviceLive.values.set(pointId, { ...prev, value: pv.value, display: pv.display, cov: true });
    if (bwLivePoll.focusPointId === pointId) {
      bwLive = { props: payload.values || [], cov: true };
      const focusPoint = inv.getEntity(pointId);
      if (focusPoint) bwUpdateLiveDisplay(focusPoint);
    }
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
  const target = bwResolvePollTarget(inv);
  if (!target) { bwStopLivePoll(); return; }
  if (bwLivePoll && bwLivePoll.kind === "device" && target.kind === "device" && bwLivePoll.id === target.id) {
    if ((bwLivePoll.focusPointId || null) === (target.focusPointId || null)) return;
    bwLivePoll = { ...bwLivePoll, focusPointId: target.focusPointId || null };
    bwLiveTick();
    if (bw.liveUseCov) void bwSubscribeLiveCov(inv, bwLivePoll);
    else bwArmLiveTimer(bwPollIntervalMs(bwLivePoll));
    return;
  }
  if (bwPollTargetsEqual(bwLivePoll, target)) return;
  bwStopLivePoll();
  bwLivePoll = { ...target, tick: 0 };
  bwLiveTick();
  if (bw.liveUseCov) {
    void bwSubscribeLiveCov(inv, bwLivePoll);
    return;
  }
  bwArmLiveTimer(bwPollIntervalMs(bwLivePoll));
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
      bwArmLiveTimer(bwPollIntervalMs(bwLivePoll));
    }
  }
  const ind = document.getElementById("bw-live-indicator");
  if (ind) ind.replaceWith(bwLiveIndicator());
  const headerLive = document.getElementById("bw-header-live-slot");
  if (headerLive) headerLive.replaceChildren(bwLiveIndicator());
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
      const equip = entity;
      const focusId = poll.focusPointId || null;
      poll.tick = (poll.tick || 0) + 1;
      const doFullSweep = !focusId || poll.tick === 1 || poll.tick % BW_DEVICE_SWEEP_EVERY === 0;

      if (doFullSweep) {
        const deviceInstance = Number(equip.deviceInstance);
        const deviceRef = equip.deviceRef || (Number.isFinite(deviceInstance) ? { deviceInstance } : null);
        if (deviceRef && Number.isFinite(deviceInstance)) {
          try {
            const devProps = await bwBacnetCap().readPoint(deviceRef, BW_DEVICE_OBJECT_TYPE, deviceInstance);
            if (bwLivePoll !== poll) return;
            bwDeviceObjLive = { props: devProps };
          } catch (err) {
            if (bwLivePoll !== poll) return;
            bwDeviceObjLive = { props: null, error: String(err) };
          }
          if (!focusId) bwUpdateObjectPropsPanel();
        }
        const points = inv.listEntities({ type: "point", equipId: equip.id }).slice(0, BW_DEVICE_POLL_CAP);
        const values = bwDeviceLive?.values || new Map();
        for (const p of points) {
          if (bwLivePoll !== poll) return;
          const ref = bwPointRef(p);
          if (!ref) { values.set(p.id, { error: "no ref" }); continue; }
          try {
            const props = await bwBacnetCap().readPoint(ref.device, ref.objectType, ref.instance);
            if (bwLivePoll !== poll) return;
            const pv = bwLivePresentValue(props);
            values.set(p.id, { value: pv.value, display: pv.display, props });
            bwCatalogProps(props);
          } catch (err) {
            if (bwLivePoll !== poll) return;
            values.set(p.id, { error: String(err) });
          }
          bwDeviceLive = { values };
          bwUpdateDeviceLive(equip);
        }
        bwRefreshColumnsMenu(equip);
      }

      if (focusId) {
        const focusPoint = inv.getEntity(focusId);
        if (focusPoint) {
          const ref = bwPointRef(focusPoint);
          if (ref) {
            try {
              const props = await bwBacnetCap().readPoint(ref.device, ref.objectType, ref.instance);
              if (bwLivePoll !== poll) return;
              bwLive = { props };
              const pv = bwLivePresentValue(props);
              if (!bwDeviceLive) bwDeviceLive = { values: new Map() };
              bwDeviceLive.values.set(focusId, { value: pv.value, display: pv.display, props });
              bwCatalogProps(props);
            } catch (err) {
              if (bwLivePoll !== poll) return;
              bwLive = { props: null, error: String(err) };
            }
            bwUpdateLiveDisplay(focusPoint);
            if (!doFullSweep) bwUpdateDeviceLive(equip);
          }
        }
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
  const headerLive = document.getElementById("bw-header-live-slot");
  if (headerLive) headerLive.replaceChildren(bwLiveIndicator());
  bwUpdateTrendChart(point);
  bwUpdateObjectPropsPanel();
}

function bwUpdateDeviceLive(equip) {
  const node = document.getElementById("bw-device-live");
  if (node) node.replaceChildren(...bwDeviceLiveRows(equip));
  const inv = inventoryInstance();
  if (inv && document.getElementById("bw-device-graphic")) {
    const { bindings } = bwGraphicContext(inv, equip);
    patchDeviceGraphicValues(bindings);
    for (const p of bindings.parameters || []) {
      const paramNode = document.querySelector(`.bw-monitor-row[data-graphic-slot="${p.slotId}"] [data-graphic-value]`);
      if (paramNode) paramNode.textContent = p.display ?? "—";
    }
  }
  const ind = document.getElementById("bw-live-indicator");
  if (ind) ind.replaceWith(bwLiveIndicator());
  const headerLive = document.getElementById("bw-header-live-slot");
  if (headerLive) headerLive.replaceChildren(bwLiveIndicator());
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
  const unitEntry = bwPropEntry(live.props, 117, "units");
  const units = bacnetUnitSymbol(unitEntry?.display);
  const out = [
    el("div", { class: "bw-readout-card" },
      el("div", { class: "bw-readout-label muted small" }, "Present value"),
      el("div", { class: "bw-live-pv" },
        el("span", { class: "bw-live-pv-val" }, formatModeledValue(point, pv.display ?? (pv.value != null ? String(pv.value) : "—"))),
        units ? el("span", { class: "bw-readout-units muted small" }, units) : null),
      flags && flags.raised.length
        ? el("div", { class: "bw-live-flags" }, ...flags.raised.map((f) => el("span", { class: `bw-flag bw-flag-${f.replace(/[^a-z]/g, "")}` }, f)))
        : el("span", { class: "muted small" }, "no active alarms"),
    ),
  ];
  if (parsed) out.push(el("div", { class: "bw-prio-wrap bw-readout-card" }, el("span", { class: "muted small" }, "Priority array (1 = highest)"), bwPriorityRibbon(point, parsed)));
  return out;
}

// Short BACnet object-type labels for the optional "Type" column.
const BW_OBJ_TYPE_LABELS = {
  0: "AI", 1: "AO", 2: "AV", 3: "BI", 4: "BO", 5: "BV",
  8: "Device", 10: "File", 13: "MSI", 14: "MSO", 15: "Notif Class",
  17: "Schedule", 19: "MSV", 20: "Trend Log", 40: "CharString",
};

function bwObjectTypeLabel(objectType) {
  const n = Number(objectType);
  if (!Number.isFinite(n)) return "";
  return BW_OBJ_TYPE_LABELS[n] || `type ${n}`;
}

// Registry of fixed device-table columns. "point" is always shown; the rest are
// opt-in via the Columns menu and persisted in bw.dliveCols. Live BACnet
// properties are offered as additional dynamic columns keyed "prop:<name>".
const BW_DLIVE_COLUMNS = [
  { key: "point", label: "Point", always: true, cls: "bw-dlive-col-point" },
  { key: "bacnetName", label: "BACnet name", cls: "bw-dlive-col-text" },
  { key: "object", label: "Object", cls: "bw-dlive-col-object" },
  { key: "type", label: "Type", cls: "bw-dlive-col-type" },
  { key: "value", label: "Live value", cls: "bw-dlive-col-val" },
  { key: "units", label: "Units", cls: "bw-dlive-col-units" },
  { key: "trend", label: "Trend", cls: "bw-dlive-col-flag" },
  { key: "writable", label: "Writable", cls: "bw-dlive-col-flag" },
];

// Properties already represented by a dedicated column (present-value, units)
// or not useful as a per-row column (object name/identifier) are not offered
// as dynamic property columns.
const BW_DLIVE_PROP_EXCLUDE = new Set([8, 75, 77, 85, 117]);

// Accumulate the union of live properties seen across the device's points.
function bwCatalogProps(props) {
  if (!Array.isArray(props)) return;
  for (const p of props) {
    if (!p || BW_DLIVE_PROP_EXCLUDE.has(Number(p.id))) continue;
    const name = p.name || (p.id != null ? `property-${p.id}` : null);
    if (!name) continue;
    if (!bwDlivePropCatalog.has(name)) {
      bwDlivePropCatalog.set(name, { id: p.id ?? null, label: humanizePropName(p.name || name) });
    }
  }
}

function bwPropColumnKey(name) {
  return `prop:${name}`;
}

// Resolve the dynamic property columns the user has enabled (in saved order).
function bwSelectedPropColumns() {
  if (!Array.isArray(bw.dliveCols)) return [];
  return bw.dliveCols
    .filter((k) => typeof k === "string" && k.startsWith("prop:"))
    .map((k) => {
      const name = k.slice("prop:".length);
      const meta = bwDlivePropCatalog.get(name);
      return {
        key: k,
        propName: name,
        propId: meta?.id ?? null,
        label: meta?.label || humanizePropName(name),
        cls: "bw-dlive-col-prop",
      };
    });
}

function bwColVisible(key) {
  if (typeof key === "string" && key.startsWith("prop:")) {
    return Array.isArray(bw.dliveCols) && bw.dliveCols.includes(key);
  }
  const col = BW_DLIVE_COLUMNS.find((c) => c.key === key);
  if (!col) return false;
  return col.always || (Array.isArray(bw.dliveCols) && bw.dliveCols.includes(key));
}

function bwVisibleDliveColumns() {
  return [...BW_DLIVE_COLUMNS.filter((c) => bwColVisible(c.key)), ...bwSelectedPropColumns()];
}

function bwDliveValueCell(p) {
  const values = bwDeviceLive?.values || new Map();
  const v = values.get(p.id);
  if (!v) return el("span", { class: "muted small" }, "…");
  if (v.error) return el("span", { class: "bw-live-err", title: v.error }, "err");
  return el("span", { class: "bw-live-val" }, formatModeledValue(p, v.display ?? (v.value != null ? String(v.value) : "—")));
}

// Render a live property value for a point from its stored full props.
function bwDlivePropCell(p, col) {
  const v = (bwDeviceLive?.values || new Map()).get(p.id);
  if (!v) return el("span", { class: "muted small" }, "…");
  if (v.error) return el("span", { class: "bw-live-err", title: v.error }, "err");
  const entry = (v.props || []).find((e) => e && (e.name === col.propName || (col.propId != null && e.id === col.propId)));
  if (!entry) return el("span", { class: "muted" }, "—");
  if (entry.error) return el("span", { class: "bw-live-err", title: entry.error }, "err");
  const text = entry.display != null && String(entry.display) !== "" ? String(entry.display) : "—";
  return el("span", { class: "bw-live-val", title: text }, text);
}

function bwDliveCellFor(col, p) {
  if (col.key.startsWith("prop:")) {
    return el("td", { class: `${col.cls} muted small` }, bwDlivePropCell(p, col));
  }
  switch (col.key) {
    case "point":
      return el("td", { class: col.cls }, p.name || p.id);
    case "bacnetName":
      return el("td", { class: `${col.cls} muted small` }, p.bacnetName || "");
    case "object":
      return el("td", { class: `${col.cls} muted small` }, p.objectType != null && p.instance != null ? `${p.objectType}:${p.instance}` : "");
    case "type":
      return el("td", { class: `${col.cls} muted small` }, bwObjectTypeLabel(p.objectType));
    case "value":
      return el("td", { class: `${col.cls} bw-dlive-val` }, bwDliveValueCell(p));
    case "units":
      return el("td", { class: `${col.cls} muted small` }, bacnetUnitSymbol(p.unit) || "");
    case "trend":
      return el("td", { class: col.cls, title: p.historize ? "Trended" : "Not trended" }, p.historize ? el("span", { class: "bw-dlive-yes" }, "●") : el("span", { class: "muted" }, "—"));
    case "writable":
      return el("td", { class: col.cls, title: p.tags?.writable ? "Commandable" : "Read-only" }, p.tags?.writable ? el("span", { class: "bw-dlive-yes" }, "✎") : el("span", { class: "muted" }, "—"));
    default:
      return el("td", {});
  }
}

function bwDeviceLiveRows(equip) {
  const inv = inventoryInstance();
  if (!inv) return [];
  const cols = bwVisibleDliveColumns();
  const span = String(cols.length);
  const points = inv.listEntities({ type: "point", equipId: equip.id });
  if (!points.length) return [el("tr", {}, el("td", { class: "muted small", colspan: span }, "No modeled points yet — import points in BACnet Manager."))];
  const shown = points.slice(0, BW_DEVICE_POLL_CAP);
  const rows = shown.map((p) =>
    el("tr", {
      class: `bw-dlive-row${p.id === bw.selectedEntityId ? " bw-dlive-row-active" : ""}`,
      "data-point-id": p.id,
      onclick: () => bwSelectTreeEntity(p),
    },
      ...cols.map((col) => bwDliveCellFor(col, p))));
  if (points.length > shown.length) {
    rows.push(el("tr", {}, el("td", { class: "muted small", colspan: span }, `+${points.length - shown.length} more not polled (cap ${BW_DEVICE_POLL_CAP})`)));
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
    if (!bwLivePaused && bwLivePoll) {
      if (bwLivePoll.kind === "point" && bwLivePoll.id === point.id) bwLiveTick();
      else if (bwLivePoll.focusPointId === point.id) bwLiveTick();
    }
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
function bwLivePanel(inv, point, { showControls = true } = {}) {
  const ref = bwPointRef(point);
  if (!ref) return null;
  const children = [];
  if (showControls) children.push(bwLiveControls());
  children.push(el("div", { id: "bw-live-display", class: "bw-live-display" }, ...bwLiveDisplayChildren(point)));
  if (point.tags?.writable) children.push(bwWriteControls(point, ref));
  else children.push(el("p", { class: "muted small" }, "Read-only object (not commandable)."));
  const cls = showControls ? "bw-live" : "bw-live bw-card";
  return el("div", { class: cls }, ...children);
}

function bwTrendChartChild(inv, point) {
  const hist = historianInstance();
  if (!point.historize) {
    return el("p", { class: "muted small" }, 'Enable "Trend this point" and save to start collecting samples.');
  }
  if (!hist) {
    return el("p", { class: "muted small" }, "Historian is not available in this build.");
  }
  if (!hist.isRunning()) {
    return el("p", { class: "muted small" }, "Start the Historian (header toolbar) to log samples.");
  }
  let samples = [];
  try {
    samples = hist.history(bwHistorianRecordForPoint(inv, point));
  } catch (_) {
    return el("p", { class: "muted small" }, "Point is not bound to a BACnet device yet.");
  }
  const host = document.getElementById("bw-trend-chart");
  const width = host?.clientWidth || 480;
  return lineChartCanvas({
    samples,
    width,
    height: 140,
    format: (v) => formatModeledValue(point, String(v)),
  });
}

function bwUpdateTrendChart(point) {
  const node = document.getElementById("bw-trend-chart");
  if (!node) return;
  const inv = inventoryInstance();
  if (!inv) return;
  node.replaceChildren(bwTrendChartChild(inv, point));
}

function bwTrendPanel(inv, point) {
  return el("div", { class: "bw-trend bw-readout-card" },
    el("div", { class: "section-head" }, el("h4", {}, "Trend")),
    el("div", { id: "bw-trend-chart", class: "bw-trend-chart" }, bwTrendChartChild(inv, point)),
  );
}


function bwColOpt(equip, key, label, { locked = false, note = null } = {}) {
  return el("label", { class: `bw-col-opt${locked ? " bw-col-opt-locked" : ""}` },
    el("input", {
      type: "checkbox",
      checked: bwColVisible(key) ? "checked" : undefined,
      disabled: locked ? "disabled" : undefined,
      onchange: locked ? undefined : (e) => bwToggleDliveCol(equip, key, e.target.checked),
    }),
    el("span", { class: "bw-col-opt-label", title: label }, label),
    note ? el("span", { class: "muted small bw-col-opt-note" }, note) : null);
}

// Dropdown that lets the user show/hide fixed columns and any live BACnet
// property (discovered from polling) as an additional column.
function bwDliveColumnsMenu(equip) {
  const props = [...bwDlivePropCatalog.entries()]
    .map(([name, meta]) => ({ name, label: meta.label }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return el("details", { class: "bw-col-menu" },
    el("summary", { class: "btn-ghost bw-col-menu-summary", title: "Show or hide table columns" }, "Columns"),
    el("div", { class: "bw-col-menu-pop" },
      el("div", { class: "bw-col-menu-head muted small" }, "Columns"),
      ...BW_DLIVE_COLUMNS.map((c) => bwColOpt(equip, c.key, c.label, { locked: c.always, note: c.always ? "always" : null })),
      el("div", { class: "bw-col-menu-head muted small" }, "BACnet properties"),
      props.length
        ? el("div", { class: "bw-col-menu-props" }, ...props.map((p) => bwColOpt(equip, bwPropColumnKey(p.name), p.label)))
        : el("div", { class: "muted small bw-col-menu-empty" }, "Reading live properties…")));
}

function bwToggleDliveCol(equip, key, on) {
  const set = new Set(Array.isArray(bw.dliveCols) ? bw.dliveCols : []);
  if (on) set.add(key);
  else set.delete(key);
  // Keep a stable order: fixed columns (registry order, minus always-on) first,
  // then any selected property columns in the order they were added.
  const fixed = BW_DLIVE_COLUMNS.filter((c) => !c.always && set.has(c.key)).map((c) => c.key);
  const propKeys = [...set].filter((k) => typeof k === "string" && k.startsWith("prop:"));
  bw.dliveCols = [...fixed, ...propKeys];
  bwSaveState();
  const wrap = document.getElementById("bw-dlive-table-wrap");
  if (wrap) wrap.replaceChildren(bwDliveTable(equip));
}

// Refresh the Columns menu after a sweep discovers new properties, but only
// when it is closed so we never disrupt an open menu mid-interaction.
function bwRefreshColumnsMenu(equip) {
  const menu = document.querySelector("#bw-model-center .bw-col-menu");
  if (menu && !menu.open) menu.replaceWith(bwDliveColumnsMenu(equip));
}

function bwDliveTable(equip) {
  const cols = bwVisibleDliveColumns();
  return el("table", { class: "bac-table bw-dlive-table" },
    el("colgroup", {}, ...cols.map((c) => el("col", { class: c.cls }))),
    el("thead", {}, el("tr", {}, ...cols.map((c) => el("th", { class: c.cls }, c.label)))),
    el("tbody", { id: "bw-device-live" }, ...bwDeviceLiveRows(equip)));
}

// Auto-polling live values for every modeled point under a selected device.
function bwDeviceLivePanel(inv, equip) {
  if (!bwEquipHasBinding(equip)) return null;
  return el("div", { class: "bw-live bw-live-fill", "data-bw-device-id": equip.id },
    el("div", { class: "bw-dlive-toolbar" }, bwLiveControls(), bwDliveColumnsMenu(equip)),
    el("div", { id: "bw-dlive-table-wrap", class: "table-scroll table-scroll-fill" }, bwDliveTable(equip)),
  );
}

// Persist edits to a point's display config, refresh the historian (and
// register it if "trend" was just turned on), and reselect to re-render.
function bwPropValueCell(row) {
  if (row.error) {
    return el("span", { class: "bw-prop-val bw-prop-err muted small", title: row.error }, row.error);
  }
  if (row.id === 111) {
    const flags = interpretStatusFlags(row.display);
    if (flags.raised.length) {
      return el("span", { class: "bw-prop-val bw-prop-chips" },
        ...flags.raised.map((f) => el("span", { class: `bw-flag bw-flag-${f.replace(/[^a-z]/g, "")}` }, f)));
    }
    return el("span", { class: "bw-prop-val" }, el("span", { class: "bw-prop-chip muted small" }, "normal"));
  }
  if ([36, 103, 112].includes(row.id)) {
    const warn = row.display && !/normal/i.test(String(row.display));
    return el("span", { class: "bw-prop-val" }, el("span", { class: `bw-prop-chip${warn ? " bw-prop-chip-warn" : ""}` }, row.display));
  }
  const mono = [85, 117, 79, 120, 87].includes(row.id) || /^\d/.test(String(row.display));
  return el("span", { class: `bw-prop-val${mono ? " bw-prop-mono" : ""}`, title: String(row.display) }, row.display);
}

function bwObjectPropsPanelContent({ props, filter = "", loading = false, error = null }) {
  if (loading) return [el("p", { class: "muted small bw-prop-loading" }, "Reading live properties…")];
  if (error && !props) return [el("p", { class: "bw-prop-loading muted small", title: error }, `Read failed: ${error}`)];
  if (!props || !props.length) return [el("p", { class: "muted small bw-prop-loading" }, "No live properties yet.")];
  const q = filter.trim().toLowerCase();
  const groups = groupObjectProperties(props)
    .map((g) => ({
      ...g,
      rows: q
        ? g.rows.filter((r) =>
            r.label.toLowerCase().includes(q)
            || String(r.display).toLowerCase().includes(q)
            || r.raw.toLowerCase().includes(q))
        : g.rows,
    }))
    .filter((g) => g.rows.length);
  if (!groups.length) {
    return [el("p", { class: "muted small" }, q ? "No properties match the filter." : "No readable properties.")];
  }
  return groups.map((g) =>
    el("details", { class: "bw-prop-group", open: true },
      el("summary", { class: "bw-prop-group-head" },
        el("span", { class: "bw-prop-group-title" }, g.label),
        el("span", { class: "bw-prop-group-count muted small" }, String(g.rows.length))),
      el("dl", { class: "bw-prop-rows" },
        ...g.rows.flatMap((row) => [
          el("dt", { class: "bw-prop-label", title: row.raw ? `${row.raw} (${row.id})` : undefined }, row.label),
          el("dd", { class: "bw-prop-dd" }, bwPropValueCell(row)),
        ]))));
}

function bwObjectPropsPanel({ props, filter, loading = false, error = null, showFilter = true }) {
  const children = [
    el("h4", { class: "bw-card-title" }, "Live BACnet properties"),
    showFilter
      ? el("div", { class: "bw-prop-filter-wrap" },
          el("input", {
            id: "bw-props-filter",
            type: "search",
            class: "nm-input bw-prop-filter",
            placeholder: "Filter properties…",
            value: filter || "",
            "aria-label": "Filter BACnet properties",
            oninput: (e) => {
              bw.propsFilter = e.target.value;
              bwUpdateObjectPropsPanel();
            },
          }))
      : null,
    el("div", { id: "bw-object-props", class: "bw-object-props" },
      ...bwObjectPropsPanelContent({ props, filter, loading, error })),
  ].filter(Boolean);
  return el("section", { class: "bw-card bw-object-props-section" }, ...children);
}

function bwUpdateObjectPropsPanel() {
  const node = document.getElementById("bw-object-props");
  if (!node) return;
  const inv = inventoryInstance();
  if (!inv) return;
  const sel = bwModelSelection(inv);
  let props = null;
  let loading = false;
  let error = null;
  if (sel.kind === "point") {
    if (!bwLive) loading = true;
    else if (bwLive.error) error = bwLive.error;
    else props = bwLive.props;
  } else if (sel.kind === "equip") {
    if (!bwDeviceObjLive) loading = true;
    else if (bwDeviceObjLive.error) error = bwDeviceObjLive.error;
    else props = bwDeviceObjLive.props;
  } else {
    return;
  }
  node.replaceChildren(...bwObjectPropsPanelContent({
    props,
    filter: bw.propsFilter,
    loading,
    error,
  }));
}

function bwSavePointConfig(point, patch) {
  const inv = inventoryInstance();
  if (!inv) return;
  const wasHistorized = !!point.historize;
  const saved = inv.upsertEntity({ ...point, ...patch });
  const hist = historianInstance();
  if (patch.historize && saved.historize) {
    try {
      hist?.addPoint(bwHistorianRecordForPoint(inv, saved));
      histPersist();
    } catch (_) { /* unbound point; skip */ }
  } else if (wasHistorized && "historize" in patch && !saved.historize) {
    // Trend turned off: stop logging this point.
    try {
      if (hist?.removePoint(bwHistorianRecordForPoint(inv, saved))) histPersist();
    } catch (_) { /* nothing to remove */ }
  }
  bwRefreshHistorianForEntity(inv, saved);
  logTo("building-workspace", `Updated ${saved.name}.`, "ok");
  bwSelectTreeEntity(saved);
}

function bwPointProperties(inv, point) {
  const nameInput = el("input", { type: "text", class: "nm-input", value: point.name || "", "aria-label": "Display name" });
  const unitInput = el("input", { type: "text", class: "nm-input bw-cfg-unit", value: bacnetUnitSymbol(point.unit) || "", "aria-label": "Unit" });
  const precInput = el("input", { type: "number", class: "nm-input bw-cfg-prec", min: "0", max: "10", placeholder: "auto", value: Number.isInteger(point.precision) ? String(point.precision) : "", "aria-label": "Decimal precision" });
  const minInput = el("input", { type: "number", class: "nm-input bw-cfg-num", value: point.min != null ? String(point.min) : "", placeholder: "—", "aria-label": "Min" });
  const maxInput = el("input", { type: "number", class: "nm-input bw-cfg-num", value: point.max != null ? String(point.max) : "", placeholder: "—", "aria-label": "Max" });
  const histInput = el("input", { type: "checkbox", checked: point.historize ? "checked" : undefined, "aria-label": "Trend this point" });

  const num = (v) => (String(v).trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
  const save = () => bwSavePointConfig(point, {
    name: nameInput.value.trim() || point.bacnetName || point.name,
    unit: unitInput.value.trim(),
    precision: precInput.value.trim() !== "" && Number.isInteger(Number(precInput.value)) ? Math.max(0, Math.min(10, Number(precInput.value))) : null,
    min: num(minInput.value),
    max: num(maxInput.value),
    historize: histInput.checked,
  });

  const resetName = point.bacnetName && point.bacnetName !== point.name
    ? el("button", { class: "btn-link bw-cfg-reset", title: `Reset to BACnet name "${point.bacnetName}"`, onclick: () => { nameInput.value = point.bacnetName; } }, "reset to BACnet name")
    : null;

  // When the point belongs to a bound device, its live table is in the center;
  // the right pane is the point detail view: readout + priority + write + trend.
  const parent = bwParentEquipForPoint(inv, point);
  const onDeviceTable = parent && bwEquipHasBinding(parent) && bwPointRef(point);
  const inspectorHead = onDeviceTable ? [
    bwLivePanel(inv, point, { showControls: false }),
    bwTrendPanel(inv, point),
  ] : [];

  return [
    ...inspectorHead,
    el("div", { class: "bw-card bw-point-config" },
      el("h4", { class: "bw-card-title" }, "Display config"),
      el("label", { class: "nm-field" }, el("span", { class: "nm-field-label" }, "Display name"), nameInput, resetName),
      el("div", { class: "bw-cfg-row" },
        el("label", { class: "nm-field" }, el("span", { class: "nm-field-label" }, "Unit"), unitInput),
        el("label", { class: "nm-field" }, el("span", { class: "nm-field-label" }, "Decimals"), precInput)),
      el("div", { class: "bw-cfg-row" },
        el("label", { class: "nm-field" }, el("span", { class: "nm-field-label" }, "Min"), minInput),
        el("label", { class: "nm-field" }, el("span", { class: "nm-field-label" }, "Max"), maxInput)),
      el("label", { class: "bw-cfg-trend" }, histInput, el("span", {}, "Trend this point (log to historian)")),
      el("div", { class: "action-row" },
        el("button", { class: "btn btn-primary", onclick: save }, "Save"))),
    el("div", { class: "bw-card bw-detail-card" },
      el("h4", { class: "bw-card-title" }, "Model"),
      el("div", { class: "bw-detail-grid" },
        bwDetailRow("BACnet name", point.bacnetName),
        bwDetailRow("Device instance", point.deviceInstance),
        bwDetailRow("Object", point.objectType != null && point.instance != null ? `${point.objectType}:${point.instance}` : ""),
        bwDetailRow("Source", (point.sourceRefs || []).join(", ")),
        bwDetailRow("Tags", Object.keys(point.tags || {}).join(", ")))),
  ];
}

function bwPointCenter(inv, point) {
  const ref = bwPointRef(point);
  if (!ref) {
    return [el("p", { class: "muted small" }, "This point is not bound to a BACnet object yet.")];
  }
  return [
    bwLivePanel(inv, point),
    bwTrendPanel(inv, point),
  ];
}

// Apply a decimal precision (or clear it) to every selected point at once.
function bwBulkSetPrecision(value) {
  const inv = inventoryInstance();
  if (!inv) return;
  const points = bwPointsForEntities(inv, bwSelectedEntities(inv));
  if (!points.length) return;
  const prec = String(value).trim() !== "" && Number.isInteger(Number(value))
    ? Math.max(0, Math.min(10, Number(value))) : null;
  for (const p of points) inv.upsertEntity({ ...p, precision: prec });
  logTo("building-workspace", `Set precision on ${points.length} point${points.length === 1 ? "" : "s"}.`, "ok");
  bwRenderModelScope({ tree: true, details: true });
}

function bwSelectionProperties(inv, entities) {
  const counts = {
    site: entities.filter((e) => e.type === "site").length,
    building: entities.filter((e) => e.type === "building").length,
    floor: entities.filter((e) => e.type === "floor").length,
    equip: entities.filter((e) => e.type === "equip").length,
    point: entities.filter((e) => e.type === "point").length,
  };
  return [
    el("div", { class: "bw-count-grid" },
      bwCountTile("Sites", counts.site),
      bwCountTile("Buildings", counts.building),
      bwCountTile("Floors", counts.floor),
      bwCountTile("Devices", counts.equip),
      bwCountTile("Points", counts.point)),
  ];
}

function bwSelectionCenter(inv, entities) {
  const points = bwPointsForEntities(inv, entities);
  const devices = entities.filter((e) => e.type === "equip");
  const templates = inv.listEntities({ type: "template" });
  return [
    el("p", { class: "muted small bw-selection-hint" }, "Ctrl-click toggles nodes. Shift-click selects a range from the last clicked node."),
    el("div", { class: "tool-actions" },
      el("button", { class: "btn btn-primary", disabled: points.length ? undefined : "disabled", onclick: bwHistorizeSelectedEntities }, `Historize ${points.length} point${points.length === 1 ? "" : "s"}`),
      points.length
        ? el("label", { class: "nm-field-inline", title: "Decimal precision for the selected points" },
            el("input", { type: "number", class: "nm-input bw-bulk-prec", min: "0", max: "10", placeholder: "decimals", "aria-label": "Decimals for selected points" }),
            el("button", { class: "btn-ghost", onclick: (e) => bwBulkSetPrecision(e.currentTarget.previousSibling.value) }, "Set precision"))
        : null,
      el("select", {
        class: "nm-input bw-template-select",
        disabled: devices.length ? undefined : "disabled",
        onchange: (e) => { bw.template = e.target.value; bwSaveState(); },
      },
        ...templates.map((t) => el("option", { value: t.id, selected: bw.template === t.id || bw.template === t.id.replace("template:", "") ? "selected" : undefined }, t.name))),
      el("button", { class: "btn-ghost", disabled: devices.length ? undefined : "disabled", onclick: () => bwApplyTemplateToSelected(bw.template) }, `Apply to ${devices.length} device${devices.length === 1 ? "" : "s"}`),
      el("button", { class: "btn-ghost", onclick: () => { bwSetSelection([]); bw.selectionAnchorId = ""; bwSaveState(); bwRenderModelScope({ tree: true, details: true, header: true }); } }, "Clear"),
      el("button", { class: "btn-ghost danger", onclick: bwRemoveSelectedEntities }, "Remove selected")),
    el("ol", { class: "plugin-log scroll-fill bw-selection-list" },
      ...entities.map((entity) => el("li", { class: "log-info" },
        el("span", { class: "log-time" }, bwTreeNodeLabel(entity)),
        el("span", { class: "log-msg" }, entity.name || entity.id)))),
  ];
}

function bwModelSelection(inv) {
  const selected = bwSelectedEntities(inv);
  if (selected.length > 1) return { kind: "multi", entities: selected };
  const entity = selected.length === 1 ? selected[0] : bwSelectedEntity(inv);
  if (!entity) return { kind: "root" };
  return { kind: entity.type, entity };
}

function bwPropsTitle(inv, sel) {
  if (sel.kind === "multi") return `${sel.entities.length} selected`;
  if (sel.kind === "root") return "Model";
  return sel.entity.name || sel.entity.id;
}

function bwModelCenter(inv) {
  const sel = bwModelSelection(inv);
  let nodes;
  if (sel.kind === "multi") nodes = bwSelectionCenter(inv, sel.entities);
  else if (sel.kind === "root") nodes = bwRootCenter(inv);
  else if (sel.kind === "site") nodes = [bwHierarchyCenter("site")];
  else if (sel.kind === "building") nodes = [bwHierarchyCenter("building")];
  else if (sel.kind === "floor") nodes = [bwHierarchyCenter("floor")];
  else if (sel.kind === "equip") nodes = bwDeviceCenter(inv, sel.entity);
  else if (sel.kind === "point") {
    const parent = bwParentEquipForPoint(inv, sel.entity);
    nodes = parent && bwEquipHasBinding(parent)
      ? bwDeviceCenter(inv, parent)
      : bwPointCenter(inv, sel.entity);
  }
  else nodes = bwRootCenter(inv);
  return el("section", { id: "bw-model-center", class: "plugin-section bw-pane bw-model-center" },
    el("div", { class: "pane-fill-body bw-center-body" }, ...nodes));
}

function bwModelProperties(inv) {
  const sel = bwModelSelection(inv);
  let nodes;
  if (sel.kind === "multi") nodes = bwSelectionProperties(inv, sel.entities);
  else if (sel.kind === "root") nodes = bwRootProperties(inv);
  else if (sel.kind === "site") nodes = bwSiteProperties(inv, sel.entity);
  else if (sel.kind === "building") nodes = bwBuildingProperties(inv, sel.entity);
  else if (sel.kind === "floor") nodes = bwFloorProperties(inv, sel.entity);
  else if (sel.kind === "equip") nodes = bwDeviceProperties(inv, sel.entity);
  else if (sel.kind === "point") nodes = bwPointProperties(inv, sel.entity);
  else nodes = bwRootProperties(inv);
  return el("aside", { id: "bw-model-properties", class: "plugin-section bw-pane bw-model-properties bw-props-panel" },
    el("div", { class: "section-head bw-props-head" },
      el("h3", {}, "Properties"),
      el("span", { class: "muted small bw-props-subtitle", title: bwPropsTitle(inv, sel) }, bwPropsTitle(inv, sel))),
    el("div", { class: "pane-fill-scroll bw-props-scroll" }, ...nodes));
}

const BW_TREE_MIN = 200;
const BW_TREE_MAX = 480;
const BW_TREE_DEFAULT = 280;
const BW_PROPS_MIN = 260;
const BW_PROPS_MAX = 560;
const BW_PROPS_DEFAULT = 320;

function bwEnsurePaneWidths() {
  if (!userState.buildingWorkspace || typeof userState.buildingWorkspace !== "object") userState.buildingWorkspace = {};
  const pw = userState.buildingWorkspace.paneWidths;
  if (!pw || typeof pw !== "object") {
    userState.buildingWorkspace.paneWidths = { tree: BW_TREE_DEFAULT, props: BW_PROPS_DEFAULT };
  } else {
    if (!Number.isFinite(pw.tree)) pw.tree = BW_TREE_DEFAULT;
    if (!Number.isFinite(pw.props)) pw.props = BW_PROPS_DEFAULT;
  }
}

function bwTreePaneWidth() {
  bwEnsurePaneWidths();
  return clampPaneWidth(userState.buildingWorkspace.paneWidths.tree, { min: BW_TREE_MIN, max: BW_TREE_MAX });
}

function bwPropsPaneWidth() {
  bwEnsurePaneWidths();
  return clampPaneWidth(userState.buildingWorkspace.paneWidths.props, { min: BW_PROPS_MIN, max: BW_PROPS_MAX });
}

function bwApplyModelColumns() {
  const layout = document.getElementById("bw-model-tab");
  if (!layout) return;
  layout.style.gridTemplateColumns = buildGridColumns({
    left: bwTreePaneWidth(),
    right: bwPropsPaneWidth(),
    threePane: true,
  });
}

function bwSetTreePaneWidth(px, persist) {
  bwEnsurePaneWidths();
  userState.buildingWorkspace.paneWidths.tree = clampPaneWidth(px, { min: BW_TREE_MIN, max: BW_TREE_MAX });
  bwApplyModelColumns();
  updateSplitterAria(document.getElementById("bw-splitter-tree"), userState.buildingWorkspace.paneWidths.tree);
  if (persist) saveUserState();
}

function bwSetPropsPaneWidth(px, persist) {
  bwEnsurePaneWidths();
  userState.buildingWorkspace.paneWidths.props = clampPaneWidth(px, { min: BW_PROPS_MIN, max: BW_PROPS_MAX });
  bwApplyModelColumns();
  updateSplitterAria(document.getElementById("bw-splitter-props"), userState.buildingWorkspace.paneWidths.props);
  if (persist) saveUserState();
}

function bwModelPaneResizeEnd(inv) {
  const point = bwSelectedEntities(inv)[0];
  if (point?.type === "point") bwUpdateTrendChart(point);
}

function bwModelTab(inv) {
  bwEnsurePaneWidths();
  const treeSplitter = createPaneSplitter({
    id: "bw-splitter-tree",
    ariaLabel: "Resize model tree",
    min: BW_TREE_MIN,
    max: BW_TREE_MAX,
    value: bwTreePaneWidth(),
    onKeyDown: paneSplitterKeyHandler(bwTreePaneWidth, (px) => bwSetTreePaneWidth(px, true), saveUserState),
    onDoubleReset: () => bwSetTreePaneWidth(BW_TREE_DEFAULT, true),
  });
  attachPaneDrag(treeSplitter, {
    getWidth: bwTreePaneWidth,
    setWidth: bwSetTreePaneWidth,
    persist: saveUserState,
    onEnd: () => bwModelPaneResizeEnd(inv),
  });
  const propsSplitter = createPaneSplitter({
    id: "bw-splitter-props",
    ariaLabel: "Resize properties pane",
    min: BW_PROPS_MIN,
    max: BW_PROPS_MAX,
    value: bwPropsPaneWidth(),
    onKeyDown: paneSplitterKeyHandler(bwPropsPaneWidth, (px) => bwSetPropsPaneWidth(px, true), saveUserState),
    onDoubleReset: () => bwSetPropsPaneWidth(BW_PROPS_DEFAULT, true),
  });
  attachPaneDragRight(propsSplitter, {
    getWidth: bwPropsPaneWidth,
    setWidth: bwSetPropsPaneWidth,
    persist: saveUserState,
    onEnd: () => bwModelPaneResizeEnd(inv),
  });
  const layout = el("div", { id: "bw-model-tab", class: "bw-model-layout", onclick: () => { if (bw.contextMenu) bwCloseTreeMenu(); } },
    bwTreePanel(inv),
    treeSplitter,
    bwModelCenter(inv),
    propsSplitter,
    bwModelProperties(inv),
  );
  layout.style.gridTemplateColumns = buildGridColumns({
    left: bwTreePaneWidth(),
    right: bwPropsPaneWidth(),
    threePane: true,
  });
  return layout;
}


function bwHistorianTab(inv) {
  const hist = historianInstance();
  const pts = hist ? hist.points() : [];
  const modelPoints = bwPointRows(inv);
  return el("section", { class: "plugin-section bw-tab-panel" },
    bwTabPanelHead({
      title: "Historian",
      meta: hist && hist.isRunning() ? "Logging" : "Idle",
      desc: "Historize modeled points with site/equipment/point tags. Existing manual Historian controls remain available.",
      actions: [
        el("button", { class: "btn btn-primary", disabled: modelPoints.length ? undefined : "disabled", onclick: () => modelPoints.forEach((p) => bwHistorizePoint(p.id)) }, "Historize modeled points"),
        el("button", { class: "btn-ghost", onclick: () => setView(pluginView("bacnet-historian")) }, "Open BACnet Historian"),
      ],
    }),
    pts.length
      ? el("ol", { class: "plugin-log scroll-fill bw-panel-body" },
          ...pts.map((p) => el("li", { class: p.lastError ? "log-error" : "log-info" },
            el("span", { class: "log-msg" }, `${[p.site, p.building, p.floor, p.equip].filter(Boolean).join(" · ")}${p.site || p.building || p.floor || p.equip ? " · " : ""}${p.label || p.pointId || `${p.objectType}:${p.instance}`} → ${p.lastError ? "ERR " + p.lastError : (p.lastValue ?? "—")}`))))
      : el("p", { class: "muted small bw-panel-body" }, "No historian points yet."));
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
  return el("section", { class: "plugin-section bw-tab-panel" },
    bwTabPanelHead({
      title: "Template Dashboard",
      meta: `${points.length} modeled point${points.length === 1 ? "" : "s"}${floor ? ` on ${floor.name}` : ""}`,
      desc: dashboardUrl ? "Observability is connected; open Grafana to view provisioned dashboards." : "Ready to chart after the Observability Pack starts; metrics stay in the local ring buffer until then.",
      actions: [
        el("button", {
          class: "btn btn-primary",
          onclick: () => {
            bw.dashboardJson = JSON.stringify(generateBuildingDashboard(snapshot, dashboardScope), null, 2);
            logTo("building-workspace", "Generated dashboard JSON from the current model.", "ok");
            bwRenderTabScope();
          },
        }, "Generate dashboard JSON"),
        el("button", { class: "btn-ghost", onclick: () => bwDownload(`building-dashboard-${bacTimestamp()}.json`, json, "application/json;charset=utf-8") }, "Export JSON"),
        dashboardUrl ? el("button", { class: "btn-ghost", onclick: () => openExternal(dashboardUrl) }, "Open Grafana dashboard") : null,
      ],
    }),
    el("textarea", { class: "nm-input bw-json scroll-fill bw-panel-body", rows: "12", readonly: "readonly" }, json));
}

function bwOpenApp(toolId, intent = {}) {
  setAppIntent(toolId, intent);
  setView(pluginView(toolId));
}

function bwAlertsTab(inv) {
  const site = bwActiveSite(inv);
  const building = bwActiveBuilding(inv, site?.id);
  const floor = bwActiveFloor(inv, building?.id);
  const vavEquips = inv.listEntities({ type: "equip", floorId: floor?.id || undefined, buildingId: building?.id || undefined, siteId: site?.id || undefined })
    .filter((e) => e.tags?.vav || e.templateId === "template:vav");
  const run = inv.listEntities({ type: "ruleRun" }).at(-1);
  const findings = (run?.findings || []).filter((f) => f.status === "fail" || f.status === "warn");
  return el("section", { class: "plugin-section bw-tab-panel" },
    bwTabPanelHead({
      title: "Alerts",
      meta: run ? `${run.summary?.fail || 0} alert${(run.summary?.fail || 0) === 1 ? "" : "s"}` : `${vavEquips.length} VAV${vavEquips.length === 1 ? "" : "s"} in scope`,
      desc: "Analytics findings and live BACnet alarms now live in dedicated apps. Open the Alarm Console to triage, or Analytics to run rule packs.",
      actions: [
        el("button", { class: "btn btn-primary", onclick: () => bwOpenApp("alarm-console", { siteId: site?.id || "" }) }, "Open Alarm Console"),
        el("button", { class: "btn-ghost", onclick: () => bwOpenApp("building-analytics", { siteId: site?.id || "" }) }, "Open Analytics"),
      ],
    }),
    run
      ? el("ol", { class: "plugin-log scroll-fill bw-panel-body" },
          ...(findings.length ? findings : [{ status: "pass", message: "No active alerts in the last analytics run." }]).map((f) => el("li", { class: f.status === "fail" ? "log-error" : f.status === "warn" ? "log-warn" : "log-info" },
            el("span", { class: "log-time" }, f.severity || f.status),
            el("span", { class: "log-msg" }, f.message || `${f.equipName || ""} · ${f.ruleName || ""}`))))
      : el("p", { class: "muted small bw-panel-body" }, "No analytics run yet. Open Analytics to run the VAV rule pack."));
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
  return el("section", { class: "plugin-section bw-tab-panel" },
    bwTabPanelHead({
      title: "Commissioning",
      meta: `${points.length} point${points.length === 1 ? "" : "s"} in scope`,
      desc: "Checks read present-value + range. A command value (or toggle) writes to writable points at the chosen priority, optionally verifies the read-back, then relinquishes.",
    }),
    el("div", { class: "bw-card bw-cx-controls" },
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
        el("label", { class: "bw-cx-check" }, el("input", { type: "checkbox", checked: bw.cxToggle ? "checked" : undefined, onchange: (e) => { bw.cxToggle = e.target.checked; } }), el("span", {}, "Toggle binary outputs"))),
      el("textarea", { class: "nm-input bw-notes", rows: "3", placeholder: "Operator notes", oninput: (e) => { bw.cxNotes = e.target.value; } }, bw.cxNotes)),
    run
      ? el("ol", { class: "plugin-log scroll-fill bw-panel-body" },
          ...(run.steps || []).map((s) => el("li", { class: s.status === "fail" ? "log-error" : s.status === "warn" ? "log-warn" : "log-info" },
            el("span", { class: "log-time" }, s.status),
            el("span", { class: "log-msg" }, `${s.pointName || s.pointId} · ${s.check}${s.value != null ? ` · ${s.value}` : ""}${s.error ? ` · ${s.error}` : ""}`))))
      : el("p", { class: "muted small bw-panel-body" }, "No run yet."));
}

function bwReportsTab(inv) {
  const runs = inv.listEntities({ type: "commissioningRun" });
  const run = bw.lastRunId ? inv.getEntity(bw.lastRunId) : runs.at(-1);
  const snapshot = inv.exportSnapshot();
  const md = run ? exportCommissioningMarkdown(snapshot, run) : "";
  const csv = run ? exportCommissioningCsv(run) : "";
  return el("section", { class: "plugin-section bw-tab-panel" },
    bwTabPanelHead({
      title: "Reports",
      meta: `${runs.length} run${runs.length === 1 ? "" : "s"}`,
      desc: run ? null : "Run commissioning checks to create a report.",
      actions: run
        ? [
            el("button", { class: "btn btn-primary", onclick: () => bwDownload(`commissioning-${bacTimestamp()}.md`, md, "text/markdown;charset=utf-8") }, "Export Markdown"),
            el("button", { class: "btn-ghost", onclick: () => bwDownload(`commissioning-${bacTimestamp()}.csv`, csv, "text/csv;charset=utf-8") }, "Export CSV"),
            el("button", { class: "btn-ghost", onclick: () => copyText(md) }, "Copy Markdown"),
          ]
        : null,
    }),
    run ? el("textarea", { class: "nm-input bw-json scroll-fill bw-panel-body", rows: "16", readonly: "readonly" }, md) : null);
}

function bwCurrentTabBody(inv) {
  return bw.tab === "historian" ? bwHistorianTab(inv)
    : bw.tab === "dashboard" ? bwDashboardTab(inv)
    : bw.tab === "commissioning" ? bwCommissioningTab(inv)
    : bw.tab === "alerts" ? bwAlertsTab(inv)
    : bw.tab === "reports" ? bwReportsTab(inv)
    : bwModelTab(inv);
}

let bwRegroupDone = false;
function renderBuildingWorkspacePage() {
  const inv = inventoryInstance();
  // Honor a deep-link intent (e.g. from Analytics "Open in Workspace"): focus the
  // requested equipment in the model tree and switch to the Model tab.
  if (inv) {
    const intent = takeAppIntent("building-workspace");
    if (intent?.equipId) {
      const ent = inv.getEntity(intent.equipId);
      if (ent) {
        bw.tab = "model";
        bwSetSelection([ent.id], ent.id);
        bw.selectionAnchorId = ent.id;
        bwSaveState();
      }
    }
  }
  // One-time tidy: nest BACnet points under their device equipment and drop the
  // empty inferred grouping shells older imports created on the floor.
  if (inv && !bwRegroupDone) {
    bwRegroupDone = true;
    const res = bwRegroupPointsUnderDevices(inv);
    if (res.reparented || res.removed || res.removedDeviceObjects) {
      const parts = [];
      if (res.reparented) parts.push(`nested ${res.reparented} point${res.reparented === 1 ? "" : "s"} under their device`);
      if (res.removedDeviceObjects) parts.push(`dropped ${res.removedDeviceObjects} device-object point${res.removedDeviceObjects === 1 ? "" : "s"}`);
      if (res.removed) parts.push(`removed ${res.removed} empty group${res.removed === 1 ? "" : "s"}`);
      logTo("building-workspace", `Tidied model: ${parts.join(", ")}.`, "info");
    }
  }
  const synced = histSyncFromInventory();
  if (synced) histPersist();
  if (!inv) {
    return el("div", { class: "plugin-controls" },
      el("section", { class: "plugin-section" },
        el("p", { class: "muted" }, "Building Workspace unavailable — the platform kernel did not resolve inventory dependencies.")));
  }
  const body = bwCurrentTabBody(inv);
  setTimeout(bwSyncLivePoll, 0); // after this page mounts, sync the live poll to the selection
  return el("div", { id: "bw-root", class: "plugin-controls plugin-controls-fill bw-root" },
    bwTabs(),
    el("div", { id: "bw-tab-body" }, body),
  );
}

function bwRenderHeaderAddon() {
  const node = document.getElementById("bw-plugin-header-addon");
  if (!node) return;
  const next = bwPluginHeaderAddon();
  if (next) node.replaceWith(next);
  else node.remove();
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

function bwRenderModelScope({ tree = false, details = false, center = false, properties = false, header = false } = {}) {
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
  const refreshCenter = center || details;
  const refreshProps = properties || details;
  const treeNode = document.getElementById("bw-model-tree-panel");
  const centerNode = document.getElementById("bw-model-center");
  const propsNode = document.getElementById("bw-model-properties");
  if (tree && treeNode) treeNode.replaceWith(bwTreePanel(inv));
  if (refreshCenter && centerNode) centerNode.replaceWith(bwModelCenter(inv));
  if (refreshProps && propsNode) propsNode.replaceWith(bwModelProperties(inv));
  if (header) bwRenderHeaderAddon();
  if ((tree && !treeNode) || (refreshCenter && !centerNode) || (refreshProps && !propsNode)) bwRenderTabScope();
  bwSyncLivePoll(); // start/stop the live poll to match the current selection
}

// ============================================================================

return {
  renderStatusPill: bwStatusPill,
  renderPage: renderBuildingWorkspacePage,
  restoreState: bwRestoreState,
  stopLivePoll: bwStopLivePoll,
  headerBreadcrumb: bwPluginHeaderAddon,
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
