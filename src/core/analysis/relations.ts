import type { AggregateInput } from "./aggregate.ts";
import type { HealthSnapshot } from "../../infra/db/repositories/health.ts";
import { pearson, shiftDay } from "./stats.ts";

export interface Relation {
  /** Stable identifier, so a test can name a pair without matching prose. */
  key: "load_vs_rhr" | "load_vs_hrv" | "hrv_vs_sleep" | "steps_vs_rhr";
  /** Hungarian label, shown to the model and in the report. */
  label: string;
  r: number;
  n: number;
  window: string;
}

/**
 * The closed list of relationships the analysis is allowed to discuss.
 *
 * Not a limitation to work around: 2,715 days and a dozen metrics will hand a
 * pattern to anyone who goes looking, and a language model always finds one.
 * Adding a pair is a code change on purpose, so the decision is made once,
 * deliberately, rather than improvised inside a prompt.
 */

/** Trailing 28-day training minutes per day, as a series aligned to dates. */
function loadSeries(input: AggregateInput, days: number): Map<string, number> {
  const byDay = new Map<string, number>();
  for (const w of input.workouts) {
    byDay.set(w.date, (byDay.get(w.date) ?? 0) + w.durationMin);
  }
  const out = new Map<string, number>();
  const first = shiftDay(input.today, -(days - 1));
  for (let d = first; d <= input.today; d = shiftDay(d, 1)) {
    let total = 0;
    for (let k = 0; k < 28; k++) total += byDay.get(shiftDay(d, -k)) ?? 0;
    out.set(d, total);
  }
  return out;
}

function column(
  snapshots: readonly HealthSnapshot[], key: keyof HealthSnapshot,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of snapshots) {
    const v = s[key];
    if (typeof v === "number") out.set(s.date, v);
  }
  return out;
}

/** Pairs the two maps on the dates they share, in date order. */
function paired(a: Map<string, number>, b: Map<string, number>): { xs: number[]; ys: number[] } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const date of [...a.keys()].sort()) {
    const y = b.get(date);
    if (y !== undefined) { xs.push(a.get(date)!); ys.push(y); }
  }
  return { xs, ys };
}

export function relations(input: AggregateInput, minN: number): Relation[] {
  const load365 = loadSeries(input, 365);
  const within365 = (m: Map<string, number>) => {
    const first = shiftDay(input.today, -364);
    return new Map([...m].filter(([d]) => d >= first && d <= input.today));
  };

  const rhr = column(input.snapshots, "rhr");
  const hrv = column(input.snapshots, "hrv");
  const steps = column(input.snapshots, "steps");
  const sleep = column(input.snapshots, "asleepMin");

  const candidates: { key: Relation["key"]; label: string; window: string; a: Map<string, number>; b: Map<string, number> }[] = [
    { key: "load_vs_rhr", label: "28 napos edzésterhelés ↔ nyugalmi pulzus", window: "365 nap", a: load365, b: within365(rhr) },
    { key: "load_vs_hrv", label: "28 napos edzésterhelés ↔ HRV", window: "365 nap", a: load365, b: within365(hrv) },
    { key: "hrv_vs_sleep", label: "HRV ↔ alváshossz", window: "teljes átfedés", a: hrv, b: sleep },
    { key: "steps_vs_rhr", label: "lépésszám ↔ nyugalmi pulzus", window: "365 nap", a: within365(steps), b: within365(rhr) },
  ];

  const out: Relation[] = [];
  for (const c of candidates) {
    const { xs, ys } = paired(c.a, c.b);
    // Below the threshold the pair is not weak evidence — it is no evidence,
    // and it never reaches the prompt.
    if (xs.length < minN) continue;
    const r = pearson(xs, ys);
    if (r === null) continue;
    out.push({ key: c.key, label: c.label, r, n: xs.length, window: c.window });
  }
  return out;
}
