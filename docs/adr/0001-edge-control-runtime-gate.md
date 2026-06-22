# ADR 0001: Edge supervisory control runtime — decision gate

Status: Open (gate not yet passed)
Date: 2026-06-22
Context: Phase 3 of the "Beat FIN and Niagara" roadmap

## Decision to be made

Whether to build a 24/7 edge supervisory **control runtime** (schedules, sequences,
alarm generation, control logic executing continuously on an edge device) that
would let STierUtilities replace a Niagara JACE / supervisor outright, rather than
riding on top of existing field controllers.

This ADR is the explicit gate: it is intentionally left **Open**. Do not start the
runtime until the criteria below are met, because it is the single largest, riskiest
expansion of scope in the roadmap.

## Where we are today (layer-on-top)

We deliberately do not run continuous control. We discover, model, visualize,
analyze, commission, and command points manually. Shipped capabilities relevant
to this decision:

- BACnet read/write/COV/alarms (`src-tauri/src/bacnet.rs`) and Modbus/TCP
  (`src-tauri/src/modbus.rs`); BACnet MS/TP framing codec
  (`src-tauri/src/bacnet_mstp.rs`).
- Schedule read + present-value command (`bacnet_read_schedule` /
  `bacnet_write_schedule`) — manual override, not a running schedule engine.
- Analytics/rules, graphics, historian, alarm console, fleet rollup, cloud sync.

This already covers most of FIN's value and the engineering/visualization half of
Niagara without the runtime's liabilities.

## Why the runtime is high-risk

- Safety + liability: continuous control of real equipment (and the failure modes
  of getting it wrong) is a categorically higher bar than read/commission tooling.
- Reliability: 24/7 execution needs watchdogs, fail-safe states, redundancy,
  deterministic timing, and field-proven uptime — years of hardening.
- Hardware: a credible JACE competitor implies an edge appliance (or certified
  reference hardware), provisioning, and field support logistics.
- Distraction: it competes for the same effort as protocol breadth + UX, which is
  where we currently out-position both incumbents.

## Gate criteria (ALL must hold before status flips to Accepted)

1. Wedge won: a repeatable base of integrators using the layer-on-top product on
   real sites, with retention.
2. Demand evidence: a quantified set of deals lost specifically because we lack a
   control runtime (not speculative).
3. Protocol + UX parity largely done: drivers (BACnet, Modbus, +1), the graphics
   builder, schedules, and the cloud supervisor are mature.
4. Safety plan: a concrete design for fail-safe behavior, watchdogs, offline
   operation, and commissioning/test certification.
5. Hardware strategy: reference edge hardware (or a partner) identified and costed.

## Options when the gate opens

- A. Embedded control engine in the Rust core (new `control_runtime` module:
  schedule execution, sequence VM, alarm engine) running on an always-on edge build.
- B. Partner/OEM an existing open controller runtime and own the modeling +
  cloud + UX layer above it.
- C. Stay layer-on-top permanently and win on engineering/UX/cloud/openness/price.

Recommended default until the gate opens: **C**, re-evaluating at each criterion.

## Consequences

Keeping this gate Open keeps the team focused on the winning wedge. Revisit this
ADR when criteria 1–3 are met; do not let runtime work start implicitly.
