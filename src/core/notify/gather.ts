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
    // computed with real tz math, which is more than a single per-day
    // instant warrants. `overdue` is derived from that instant instead of
    // assumed false: `nextOccurrence()` in finance-subs only guarantees
    // `renewsOn >= today` at the moment the module runs, not at the moment
    // this notification path checks it, so a renewal read well after its
    // instant has already happened and must not be reported as still ahead.
    const dueAt = `${raw.renewsOn}T07:00:00.000Z`;
    out.push({ label: `${raw.name} megújul`, dueAt, overdue: Date.parse(dueAt) <= now.getTime() });
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
export async function gatherCandidates(
  deps: GatherDeps,
  now: Date,
  _signal: AbortSignal,
): Promise<Candidate[]> {
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
    newAnalyses = deps.analyses.latestPerDomain()
      .filter((a) => since === null || a.createdAt > since)
      .map((a) => ({ domain: a.domain, summary: a.summary, createdAt: a.createdAt }));
  } catch (err) {
    deps.logger.warn({ err: String(err) }, "analyses unavailable for the notification");
  }

  return candidates({ now, tz: deps.tz, metrics, newAnalyses, deadlines });
}
