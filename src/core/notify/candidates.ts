import type { Metrics } from "../analysis/aggregate.ts";
import { daysBetween, type Tz } from "../../shared/dates.ts";

export type CandidateKind = "deadline" | "health" | "analysis";

export interface Candidate {
  /**
   * Stable identity for deduplication.
   *
   * It must be identical on two ticks describing the same situation. A key
   * that moved with the clock would make every tick look new, and the
   * assistant would repeat itself until the retention window pruned it.
   */
  key: string;
  kind: CandidateKind;
  urgency: "now" | "soon";
  /** Hungarian, one line, carrying the evidence it rests on. */
  text: string;
}

export interface DeadlineItem {
  label: string;
  /** ISO instant by which it has to happen, or at which it happens. */
  dueAt: string;
  /** Only consulted for deadlines; an event is judged by its local date. */
  overdue: boolean;
  /**
   * A deadline can be missed; an event merely arrives. They differ in wording
   * and in horizon: "the deadline has passed" is simply untrue of a renewal,
   * and a renewal is known a day ahead, not four hours ahead.
   */
  sort?: "deadline" | "event";
}

export interface CandidateInput {
  now: Date;
  tz: Tz;
  /** Null when the history could not be aggregated; the rest still stands. */
  metrics: Metrics | null;
  newAnalyses: { domain: string; summary: string; createdAt: string }[];
  deadlines: DeadlineItem[];
}

/** A deadline further out than this can wait for the next time we speak. */
export const DEADLINE_HORIZON_H = 4;

/**
 * How many local days ahead an event is worth mentioning. 1 = today and
 * tomorrow.
 *
 * Events are judged in local days rather than in hours because that is how
 * they are known. `config.finance.alertDaysBefore` is [7, 3, 1], so a renewal
 * alert is one, three or seven days out — never less than seventeen hours
 * away, which the four-hour instant horizon would drop every single time,
 * leaving the renewal source dead in production while looking alive in tests.
 */
export const EVENT_HORIZON_DAYS = 1;

/** How far HRV must sit from its own 90-day baseline, in standard deviations. */
export const HRV_SIGMA_THRESHOLD = 1.5;

/** Resting heart rate worsening by at least this many bpm per 30 days. */
export const RHR_SLOPE_THRESHOLD = 2;

/**
 * Sample-size floors. A push is a stronger claim than a line in a report, so
 * it must not rest on less evidence.
 *
 * MIN_N7 and MIN_N90 are the aggregation layer's own gates repeated here:
 * `aggregate()` already returns a null `hrvDeviation` below 3 and 20, so as
 * the code stands today neither can ever reject anything. They are kept as
 * defence in depth — if that layer's floors are ever loosened, the threshold
 * that decides whether to interrupt someone should not move with them.
 *
 * MIN_RHR_N is not inherited: it was invented here. `slopePer30d()` reports a
 * trend from three points, and three points are nowhere near enough to
 * interrupt someone with the claim that their resting heart rate is rising.
 */
const MIN_N7 = 3;
const MIN_N90 = 20;
const MIN_RHR_N = 60;

const DOMAIN_LABEL: Record<string, string> = {
  physical: "Fizikai fejlődés",
  recovery: "Regenerálódás",
  finance: "Pénzügy",
  synthesis: "Összegzés",
};

export function candidates(input: CandidateInput): Candidate[] {
  const out: Candidate[] = [];
  const horizonMs = DEADLINE_HORIZON_H * 3_600_000;

  for (const d of input.deadlines) {
    // The due day, not the current time: the same task on the same day is the
    // same task however often we look at it.
    const key = `deadline:${d.label}:${d.dueAt.slice(0, 10)}`;

    if ((d.sort ?? "deadline") === "event") {
      // Local days, which is why `tz` is carried this far down. A renewal
      // pinned to 07:00Z falls on its own local date in both halves of the
      // year, so "ma" stays true whether we look at it at 08:00 or at 21:00 —
      // no separate overdue case is needed, and none of the deadline
      // vocabulary applies: an event that arrived on schedule was not missed.
      const daysAway = daysBetween(input.now, new Date(d.dueAt), input.tz);
      if (daysAway < 0 || daysAway > EVENT_HORIZON_DAYS) continue;

      out.push({
        key,
        kind: "deadline",
        urgency: daysAway === 0 ? "now" : "soon",
        text: `${d.label} — ${daysAway === 0 ? "ma" : "holnap"}.`,
      });
      continue;
    }

    const msLeft = new Date(d.dueAt).getTime() - input.now.getTime();
    if (!d.overdue && msLeft > horizonMs) continue;

    const minutesLeft = Math.max(0, Math.round(msLeft / 60_000));
    out.push({
      key,
      kind: "deadline",
      urgency: d.overdue || msLeft <= 0 ? "now" : "soon",
      text: d.overdue
        ? `${d.label} — a határidő már lejárt.`
        : `${d.label} — ${minutesLeft} perc múlva jár le.`,
    });
  }

  const m = input.metrics;
  if (m) {
    const dev = m.recovery.hrvDeviation;
    if (dev && dev.n7 >= MIN_N7 && dev.n90 >= MIN_N90 && Math.abs(dev.sigma) >= HRV_SIGMA_THRESHOLD) {
      const direction = dev.sigma < 0 ? "alatta" : "fölötte";
      out.push({
        key: "health:hrv-deviation",
        kind: "health",
        urgency: "soon",
        text: `A HRV-d ${Math.abs(dev.sigma).toFixed(1)} szórással a 90 napos alapvonalad ${direction} `
          + `van (${dev.n7} nap a friss ablakban, ${dev.n90} az alapvonalban).`,
      });
    }

    const rhr = m.physical.rhr;
    // Only a rising trend: a falling resting heart rate is good news, and good
    // news does not need to interrupt anyone.
    if (rhr.slopePer30d !== null && rhr.slopePer30d >= RHR_SLOPE_THRESHOLD && rhr.n >= MIN_RHR_N) {
      out.push({
        key: "health:rhr-rising",
        kind: "health",
        urgency: "soon",
        text: `A nyugalmi pulzusod 30 naponta ${rhr.slopePer30d.toFixed(1)} bpm-mel emelkedik `
          + `(${rhr.n} nap, ${rhr.window}).`,
      });
    }
  }

  for (const a of input.newAnalyses) {
    out.push({
      key: `analysis:${a.domain}:${a.createdAt.slice(0, 10)}`,
      kind: "analysis",
      urgency: "soon",
      text: `${DOMAIN_LABEL[a.domain] ?? a.domain} — ${a.summary}`,
    });
  }

  return [...out].sort(byUrgency);
}

/**
 * Urgent first; within a group, the order they were produced in.
 *
 * Exported because the tick caps the list before sending, and a cap that keeps
 * the first five has to be applied to a list that is genuinely urgent-first —
 * not one that merely happens to be.
 */
export function byUrgency(a: Candidate, b: Candidate): number {
  return Number(b.urgency === "now") - Number(a.urgency === "now");
}
