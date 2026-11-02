import { GitLibError } from "../errors.js";
import type { DependabotSchedule, StoredDependabotSchedule } from "../planning/types.js";
import type { StoredRun } from "./store.js";

/** The schedule the user typed is not one the server can follow. The message is safe to show. */
export class DependabotScheduleError extends GitLibError {}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** A run that could not ask some owner is tried again after this long... */
export const RETRY_AFTER_MS = 30 * 60_000;
/** ...but only until this long after the slot, so a permanent failure does not retry all day. */
export const RETRY_WINDOW_MS = 6 * 3_600_000;

/** Checks what the page sent and returns it in canonical form (days sorted and unique). */
export function normalizeSchedule(input: { enabled?: unknown; days?: unknown; time?: unknown }): DependabotSchedule {
  if (typeof input.enabled !== "boolean") throw new DependabotScheduleError("Say whether the schedule is on or off.");
  if (!Array.isArray(input.days) || !input.days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)) {
    throw new DependabotScheduleError("Days must be weekdays from Sunday to Saturday.");
  }
  if (typeof input.time !== "string" || !TIME.test(input.time)) {
    throw new DependabotScheduleError("The time must look like 08:00 (24-hour).");
  }
  const days = [...new Set(input.days as number[])].sort((a, b) => a - b);
  if (input.enabled && days.length === 0) throw new DependabotScheduleError("Pick at least one day, or turn the schedule off.");
  return { enabled: input.enabled, days, time: input.time };
}

/** `time` on the calendar day of `day`, in the process's time zone (which handles a day with a clock change). */
function slotOn(day: Date, time: string): Date {
  const [hours, minutes] = time.split(":").map(Number) as [number, number];
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes, 0, 0);
}

const dayOffset = (from: Date, offset: number): Date => new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset, 12);

/** The latest slot at or before `now`, or null when the schedule is off or has no days. */
export function previousSlot(schedule: DependabotSchedule, now: Date): Date | null {
  if (!schedule.enabled || schedule.days.length === 0) return null;
  for (let offset = 0; offset >= -7; offset -= 1) {
    const day = dayOffset(now, offset);
    if (!schedule.days.includes(day.getDay())) continue;
    const slot = slotOn(day, schedule.time);
    if (slot.getTime() <= now.getTime()) return slot;
  }
  return null;
}

/** The earliest slot after `after`, or null when the schedule is off or has no days. */
export function nextSlot(schedule: DependabotSchedule, after: Date): Date | null {
  if (!schedule.enabled || schedule.days.length === 0) return null;
  for (let offset = 0; offset <= 7; offset += 1) {
    const day = dayOffset(after, offset);
    if (!schedule.days.includes(day.getDay())) continue;
    const slot = slotOn(day, schedule.time);
    if (slot.getTime() > after.getTime()) return slot;
  }
  return null;
}

/**
 * Whether a check should start now. The latest slot has to be newer than both the last run (any run, however it was
 * started: a fresh check satisfies the slot) and the moment the schedule was saved (so turning it on at 14:00 does not
 * "catch up" 08:00). A run that could not ask some owner is retried after a while, within a few hours of the slot.
 * This is also what makes a restart catch up on a slot missed while the server was down.
 */
export function isCheckDue(schedule: StoredDependabotSchedule, lastRun: StoredRun | null, now: Date): boolean {
  const slot = previousSlot(schedule, now);
  if (!slot) return false;
  const anchor = Math.max(schedule.updatedAt ? Date.parse(schedule.updatedAt) : 0, lastRun ? Date.parse(lastRun.startedAt) : 0);
  if (anchor < slot.getTime()) return true;

  const failed = lastRun !== null && lastRun.report.errors.length > 0;
  return failed && now.getTime() - Date.parse(lastRun.finishedAt) >= RETRY_AFTER_MS && now.getTime() - slot.getTime() < RETRY_WINDOW_MS;
}
