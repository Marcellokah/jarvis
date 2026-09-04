import { config } from "../config/config.ts";
import { loadEnv, type Env } from "./env.ts";
import { ALL_MODULES } from "./modules/index.ts";
import { assertUniqueNames } from "./core/registry.ts";
import { createBriefService, type BriefService } from "./core/brief-service.ts";
import { templateSynthesizer } from "./core/synthesis/template.ts";
import { apiSynthesizer } from "./core/synthesis/api.ts";
import { groqSynthesizer } from "./core/synthesis/groq.ts";
import type { Synthesizer } from "./core/synthesis/synthesizer.ts";
import type { RunnerDeps } from "./core/runner.ts";
import { openDb, type Db } from "./infra/db/index.ts";
import { createSeenStore } from "./infra/db/repositories/seen.ts";
import { createActionRepo } from "./infra/db/repositories/actions.ts";
import { createCalendarWriteRepo } from "./infra/db/repositories/calendar-writes.ts";
import { createProposalService, type ProposalService } from "./core/proposals.ts";
import { groqChat, type ChatService } from "./core/chat.ts";
import { GROQ_KEY_VAR } from "./infra/groq.ts";
import { createSubscriptionRepo, type SubscriptionRepo } from "./infra/db/repositories/subscriptions.ts";
import { createSubscriptionMonthRepo, type SubscriptionMonthRepo } from "./infra/db/repositories/subscription-months.ts";
import { recordSubscriptionMonth } from "./core/subscription-snapshot.ts";
import { createBriefRepo } from "./infra/db/repositories/briefs.ts";
import { createHealthRepo, type HealthRepo } from "./infra/db/repositories/health.ts";
import { createWorkoutRepo, type WorkoutRepo } from "./infra/db/repositories/workouts.ts";
import { createMealRepo, type MealRepo } from "./infra/db/repositories/meals.ts";
import { createAnalysisRepo, type AnalysisRepo } from "./infra/db/repositories/analyses.ts";
import { createConversationRepo, type ConversationRepo } from "./infra/db/repositories/conversations.ts";
import { createNotificationRepo, type NotificationRepo } from "./infra/db/repositories/notifications.ts";
import { buildAskContext } from "./core/ask/context.ts";
import { createFetcher } from "./infra/http-client.ts";
import { createLogger, type Logger } from "./infra/logger.ts";
import { keychainSecrets, type SecretResolver } from "./infra/secrets.ts";
import { caldavCalendar, ICLOUD_CALDAV_URL } from "./infra/calendar/caldav.ts";
import { CalendarNotConfiguredError, type CalendarService } from "./infra/calendar/service.ts";
import { systemClock, type Clock } from "./infra/clock.ts";
import { TZ } from "./shared/dates.ts";
import { fromRoot } from "./shared/paths.ts";

export interface App {
  env: Env;
  db: Db;
  logger: Logger;
  clock: Clock;
  briefs: BriefService;
  /** The live chain, already wired with credentials. Never rebuild this. */
  synthesizers: readonly Synthesizer[];
  proposals: ProposalService;
  chat: ChatService;
  actions: ReturnType<typeof createActionRepo>;
  subscriptions: SubscriptionRepo;
  subscriptionMonths: SubscriptionMonthRepo;
  health: HealthRepo;
  workouts: WorkoutRepo;
  meals: MealRepo;
  analyses: AnalysisRepo;
  conversations: ConversationRepo;
  notifications: NotificationRepo;
  runner: RunnerDeps;
  modules: readonly typeof ALL_MODULES[number][];
  close(): void;
}

/**
 * The composition root. Every dependency is constructed here exactly once and
 * passed down; nothing below this file reaches for a global.
 */
export function createApp(overrides: { env?: Env; clock?: Clock } = {}): App {
  const env = overrides.env ?? loadEnv();
  const clock = overrides.clock ?? systemClock;
  const logger = createLogger(env.LOG_LEVEL, env.LOG_PRETTY);

  assertUniqueNames(ALL_MODULES);

  const db = openDb(fromRoot(env.JARVIS_DB), logger);
  const secrets = keychainSecrets("jarvis");

  const runner: RunnerDeps = {
    db,
    http: createFetcher({ logger }),
    calendar: buildCalendar(secrets, clock, logger),
    secrets,
    logger,
    seen: createSeenStore(db),
    tz: TZ,
  };

  const synthesizers = buildSynthesisChain(env, logger, secrets);
  const health = createHealthRepo(db);
  const workouts = createWorkoutRepo(db);
  const meals = createMealRepo(db);
  const actions = createActionRepo(db);
  const subscriptionMonths = createSubscriptionMonthRepo(db);
  const analyses = createAnalysisRepo(db);
  const conversations = createConversationRepo(db);
  const notifications = createNotificationRepo(db);

  const proposals = createProposalService({
    actions,
    writes: createCalendarWriteRepo(db),
    calendar: runner.calendar,
    logger,
  });

  const briefs = createBriefService({
    modules: ALL_MODULES,
    synthesizers,
    runner,
    briefs: createBriefRepo(db),
    actions,
    health,
    logger,
    tz: TZ,
    freshnessMinutes: config.brief.freshnessMinutes,
    maxWaitSeconds: config.brief.maxWaitSeconds,
  });

  // Same provider that writes the brief. Nothing routine should touch the
  // work account.
  const chat = groqChat({
    fetcher: runner.http,
    model: config.groq.chatModel,
    systemPromptFile: fromRoot("jarvis.md"),
    maxTokens: config.groq.chatMaxTokens,
    temperature: config.groq.temperature,
    timeoutMs: config.groq.timeoutMs,
    logger,
    apiKey: () => secrets.get(GROQ_KEY_VAR),
    clock,
    conversations,
    context: (chatId, signal) => buildAskContext({
      health, workouts, meals,
      subscriptionMonths,
      analyses, conversations, briefs, clock, logger,
      historyDepth: config.groq.chatHistoryDepth,
    }, chatId, signal),
  });

  return {
    env, db, logger, clock, briefs, synthesizers, proposals, chat, health, workouts, meals, runner,
    actions,
    subscriptions: createSubscriptionRepo(db),
    subscriptionMonths,
    analyses,
    conversations,
    notifications,
    modules: ALL_MODULES,
    close: () => db.close(),
  };
}

// Re-exported so main.ts's existing `import { recordSubscriptionMonth } from
// "./app.ts"` keeps working; the implementation lives in core/subscription-snapshot.ts
// so infra/scheduler.ts can call the same code without depending on this
// composition root.
export { recordSubscriptionMonth };

/**
 * Without credentials the calendar reads as empty and refuses to write, rather
 * than silently swallowing an accepted proposal.
 */
function buildCalendar(secrets: SecretResolver, clock: Clock, logger: Logger): CalendarService {
  return caldavCalendar({
    serverUrl: ICLOUD_CALDAV_URL,
    credentials: async () => {
      const username = await secrets.get("ICLOUD_USERNAME");
      const password = await secrets.get("ICLOUD_APP_PASSWORD");
      if (!username || !password) {
        throw new CalendarNotConfiguredError(
          "nincs beállítva ICLOUD_USERNAME / ICLOUD_APP_PASSWORD "
          + "(app-specific password az appleid.apple.com-ról; env vagy Kulcskarika)",
        );
      }
      return { username, password };
    },
    writeCalendar: config.calendar.writeCalendar,
    readCalendars: [...config.calendar.readCalendars],
    logger,
    now: () => clock.now(),
  });
}

/**
 * `template` must always be last: it is the only synthesizer that cannot fail,
 * and dropping it would make the brief conditional on a network.
 */
export function buildSynthesisChain(
  env: Env, logger: Logger, secrets?: SecretResolver,
): Synthesizer[] {
  const requested = (env.SYNTHESIS_CHAIN ?? config.synthesis.chain.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const chain: Synthesizer[] = [];
  for (const name of requested) {
    switch (name) {
      case "groq":
        chain.push(groqSynthesizer({
          fetcher: createFetcher({ logger }),
          model: config.groq.model,
          systemPromptFile: fromRoot("jarvis.md"),
          maxTokens: config.groq.maxTokens,
          temperature: config.groq.temperature,
          timeoutMs: config.groq.timeoutMs,
          logger,
          apiKey: async () => secrets?.get(GROQ_KEY_VAR),
        }));
        break;
      case "api":
        // Deliberately opt-in: this is the only path that costs money.
        logger.warn({}, "PAID synthesizer enabled — briefs will be billed to ANTHROPIC_API_KEY");
        chain.push(apiSynthesizer({ systemPromptFile: fromRoot("jarvis.md"), logger }));
        break;
      case "template":
        chain.push(templateSynthesizer());
        break;
      default:
        logger.warn({ synthesizer: name }, "unknown synthesizer in chain, skipping");
    }
  }

  if (!chain.some((s) => s.name === "template")) chain.push(templateSynthesizer());
  return chain;
}
