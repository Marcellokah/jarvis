import { isoTime, type Tz } from "../../shared/dates.ts";

export interface GateOptions {
  /** Never speak twice inside this many hours. */
  minHoursBetween: number;
  /** Quiet from this local hour (inclusive). */
  quietFromHour: number;
  /** Quiet until this local hour (exclusive). */
  quietToHour: number;
}

/**
 * Whether the assistant may speak unprompted right now.
 *
 * Returns null when it may, or a Hungarian reason when it may not — the reason
 * is logged, because "nothing happened" and "something was suppressed" look
 * identical otherwise, and only one of them is a bug.
 *
 * Both gates are checked before anything is read from the database or the
 * network. A tick that cannot send has no business doing work.
 */
export function gateReason(
  now: Date,
  tz: Tz,
  lastSentAt: string | null,
  opts: GateOptions,
): string | null {
  // Quiet hours are judged in local time, not UTC: the point is when the
  // person is asleep, and Budapest is one or two hours ahead depending on the
  // season.
  const hour = Number(isoTime(now, tz).slice(0, 2));
  const quiet = opts.quietFromHour > opts.quietToHour
    // The window crosses midnight, which is the normal case for night hours.
    ? hour >= opts.quietFromHour || hour < opts.quietToHour
    : hour >= opts.quietFromHour && hour < opts.quietToHour;

  if (quiet) {
    return `csendes órák (${opts.quietFromHour}:00–${opts.quietToHour}:00), most ${hour}:00`;
  }

  if (lastSentAt !== null) {
    const elapsedH = (now.getTime() - new Date(lastSentAt).getTime()) / 3_600_000;
    if (elapsedH < opts.minHoursBetween) {
      return `az utolsó értesítés ${elapsedH.toFixed(1)} órája ment ki, `
        + `a korlát ${opts.minHoursBetween} óra`;
    }
  }

  return null;
}
