/**
 * Measures whether a local model can drive the investigation loop.
 *
 * The design question this answers is narrow and specific: given a goal, the
 * steps taken so far, and a closed menu of questions, can a 7-12B model
 * running on this Mac pick a sensible next question — repeatedly, in valid
 * JSON, without wandering?
 *
 * It is a measurement, not the feature. The question implementations here are
 * the smallest thing that exercises real data; the real ones get their own
 * module and tests. What matters is the transcript each model produces, which
 * is printed in full so the choices can be read rather than trusted.
 *
 *   npm run eval-agent                       # every pulled model, every task
 *   npm run eval-agent -- qwen3:8b           # one model
 *   npm run eval-agent -- qwen3:8b --task=3  # one model, one task
 *
 * Read-only against the real database: it opens the history, never writes.
 */
import { openDb } from "../src/infra/db/index.ts";
import { createHealthRepo, type HealthSnapshot } from "../src/infra/db/repositories/health.ts";
import { createWorkoutRepo } from "../src/infra/db/repositories/workouts.ts";
import { silentLogger } from "../src/infra/logger.ts";
import { mean, stdDev, shiftDay } from "../src/core/analysis/stats.ts";
import { fromRoot } from "../src/shared/paths.ts";

const OLLAMA = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const MAX_STEPS = 8;

/** Metrics the menu can talk about, mapped to their snapshot field. */
const METRICS = {
  alvas: "sleepH", hrv: "hrv", nyugalmi_pulzus: "rhr", lepes: "steps",
  edzesperc: "exerciseMin", melyalvas: "deepMin", rem: "remMin", ebredes: "awakenings",
} as const;
type MetricName = keyof typeof METRICS;

const db = openDb(fromRoot("data/jarvis.db"), silentLogger());
const health = createHealthRepo(db);
const workouts = createWorkoutRepo(db);

const TODAY = "2026-09-04";
const series = (metric: MetricName, from: string, to: string) =>
  health.between(from, to)
    .map((s) => ({ date: s.date, value: s[METRICS[metric]] as number | null }))
    .filter((p): p is { date: string; value: number } => p.value !== null);

// ---------------------------------------------------------------- the menu

interface Step { name: string; args: Record<string, unknown> }

const MENU = `
elteresek(mutato, ablak_nap)      which days in the window sit far from the mean (z-score)
nap(datum)                        one day in full: sleep, HRV, RHR, steps, workouts
hasonlo_napok(datum, mutato, k)   the k days whose value is closest to that day's
mi_lett_utana(datum, napok)       what the following days looked like
ritmus(mutato, bontas)            mean per weekday ("hetnap") or per month ("honap")
edzesek(tol, ig)                  workouts in a date range
lefedettseg(mutato)               how many measurements exist, and from when
kerdezz(szoveg)                   ask the owner a question — ends the investigation
kesz(megallapitas, tamaszkodik)   state the finding — ends the investigation

mutato is one of: ${Object.keys(METRICS).join(", ")}
Dates are YYYY-MM-DD. Today is ${TODAY}.
`.trim();

function runStep(step: Step): string {
  const a = step.args;
  const m = a.mutato as MetricName;
  switch (step.name) {
    case "elteresek": {
      const win = Number(a.ablak_nap ?? 90);
      const pts = series(m, shiftDay(TODAY, -win), TODAY);
      if (pts.length < 3) return `only ${pts.length} measurements — not enough`;
      const avg = mean(pts.map((p) => p.value))!;
      const sd = stdDev(pts.map((p) => p.value))!;
      if (sd === 0) return "every value identical, no deviation";
      const out = pts
        .map((p) => ({ ...p, z: (p.value - avg) / sd }))
        .filter((p) => Math.abs(p.z) >= 1.5)
        .sort((x, y) => Math.abs(y.z) - Math.abs(x.z))
        .slice(0, 12);
      return `mean ${avg.toFixed(1)}, sd ${sd.toFixed(1)}, n=${pts.length}\n`
        + (out.length ? out.map((p) => `  ${p.date}  ${p.value}  z=${p.z >= 0 ? "+" : ""}${p.z.toFixed(2)}`).join("\n")
                      : "  no day beyond 1.5 sd");
    }
    case "nap": {
      const d = String(a.datum);
      const s = health.forDate(d);
      if (!s) return `${d}: no row at all`;
      const w = workouts.forDate(d);
      const bits = (Object.keys(METRICS) as MetricName[])
        .map((k) => [k, s[METRICS[k]] as number | null] as const)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => `${k}=${v}`);
      return `${d}: ${bits.length ? bits.join(" ") : "row exists but every field empty"}\n`
        + `  workouts: ${w.length ? w.map((x) => `${x.type} ${x.durationMin}min`).join(", ") : "none"}`;
    }
    case "hasonlo_napok": {
      const d = String(a.datum);
      const k = Number(a.k ?? 5);
      const base = health.forDate(d)?.[METRICS[m]] as number | null | undefined;
      if (base === null || base === undefined) return `${d} has no ${m} value to match against`;
      const pts = series(m, "2019-01-01", TODAY).filter((p) => p.date !== d);
      return pts
        .map((p) => ({ ...p, gap: Math.abs(p.value - base) }))
        .sort((x, y) => x.gap - y.gap)
        .slice(0, k)
        .map((p) => `  ${p.date}  ${m}=${p.value}`)
        .join("\n") || "no comparable days";
    }
    case "mi_lett_utana": {
      const d = String(a.datum);
      const n = Math.min(Number(a.napok ?? 3), 7);
      const rows: string[] = [];
      for (let i = 1; i <= n; i++) {
        const day = shiftDay(d, i);
        const s = health.forDate(day);
        const w = workouts.forDate(day);
        rows.push(s
          ? `  ${day}  alvas=${s.sleepH ?? "-"} hrv=${s.hrv?.toFixed(1) ?? "-"} lepes=${s.steps ?? "-"} edzes=${w.length}`
          : `  ${day}  no data`);
      }
      return rows.join("\n");
    }
    case "ritmus": {
      const by = String(a.bontas ?? "hetnap");
      const pts = series(m, shiftDay(TODAY, -365), TODAY);
      const buckets = new Map<string, number[]>();
      const names = ["vasárnap", "hétfő", "kedd", "szerda", "csütörtök", "péntek", "szombat"];
      for (const p of pts) {
        const key = by === "honap" ? p.date.slice(0, 7) : names[new Date(`${p.date}T12:00:00Z`).getUTCDay()]!;
        (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(p.value);
      }
      return [...buckets].map(([k, v]) => `  ${k}: ${mean(v)!.toFixed(1)} (n=${v.length})`).join("\n")
        || "no data in the last 365 days";
    }
    case "edzesek": {
      const rows = workouts.between(String(a.tol), String(a.ig));
      return rows.length
        ? rows.slice(0, 25).map((w) => `  ${w.date}  ${w.type}  ${w.durationMin}min`).join("\n")
        : "no workouts in that range";
    }
    case "lefedettseg": {
      const all = series(m, "2019-01-01", TODAY);
      if (all.length === 0) return `${m}: never measured`;
      const last90 = all.filter((p) => p.date >= shiftDay(TODAY, -90));
      const byYear = new Map<string, number>();
      for (const p of all) byYear.set(p.date.slice(0, 4), (byYear.get(p.date.slice(0, 4)) ?? 0) + 1);

      // The gaps, not just the counts.
      //
      // Counts alone cannot show that a metric only started being measured
      // four days ago after a four-month silence — and that break is the whole
      // answer to "why is today's reading unlike every earlier one". Without
      // it the model is left to invent a physiological story, which is the
      // failure mode this measurement exists to catch. The longest recent gap
      // and the current unbroken run are the two numbers that reveal it.
      const dates = all.map((p) => p.date);
      let runStart = dates.at(-1)!;
      for (let i = dates.length - 1; i > 0; i--) {
        if (shiftDay(dates[i]!, -1) !== dates[i - 1]) break;
        runStart = dates[i - 1]!;
      }
      const beforeRun = dates.filter((d) => d < runStart).at(-1);

      return `${m}: ${all.length} measurements, ${all[0]!.date} → ${all.at(-1)!.date}\n`
        + `  last 90 days: ${last90.length} measurements\n`
        + `  per year: ${[...byYear].map(([y, n]) => `${y}=${n}`).join(" ")}\n`
        + `  current unbroken run starts ${runStart}`
        + (beforeRun
          ? `; the measurement before that run was ${beforeRun}`
          : "; nothing measured before that run");
    }
    default:
      return `unknown step "${step.name}" — pick one from the menu`;
  }
}

// ---------------------------------------------------------------- the loop

const SCHEMA = {
  type: "object",
  properties: {
    lepes: { type: "string", enum: [...Object.keys({
      elteresek: 0, nap: 0, hasonlo_napok: 0, mi_lett_utana: 0, ritmus: 0,
      edzesek: 0, lefedettseg: 0, kerdezz: 0, kesz: 0,
    })] },
    parameterek: { type: "object" },
    miert: { type: "string" },
  },
  required: ["lepes", "parameterek", "miert"],
} as const;

/**
 * Instructions in English, answer in Hungarian.
 *
 * Deliberate, and itself part of what is being measured: small models follow
 * English instructions more reliably than Hungarian ones, while the finding
 * has to reach a Hungarian reader. If a model can hold that split, the real
 * loop can use it too.
 */
const SYSTEM = `You are investigating one person's health history. You cannot see the data
directly — you must ask for it, one question at a time, from this menu:

${MENU}

Rules:
- Reply with ONE step as JSON: {"lepes": ..., "parameterek": {...}, "miert": "..."}
- Look before you conclude. A finding that rests on no observation is worthless.
- If a metric might simply not be measured, check "lefedettseg" before theorising.
- When the data cannot answer the goal, use "kerdezz" — do not guess.
- End with "kesz" only when you can name the steps your finding rests on:
  {"lepes":"kesz","parameterek":{"megallapitas":"<in Hungarian>","tamaszkodik":[2,4]},"miert":"..."}
- "megallapitas" must be written in Hungarian, for the person themselves.`;

interface TaskResult {
  task: string; model: string; steps: number; badJson: number; badStep: number;
  ms: number; ended: string; verdict: string; transcript: string[];
}

async function investigate(model: string, task: { id: number; goal: string }): Promise<TaskResult> {
  const messages: { role: string; content: string }[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: `Goal: ${task.goal}\n\nPick your first step.` },
  ];
  const transcript: string[] = [];
  let badJson = 0, badStep = 0, ended = "kifutott", verdict = "";
  const t0 = Date.now();

  for (let i = 1; i <= MAX_STEPS; i++) {
    const res = await fetch(`${OLLAMA}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model, messages, stream: false, format: SCHEMA,
        options: { temperature: 0.2, num_ctx: 8192 },
      }),
    });
    if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
    const body = await res.json() as { message?: { content?: string } };
    const raw = body.message?.content ?? "";

    let step: Step;
    try {
      const parsed = JSON.parse(raw) as { lepes: string; parameterek: Record<string, unknown>; miert?: string };
      step = { name: parsed.lepes, args: parsed.parameterek ?? {} };
      transcript.push(`${i}. ${step.name}(${JSON.stringify(step.args)})  — ${parsed.miert ?? ""}`);
    } catch {
      badJson++;
      transcript.push(`${i}. ⚠️  nem JSON: ${raw.slice(0, 120)}`);
      messages.push({ role: "assistant", content: raw },
                    { role: "user", content: "That was not valid JSON. Reply with one JSON step." });
      continue;
    }

    if (step.name === "kesz") {
      ended = "kesz";
      verdict = String(step.args.megallapitas ?? "(üres)");
      transcript.push(`   → ${verdict}`);
      transcript.push(`   → támaszkodik: ${JSON.stringify(step.args.tamaszkodik ?? [])}`);
      break;
    }
    if (step.name === "kerdezz") {
      ended = "kerdezz";
      verdict = String(step.args.szoveg ?? "(üres)");
      transcript.push(`   → KÉRDÉS: ${verdict}`);
      break;
    }

    const observation = runStep(step);
    if (observation.startsWith("unknown step")) badStep++;
    transcript.push(observation.split("\n").map((l) => `   ${l}`).join("\n"));
    messages.push({ role: "assistant", content: raw },
                  { role: "user", content: `Result of step ${i}:\n${observation}\n\nNext step.` });
  }

  return {
    task: `T${task.id}`, model, steps: transcript.filter((l) => /^\d+\./.test(l)).length,
    badJson, badStep, ms: Date.now() - t0, ended, verdict, transcript,
  };
}

// ---------------------------------------------------------------- the tasks

/**
 * Three real questions. T3 is the one that matters most: the answer is known.
 *
 * The watch only started being worn overnight around 2026-09-01, so the HRV
 * series switches from daytime spot readings to sleep-period ones on that
 * date. 203.6 ms is not a physiological event, it is a change of instrument —
 * and "lefedettseg(alvas)" is the step that reveals it. A model that instead
 * invents a recovery story has failed the task while sounding convincing,
 * which is exactly the failure mode this whole measurement exists to catch.
 */
const TASKS = [
  { id: 1, goal: "Sleep on 2026-09-04 was 6.6 hours. Is that unusual for this person, and does anything in the data explain it?" },
  { id: 2, goal: "Is there a recurring weekly pattern that hurts this person's sleep?" },
  { id: 3, goal: "HRV on 2026-09-04 was 203.6 ms. Every earlier reading in the whole history is below 158. What happened?" },
];

const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith("--task="))?.split("=")[1];
const wanted = args.filter((a) => !a.startsWith("--"));

const listed = await (await fetch(`${OLLAMA}/api/tags`)).json() as { models: { name: string }[] };
const models = wanted.length ? wanted : listed.models.map((m) => m.name);
if (models.length === 0) {
  console.error("Nincs letöltött modell. Előbb: ollama pull qwen3:8b");
  process.exit(1);
}

const tasks = only ? TASKS.filter((t) => String(t.id) === only) : TASKS;
const results: TaskResult[] = [];

for (const model of models) {
  for (const task of tasks) {
    process.stderr.write(`… ${model} / T${task.id}\n`);
    try {
      const r = await investigate(model, task);
      results.push(r);
      console.log(`\n${"═".repeat(72)}\n${model}  ·  T${task.id}\n${"═".repeat(72)}`);
      console.log(`Cél: ${task.goal}\n`);
      console.log(r.transcript.join("\n"));
      console.log(`\n[${(r.ms / 1000).toFixed(1)} mp · ${r.steps} lépés · ${r.badJson} rossz JSON · vége: ${r.ended}]`);
    } catch (err) {
      console.log(`\n${model} / T${task.id}: ✗ ${String(err)}`);
    }
  }
}

console.log(`\n${"═".repeat(72)}\nÖSSZEGZÉS\n${"═".repeat(72)}`);
console.log("modell".padEnd(20) + "feladat  lépés  rosszJSON  ismeretlen  idő      vége");
for (const r of results) {
  console.log(
    r.model.padEnd(20) + r.task.padEnd(9) + String(r.steps).padEnd(7)
    + String(r.badJson).padEnd(11) + String(r.badStep).padEnd(12)
    + `${(r.ms / 1000).toFixed(1)} mp`.padEnd(9) + r.ended,
  );
}
db.close();
