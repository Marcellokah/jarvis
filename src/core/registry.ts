import type { JarvisModule, ModuleSchedule } from "./module.ts";
import { dayOfWeek, type Tz } from "../shared/dates.ts";

/** Does this module run today? */
export function runsToday(schedule: ModuleSchedule | undefined, now: Date, tz: Tz): boolean {
  if (!schedule || schedule === "daily") return true;
  return schedule.days.includes(dayOfWeek(now, tz));
}

/**
 * The modules that should run right now: enabled in config.ts, and scheduled
 * for today. Order is preserved from the registration barrel, which is what
 * gives the brief a stable section order before priority sorting.
 */
export function selectModules(all: readonly JarvisModule[], now: Date, tz: Tz): JarvisModule[] {
  return all.filter((m) => m.enabled && runsToday(m.schedule, now, tz));
}

/** Duplicate names would make config toggles and Telegram commands ambiguous. */
export function assertUniqueNames(all: readonly JarvisModule[]): void {
  const seen = new Set<string>();
  for (const m of all) {
    if (seen.has(m.name)) throw new Error(`Duplicate module name: ${m.name}`);
    seen.add(m.name);
  }
}
