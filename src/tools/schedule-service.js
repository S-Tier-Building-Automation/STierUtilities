// Schedule service — a normalized weekly-schedule model plus read/write over the
// bacnet.read capability. Viewing and editing BACnet Schedule objects is a
// high-value commissioning surface that needs no control runtime: the device
// keeps running its schedule; we just read it, present it, and command/override
// the present-value.
//
// The weekly model and its operations are pure and unit-tested; the service
// methods passthrough to the backend schedule commands.

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]; // BACnet weekly-schedule order

/** "HH:MM" -> minutes since midnight, or null if malformed. */
export function parseTime(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

/** minutes since midnight -> "HH:MM". */
export function formatTime(minutes) {
  const m = ((Number(minutes) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** A fresh 7-day weekly schedule with an out-of-effective default value. */
export function createWeeklySchedule({ scheduleDefault = null } = {}) {
  return {
    scheduleDefault,
    days: DAYS.map(() => []),
    version: 1,
  };
}

function dayIndex(day) {
  if (typeof day === "number") return day;
  const i = DAYS.indexOf(String(day).slice(0, 3));
  return i;
}

function sortDay(entries) {
  return [...entries].sort((a, b) => (parseTime(a.time) ?? 0) - (parseTime(b.time) ?? 0));
}

/** Add (or replace at the same time) a time-value entry on a day. Immutable. */
export function addEntry(weekly, day, time, value) {
  const i = dayIndex(day);
  if (i < 0 || i > 6) throw new Error(`invalid day ${day}`);
  if (parseTime(time) == null) throw new Error(`invalid time ${time}`);
  const next = JSON.parse(JSON.stringify(weekly));
  next.days[i] = sortDay([...next.days[i].filter((e) => e.time !== time), { time, value }]);
  return next;
}

/** Remove the entry at a given time on a day. Immutable. */
export function removeEntry(weekly, day, time) {
  const i = dayIndex(day);
  const next = JSON.parse(JSON.stringify(weekly));
  if (i >= 0 && i <= 6) next.days[i] = next.days[i].filter((e) => e.time !== time);
  return next;
}

/**
 * The effective value at a day+time: the most recent entry whose time is <= the
 * query time, else the schedule default (BACnet semantics).
 */
export function valueAt(weekly, day, time) {
  const i = dayIndex(day);
  const mins = parseTime(time);
  if (i < 0 || i > 6 || mins == null) return weekly.scheduleDefault ?? null;
  let current = weekly.scheduleDefault ?? null;
  for (const e of sortDay(weekly.days[i])) {
    if ((parseTime(e.time) ?? 0) <= mins) current = e.value;
    else break;
  }
  return current;
}

/** Detect duplicate times within any day (a common scheduling mistake). */
export function findConflicts(weekly) {
  const conflicts = [];
  weekly.days.forEach((entries, i) => {
    const seen = new Set();
    for (const e of entries) {
      if (seen.has(e.time)) conflicts.push({ day: DAYS[i], time: e.time });
      seen.add(e.time);
    }
  });
  return conflicts;
}

export const SCHEDULE_DAYS = DAYS;

/** Wrap the bacnet.read schedule commands behind a small service. */
export function createScheduleService({ bacnet } = {}) {
  if (!bacnet) throw new Error("schedule service requires a bacnet.read capability");
  return {
    parseTime,
    formatTime,
    createWeeklySchedule,
    addEntry,
    removeEntry,
    valueAt,
    findConflicts,
    /** Read a Schedule object's properties from a device. */
    read: ({ device, instance }) => bacnet.readSchedule({ device, instance }),
    /** Command the schedule's present-value (manual override). */
    command: ({ device, instance, value, priority = null }) =>
      bacnet.writeSchedule({ device, instance, value, priority }),
  };
}
