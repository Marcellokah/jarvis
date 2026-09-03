import { escapeHtml } from "../markdown.ts";
import { hu } from "./format.ts";
import type { Metric } from "../../../core/analysis/stats.ts";

export interface GreetingData {
  /** Local hour 0..23 in Europe/Budapest — the caller does the conversion. */
  hour: number;
  /** The owner's name, or an empty string when none is configured. */
  name: string;
}

/**
 * Four times of day, and the reader's name when there is one.
 *
 * Deliberately not a rotating set of phrasings: a greeting that changes at
 * random reads as a toy after a week, and the time of day is variation that
 * actually means something.
 *
 * The night bucket (22–04) says "Szia" rather than a genuine greeting, on
 * purpose: Hungarian has no time-of-day GREETING for the middle of the
 * night — "Jó éjszakát" is what you say to someone who is LEAVING, not
 * arriving, so using it here would tell the owner goodbye on the one line
 * they read when they just opened the app. "Szia" is the neutral hello that
 * works at any hour, so it covers the gap the other three buckets don't
 * have. The register mixes deliberately: "Jó reggelt" / "Jó napot" / "Jó
 * estét" are the ordinary forms a person actually says out loud, and this
 * app only ever speaks to the one person who owns it — "Szia" fits that
 * same voice rather than reading as a downgrade.
 *
 * An earlier version had six buckets and used "Szép napot" (10–12) and
 * "Jó éjt" (22–04) — both Hungarian FAREWELLS ("have a nice day", "sleep
 * well"), which read as goodbye on the first line the owner sees on
 * arrival. See the design doc's "a távollétben hozott döntések" for the
 * correction.
 *
 * Escaping happens here, once, on the raw name — the string this function
 * returns is already HTML-safe. `greetingBand` embeds that string directly
 * and must NOT escape it again, or an injected `<b>` would come out as
 * `&amp;lt;b&amp;gt;` instead of `&lt;b&gt;`.
 */
export function greeting(d: GreetingData): string {
  const h = d.hour;
  const word = h < 4 ? "Szia"
    : h < 10 ? "Jó reggelt"
    : h < 18 ? "Jó napot"
    : h < 22 ? "Jó estét"
    : "Szia";
  const name = d.name.trim();
  return name === "" ? `${word}!` : `${word}, ${escapeHtml(name)}!`;
}

export interface HighlightInput {
  hrvDeviation: { sigma: number; n7: number; n90: number } | null;
  /** Today's step count, or null when today has none. */
  todaySteps: number | null;
  steps28: Metric;
}

/** A standard deviation this far from the baseline is worth a sentence. */
const SIGMA = 1;
/** Fewer than this many nights in the recent window and the deviation is not a claim. */
const MIN_HRV_NIGHTS = 3;
/**
 * Fewer than this many nights in the 90-day baseline itself, and "your own
 * 90-day baseline" is a claim the baseline cannot back up.
 *
 * `n90` is carried on `hrvDeviation` and, until this guard, never read: the
 * sentence says "a saját 90 napos alapvonalad" on the strength of `n7`
 * alone. `core/notify/candidates.ts` faces the exact same shape of input —
 * `aggregate()` already gates `hrvDeviation` on both counts internally — and
 * repeats the floor here anyway, in a comment that explains why: defence in
 * depth, because if the upstream floor is ever loosened, the threshold that
 * decides whether to say something to the owner should not move with it.
 * Same reasoning, same number (`MIN_N90` there), applied here.
 */
const MIN_HRV_N90 = 20;
/** Today's steps must clear the 28-day mean by this much. */
const STEP_RATIO = 1.5;
/** Fewer than this many measured days and "your average" is a lie. */
const MIN_STEP_DAYS = 14;

/**
 * The one thing worth saying about today — or nothing.
 *
 * The silence is the feature. A highlight that fires every morning is the
 * same thing as an indicator that is always lit: it stops carrying
 * information and starts being decoration, which this project refuses
 * everywhere else. The thresholds are deliberately conservative so most days
 * say nothing at all.
 *
 * Every sentence compares. A bare "10 608 lépés" is a number; "1,7 times your
 * 28-day average" is the thing worth reading.
 *
 * Order matters, because there is one sentence and more than one rule can
 * match: how the body recovered outranks what it did. Both branches share
 * one voice — an above-baseline night and a below-baseline night read the
 * same way, because this is information, not an alarm (`--riado` is not
 * used here; see the caller's CSS).
 */
export function highlight(h: HighlightInput): string | null {
  const dev = h.hrvDeviation;
  if (dev !== null && dev.n7 >= MIN_HRV_NIGHTS && dev.n90 >= MIN_HRV_N90
      && Math.abs(dev.sigma) >= SIGMA) {
    const irany = dev.sigma > 0 ? "fölött" : "alatt";
    return `A HRV-d ${hu(Math.abs(dev.sigma), 2)} szórással a saját `
      + `90 napos alapvonalad ${irany} van.`;
  }

  const mean = h.steps28.value;
  if (h.todaySteps !== null && mean !== null && mean > 0
      && h.steps28.n >= MIN_STEP_DAYS && h.todaySteps / mean >= STEP_RATIO) {
    const arany = h.todaySteps / mean;
    // A whole ratio ("2-szerese") does not need the decimal point that a
    // fractional one ("1,7-szerese") does — `hu(arany, 1)` always emits one,
    // so "2,0-szerese" was reading as a rounded-off number rather than an
    // exact one. Hungarian's multiplier suffix also has vowel harmony
    // ("háromszorosa" at 3, "ötszöröse" at 5) that this stays clear of on
    // purpose: the thresholds above keep the ratio in the 1.5–3-ish range in
    // practice, where "-szerese" is the only form ever needed, and a full
    // harmony table for a suffix that rarely fires would be complexity this
    // one sentence does not earn back.
    const aranySzoveg = Number.isInteger(arany) ? hu(arany) : hu(arany, 1);
    return `Ma ${hu(h.todaySteps)} lépés — a 28 napos átlagod `
      + `${aranySzoveg}-szerese.`;
  }

  return null;
}

/**
 * The band itself: the greeting always, the sentence only when there is one.
 *
 * The greeting never depends on data — the hour and the name are always
 * there — so a morning with nothing measured yet still opens with something
 * addressed to a person rather than with a date.
 *
 * Escaping split by layer: `greeting()` already returns HTML-safe text (see
 * its own doc comment), so it is embedded here verbatim. `highlight()`
 * returns plain text, so this is the one place that escapes it, right
 * before it goes into the page.
 */
export function greetingBand(g: GreetingData, h: HighlightInput | null): string {
  const mondat = h === null ? null : highlight(h);
  const sor = mondat === null ? "" : `<p class="mondat">${escapeHtml(mondat)}</p>`;
  return `<section class="koszones"><p class="udv">${greeting(g)}</p>${sor}</section>`;
}
