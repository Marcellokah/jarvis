/**
 * Verifies every credential path and external dependency without printing a
 * single secret. Run after a machine change, a password rotation, or any
 * "why isn't the brief arriving?" question.
 *
 *   npm run smoke
 */
import { config } from "../config/config.ts";
import { createApp } from "../src/app.ts";
import { requireApiToken, API_TOKEN_VAR } from "../src/env.ts";
import { GROQ_KEY_VAR } from "../src/infra/groq.ts";
import { createMealRepo } from "../src/infra/db/repositories/meals.ts";
import { buildModuleContext } from "../src/core/runner.ts";

interface Check { name: string; ok: boolean; detail: string }
const checks: Check[] = [];
const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

process.env.LOG_LEVEL ??= "error";
const app = createApp();

try {
  // --- Cost guard -----------------------------------------------------------
  // The whole system is designed to run at $0. A paid synthesizer must only
  // ever be present because someone deliberately opted in.
  const chain = (app.env.SYNTHESIS_CHAIN ?? config.synthesis.chain.join(",")).split(",").map((s) => s.trim());
  const paid = chain.filter((s) => s === "api");
  // Two different questions that used to be one check. The daily brief must
  // never cost money — that stays a hard rule. Which provider serves it is a
  // reporting matter.
  add(
    "cost: brief never metered",
    paid.length === 0,
    paid.length === 0
      ? `a lánc végig ingyenes: ${chain.join(" → ")}`
      : `FIZETŐS SZINTETIZÁLÓ A LÁNCBAN: ${paid.join(", ")}`,
  );
  add(
    "cost: ANTHROPIC_API_KEY unset",
    !process.env.ANTHROPIC_API_KEY,
    process.env.ANTHROPIC_API_KEY ? "beállítva — mért hívás lehetséges" : "unset",
  );

  // --- Local prerequisites --------------------------------------------------
  // Where it comes from matters as much as whether it exists: an entry left in
  // .env keeps working, so the move to the Keychain has to be visible here.
  const fromEnv = process.env[API_TOKEN_VAR] !== undefined;
  try {
    const token = await requireApiToken(app.runner.secrets);
    add(
      `config: ${API_TOKEN_VAR}`,
      !fromEnv,
      fromEnv
        ? `${token.length} characters, but from the environment — move it: ./scripts/set-secret.sh ${API_TOKEN_VAR}`
        : `${token.length} characters, from the Keychain`,
    );
  } catch (err) {
    add(`config: ${API_TOKEN_VAR}`, false, err instanceof Error ? err.message.split("\n")[0]! : String(err));
  }
  const groqKey = await app.runner.secrets.get(GROQ_KEY_VAR);
  add(
    `config: ${GROQ_KEY_VAR}`,
    Boolean(groqKey),
    groqKey
      ? `${groqKey.length} karakter — a szintézis és a chat a Groq ingyenes tierjén megy`
      : `hiányzik — a brief a template renderelővel készül. Tárold: ./scripts/set-secret.sh ${GROQ_KEY_VAR}`,
  );
  add("db: reachable", true, app.env.JARVIS_DB);

  const meals = createMealRepo(app.db).count();
  add("db: meal_plan seeded", meals > 0, meals > 0 ? `${meals} meals` : "empty — run: npm run seed");

  // --- Synthesis ------------------------------------------------------------
  // Never fatal: `template` always works, so a logged-out CLI degrades the
  // prose rather than the delivery. Reported so the degradation is visible
  // instead of mysterious.
  // The app's own chain, not a rebuilt one: rebuilding it here without the
  // secret resolver is exactly what made a stored token look absent.
  // Remediation is provider-specific — `claude setup-token` only helps the
  // claude-code path, and telling a Groq user to run it just wastes their time.
  const remedy: Record<string, string> = {
    "claude-code": "run `claude setup-token`",
    groq: `store the key: ./scripts/set-secret.sh ${GROQ_KEY_VAR}`,
    api: "set ANTHROPIC_API_KEY (deliberately, this path costs money)",
  };
  for (const synth of app.synthesizers) {
    const ok = await synth.available();
    add(
      `synthesis: ${synth.name}`,
      true,
      synth.name === "template"
        ? "always available (the guarantee)"
        : ok
          ? "available — briefs will use it"
          : `unavailable — ${remedy[synth.name] ?? "check its configuration"}, then re-run smoke. Falling back to template.`,
    );
  }

  // --- Modules --------------------------------------------------------------
  for (const module of app.modules) {
    if (!module.enabled) { add(`module: ${module.name}`, true, "disabled in config.ts"); continue; }
    if (!module.healthCheck) { add(`module: ${module.name}`, true, "enabled (no health check)"); continue; }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const health = await module.healthCheck(
        buildModuleContext(app.runner, module.name, app.clock.now(), controller.signal),
      );
      add(`module: ${module.name}`, health.ok, health.detail ?? "");
    } catch (err) {
      add(`module: ${module.name}`, false, String(err));
    } finally {
      clearTimeout(timer);
    }
  }
} finally {
  app.close();
}

const width = Math.max(...checks.map((c) => c.name.length));
for (const c of checks) {
  console.log(`${c.ok ? "✓" : "✗"} ${c.name.padEnd(width)}  ${c.detail}`);
}

const failed = checks.filter((c) => !c.ok);
console.log(failed.length === 0
  ? `\n${checks.length} rendben.`
  : `\n${failed.length} hiba: ${failed.map((f) => f.name).join(", ")}`);
process.exit(failed.length === 0 ? 0 : 1);
