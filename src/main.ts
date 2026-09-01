import { createApp, recordSubscriptionMonth } from "./app.ts";
import { requireApiToken } from "./env.ts";
import { buildServer } from "./delivery/http/server.ts";
import { buildBot } from "./delivery/telegram/bot.ts";
import { acquireInstanceLock } from "./infra/instance-lock.ts";
import { startScheduler } from "./infra/scheduler.ts";
import { config } from "../config/config.ts";

const app = createApp();

// Exit 0, not a throw: launchd's KeepAlive/SuccessfulExit=false would restart a
// non-zero exit forever, and no number of restarts conjures a missing secret.
// Same reasoning as the duplicate-instance and port-in-use paths below.
const apiToken = await requireApiToken(app.runner.secrets).catch((err: unknown) => {
  app.logger.error(
    { err: err instanceof Error ? err.message : String(err) },
    "refusing to start without the API bearer token",
  );
  app.close();
  process.exit(0);
});

const server = await buildServer({
  token: apiToken,
  briefs: app.briefs,
  proposals: app.proposals,
  health: app.health,
  modules: app.modules,
  runner: app.runner,
  clock: app.clock,
  logger: app.logger,
});

// Long polling from two processes makes Telegram return 409 and both start
// dropping messages. The lock is also what makes a second start-up exit
// cleanly: it cannot bind the port either, and under launchd's KeepAlive an
// unhandled EADDRINUSE turns into a restart loop.
const lock = acquireInstanceLock(app.db, app.logger, app.clock.now());

if (!lock) {
  app.logger.error(
    {},
    "another Jarvis instance is already running — exiting. "
    + "Stop it first: launchctl bootout gui/$(id -u)/local.jarvis.agent",
  );
  app.close();
  // Exit 0 deliberately: the launchd agent uses KeepAlive/SuccessfulExit=false,
  // so a non-zero exit here would be restarted forever against a port that is
  // never going to be free.
  process.exit(0);
}

// `shutdown` is a hoisted function declaration, so TypeScript will not carry
// the null-narrowing above into it. Bind the checked value instead.
const heldLock = lock;

const telegramToken = await app.runner.secrets.get("TELEGRAM_BOT_TOKEN");
const allowedChatId = await app.runner.secrets.get("TELEGRAM_ALLOWED_CHAT_ID");
const bot = telegramToken
  ? buildBot({
      token: telegramToken,
      allowedChatId,
      briefs: app.briefs,
      proposals: app.proposals,
      actions: app.actions,
      subscriptions: app.subscriptions,
      modules: app.modules,
      runner: app.runner,
      chat: app.chat,
      clock: app.clock,
      logger: app.logger,
    })
  : null;

if (!telegramToken) {
  app.logger.warn({}, "TELEGRAM_BOT_TOKEN not set — the bot is inactive; the HTTP API still works");
}

const scheduler = startScheduler({
  db: app.db,
  clock: app.clock,
  logger: app.logger,
  seenRetentionDays: config.schedule.seenRetentionDays,
  conversationRetentionDays: config.schedule.conversationRetentionDays,
});

let shuttingDown = false;

const SHUTDOWN_GRACE_MS = 8_000;

/**
 * Bounded on purpose. `bot.stop()` waits for the in-flight long poll, which on
 * a partitioned network can outlast launchd's patience — and a SIGKILL leaves
 * the instance lock held for its full staleness window, delaying the restart
 * that was supposed to fix things.
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.logger.info({ signal }, "shutting down");

  const graceful = (async () => {
    scheduler.stop();
    await bot?.stop().catch(() => {});
    await server.close();
  })();

  const timedOut = await Promise.race([
    graceful.then(() => false),
    new Promise<boolean>((r) => setTimeout(() => r(true), SHUTDOWN_GRACE_MS).unref()),
  ]);

  if (timedOut) {
    app.logger.warn({ graceMs: SHUTDOWN_GRACE_MS }, "graceful shutdown timed out — exiting anyway");
  }

  // Released even on timeout: a held lock would block the next start-up for
  // longer than the shutdown we just gave up on.
  heldLock.release();
  app.close();
}

/**
 * Exit 143 (128 + SIGTERM), not 0.
 *
 * The launchd agent uses KeepAlive/SuccessfulExit=false, so a clean exit means
 * "stay down". That is right for the duplicate-instance and port-in-use paths,
 * which exit 0 deliberately — restarting them could never succeed. But a
 * SIGTERM'd service should come back, or one stray signal silently costs you
 * every future morning brief.
 *
 * To actually stop it: `launchctl bootout gui/$(id -u)/local.jarvis.agent`,
 * which unloads the job regardless of exit code.
 */
const onSignal = (signal: string, code: number) => () => {
  void shutdown(signal).then(() => process.exit(code));
};

process.on("SIGINT", onSignal("SIGINT", 130));
process.on("SIGTERM", onSignal("SIGTERM", 143));

// Recorded at start-up and again in the nightly sweep. This is the leg that
// can be relied on: croner does not replay a 04:00 run missed while the Mac
// was asleep, so the guarantee is "whenever the agent restarts", not "at least
// once a night". Guarded like every other start-up step here: a transient DB
// error must not become an unhandled exception that exits non-zero before the
// server ever binds — under launchd's KeepAlive/SuccessfulExit=false that turns
// one bad snapshot into a restart loop. A missed snapshot is a gap the next
// start-up or nightly sweep can still fill; a crash loop takes the whole
// assistant down.
try {
  recordSubscriptionMonth(app);
} catch (err) {
  app.logger.warn({ err: err instanceof Error ? err.message : String(err) }, "start-up subscription snapshot failed");
}

try {
  await server.listen({ host: app.env.JARVIS_HOST, port: app.env.JARVIS_PORT });
} catch (err) {
  // A raw EADDRINUSE stack trace in a log file explains nothing on its own.
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "EADDRINUSE") {
    app.logger.error(
      { port: app.env.JARVIS_PORT },
      `port ${app.env.JARVIS_PORT} is already in use — another Jarvis is running, `
      + "or something else holds the port. Exiting without restarting.",
    );
    heldLock.release();
    app.close();
    process.exit(0);
  }
  throw err;
}

app.logger.info(
  {
    address: `http://${app.env.JARVIS_HOST}:${app.env.JARVIS_PORT}`,
    modules: app.modules.filter((m) => m.enabled).map((m) => m.name),
    telegram: bot ? "polling" : "off",
  },
  "jarvis listening",
);

// Not awaited: polling runs for the process lifetime. It still needs a catch —
// `bot.stop()` aborts grammY's retry backoff, which rejects this promise, and
// an unhandled rejection would take the HTTP server down with it.
if (bot) {
  bot
    .start({
      onStart: (me) => app.logger.info({ username: me.username }, "telegram bot polling"),
    })
    .catch((err: unknown) => {
      if (shuttingDown) return; // expected: stop() aborted an in-flight delay

      app.logger.error(
        { err: String(err) },
        "telegram polling stopped unexpectedly — restarting the process",
      );
      // Exit non-zero so launchd's KeepAlive restarts us. launchd throttles
      // respawns to ~10s, so a persistent fault backs off rather than spins.
      // The HTTP brief keeps working in the meantime either way.
      void shutdown("telegram-failure").then(() => process.exit(1));
    });
}
