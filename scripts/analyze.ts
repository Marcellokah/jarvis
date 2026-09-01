/**
 * The deep analysis.
 *
 *   npm run analyze
 *
 * Four Groq calls a minute apart, so it takes about three minutes. That is the
 * price of giving each domain the whole token budget instead of a quarter of it.
 *
 * The numbers are computed here, in code, and printed whatever happens to the
 * model. If Groq is unreachable the statistics still land -- they are the
 * durable product, and the prose is commentary on them.
 */
import { createApp } from "../src/app.ts";
import { config } from "../config/config.ts";
import { aggregate } from "../src/core/analysis/aggregate.ts";
import { relations } from "../src/core/analysis/relations.ts";
import { runAnalysis } from "../src/core/analysis/analyst.ts";
import { GROQ_KEY_VAR } from "../src/infra/groq.ts";
import { isoDate, TZ } from "../src/shared/dates.ts";
import { agentFix, holdersOf } from "../src/infra/db/holder.ts";
import { fromRoot } from "../src/shared/paths.ts";
import { loadEnv } from "../src/env.ts";

process.env.LOG_LEVEL ??= "error";

// One env read, threaded into createApp below, the way the import does it.
// Reading it twice would let the path this warning names drift from the file
// the app actually opens, and a warning about the wrong file is worse than
// none.
const env = loadEnv();

// Same holder as the import, but a warning rather than a refusal: a lost
// analysis write costs three minutes to redo, not seven years of history, so
// there is nothing here worth stopping the run over.
const dbPath = fromRoot(env.JARVIS_DB);
const holders = holdersOf(dbPath);
if (holders.length > 0) {
  console.error(
    `⚠ Az adatbázist másik folyamat tartja nyitva (pid ${holders.join(", ")}) — `
    + "valószínűleg a launchd agent (local.jarvis.agent / src/main.ts fut). Az elemzés "
    + "írása emiatt elveszhet. Ha ez történik, állítsd le, futtasd újra, indítsd újra:\n\n"
    + agentFix("npm run analyze"),
  );
}

const app = createApp({ env });
const now = app.clock.now();
const today = isoDate(now, TZ);

const input = {
  today,
  snapshots: app.health.between("1970-01-01", today),
  workouts: app.workouts.between("1970-01-01", today),
  months: app.subscriptionMonths.months().map((month) => ({
    month, subs: app.subscriptionMonths.forMonth(month),
  })),
};

console.log(
  `Adat: ${input.snapshots.length} nap · ${input.workouts.length} edzés · `
  + `${input.months.length} hónap előfizetés`,
);

const metrics = aggregate(input);
const rels = relations(input, config.analysis.minCorrelationN);

console.log();
console.log("## Számok");
console.log(JSON.stringify(metrics, null, 2));
console.log();
console.log(rels.length === 0
  ? `Összefüggés: egyik pár sem érte el a ${config.analysis.minCorrelationN} napos küszöböt.`
  : rels.map((r) => `${r.label}: r = ${r.r.toFixed(2)} (n = ${r.n}, ${r.window})`).join("\n"));

console.log();
console.log(`Elemzés indul — ${config.analysis.paceMs / 1000} másodperc szünet a hívások között.`);

const run = await runAnalysis(metrics, rels, {
  fetcher: app.runner.http,
  model: config.analysis.model,
  maxTokens: config.analysis.maxTokens,
  temperature: config.analysis.temperature,
  timeoutMs: config.analysis.timeoutMs,
  paceMs: config.analysis.paceMs,
  memoryDepth: config.analysis.memoryDepth,
  apiKey: () => app.runner.secrets.get(GROQ_KEY_VAR),
  analyses: app.analyses,
  logger: app.logger,
  clock: app.clock,
}, new AbortController().signal);

for (const outcome of run.outcomes) {
  console.log();
  if (outcome.markdown) {
    console.log(outcome.markdown);
  } else {
    // Naming the gap is the point: a silently missing domain reads exactly
    // like a domain with nothing to say.
    console.log(`⚠ A(z) ${outcome.domain} terület kimaradt: ${outcome.error}`);
  }
}

app.close();
