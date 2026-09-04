/**
 * Runs one investigation and prints the whole transcript.
 *
 *   npm run investigate -- "Miért alacsonyabb ma a regenerációm?"
 *
 * Prints every step, not just the finding: a fluent wrong conclusion is
 * invisible in the finding alone, and reading the steps back is the only way
 * to tell inference from invention.
 *
 * THIS COSTS MONEY — the one metered path in the system.
 */
import { config } from "../config/config.ts";
import { createApp } from "../src/app.ts";
import { investigate } from "../src/core/agent/loop.ts";
import { anthropicInvestigator, ANTHROPIC_KEY_VAR } from "../src/infra/anthropic.ts";
import { createInvestigationRepo } from "../src/infra/db/repositories/investigations.ts";
import { createHealthRepo } from "../src/infra/db/repositories/health.ts";
import { createWorkoutRepo } from "../src/infra/db/repositories/workouts.ts";
import { isoDate } from "../src/shared/dates.ts";

process.env.LOG_LEVEL ??= "info";
const app = createApp();

const goal = process.argv.slice(2).join(" ").trim();
if (!goal) {
  console.error("Adj meg egy célt:  npm run investigate -- \"Miért alacsonyabb ma a regenerációm?\"");
  app.close();
  process.exit(1);
}

const apiKey = await app.runner.secrets.get(ANTHROPIC_KEY_VAR);
if (!apiKey) {
  console.error(`Nincs ${ANTHROPIC_KEY_VAR}. Tárold: ./scripts/set-secret.sh ${ANTHROPIC_KEY_VAR}`);
  app.close();
  process.exit(1);
}

const startedAt = new Date();
const today = isoDate(startedAt);
// Exactly one investigator per run: its cost ceiling lives in a closure
// scoped to this instance, so a second instance would give the ceiling its
// own separate budget instead of sharing the one config.agent.maxUsdPerRun.
const model = anthropicInvestigator({
  apiKey, today, logger: app.runner.logger,
  model: config.agent.model, maxUsd: config.agent.maxUsdPerRun,
});

const result = await investigate({
  goal, model,
  ctx: {
    health: createHealthRepo(app.db),
    workouts: createWorkoutRepo(app.db),
    calendar: app.runner.calendar,
    today,
  },
  logger: app.runner.logger,
  signal: AbortSignal.timeout(10 * 60_000),
});

console.log(`\nCél: ${goal}\n${"═".repeat(72)}`);
result.transcript.forEach((entry, i) => {
  console.log(`${i + 1}. ${entry.step.name}(${JSON.stringify(entry.step.args)})`);
  if (entry.step.why) console.log(`   — ${entry.step.why}`);
  console.log(entry.observation.split("\n").map((l) => `   ${l}`).join("\n"));
});

console.log("═".repeat(72));
switch (result.outcome.kind) {
  case "kesz":
    console.log(`\nMEGÁLLAPÍTÁS: ${result.outcome.finding}`);
    console.log(`támaszkodik: ${result.outcome.cites.join(", ")} · cáfolat: ${result.outcome.falsifiedBy}. lépés`);
    break;
  case "kerdezz":
    console.log(`\nKÉRDÉS HOZZÁD: ${result.outcome.question}`);
    break;
  case "kifutott":
    console.log(`\nKifutott a ${config.agent.maxSteps} lépésből, megállapítás nélkül.`);
    break;
  case "hiba":
    console.log(`\nA nyomozás nem futott le: ${result.outcome.reason}`);
    break;
}
console.log(`\n[${model.spentUsd()} USD]`);

// Recorded on every outcome, "hiba" included: a failed run that leaves no row
// is a run nobody can learn from, and the cost was still spent either way.
createInvestigationRepo(app.db).record({
  startedAt, goal, outcome: result.outcome.kind,
  finding: result.outcome.kind === "kesz" ? result.outcome.finding
    : result.outcome.kind === "kerdezz" ? result.outcome.question : null,
  transcript: result.transcript,
  usd: model.spentUsd(),
});

app.close();
