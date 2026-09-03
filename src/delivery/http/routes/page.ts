import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { MAX_QUESTION_CHARS } from "../../../core/chat.ts";
import type { Turn } from "../../../infra/db/repositories/conversations.ts";
import { addDays, isoDate, TZ } from "../../../shared/dates.ts";
import { todayBody } from "../view/today.ts";
import type { ActionRow, ActionsData } from "../view/actions.ts";
import { metricsRowsFrom, numbersBody, type MetricRow } from "../view/numbers.ts";
import { askBody } from "../view/ask.ts";
import { buildSeries } from "../view/chart/series.ts";
import { SOROZATOK, valuesFrom } from "../view/chart/registry.ts";
import { sparkline } from "../view/chart/sparkline.ts";
import { plot } from "../view/chart/plot.ts";
import { detailBody, parseRange } from "../view/chart/detail.ts";
import { render, shellInputs, type PageDeps } from "./page-shell.ts";

export type { PageDeps } from "./page-shell.ts";

/** The web page is one thread; Telegram chats are their own. */
export const WEB_CHAT_ID = "web";

const body = z.object({ question: z.string().trim().min(1).max(MAX_QUESTION_CHARS) });

export function registerPageRoutes(app: FastifyInstance, deps: PageDeps): void {
  app.get<{ Querystring: { hiba?: string } }>("/", async (request, reply) => {
    const now = deps.clock.now();
    const inputs = await shellInputs(deps, now);

    // A module's own title, or its raw name when the module is gone. Inventing
    // a nicer label for a module that no longer exists would be a lie about
    // where the action came from.
    const cim = (name: string) =>
      deps.modules.find((m) => m.name === name)?.title ?? name;

    // Its own try/catch, like every other input this page assembles: a
    // failing action repo must drop the todo band, never the briefing.
    let napok: ActionsData["napok"] = [];
    try {
      const byDate = new Map<string, ActionRow[]>();
      for (const a of deps.actions.listAllOpen()) {
        const items = byDate.get(a.date) ?? [];
        items.push({
          id: a.id,
          kind: a.kind,
          text: a.text,
          modul: cim(a.module),
          reszletek: a.proposal === null ? [] : [
            a.proposal.start,
            ...(a.proposal.location ? [a.proposal.location] : []),
            ...(a.proposal.notes ? [a.proposal.notes] : []),
          ],
        });
        byDate.set(a.date, items);
      }
      napok = [...byDate.entries()].map(([date, items]) => ({ date, items }));
    } catch (err) {
      deps.logger.warn({ err: String(err) }, "page rendered without its actions");
    }

    // Separately guarded: a failing calendar-write repo must not take the
    // todo band with it.
    let undoable: ActionsData["undoable"] = [];
    try {
      undoable = deps.proposals.listUndoable(20);
    } catch (err) {
      deps.logger.warn({ err: String(err) }, "page rendered without its undoable writes");
    }

    return reply.type("text/html; charset=utf-8").send(render("ma", inputs, todayBody({
      briefMarkdown: inputs.briefMarkdown,
      readings: inputs.readings,
      lastSeen: inputs.lastSeen,
      writtenAge: inputs.writtenAge,
      hibaKod: request.query.hiba,
      actions: { napok, undoable },
    })));
  });

  app.get("/szamok", async (_request, reply) => {
    const now = deps.clock.now();
    const inputs = await shellInputs(deps, now);

    // The aggregate the rows are built from touches every table the app has;
    // a corrupt row or a bad query must dim the numbers, not the page.
    let metricsRows: MetricRow[] = [];
    try {
      metricsRows = metricsRowsFrom(deps.metrics());
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
      let from = isoDate(addDays(now, -range.days + 1), TZ);

      let series = buildSeries(spec.column, from, to, []);
      try {
        // A window may reach back further than the history itself does —
        // `mind` asks for 4000 days and the record begins in 2019 — and every
        // coverage figure on the page is then divided by ~1300 days this
        // system could not have measured: a 99.9%-complete step series
        // announced "68% lefedettség", the confidently wrong number this whole
        // project exists to prevent. The record's first day is the earliest
        // honest denominator. Only a window that STARTS before it is clamped:
        // a hole inside the record is a real hole and must keep counting
        // against coverage.
        const first = deps.health.firstDate();
        if (first !== null && first > from && first <= to) from = first;
        series = buildSeries(spec.column, from, to, valuesFrom(deps.health.between(from, to), spec.column));
      } catch (err) {
        deps.logger.warn({ err: String(err) }, "detail page rendered without its series");
      }

      return reply.type("text/html; charset=utf-8")
        .send(render("szamok", inputs, detailBody(spec, series, range, plot(series, spec))));
    },
  );

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
