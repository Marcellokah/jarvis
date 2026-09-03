import type { BriefService } from "../../../core/brief-service.ts";
import type { ChatService } from "../../../core/chat.ts";
import type { AnalysisRepo, AnalysisRow } from "../../../infra/db/repositories/analyses.ts";
import type { ConversationRepo } from "../../../infra/db/repositories/conversations.ts";
import type { HealthRepo, HealthSnapshot } from "../../../infra/db/repositories/health.ts";
import type { WorkoutRepo } from "../../../infra/db/repositories/workouts.ts";
import type { MealRepo } from "../../../infra/db/repositories/meals.ts";
import type { SubscriptionRepo } from "../../../infra/db/repositories/subscriptions.ts";
import type { ActionRepo } from "../../../infra/db/repositories/actions.ts";
import type { ProposalService } from "../../../core/proposals.ts";
import type { JarvisModule } from "../../../core/module.ts";
import type { Metrics } from "../../../core/analysis/aggregate.ts";
import type { Clock } from "../../../infra/clock.ts";
import type { Logger } from "../../../infra/logger.ts";
import { huLongDate, isoDate, TZ } from "../../../shared/dates.ts";
import {
  readChannels, summarise, type ChannelReading, type ChannelSummary,
} from "../view/channels.ts";
import { layout, type NavState, type Section } from "../view/shell.ts";

export interface PageDeps {
  briefs: BriefService;
  chat: ChatService;
  analyses: AnalysisRepo;
  conversations: ConversationRepo;
  health: HealthRepo;
  workouts: WorkoutRepo;
  meals: MealRepo;
  subscriptions: SubscriptionRepo;
  actions: ActionRepo;
  proposals: ProposalService;
  /** For turning a stored module NAME into that module's own title. */
  modules: readonly JarvisModule[];
  /**
   * The freshest aggregate, rebuilt per request.
   *
   * Raw `Metrics` rather than the finished `MetricRow[]` the Számok page
   * shows: the area pages want `physical.byMonth`, `recovery.sleepByYear`
   * and `finance.monthOverMonth`, none of which survive the formatting into
   * rows. `/szamok` applies `metricsRowsFrom` itself, inside the same
   * try/catch that already guarded it.
   */
  metrics: () => Metrics;
  clock: Clock;
  logger: Logger;
}

/** "2 órája" — a brief kora emberi szavakkal, vagy null, ha nem olvasható. */
function ageWords(from: string, now: Date): string | null {
  const ms = now.getTime() - Date.parse(from);
  // `Date.parse` answers NaN for anything it cannot read, and `Math.max(0,
  // NaN)` is NaN — which rendered a confident "NaN napja" in the one place
  // this project's whole principle points the other way. Missing data beats
  // confidently wrong data, and it has to look missing: null drops the line
  // rather than printing a number that was never a number.
  if (Number.isNaN(ms)) return null;
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} perce`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} órája`;
  return `${Math.round(hours / 24)} napja`;
}

/** "2026. augusztus 30., vasárnap" — egy naptári nap a keret hangján. */
function dayWords(day: string): string | null {
  // Noon UTC, not midnight: a midnight instant read back in Europe/Budapest
  // lands on the neighbouring day, and the label would name the wrong date.
  const at = new Date(`${day}T12:00:00Z`);
  return Number.isNaN(at.getTime()) ? null : huLongDate(at, TZ);
}

/**
 * Everything the shell shows, plus the reads the bodies share with it.
 *
 * Four routes want the same status strip and the same nav lamps, and three of
 * them spelled that out line for line; all four read the cached brief twice,
 * once for the strip's age and once for the "Ma" lamp. The repetition and the
 * double read are the same problem, so one function answers both — and each
 * page's own body then only reads what is uniquely its own.
 */
export interface ShellInputs {
  dateLabel: string;
  briefAge: string | null;
  channels: ChannelSummary;
  nav: NavState;
  /** The cached brief's text — null when absent, blank, or unreadable. */
  briefMarkdown: string | null;
  /** How old today's row is, already worded — null when there is none. */
  writtenAge: string | null;
  /** The most recent day that has any data, already worded, when today has none. */
  lastSeen: string | null;
  readings: readonly ChannelReading[];
  /** The latest analysis per domain: one read for the lamp and the band alike. */
  analyses: AnalysisRow[];
}

/**
 * Each source keeps its own try/catch, exactly as the routes first wrote them.
 * That isolation is the point of this function's shape, not an accident of
 * it: a failing brief must not take today's readings with it, and a failing
 * analyses repo must dim one lamp rather than 500 a page that has everything
 * else to show.
 */
export async function shellInputs(deps: PageDeps, now: Date): Promise<ShellInputs> {
  const today = isoDate(now, TZ);

  // `cached`, never `get`: opening a page must not start a brief generation —
  // every module plus a Groq synthesis, up to 45 seconds, for a page the
  // owner only wanted to read.
  let briefMarkdown: string | null = null;
  let briefAge: string | null = null;
  try {
    const brief = deps.briefs.cached(now);
    if (brief && brief.markdown.trim() !== "") {
      briefMarkdown = brief.markdown;
      briefAge = ageWords(brief.generatedAt, now);
    }
  } catch (err) {
    deps.logger.warn({ err: String(err) }, "page rendered without a brief");
  }

  let snapshot: HealthSnapshot | undefined = undefined;
  let lastSeen: string | null = null;
  try {
    snapshot = deps.health.forDate(today);
    if (snapshot === undefined) {
      const previous = deps.health.latest(today)?.date;
      lastSeen = previous === undefined ? null : dayWords(previous);
    }
  } catch (err) {
    deps.logger.warn({ err: String(err) }, "page rendered without today's readings");
  }

  let analyses: AnalysisRow[] = [];
  try {
    analyses = deps.analyses.latestPerDomain();
  } catch (err) {
    deps.logger.warn({ err: String(err) }, "page rendered without its analyses");
  }

  // `available()` is a `SecretResolver` read under the hood, and nothing
  // guarantees an arbitrary resolver swallows its own errors the way the
  // keychain one happens to — a throw here must dim the "Kérdés" lamp, not
  // 500 every page that shows it.
  let chatAvailable = false;
  try {
    chatAvailable = await deps.chat.available();
  } catch (err) {
    deps.logger.warn({ err: String(err) }, "nav indicator fell back to dark");
  }

  const readings = readChannels(snapshot, now);

  return {
    dateLabel: huLongDate(now, TZ),
    briefAge,
    channels: summarise(readings),
    nav: {
      ma: briefMarkdown !== null,
      // Lit while the deep analysis is still fresh. The analysis is started
      // by hand (`npm run analyze`) and reports over 28-day windows, so a
      // week — by which a quarter of that window has turned over — is where
      // its picture stops being the current one. Unlike the old "there is at
      // least one analysis" lamp, this one can actually go dark.
      terulet: analyses.some(
        (a) => now.getTime() - Date.parse(a.createdAt) <= 7 * 86_400_000,
      ),
      kerdes: chatAvailable,
    },
    briefMarkdown,
    writtenAge: snapshot ? ageWords(snapshot.ingestedAt, now) : null,
    lastSeen,
    readings,
    analyses,
  };
}

/**
 * The shell around one page's body, from inputs every page computes alike.
 *
 * `path` is optional and only the six area routes currently pass it — see
 * `ShellData.path` for why it exists: without it, every area page would mark
 * the hub link as current rather than its own submenu link.
 */
export function render(section: Section, inputs: ShellInputs, body: string, path?: string): string {
  return layout({
    section,
    dateLabel: inputs.dateLabel,
    briefAge: inputs.briefAge,
    channels: inputs.channels,
    nav: inputs.nav,
    path,
    body,
  });
}
