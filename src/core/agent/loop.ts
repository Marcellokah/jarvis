import type { Logger } from "../../infra/logger.ts";
import type { TranscriptEntry } from "../../infra/db/repositories/investigations.ts";
import { runQuestion, QUESTIONS, type QuestionContext } from "./questions.ts";

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

/**
 * The step that makes falsification checkable.
 *
 * A gate that only asked "name a step you cite" is not a gate: the model that
 * produced this plan's motivating failure cited five real steps and still
 * invented the causal link. Citations prove lookup, not inference.
 *
 * So the claim has to be on the record BEFORE the evidence that tests it. The
 * model states a hypothesis as its own step, and `kesz` is only accepted when
 * it names a falsification step that ran after that hypothesis -- a step
 * taken while the claim was already fixed, and therefore capable of killing
 * it.
 */
export const HYPOTHESIS_STEP = "hipotezis";

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

    if (step.name === HYPOTHESIS_STEP) {
      const claim = String(step.args.allitas ?? "");
      transcript.push({
        step,
        observation: `rögzített hipotézis: ${claim}\n`
          + "Most futtass egy lépést, ami ezt MEGDÖNTENÉ, ha hamis.",
      });
      continue;
    }

    if (step.name === "kerdezz") {
      return { goal: opts.goal, transcript, outcome: terminalOutcome(step) };
    }

    if (step.name === "kesz") {
      const refusal = gateFinding(step, transcript);
      if (refusal === null) {
        return { goal: opts.goal, transcript, outcome: terminalOutcome(step) };
      }
      // Rejected, not fatal: the observation goes back and the model can
      // do the work the gate is asking for.
      transcript.push({ step, observation: refusal });
      opts.logger.info({ refusal }, "finding rejected by the falsification gate");
      continue;
    }

    const { observation, evidence } = await runQuestion(step.name, step.args, opts.ctx);
    transcript.push({ step, observation, evidence });
    opts.logger.debug({ step: step.name, args: step.args, evidence }, "investigation step");
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

/**
 * Returns null when the finding may stand, or the refusal text to feed back.
 *
 * Indices in `cafolat` are 1-based, matching the step numbers the model sees
 * in its own transcript.
 */
function gateFinding(step: Step, transcript: readonly TranscriptEntry[]): string | null {
  // The LAST hipotezis, not the first: a model that abandons hypothesis A for
  // hypothesis B after a rejection must be checked against B. Pinning to the
  // first hypothesis would let evidence gathered for an abandoned claim keep
  // unlocking the gate for every claim made afterward.
  const hypothesisAt = transcript.findLastIndex((e) => e.step.name === HYPOTHESIS_STEP);
  if (hypothesisAt === -1) {
    return "a megállapítás elutasítva: előbb rögzítsd a hipotézisedet a "
      + "\"hipotezis\" lépéssel, majd futtass egy lépést, ami megdöntené.";
  }

  const falsifiedBy = Number(step.args.cafolat ?? 0);
  if (!Number.isInteger(falsifiedBy) || falsifiedBy < 1 || falsifiedBy > transcript.length) {
    return `a megállapítás elutasítva: a "cafolat" mezőben nevezd meg a cáfolatra `
      + `futtatott lépés sorszámát (1—${transcript.length}).`;
  }

  // 1-based in the model's view, 0-based here.
  if (falsifiedBy - 1 <= hypothesisAt) {
    return "a megállapítás elutasítva: a cáfolatnak a hipotézis UTÁN futtatott "
      + `lépésnek kell lennie (a hipotézis a ${hypothesisAt + 1}. lépés volt).`;
  }

  // An in-range index is not enough: every rejected step (a "kesz" that
  // failed this gate, a "hipotezis", an unknown/mistyped name) is ALSO
  // pushed onto the transcript with its own observation, which makes it a
  // nameable index. Without this check the gate is beatable in two turns --
  // state a hypothesis, submit a bare "kesz" that gets rejected as
  // out-of-range, then resubmit citing that very rejection as the
  // falsification step, since by then it IS in range and it DID come after
  // the hypothesis. The refusal text even tells the model to "name a step
  // number", so this is a path the gate would otherwise signpost. A citation
  // only counts if it names a real question step -- one that actually ran
  // data through the closed menu -- never a control step or a bounce-back.
  const cited = transcript[falsifiedBy - 1]!;
  // `Object.hasOwn`, not `in`. `QUESTIONS` is a plain object literal, so `in`
  // answered true for "constructor", "toString", "valueOf" and "__proto__" --
  // none of which is a question. `runQuestion` handed such a step back an
  // error observation, the loop pushed it onto the transcript like any other
  // step, and the gate then read its name off the prototype chain and let it
  // through: hipotezis → constructor → kesz was a two-step bypass.
  if (!Object.hasOwn(QUESTIONS, cited.step.name)) {
    return `a megállapítás elutasítva: a "cafolat" egy valódi adatlekérdező lépésre `
      + `mutasson (a ${falsifiedBy}. lépés "${cited.step.name}" volt, ami nem az).`;
  }

  // A name is not a result. `elteresek({mutato: "nincs_ilyen"})` and
  // `nap({datum: "1999-01-01"})` are both real questions from the closed
  // menu, and both come back having read nothing at all -- an unknown metric,
  // a date with no row. A claim cannot be tested against an answer that never
  // touched the data, so the cited step has to have produced some. The
  // question itself decides: `runQuestion` returns that flag, and every
  // absence-of-data, unusable-argument and missing-instrument path sets it
  // false. A measured "nothing stood out over n=84 nights" is not one of
  // those -- that one read the data and can kill a claim.
  if (cited.evidence !== true) {
    return `a megállapítás elutasítva: a ${falsifiedBy}. lépés ("${cited.step.name}") `
      + "nem hozott adatot, ezért nem cáfolhat semmit — futtass egy lépést, "
      + "ami tényleg mér valamit, és arra hivatkozz.";
  }

  return null;
}
