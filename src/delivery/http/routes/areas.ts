import type { FastifyInstance } from "fastify";
import { addDays, isoDate, TZ } from "../../../shared/dates.ts";
import { buildSeries } from "../view/chart/series.ts";
import { SOROZATOK, valuesFrom } from "../view/chart/registry.ts";
import { sparkline } from "../view/chart/sparkline.ts";
import { hu, huFt } from "../view/format.ts";
import type { SeriesTile, AreaAnalysis } from "../view/area/frame.ts";
import { hubBody, type HubCard } from "../view/area/hub.ts";
import { loadBody } from "../view/area/load.ts";
import { recoveryBody } from "../view/area/recovery.ts";
import { nutritionBody } from "../view/area/nutrition.ts";
import { financeBody } from "../view/area/finance.ts";
import { OLDAL_MERET, parseOldal, worklogBody } from "../view/area/worklog.ts";
import { render, shellInputs, type PageDeps } from "./page-shell.ts";
import type { Metrics } from "../../../core/analysis/aggregate.ts";
import type { AnalysisRow } from "../../../infra/db/repositories/analyses.ts";
import type { HealthSnapshot } from "../../../infra/db/repositories/health.ts";

/** How many recorded months an annual projection needs — mirrors aggregate.ts. */
const MIN_MONTHS_TO_ANNUALISE = 6;

/** The longest window any area tile draws. */
const TILE_DAYS = 365;

/**
 * The analysis for one domain, in the shape the area bands want.
 *
 * `latestPerDomain()` mixes vintages by design, so each area gets its own
 * domain's newest row rather than "the last run's output".
 */
function analysisFor(rows: readonly AnalysisRow[], domain: string): AreaAnalysis | undefined {
  const hit = rows.find((a) => a.domain === domain);
  return hit === undefined ? undefined : { markdown: hit.markdown, createdAt: hit.createdAt };
}

export function registerAreaRoutes(app: FastifyInstance, deps: PageDeps): void {
  /**
   * The sparklines for a set of columns, over one shared history read.
   *
   * Its own try/catch, like every other input this app assembles: a failing
   * health query must dim the tiles, never take the page — let alone the
   * numbers next to it — down with it.
   */
  const tilesFor = (
    columns: readonly string[], now: Date,
  ): SeriesTile[] => {
    const out: SeriesTile[] = [];
    try {
      const to = isoDate(now, TZ);
      const from = isoDate(addDays(now, -TILE_DAYS + 1), TZ);
      const snaps: HealthSnapshot[] = deps.health.between(from, to);
      for (const column of columns) {
        const spec = SOROZATOK.get(column);
        if (spec === undefined) continue;
        const series = buildSeries(column, from, to, valuesFrom(snaps, column));
        out.push({ column, label: spec.label, days: TILE_DAYS, chart: sparkline(series, spec) });
      }
    } catch (err) {
      deps.logger.warn({ err: String(err) }, "area page rendered without its tiles");
    }
    return out;
  };

  /** The aggregate, or nothing — never a thrown page. */
  const metricsOf = (): Metrics | null => {
    try {
      return deps.metrics();
    } catch (err) {
      deps.logger.warn({ err: String(err) }, "area page rendered without its metrics");
      return null;
    }
  };

  app.get("/terulet", async (_request, reply) => {
    const now = deps.clock.now();
    const inputs = await shellInputs(deps, now);
    const m = metricsOf();

    let measuredDays = 0;
    try {
      const today = isoDate(now, TZ);
      measuredDays = deps.health.between("1970-01-01", today)
        .filter((s) => typeof s.dietKcal === "number").length;
    } catch (err) {
      deps.logger.warn({ err: String(err) }, "hub rendered without its nutrition count");
    }

    const summaryOf = (domain: string): { note: string; date: string | null } => {
      const hit = inputs.analyses.find((a) => a.domain === domain);
      return hit === undefined
        ? { note: "Még nem futott mélyelemzés.", date: null }
        : { note: hit.summary, date: hit.createdAt.slice(0, 10) };
    };

    const physical = summaryOf("physical");
    const recovery = summaryOf("recovery");
    const finance = summaryOf("finance");
    const latestMonth = m?.finance.months.at(-1);

    const cards: HubCard[] = [
      {
        href: "/terulet/terheles", title: "Terhelés",
        figure: m?.physical.loadRatio == null ? null : `${hu(m.physical.loadRatio, 2)}×`,
        note: physical.note, noteDate: physical.date,
      },
      {
        href: "/terulet/regeneracio", title: "Regeneráció",
        figure: m?.recovery.hrvDeviation == null
          ? null
          : `${m.recovery.hrvDeviation.sigma > 0 ? "+" : ""}${hu(m.recovery.hrvDeviation.sigma, 2)} σ`,
        note: recovery.note, noteDate: recovery.date,
      },
      {
        // No `nutrition` analysis domain exists yet (S8 will add one), so this
        // card carries a measured line of its own rather than an empty slot.
        href: "/terulet/taplalkozas", title: "Táplálkozás",
        figure: measuredDays === 0 ? null : `${hu(measuredDays)} nap`,
        note: "Rögzített bevitel.", noteDate: null,
      },
      {
        href: "/terulet/penzugy", title: "Pénzügy",
        figure: latestMonth === undefined ? null : huFt(latestMonth.totalHuf),
        note: finance.note, noteDate: finance.date,
      },
    ];

    return reply.type("text/html; charset=utf-8").send(render("terulet", inputs, hubBody({
      synthesis: analysisFor(inputs.analyses, "synthesis"),
      cards,
    }), "/terulet"));
  });

  app.get("/terulet/terheles", async (_request, reply) => {
    const now = deps.clock.now();
    const inputs = await shellInputs(deps, now);
    const m = metricsOf();

    let byType: ReturnType<typeof deps.workouts.byType> = [];
    try {
      byType = deps.workouts.byType();
    } catch (err) {
      deps.logger.warn({ err: String(err) }, "load page rendered without its type table");
    }

    let recent: ReturnType<typeof deps.workouts.page>["rows"] = [];
    try {
      recent = deps.workouts.page(0, 20).rows;
    } catch (err) {
      deps.logger.warn({ err: String(err) }, "load page rendered without its recent workouts");
    }

    return reply.type("text/html; charset=utf-8").send(render("terulet", inputs, loadBody({
      loadRatio: m?.physical.loadRatio ?? null,
      strengthPerWeek28d: m?.physical.strengthPerWeek28d ?? null,
      byMonth: m?.physical.byMonth ?? [],
      byType,
      recent,
      tiles: tilesFor(["steps", "distance_km", "move_kcal", "exercise_min"], now),
      analysis: analysisFor(inputs.analyses, "physical"),
    }), "/terulet/terheles"));
  });

  app.get<{ Querystring: { oldal?: string } }>(
    "/terulet/terheles/naplo", async (request, reply) => {
      const now = deps.clock.now();
      const inputs = await shellInputs(deps, now);

      // Two independent reads, each with its own try/catch: `total` backs the
      // pager's "1 / 3 · 120 edzés" claim, and `rows` backs the table under
      // it. Sharing one try/catch let a throwing row read leave `total` at
      // its real count while `rows` stayed `[]` — an empty table under a
      // pager still confidently claiming 120 workouts, exactly the missing
      // data that does not look missing this page's empty-state branch
      // exists to avoid. A failed row read also resets `total` to 0, so
      // `worklogBody` takes its own empty-state branch instead of pairing an
      // empty table with a count it cannot back.
      let total = 0;
      try {
        total = deps.workouts.page(0, 1).total;
      } catch (err) {
        deps.logger.warn({ err: String(err) }, "worklog rendered without its count");
      }

      let rows: ReturnType<typeof deps.workouts.page>["rows"] = [];
      let oldal = 1;
      try {
        oldal = parseOldal(request.query.oldal, total);
        rows = deps.workouts.page((oldal - 1) * OLDAL_MERET, OLDAL_MERET).rows;
      } catch (err) {
        deps.logger.warn({ err: String(err) }, "worklog rendered without its rows");
        total = 0;
      }

      return reply.type("text/html; charset=utf-8")
        .send(render("terulet", inputs, worklogBody(rows, oldal, total), "/terulet/terheles/naplo"));
    },
  );

  app.get("/terulet/regeneracio", async (_request, reply) => {
    const now = deps.clock.now();
    const inputs = await shellInputs(deps, now);
    const m = metricsOf();
    const EMPTY = { value: null, n: 0, coverage: 0, window: "365d" };

    return reply.type("text/html; charset=utf-8").send(render("terulet", inputs, recoveryBody({
      deviation: m?.recovery.hrvDeviation ?? null,
      sleepByYear: m?.recovery.sleepByYear ?? [],
      stages: m?.recovery.stages ?? { core: EMPTY, rem: EMPTY, deep: EMPTY },
      awakenings: m?.recovery.awakenings ?? EMPTY,
      tiles: tilesFor(["hrv", "rhr", "hr_recovery", "sleep_h"], now),
      analysis: analysisFor(inputs.analyses, "recovery"),
    }), "/terulet/regeneracio"));
  });

  app.get("/terulet/taplalkozas", async (_request, reply) => {
    const now = deps.clock.now();
    const inputs = await shellInputs(deps, now);

    // The one figure on the five pages that does NOT come from aggregate():
    // `Metrics` has no nutrition branch yet, so the days are counted from the
    // same snapshot read main.ts performs for the aggregate anyway.
    let measuredDays = 0;
    let measuredProteinDays = 0;
    let lastDate: string | null = null;
    let kcal: number | null = null;
    let proteinG: number | null = null;
    try {
      const today = isoDate(now, TZ);
      const rows = deps.health.between("1970-01-01", today)
        .filter((s) => typeof s.dietKcal === "number");
      measuredDays = rows.length;
      // `between` returns rows in ascending date order (verified in the
      // repository), so the last element is the most recently measured day.
      lastDate = rows.at(-1)?.date ?? null;
      if (rows.length > 0) {
        kcal = Math.round(rows.reduce((a, s) => a + (s.dietKcal ?? 0), 0) / rows.length);
        const withProtein = rows.filter((s) => typeof s.dietProteinG === "number");
        measuredProteinDays = withProtein.length;
        proteinG = withProtein.length === 0
          ? null
          : Math.round(withProtein.reduce((a, s) => a + (s.dietProteinG ?? 0), 0) / withProtein.length);
      }
    } catch (err) {
      deps.logger.warn({ err: String(err) }, "nutrition page rendered without its intake");
    }

    let plan: ReturnType<typeof deps.meals.forWeekday> = [];
    try {
      // Seven reads of three rows each. `MealRepo` has no "all" method and
      // does not need one: 21 rows is cheaper than a new query and its test.
      plan = [0, 1, 2, 3, 4, 5, 6].flatMap((w) => deps.meals.forWeekday(w));
    } catch (err) {
      deps.logger.warn({ err: String(err) }, "nutrition page rendered without its plan");
    }

    return reply.type("text/html; charset=utf-8").send(render("terulet", inputs, nutritionBody({
      measuredDays, measuredProteinDays, lastDate, actual: { kcal, proteinG }, plan,
      tiles: tilesFor(["diet_kcal", "diet_protein_g"], now),
    }), "/terulet/taplalkozas"));
  });

  app.get("/terulet/penzugy", async (_request, reply) => {
    const now = deps.clock.now();
    const inputs = await shellInputs(deps, now);
    const m = metricsOf();

    let subscriptions: ReturnType<typeof deps.subscriptions.listAll> = [];
    try {
      subscriptions = deps.subscriptions.listAll();
    } catch (err) {
      deps.logger.warn({ err: String(err) }, "finance page rendered without its subscriptions");
    }

    return reply.type("text/html; charset=utf-8").send(render("terulet", inputs, financeBody({
      months: m?.finance.months ?? [],
      monthOverMonth: m?.finance.monthOverMonth ?? null,
      annualisedHuf: m?.finance.annualisedHuf ?? null,
      minMonths: MIN_MONTHS_TO_ANNUALISE,
      subscriptions,
      today: isoDate(now, TZ),
      analysis: analysisFor(inputs.analyses, "finance"),
    }), "/terulet/penzugy"));
  });
}
