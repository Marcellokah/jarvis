import type { Logger } from "../../infra/logger.ts";
import type { TranscriptEntry } from "../../infra/db/repositories/investigations.ts";
import { runQuestion, type QuestionContext } from "./questions.ts";

export interface Step {
  name: string;
  args: Record<string, unknown>;
  /** The model's own reason for this step. Kept for the transcript, never acted on. */
  why: string;
}

export interface InvestigatorModel {
  nextStep(goal: string, transcript: readonly TranscriptEntry[], signal: AbortSignal): Promise<Step>;
}

export type Outcome =
  | { kind: "kesz"; finding: string; cites: number[]; falsifiedBy: number }
  | { kind: "kerdezz"; question: string }
  | { kind: "kifutott" }
  | { kind: "hiba"; reason: string };

export interface InvestigationResult {
  goal: string;
  transcript: TranscriptEntry[];
  outcome: Outcome;
}

/**
 * Ten, not eight.
 *
 * During the measurement a 9B model ran out at eight while still making
 * progress -- it was pulling one day at a time. `napok(tol, ig)` removes most
 * of that waste, and two more rounds cover the hypothesis and falsification
 * steps the gate now requires.
 */
export const MAX_STEPS = 10;

/** Steps that end the investigation rather than producing an observation. */
const TERMINAL = new Set(["kesz", "kerdezz"]);

export async function investigate(opts: {
  goal: string;
  model: InvestigatorModel;
  ctx: QuestionContext;
  logger: Logger;
  signal: AbortSignal;
}): Promise<InvestigationResult> {
  const transcript: TranscriptEntry[] = [];

  for (let i = 0; i < MAX_STEPS; i++) {
    let step: Step;
    try {
      step = await opts.model.nextStep(opts.goal, transcript, opts.signal);
    } catch (err) {
      // No template fallback here, deliberately: the brief degrades to plain
      // text because its content comes from the modules, but here the
      // inference IS the product. A missing finding beats a false one.
      const reason = err instanceof Error ? err.message : String(err);
      opts.logger.warn({ reason }, "investigation model failed");
      return { goal: opts.goal, transcript, outcome: { kind: "hiba", reason } };
    }

    if (TERMINAL.has(step.name)) {
      return { goal: opts.goal, transcript, outcome: terminalOutcome(step) };
    }

    const observation = await runQuestion(step.name, step.args, opts.ctx);
    transcript.push({ step, observation });
    opts.logger.debug({ step: step.name, args: step.args }, "investigation step");
  }

  opts.logger.info({ steps: transcript.length }, "investigation ran out of steps");
  return { goal: opts.goal, transcript, outcome: { kind: "kifutott" } };
}

function terminalOutcome(step: Step): Outcome {
  if (step.name === "kerdezz") {
    return { kind: "kerdezz", question: String(step.args.szoveg ?? "") };
  }
  const falsifiedBy = Number(step.args.cafolat ?? 0);
  return {
    kind: "kesz",
    finding: String(step.args.megallapitas ?? ""),
    // A citation that didn't parse to a number is worse than a missing one --
    // drop it rather than let a NaN ride into the stored transcript.
    cites: Array.isArray(step.args.tamaszkodik)
      ? step.args.tamaszkodik.map(Number).filter((n) => Number.isInteger(n))
      : [],
    // 0 is already outside the valid 1..n step range, so a malformed `cafolat`
    // (e.g. "kettő") reads downstream exactly as "no falsification step was
    // named" -- true, and it keeps the field a plain number, unlike NaN or null.
    falsifiedBy: Number.isInteger(falsifiedBy) ? falsifiedBy : 0,
  };
}
