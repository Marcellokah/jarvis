import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { BriefService } from "../../../core/brief-service.ts";
import { MAX_QUESTION_CHARS, type ChatService } from "../../../core/chat.ts";
import type { AnalysisRepo } from "../../../infra/db/repositories/analyses.ts";
import type { ConversationRepo, Turn } from "../../../infra/db/repositories/conversations.ts";
import type { HealthRepo, HealthSnapshot } from "../../../infra/db/repositories/health.ts";
import type { Clock } from "../../../infra/clock.ts";
import type { Logger } from "../../../infra/logger.ts";
import { addDays, huLongDate, isoDate, TZ } from "../../../shared/dates.ts";
import {
  readChannels, summarise, type ChannelReading, type ChannelSummary,
} from "../view/channels.ts";
import { layout, type NavState, type Section } from "../view/shell.ts";
import { todayBody } from "../view/today.ts";
import { numbersBody, type MetricRow } from "../view/numbers.ts";
import { analysesBody } from "../view/analyses.ts";
import { askBody } from "../view/ask.ts";
import type { AnalysisRow } from "../../../infra/db/repositories/analyses.ts";
import { buildSeries } from "../view/chart/series.ts";
import { SOROZATOK, valuesFrom } from "../view/chart/registry.ts";
import { sparkline } from "../view/chart/sparkline.ts";
import { plot } from "../view/chart/plot.ts";
import { detailBody, parseRange } from "../view/chart/detail.ts";

/** The web page is one thread; Telegram chats are their own. */
export const WEB_CHAT_ID = "web";

export interface PageDeps {
  briefs: BriefService;
  chat: ChatService;
  analyses: AnalysisRepo;
  conversations: ConversationRepo;
  health: HealthRepo;
  metricsRows: () => MetricRow[];
  clock: Clock;
  logger: Logger;
}

const body = z.object({ question: z.string().trim().min(1).max(MAX_QUESTION_CHARS) });

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
interface ShellInputs {
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
async function shellInputs(deps: PageDeps, now: Date): Promise<ShellInputs> {
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
      elemzes: analyses.length > 0,
      kerdes: chatAvailable,
    },
    briefMarkdown,
    writtenAge: snapshot ? ageWords(snapshot.ingestedAt, now) : null,
    lastSeen,
    readings,
    analyses,
  };
}

/** The shell around one page's body, from inputs every page computes alike. */
function render(section: Section, inputs: ShellInputs, body: string): string {
  return layout({
    section,
    dateLabel: inputs.dateLabel,
    briefAge: inputs.briefAge,
    channels: inputs.channels,
    nav: inputs.nav,
    body,
  });
}

export function registerPageRoutes(app: FastifyInstance, deps: PageDeps): void {
  app.get("/", async (_request, reply) => {
    const inputs = await shellInputs(deps, deps.clock.now());
    return reply.type("text/html; charset=utf-8").send(render("ma", inputs, todayBody({
      briefMarkdown: inputs.briefMarkdown,
      readings: inputs.readings,
      lastSeen: inputs.lastSeen,
      writtenAge: inputs.writtenAge,
    })));
  });

  app.get("/szamok", async (_request, reply) => {
    const now = deps.clock.now();
    const inputs = await shellInputs(deps, now);

    // The aggregate the rows are built from touches every table the app has;
    // a corrupt row or a bad query must dim the numbers, not the page.
    let metricsRows: MetricRow[] = [];
    try {
      metricsRows = deps.metricsRows();
    } catch (err) {
      deps.logger.warn({ err: String(err) }, "page rendered without its metrics");
    }

    // Its own try/catch, like every other input this shell assembles: a
    // failing health query must dim the sparklines, never take the numbers —
    // let alone the whole page — down with it.
    const charts = new Map<string, string>();
    try {
      const to = isoDate(now, TZ);
      // One fetch for the longest window any row needs, sliced per row below
      // — the rows share history, so there is no reason to query it twice.
      const longest = Math.max(0, ...metricsRows.map((r) => r.series?.days ?? 0));
      if (longest > 0) {
        const snaps = deps.health.between(isoDate(addDays(now, -longest + 1), TZ), to);
        for (const r of metricsRows) {
          if (r.series === null) continue;
          const spec = SOROZATOK.get(r.series.column);
          if (spec === undefined) continue;
          const from = isoDate(addDays(now, -r.series.days + 1), TZ);
          const window = snaps.filter((s) => s.date >= from);
          charts.set(
            r.label,
            sparkline(buildSeries(r.series.column, from, to, valuesFrom(window, r.series.column)), spec),
          );
        }
      }
    } catch (err) {
      deps.logger.warn({ err: String(err) }, "page rendered without its sparklines");
    }

    return reply.type("text/html; charset=utf-8")
      .send(render("szamok", inputs, numbersBody(metricsRows, charts)));
  });

  app.get<{ Params: { metrika: string }; Querystring: { tart?: string } }>(
    "/szamok/:metrika", async (request, reply) => {
      const spec = SOROZATOK.get(request.params.metrika);
      // 404, nem üres diagram: az utóbbi azt állítaná, hogy létezik ez a mérés,
      // csak épp nincs adata — ami a rendszer alapszabályát sértené.
      if (spec === undefined) return reply.code(404).send({ error: "not_found" });

      const now = deps.clock.now();
      const inputs = await shellInputs(deps, now);
      const range = parseRange(request.query.tart);
      const to = isoDate(now, TZ);
      const from = isoDate(addDays(now, -range.days + 1), TZ);

      let series = buildSeries(spec.column, from, to, []);
      try {
        series = buildSeries(spec.column, from, to, valuesFrom(deps.health.between(from, to), spec.column));
      } catch (err) {
        deps.logger.warn({ err: String(err) }, "detail page rendered without its series");
      }

      return reply.type("text/html; charset=utf-8")
        .send(render("szamok", inputs, detailBody(spec, series, range.key, plot(series, spec))));
    },
  );

  app.get("/elemzes", async (_request, reply) => {
    const inputs = await shellInputs(deps, deps.clock.now());
    return reply.type("text/html; charset=utf-8")
      .send(render("elemzes", inputs, analysesBody(inputs.analyses)));
  });

  app.get("/kerdes", async (_request, reply) => {
    const inputs = await shellInputs(deps, deps.clock.now());

    // Its own try/catch, like every other piece of every page: a failing
    // conversation repo must render the empty thread, never take the page
    // down — the one thing worse than an empty "Kérdés" page is a 500 one.
    let history: Turn[] = [];
    try {
      history = deps.conversations.recent(WEB_CHAT_ID, 20);
    } catch (err) {
      deps.logger.warn({ err: String(err) }, "page rendered without its conversation thread");
    }

    // `nav.kerdes` is exactly `chat.available()`, already computed with its
    // own try/catch — reused here instead of asking a second time.
    return reply.type("text/html; charset=utf-8")
      .send(render("kerdes", inputs, askBody({ history, chatAvailable: inputs.nav.kerdes })));
  });

  app.post("/api/chat", async (request, reply) => {
    const parsed = body.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "bad_request", detail: "a `question` mező kötelező" });
    }

    try {
      // The page waits on this request, so the deadline lives here rather than
      // in the browser: a hung call must free the connection, not hold it open
      // until the client gives up with nothing to show.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 90_000);
      try {
        const answer = await deps.chat.ask(WEB_CHAT_ID, parsed.data.question, controller.signal);
        return reply.send({ answer });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      // Named, not swallowed: a question that silently produced nothing looks
      // exactly like a question nobody asked.
      deps.logger.warn({ err: String(err) }, "chat question failed");
      return reply.code(502).send({ error: "chat_failed", detail: String(err) });
    }
  });
}
