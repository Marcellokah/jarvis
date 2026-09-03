import type { HealthSnapshot } from "../../../infra/db/repositories/health.ts";
import { isoDate, isoTime, TZ } from "../../../shared/dates.ts";
import { hu } from "./format.ts";

export type ChannelState = "erkezett" | "varakozik" | "elmaradt";

export interface Channel {
  /** The history column this channel is measured in. */
  column: string;
  label: string;
  /**
   * The local hour by which the pipeline should have delivered it.
   *
   * Before this hour an absent value is not a gap, and must not be shown as
   * one: three of the six arrive from the 23:50 run, so without the hour the
   * status strip would read "3/6" and alarm every single day from morning to
   * night while nothing at all was wrong. A signal that always alarms is worth
   * exactly as much as one that never does.
   */
  dueHour: number;
  format: (v: number) => string;
}
/**
 * What the daily channel delivers EVERY day, and when.
 *
 * Deliberately not the 31 stored columns: VO2max, walking steadiness and the
 * six-minute walk are measured occasionally by the watch, so their absence
 * says nothing about the pipeline. These six say everything about it.
 */
export const NAPI_MAG: readonly Channel[] = [
  { column: "sleep_h", label: "Alvás", dueHour: 8, format: (v) => `${hu(v, 1)} óra` },
  { column: "hrv", label: "HRV", dueHour: 8, format: (v) => `${hu(v, 1)} ms` },
  { column: "rhr", label: "Nyugalmi pulzus", dueHour: 8, format: (v) => `${hu(v)} bpm` },
  { column: "steps", label: "Lépés", dueHour: 24, format: (v) => `${hu(v)} lépés` },
  { column: "move_kcal", label: "Aktív kalória", dueHour: 24, format: (v) => `${hu(v)} kcal` },
  { column: "exercise_min", label: "Mozgás", dueHour: 24, format: (v) => `${hu(v)} perc` },
];

/**
 * Whole calendar days between two 'YYYY-MM-DD' strings, `b - a`.
 *
 * Parsed as UTC dates purely as arithmetic — these are already local
 * calendar-day strings (from `today.date` and `isoDate(now, TZ)`), so no
 * further timezone conversion belongs here, only day counting.
 */
function daysBetween(a: string, b: string): number {
  const toUTC = (s: string) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y!, m! - 1, d!);
  };
  return Math.round((toUTC(b) - toUTC(a)) / 86_400_000);
}

/** The snapshot field each channel column is read from. */
const FIELD: Record<string, keyof HealthSnapshot> = {
  sleep_h: "sleepH", hrv: "hrv", rhr: "rhr",
  steps: "steps", move_kcal: "moveKcal", exercise_min: "exerciseMin",
};

export interface ChannelReading {
  channel: Channel;
  state: ChannelState;
  /** Formatted for a person, or null when nothing was measured. */
  value: string | null;
}

export function readChannels(
  today: HealthSnapshot | undefined, now: Date,
): ChannelReading[] {
  // Local hour alone wraps at midnight, so a naive `hour >= dueHour` can never
  // fire for a dueHour of 24: the moment the day ends, hour resets to 0 and
  // looks earlier than ever, not later. What actually matters is whether
  // `now` still falls within the calendar day `today` reports on — once the
  // wall clock has crossed into the next local date, that day is over and
  // every one of its due hours (24 included) has necessarily passed, so we
  // fold each elapsed day into the hour count instead of letting it wrap.
  const daysPast = today ? daysBetween(today.date, isoDate(now, TZ)) : 0;
  const hour = Number(isoTime(now, TZ).slice(0, 2)) + daysPast * 24;

  return NAPI_MAG.map((channel) => {
    const raw = today?.[FIELD[channel.column]!];
    // Only null means absent. A measured zero — no steps on a day spent in bed
    // — is a fact, and turning it into a gap would be the same lie as turning
    // a gap into a zero.
    if (typeof raw === "number") {
      return { channel, state: "erkezett" as const, value: channel.format(raw) };
    }
    return {
      channel,
      state: hour >= channel.dueHour ? ("elmaradt" as const) : ("varakozik" as const),
      value: null,
    };
  });
}

export interface ChannelSummary {
  arrived: number;
  waiting: number;
  missing: number;
  /** Labels of the missing ones — the status strip names them. */
  missingLabels: string[];
  total: number;
}

export function summarise(readings: readonly ChannelReading[]): ChannelSummary {
  return {
    arrived: readings.filter((r) => r.state === "erkezett").length,
    waiting: readings.filter((r) => r.state === "varakozik").length,
    missing: readings.filter((r) => r.state === "elmaradt").length,
    missingLabels: readings.filter((r) => r.state === "elmaradt").map((r) => r.channel.label),
    total: readings.length,
  };
}
