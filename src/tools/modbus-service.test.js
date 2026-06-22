import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createModbusService,
  decodeRegisters,
  pointsFromRegisterMap,
  registerSpan,
} from "./modbus-service.js";
import { parseSourceRef, modbusSourceRef, createInventory, createMemoryInventoryStorage } from "./inventory.js";

test("modbus source refs parse round-trip through the inventory grammar", () => {
  const ref = modbusSourceRef(3, "input", 40001);
  assert.equal(ref, "modbus:3:input:40001");
  assert.deepEqual(parseSourceRef(ref), { kind: "modbus", unitId: 3, register: "input", address: 40001 });
  assert.equal(parseSourceRef("modbus:1:coil:5"), null, "unknown register kind rejected");
});

test("register decoding handles widths, signedness, and word order", () => {
  assert.equal(registerSpan("float32"), 2);
  assert.equal(registerSpan("uint16"), 1);
  assert.equal(decodeRegisters([0xfff6], "int16"), -10);
  assert.equal(decodeRegisters([0x0001, 0x0000], "uint32"), 0x00010000);
  assert.equal(decodeRegisters([0x3f80, 0x0000], "float32"), 1.0);
  assert.equal(decodeRegisters([0x0000, 0x3f80], "float32", { wordSwap: true }), 1.0);
  assert.equal(decodeRegisters([0], "bool"), false);
  assert.equal(decodeRegisters([1], "bool"), true);
});

test("register map normalizes into dedupable point entities", () => {
  const inv = createInventory({ storage: createMemoryInventoryStorage(), now: () => 1 });
  const drafts = pointsFromRegisterMap({
    unitId: 5,
    equipId: "equip:meter-1",
    registers: [
      { name: "kW", address: 100, register: "holding", dataType: "float32", unit: "kW" },
      { name: "Status", address: 10, register: "input", dataType: "bool" },
    ],
  });
  assert.equal(drafts.length, 2);
  const first = inv.upsertEntity(drafts[0]);
  // Re-import the same register merges (source-ref de-dupe), not duplicates.
  const second = inv.upsertEntity({ ...drafts[0], name: "Active Power" });
  assert.equal(first.id, second.id);
  assert.equal(inv.listEntities({ type: "point" }).length, 1);
  assert.deepEqual(first.sourceRefs, ["modbus:5:holding:100"]);
});

test("service wraps the invoke commands and decodes typed reads", async () => {
  const calls = [];
  const invoke = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "modbus_read_registers") return { address: args.address, count: args.count, registers: [0x3f80, 0x0000] };
    return undefined;
  };
  const svc = createModbusService({ invoke });
  const v = await svc.readValue({ host: "10.0.0.5", unitId: 2, address: 100, dataType: "float32" });
  assert.equal(v, 1.0);
  assert.equal(calls[0].args.count, 2, "float32 spans two registers");
  await svc.writeRegister({ host: "10.0.0.5", address: 1, value: 255 });
  assert.equal(calls[1].cmd, "modbus_write_register");
});
