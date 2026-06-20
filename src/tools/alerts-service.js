// building-alerts service — composes rule findings (from the modeled rule runs)
// and live BACnet alarms into one acknowledgeable feed behind the alerts.v1
// capability. The Alarm Console consumes this; it owns no rule or BACnet logic.

/**
 * @param {{ inventory: object, rules: object, bacnet?: object|null }} deps
 */
export function createAlertsService({ inventory, rules, bacnet = null }) {
  if (!inventory) throw new Error("alerts service requires an inventory capability");
  if (!rules) throw new Error("alerts service requires a rules capability");

  /** The most recent rule run, optionally constrained to a run id. */
  function latestRun(runId = null) {
    if (runId) return inventory.getEntity(runId);
    return inventory.listEntities({ type: "ruleRun" }).at(-1) || null;
  }

  /** A rule finding -> unified alert shape. */
  function fromFinding(finding, run) {
    return {
      id: `rule:${run?.id || "run"}:${finding.equipId || ""}:${finding.ruleId || ""}`,
      source: "rule",
      severity: finding.severity || (finding.status === "fail" ? "high" : "medium"),
      status: finding.status,
      message: finding.message || `${finding.equipName || ""} · ${finding.ruleName || ""}`,
      equipId: finding.equipId || null,
      equipName: finding.equipName || null,
      pointId: finding.pointId || null,
      at: finding.at || run?.finishedAt || null,
      ackable: false,
      ref: null,
    };
  }

  /** A BACnet alarm entry -> unified alert shape. */
  function fromBacnetAlarm(entry, device) {
    const objectType = entry.objectType ?? entry.object?.type ?? null;
    const instance = entry.instance ?? entry.object?.instance ?? null;
    return {
      id: `bacnet:${device?.deviceInstance ?? device?.instance ?? "dev"}:${objectType}:${instance}`,
      source: "bacnet",
      severity: entry.severity || "medium",
      status: entry.acknowledged ? "ack" : "active",
      message: entry.message || entry.description || entry.objectName || `Alarm on object ${objectType}:${instance}`,
      equipId: null,
      equipName: entry.objectName || null,
      pointId: null,
      at: entry.timestamp || entry.eventTimestamp || null,
      ackable: !entry.acknowledged && objectType != null && instance != null,
      ref: { device, objectType, instance },
    };
  }

  return {
    /**
     * Findings from the latest (or a specified) rule run.
     * @param {{ runId?: string, status?: string[] }} [opts]
     */
    listRuleFindings({ runId = null, status = ["fail", "warn"] } = {}) {
      const run = latestRun(runId);
      if (!run) return [];
      const wanted = new Set(status);
      return (run.findings || [])
        .filter((f) => wanted.has(f.status))
        .map((f) => fromFinding(f, run));
    },

    /**
     * Live BACnet alarms across the given device refs.
     * @param {{ devices?: object[] }} [opts]
     */
    async listBacnetAlarms({ devices = [] } = {}) {
      if (!bacnet) return [];
      const out = [];
      for (const device of devices) {
        try {
          const entries = await bacnet.getAlarms(device);
          for (const entry of entries || []) out.push(fromBacnetAlarm(entry, device));
        } catch (err) {
          out.push({
            id: `bacnet-error:${device?.deviceInstance ?? device?.instance ?? "dev"}`,
            source: "bacnet",
            severity: "low",
            status: "error",
            message: `Could not read alarms: ${err && err.message ? err.message : err}`,
            equipId: null,
            equipName: null,
            pointId: null,
            at: null,
            ackable: false,
            ref: null,
          });
        }
      }
      return out;
    },

    /**
     * Unified rule findings + BACnet alarms.
     * @param {{ runId?: string, devices?: object[], status?: string[] }} [opts]
     */
    async listUnified({ runId = null, devices = [], status = ["fail", "warn"] } = {}) {
      const ruleAlerts = this.listRuleFindings({ runId, status });
      const bacnetAlerts = await this.listBacnetAlarms({ devices });
      return [...bacnetAlerts, ...ruleAlerts];
    },

    /** Acknowledge a live BACnet alarm (delegates to bacnet.read). */
    async acknowledge({ device, objectType, instance }) {
      if (!bacnet) throw new Error("alerts: BACnet capability unavailable");
      return bacnet.acknowledgeAlarm({ device, objectType, instance });
    },

    /** Run the rule packs in scope and persist the run. Returns the saved run. */
    async runRuleScan({ scope = {}, options = {}, useLive = true } = {}) {
      const run = await rules.run({ scope, options, useLive });
      return inventory.recordRuleRun(run);
    },
  };
}
