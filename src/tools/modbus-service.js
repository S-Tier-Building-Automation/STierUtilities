// Modbus driver service — wraps the modbus_* Tauri commands behind the
// `modbus.read` capability and normalizes register maps into the same `point`
// entities BACnet objects produce, so the rest of the platform (historian,
// graphics, analytics) treats Modbus points identically.

import { modbusSourceRef } from "./inventory.js";

const DATA_TYPES = new Set(["uint16", "int16", "uint32", "int32", "float32", "bool"]);

/** How many 16-bit registers a data type spans. */
export function registerSpan(dataType) {
  switch (dataType) {
    case "uint32":
    case "int32":
    case "float32":
      return 2;
    default:
      return 1;
  }
}

/** Decode raw register words (big-endian) into a JS value for a data type. */
export function decodeRegisters(registers, dataType, { wordSwap = false } = {}) {
  const r = Array.isArray(registers) ? registers : [];
  const hi = r[0] ?? 0;
  const lo = r[1] ?? 0;
  switch (dataType) {
    case "int16":
      return hi > 0x7fff ? hi - 0x10000 : hi;
    case "bool":
      return hi !== 0;
    case "uint32": {
      const [a, b] = wordSwap ? [lo, hi] : [hi, lo];
      return (a * 0x10000 + b) >>> 0;
    }
    case "int32": {
      const [a, b] = wordSwap ? [lo, hi] : [hi, lo];
      const u = (a * 0x10000 + b) >>> 0;
      return u > 0x7fffffff ? u - 0x100000000 : u;
    }
    case "float32": {
      const [a, b] = wordSwap ? [lo, hi] : [hi, lo];
      const buf = new ArrayBuffer(4);
      const dv = new DataView(buf);
      dv.setUint16(0, a);
      dv.setUint16(2, b);
      return dv.getFloat32(0);
    }
    case "uint16":
    default:
      return hi;
  }
}

/**
 * Turn a register-map config into point-entity drafts ready for inventory
 * upsert. Each register becomes a point with a stable modbus source ref so
 * re-imports de-dupe (same mechanism as BACnet source refs).
 * @param {object} cfg
 * @param {number} cfg.unitId       Modbus unit/slave id
 * @param {Array<{name:string, address:number, register?:string, dataType?:string, unit?:string}>} cfg.registers
 */
export function pointsFromRegisterMap({ unitId, registers = [], siteId, buildingId, floorId, equipId } = {}) {
  return registers
    .filter((reg) => reg && Number.isFinite(Number(reg.address)))
    .map((reg) => {
      const register = String(reg.register || "holding").toLowerCase() === "input" ? "input" : "holding";
      const dataType = DATA_TYPES.has(reg.dataType) ? reg.dataType : "uint16";
      return {
        type: "point",
        name: reg.name || `${register} ${reg.address}`,
        sourceRefs: [modbusSourceRef(unitId, register, reg.address)],
        siteId, buildingId, floorId, equipId,
        modbus: { unitId: Number(unitId), register, address: Number(reg.address), dataType, wordSwap: Boolean(reg.wordSwap) },
        unit: reg.unit || null,
        tags: { point: true, modbus: true },
      };
    });
}

/** Build the modbus.read capability over the injected Tauri invoke. */
export function createModbusService({ invoke } = {}) {
  if (typeof invoke !== "function") throw new Error("modbus service requires invoke");
  return {
    /** Read N registers from a unit. kind: "holding" | "input". */
    readRegisters: ({ host, port = 502, unitId = 1, kind = "holding", address, count = 1 }) =>
      invoke("modbus_read_registers", { host, port, unitId, kind, address, count }),
    /** Read one typed value (decodes multi-register types). */
    async readValue({ host, port = 502, unitId = 1, kind = "holding", address, dataType = "uint16", wordSwap = false }) {
      const span = registerSpan(dataType);
      const res = await invoke("modbus_read_registers", { host, port, unitId, kind, address, count: span });
      return decodeRegisters(res?.registers || [], dataType, { wordSwap });
    },
    /** Write a single holding register. */
    writeRegister: ({ host, port = 502, unitId = 1, address, value }) =>
      invoke("modbus_write_register", { host, port, unitId, address, value }),
    /** Write a block of holding registers. */
    writeRegisters: ({ host, port = 502, unitId = 1, address, values }) =>
      invoke("modbus_write_registers", { host, port, unitId, address, values }),
    /** Normalize a register map into point drafts (pure; see pointsFromRegisterMap). */
    pointsFromRegisterMap,
  };
}
