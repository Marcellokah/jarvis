import { openDb, type Db } from "../src/infra/db/index.ts";
import { silentLogger, type Logger } from "../src/infra/logger.ts";
import { nullSeenStore } from "../src/infra/db/repositories/seen.ts";
import { staticSecrets } from "../src/infra/secrets.ts";
import { fixtureFetcher } from "../src/infra/http-client.ts";
import { createMealRepo, type MealRepo, type PlannedMeal } from "../src/infra/db/repositories/meals.ts";
import { createModuleCache } from "../src/infra/db/repositories/cache.ts";
import type { ModuleContext } from "../src/core/module.ts";
import { TZ } from "../src/shared/dates.ts";
import { unavailableCalendar, type CalendarService } from "../src/infra/calendar/service.ts";

export function memoryDb(): Db {
  return openDb(":memory:", silentLogger());
}

export interface LogEntry { level: string; obj: Record<string, unknown>; msg?: string }

/** Keeps what was logged, so "this leaves a trace" can be asserted. */
export function recordingLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const at = (level: string) => (obj: unknown, msg?: string) =>
    { entries.push({ level, obj: (obj ?? {}) as Record<string, unknown>, msg }); };
  const self = {
    entries,
    debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error"),
    child: () => self,
  };
  return self as Logger & { entries: LogEntry[] };
}

export function ctxAt(
  iso: string,
  db: Db,
  routes: Record<string, unknown> = {},
  calendar: CalendarService = unavailableCalendar("test"),
): ModuleContext {
  return {
    now: new Date(iso),
    tz: TZ,
    db,
    http: fixtureFetcher(routes),
    calendar,
    secrets: staticSecrets({}),
    logger: silentLogger(),
    signal: new AbortController().signal,
    seen: nullSeenStore(),
    cache: createModuleCache(db, "test", () => new Date(iso), silentLogger()),
  };
}

export function meal(p: Partial<PlannedMeal> & Pick<PlannedMeal, "weekday" | "meal" | "item">): PlannedMeal {
  return {
    needsDefrost: false, defrostLeadH: 0, proteinG: null, kcal: null, ...p,
  };
}

export function seedMeals(db: Db, meals: PlannedMeal[]): void {
  createMealRepo(db).replaceAll(meals);
}

// ---------------------------------------------------------------------------
// Full-stack test harness: real BriefService and Fastify, in-memory database.
// ---------------------------------------------------------------------------

import { createBriefService, type BriefService } from "../src/core/brief-service.ts";
import { templateSynthesizer } from "../src/core/synthesis/template.ts";
import type { Synthesizer } from "../src/core/synthesis/synthesizer.ts";
import type { RunnerDeps } from "../src/core/runner.ts";
import { createActionRepo, type ActionRepo } from "../src/infra/db/repositories/actions.ts";
import { createCalendarWriteRepo } from "../src/infra/db/repositories/calendar-writes.ts";
import { createProposalService, type ProposalService } from "../src/core/proposals.ts";
import { createBriefRepo } from "../src/infra/db/repositories/briefs.ts";
import { createHealthRepo, type HealthRepo } from "../src/infra/db/repositories/health.ts";
import { createWorkoutRepo, type WorkoutRepo } from "../src/infra/db/repositories/workouts.ts";
import { createSubscriptionMonthRepo } from "../src/infra/db/repositories/subscription-months.ts";
import { createSubscriptionRepo, type SubscriptionRepo } from "../src/infra/db/repositories/subscriptions.ts";
import { createAnalysisRepo, type AnalysisRepo } from "../src/infra/db/repositories/analyses.ts";
import { createConversationRepo, type ConversationRepo } from "../src/infra/db/repositories/conversations.ts";
import { unavailableChat, type ChatService } from "../src/core/chat.ts";
import { aggregate } from "../src/core/analysis/aggregate.ts";
import { isoDate } from "../src/shared/dates.ts";
import { buildServer } from "../src/delivery/http/server.ts";
import type { JarvisModule } from "../src/core/module.ts";
import type { FastifyInstance } from "fastify";

export interface TestApp {
  db: Db;
  briefs: BriefService;
  proposals: ProposalService;
  chat: ChatService;
  health: HealthRepo;
  analyses: AnalysisRepo;
  conversations: ConversationRepo;
  workouts: WorkoutRepo;
  meals: MealRepo;
  subscriptions: SubscriptionRepo;
  actions: ActionRepo;
  server: FastifyInstance;
  runner: RunnerDeps;
  modules: readonly JarvisModule[];
  setNow(iso: string): void;
  close(): Promise<void>;
}

export const TEST_TOKEN = "test-token-0123456789abcdef";

export async function buildTestApp(options: {
  modules: readonly JarvisModule[];
  synthesizers?: readonly Synthesizer[];
  calendar?: CalendarService;
  /** Defaults to an always-unavailable stub — no test in this suite needs a live model. */
  chat?: ChatService;
  now: string;
  freshnessMinutes?: number;
  maxWaitSeconds?: number;
  logger?: Logger;
}): Promise<TestApp> {
  const db = memoryDb();
  let current = new Date(options.now);
  const clock = { now: () => new Date(current) };

  const runner: RunnerDeps = {
    db,
    http: fixtureFetcher({}),
    calendar: options.calendar ?? unavailableCalendar("test"),
    secrets: staticSecrets({}),
    logger: silentLogger(),
    seen: nullSeenStore(),
    tz: TZ,
  };

  const actions = createActionRepo(db);
  const proposals = createProposalService({
    actions,
    writes: createCalendarWriteRepo(db),
    calendar: runner.calendar,
    logger: silentLogger(),
  });

  const health = createHealthRepo(db);
  const briefs = createBriefService({
    modules: options.modules,
    synthesizers: options.synthesizers ?? [templateSynthesizer()],
    runner,
    briefs: createBriefRepo(db),
    actions,
    health,
    logger: silentLogger(),
    tz: TZ,
    freshnessMinutes: options.freshnessMinutes ?? 90,
    maxWaitSeconds: options.maxWaitSeconds ?? 5,
  });
  const analyses = createAnalysisRepo(db);
  const conversations = createConversationRepo(db);
  const workouts = createWorkoutRepo(db);
  const subscriptionMonths = createSubscriptionMonthRepo(db);
  const chat = options.chat ?? unavailableChat("teszt: nincs modell bekötve");

  const meals = createMealRepo(db);
  const subscriptions = createSubscriptionRepo(db);

  // Same construction the real ask-context assembler and main.ts use: the
  // page's numbers table is always the freshest `aggregate()` over an
  // in-memory (here, empty-unless-seeded) database.
  const metrics = () => {
    const today = isoDate(clock.now());
    return aggregate({
      today,
      snapshots: health.between("1970-01-01", today),
      workouts: workouts.between("1970-01-01", today),
      months: subscriptionMonths.months().map((month) => ({
        month, subs: subscriptionMonths.forMonth(month),
      })),
    });
  };

  const server = await buildServer({
    token: TEST_TOKEN, briefs, proposals, chat, health, analyses, conversations,
    workouts, meals, subscriptions, metrics, modules: options.modules,
    runner, clock, logger: options.logger ?? silentLogger(),
  });

  let closed = false;
  return {
    db, briefs, proposals, chat, health, analyses, conversations,
    workouts, meals, subscriptions, actions, server, runner,
    modules: options.modules,
    setNow: (iso) => { current = new Date(iso); },
    // Idempotent: tests close explicitly and afterEach closes again.
    close: async () => {
      if (closed) return;
      closed = true;
      await server.close();
      db.close();
    },
  };
}

/** A module built inline for a test, with sensible defaults. */
export function stubModule(p: Partial<JarvisModule> & Pick<JarvisModule, "name">): JarvisModule {
  return {
    title: `## ${p.name}`,
    enabled: true,
    execute: async () => ({ data: {}, actions: [], priority: "normal" as const }),
    renderPlain: () => `${p.name} body`,
    ...p,
  };
}
