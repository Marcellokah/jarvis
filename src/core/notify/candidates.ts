import type { Metrics } from "../analysis/aggregate.ts";
import { isoDate, type Tz } from "../../shared/dates.ts";

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
  /** ISO instant by which it has to happen. */
  dueAt: string;
  overdue: boolean;
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

/** How far HRV must sit from its own 90-day baseline, in standard deviations. */
export const HRV_SIGMA_THRESHOLD = 1.5;

/** Resting heart rate worsening by at least this many bpm per 30 days. */
export const RHR_SLOPE_THRESHOLD = 2;

/**
 * The sample-size floors, inherited from the aggregation layer rather than
 * invented here: the same gates S3 applies before it will report a deviation
 * at all. A push is a stronger claim than a line in a report, so it must not
 * rest on less.
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
    const msLeft = new Date(d.dueAt).getTime() - input.now.getTime();
    if (!d.overdue && msLeft > horizonMs) continue;

    out.push({
      // The due day, not the current time: the same task on the same day is
      // the same task however often we look at it.
      key: `deadline:${d.label}:${d.dueAt.slice(0, 10)}`,
      kind: "deadline",
      urgency: d.overdue || msLeft <= 0 ? "now" : "soon",
      text: d.overdue
        ? `${d.label} — a határidő már lejárt.`
        : `${d.label} — ${Math.max(0, Math.round(msLeft / 60_000))} perc múlva jár le.`,
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

  // Urgent first; within a group, the order they were produced in.
  return [...out].sort((a, b) => Number(b.urgency === "now") - Number(a.urgency === "now"));
}

/** Exported for the tick's logging: today's date in the configured zone. */
export function candidateDay(input: CandidateInput): string {
  return isoDate(input.now, input.tz);
}
