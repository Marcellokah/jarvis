import type { TranscriptEntry } from "../../infra/db/repositories/investigations.ts";
import type { Step } from "./loop.ts";
import { MENU_TEXT } from "./questions.ts";

/**
 * Instructions in English, finding in Hungarian.
 *
 * Measured, not assumed: in the local-model evaluation the two candidates
 * held English instructions reliably while their Hungarian prose quality
 * differed sharply. The split survives here because the finding has to reach
 * a Hungarian reader either way, and the instructions are the part that must
 * not be misread.
 *
 * Byte-stable for a given day so the whole thing caches: it goes in the
 * `system` block behind a `cache_control` breakpoint, and the volatile
 * transcript goes in the user turn after it.
 */
export function buildSystemPrompt(today: string): string {
  return `You are investigating one person's health history. You cannot see the data
directly — you must ask for it, one question at a time, from this menu:

${MENU_TEXT}

Dates are YYYY-MM-DD. Today is ${today}.

Rules:
- Reply with ONE step as JSON: {"lepes": ..., "parameterek": {...}, "miert": "..."}
- Look before you conclude. A finding that rests on no observation is worthless.
- Every single-day measurement arrives labelled with its distance from this
  person's own baseline, e.g. "hrv=203,6 (+9,7σ, minden idők maximuma)". The
  averages from "ritmus" are the one exception: they are bucket means, not
  single readings, so they carry a sample count instead. A value marked as
  many sigma from baseline is NOT ordinary — never describe it as normal.
- If a metric might simply not be measured, or might have started being
  measured differently, check "lefedettseg" before theorising. A change of
  instrument looks exactly like a change of body.
- When the data cannot answer the goal, use "kerdezz" — do not guess.
- Before "kesz" you MUST state your hypothesis with "hipotezis", and then run
  a step that would DISPROVE it if it were false. "kesz" is rejected without
  that, and the rejection tells you what is missing.
- "megallapitas" must be written in Hungarian, for the person themselves.
- "tamaszkodik" lists the step numbers the finding rests on; "cafolat" is the
  single step number that tested it.`;
}

/** The volatile half: the goal and everything observed so far, numbered from 1. */
export function buildUserTurn(goal: string, transcript: readonly TranscriptEntry[]): string {
  if (transcript.length === 0) {
    return `Goal: ${goal}\n\nPick your first step.`;
  }
  const steps = transcript.map((entry, i) =>
    `${i + 1}. ${entry.step.name}(${JSON.stringify(entry.step.args)}) — ${entry.step.why}\n`
    + entry.observation.split("\n").map((l) => `   ${l}`).join("\n"),
  ).join("\n");
  return `Goal: ${goal}\n\nSteps so far:\n${steps}\n\nNext step.`;
}

interface RawStep { lepes?: string; parameterek?: Record<string, unknown>; miert?: string }

export function parseStep(raw: string): Step {
  let parsed: RawStep;
  try {
    parsed = JSON.parse(raw) as RawStep;
  } catch {
    throw new Error(`a modell válasza nem értelmezhető JSON-ként: ${raw.slice(0, 200)}`);
  }
  if (!parsed.lepes) throw new Error("a modell válasza nem értelmezhető: hiányzik a \"lepes\" mező");
  return { name: parsed.lepes, args: parsed.parameterek ?? {}, why: parsed.miert ?? "" };
}
