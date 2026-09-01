import type { Logger } from "../../infra/logger.ts";
import type { NotificationRepo } from "../../infra/db/repositories/notifications.ts";
import type { AnalysisRepo } from "../../infra/db/repositories/analyses.ts";
import type { Metrics } from "../analysis/aggregate.ts";
import type { Tz } from "../../shared/dates.ts";
import { candidates, type Candidate, type DeadlineItem } from "./candidates.ts";

export interface GatherDeps {
  tz: Tz;
  logger: Logger;
  notifications: NotificationRepo;
  analyses: AnalysisRepo;
  /** The aggregation over the whole history. May throw; may return null. */
  metrics: () => Metrics | null;
  /**
   * Runs one module and returns its data.
   *
   * Deliberately narrow: the caller wires this to `BriefService.runOne`, which
   * runs a single module. `get` and `generate` synthesise a brief, and a
   * synthesis is a Groq call — this path must never trigger one.
   */
  runModule: (name: string, now: Date) => Promise<unknown>;
}

/**
 * An analysis older than this is not news, whatever the notification log says.
 *
 * `latestPerDomain()` has no age limit of its own, so on the first tick after
 * a fresh install — `lastSentAt()` null, nothing filtered — every domain's
 * newest analysis would count as new and all four would go out at once, over
 * Telegram's 4096 characters and split into several messages, at the moment
 * the system has the least headroom. And an analysis from three weeks ago
 * would be announced as new, which it is not.
 */
const ANALYSIS_MAX_AGE_H = 24;

interface DefrostShape { item?: unknown; takeOutBy?: unknown; overdue?: unknown }
interface RenewalShape { name?: unknown; renewsOn?: unknown }

/** Narrow, defensive readers: a module's shape changing must not throw here. */
function defrostDeadlines(data: unknown): DeadlineItem[] {
  const list = (data as { defrost?: unknown } | null)?.defrost;
  if (!Array.isArray(list)) return [];
  const out: DeadlineItem[] = [];
  for (const raw of list as DefrostShape[]) {
    if (typeof raw.item !== "string" || typeof raw.takeOutBy !== "string") continue;
    out.push({ label: raw.item, dueAt: raw.takeOutBy, overdue: raw.overdue === true });
  }
  return out;
}

/**
 * `FinanceAndSubs` puts renewals in `data.alerts` (see `FinanceData` in
 * `src/modules/finance-subs/index.ts`) — confirmed by reading the module
 * rather than guessed, since the plan was written without that.
 */
function renewalDeadlines(data: unknown, now: Date): DeadlineItem[] {
  const list = (data as { alerts?: unknown } | null)?.alerts;
  if (!Array.isArray(list)) return [];
  const out: DeadlineItem[] = [];
  for (const raw of list as RenewalShape[]) {
    if (typeof raw.name !== "string" || typeof raw.renewsOn !== "string") continue;
    // A renewal has a day, not a moment. The fixed 07:00Z instant is 09:00
    // Budapest in summer and 08:00 in winter — pinned in UTC rather than
    // computed with real tz math, which is more than a single per-day instant
    // warrants, and either way it lands on the renewal's own local date, which
    // is what `candidates()` judges an event by. `overdue` is derived from the
    // instant instead of assumed false: `nextOccurrence()` in finance-subs
    // only guarantees `renewsOn >= today` at the moment the module runs, not
    // at the moment this path reads it. The event wording no longer consults
    // it — a renewal read at 21:00 on its own day is still "ma" — but
    // recording it as still ahead would be untrue.
    const dueAt = `${raw.renewsOn}T07:00:00.000Z`;
    out.push({
      label: `${raw.name} megújul`,
      dueAt,
      overdue: Date.parse(dueAt) <= now.getTime(),
      // A renewal happens; it is never "missed" the way a defrost deadline is.
      sort: "event",
    });
  }
  return out;
}

/**
 * Collects everything worth considering, with each source isolated.
 *
 * The sources fail in different ways — the modules reach the network and the
 * calendar, the aggregation walks seven years of rows — and one of them
 * falling over must not silence a finding that is already in hand.
 */
export async function gatherCandidates(deps: GatherDeps, now: Date): Promise<Candidate[]> {
  const deadlines: DeadlineItem[] = [];
  try {
    const health = await deps.runModule("HealthAndMealPrep", now);
    deadlines.push(...defrostDeadlines(health));
  } catch (err) {
    deps.logger.warn({ err: String(err) }, "defrost deadlines unavailable for the notification");
  }

  try {
    const finance = await deps.runModule("FinanceAndSubs", now);
    deadlines.push(...renewalDeadlines(finance, now));
  } catch (err) {
    deps.logger.warn({ err: String(err) }, "subscription renewals unavailable for the notification");
  }

  let metrics: Metrics | null = null;
  try {
    metrics = deps.metrics();
  } catch (err) {
    deps.logger.warn({ err: String(err) }, "metrics unavailable for the notification");
  }

  let newAnalyses: { domain: string; summary: string; createdAt: string }[] = [];
  try {
    const since = deps.notifications.lastSentAt();
    const oldest = now.getTime() - ANALYSIS_MAX_AGE_H * 3_600_000;
    newAnalyses = deps.analyses.latestPerDomain()
      .filter((a) => since === null || a.createdAt > since)
      .filter((a) => Date.parse(a.createdAt) >= oldest)
      .map((a) => ({ domain: a.domain, summary: a.summary, createdAt: a.createdAt }));
  } catch (err) {
    deps.logger.warn({ err: String(err) }, "analyses unavailable for the notification");
  }

  return candidates({ now, tz: deps.tz, metrics, newAnalyses, deadlines });
}
