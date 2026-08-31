/**
 * Runs today's real brief through several models and prints them side by side.
 *
 * The model choice is a measurement, not a guess: what matters is whether the
 * output holds the contract in jarvis.md — one `#` heading, `## ` titles taken
 * verbatim from the modules, `- [ ] ` todos — because the renderer splits on
 * exactly that.
 *
 *   npm run eval-models                       # what models are available
 *   npm run eval-models -- llama-3.3-70b-versatile openai/gpt-oss-120b
 */
import { createApp } from "../src/app.ts";
import { createBriefService } from "../src/core/brief-service.ts";
import { createBriefRepo } from "../src/infra/db/repositories/briefs.ts";
import { createActionRepo } from "../src/infra/db/repositories/actions.ts";
import { createHealthRepo } from "../src/infra/db/repositories/health.ts";
import { nullSeenStore } from "../src/infra/db/repositories/seen.ts";
import { openDb } from "../src/infra/db/index.ts";
import { silentLogger } from "../src/infra/logger.ts";
import { groqSynthesizer } from "../src/core/synthesis/groq.ts";
import { GROQ_MODELS_URL, GROQ_KEY_VAR } from "../src/infra/groq.ts";
import type { Synthesizer, BriefContext } from "../src/core/synthesis/synthesizer.ts";
import { config } from "../config/config.ts";
import { TZ } from "../src/shared/dates.ts";
import { fromRoot } from "../src/shared/paths.ts";

process.env.LOG_LEVEL ??= "error";
const app = createApp();
const models = process.argv.slice(2);

const apiKey = await app.runner.secrets.get(GROQ_KEY_VAR);
if (!apiKey) {
  console.error(`Nincs ${GROQ_KEY_VAR}. Tárold: ./scripts/set-secret.sh ${GROQ_KEY_VAR}`);
  app.close();
  process.exit(1);
}

if (models.length === 0) {
  const list = await app.runner.http.json<{ data?: { id: string; context_window?: number }[] }>(
    GROQ_MODELS_URL, { headers: { authorization: `Bearer ${apiKey}` } },
  );
  console.log("Elérhető modellek:\n");
  for (const m of (list.data ?? []).sort((a, b) => a.id.localeCompare(b.id))) {
    console.log(`  ${m.id}${m.context_window ? `  (${m.context_window} token)` : ""}`);
  }
  console.log("\nÖsszehasonlítás:  npm run eval-models -- <modell> <modell>");
  app.close();
  process.exit(0);
}

// A scratch database for the brief and action rows this run produces, and a
// null seen-store: an evaluation must not consume today's dedupe budget or
// leave rows behind in the real one.
const scratch = openDb(":memory:", silentLogger());

let captured: BriefContext | undefined;
const capture: Synthesizer = {
  name: "capture",
  available: async () => true,
  synthesize: async (ctx) => { captured = ctx; return "# captured\n\n## x\n\ny"; },
};

const briefs = createBriefService({
  modules: app.modules,
  synthesizers: [capture],
  runner: { ...app.runner, seen: nullSeenStore() },
  briefs: createBriefRepo(scratch),
  actions: createActionRepo(scratch),
  health: createHealthRepo(scratch),
  logger: silentLogger(),
  tz: TZ,
  freshnessMinutes: 0,
  maxWaitSeconds: 60,
});

await briefs.generate(app.clock.now());
if (!captured) throw new Error("no context captured");

const signal = new AbortController().signal;

for (const [index, model] of models.entries()) {
  const synth = groqSynthesizer({
    fetcher: app.runner.http,
    model,
    systemPromptFile: fromRoot("jarvis.md"),
    maxTokens: config.groq.maxTokens,
    temperature: config.groq.temperature,
    timeoutMs: config.groq.timeoutMs,
    logger: silentLogger(),
    apiKey: async () => apiKey,
  });

  console.log(`\n${"═".repeat(64)}\n  ${model}\n${"═".repeat(64)}\n`);
  const started = Date.now();
  try {
    const markdown = await synth.synthesize(captured, signal);
    console.log(markdown);
    console.log(`\n— ${Date.now() - started} ms · ${markdown.length} karakter`);
  } catch (err) {
    console.log(`✗ ${err instanceof Error ? err.message : String(err)}`);
    console.log(`— ${Date.now() - started} ms`);
  }

  // The free tier is 6,000 tokens a minute and each run spends most of it.
  // Compared by index, not value — the same model id can appear twice (e.g.
  // to check repeatability), and a value comparison would skip the pause and
  // hit a 429 on the second run.
  if (index !== models.length - 1) {
    console.log("\n  …60 másodperc szünet a token/perc limit miatt\n");
    await new Promise((r) => setTimeout(r, 60_000));
  }
}

scratch.close();
app.close();
