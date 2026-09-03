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
 * Six times of day, and the reader's name when there is one.
 *
 * Deliberately not a rotating set of phrasings: a greeting that changes at
 * random reads as a toy after a week, and the time of day is variation that
 * actually means something.
 *
 * Escaping happens here, once, on the raw name — the string this function
 * returns is already HTML-safe. `greetingBand` embeds that string directly
 * and must NOT escape it again, or an injected `<b>` would come out as
 * `&amp;lt;b&amp;gt;` instead of `&lt;b&gt;`.
 */
export function greeting(d: GreetingData): string {
  const h = d.hour;
  const word = h < 4 ? "Jó éjt"
    : h < 7 ? "Jó reggelt"
    : h < 10 ? "Jó reggelt"
    : h < 12 ? "Szép napot"
    : h < 18 ? "Jó napot"
    : h < 22 ? "Szép estét"
    : "Jó éjt";
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
/** Fewer than this many nights and the deviation is not a claim. */
const MIN_HRV_NIGHTS = 3;
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
  if (dev !== null && dev.n7 >= MIN_HRV_NIGHTS && Math.abs(dev.sigma) >= SIGMA) {
    const irany = dev.sigma > 0 ? "fölött" : "alatt";
    return `A HRV-d ${hu(Math.abs(dev.sigma), 2)} szórással a saját `
      + `90 napos alapvonalad ${irany} van.`;
  }

  const mean = h.steps28.value;
  if (h.todaySteps !== null && mean !== null && mean > 0
      && h.steps28.n >= MIN_STEP_DAYS && h.todaySteps / mean >= STEP_RATIO) {
    return `Ma ${hu(h.todaySteps)} lépés — a 28 napos átlagod `
      + `${hu(h.todaySteps / mean, 1)}-szerese.`;
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
