import { escapeHtml, renderMarkdown } from "./markdown.ts";
import type { Turn } from "../../infra/db/repositories/conversations.ts";
// `MetricRow`, `metricsRowsFrom` and the `readout` row renderer moved to
// `view/numbers.ts` (the new `/szamok` route's home); imported back here so
// this module — kept alive only until Task 8 removes it — keeps compiling
// without a second copy of any of them.
import { metricsRowsFrom, readout, type MetricRow } from "./view/numbers.ts";
// Same move, same reason: `analysesBlock` (and the `DOMAIN_TITLE` map it
// closes over) is now `view/analyses.ts`'s, the new `/elemzes` route's home.
import { analysesBlock } from "./view/analyses.ts";
// Same move, same reason again: `chatBlock` and `SCRIPT` are now
// `view/ask.ts`'s, the new `/kerdes` route's home.
import { chatBlock, SCRIPT } from "./view/ask.ts";

export { metricsRowsFrom, type MetricRow };

export interface PageData {
  dateLabel: string;
  briefMarkdown: string | null;
  analyses: { domain: string; markdown: string; createdAt: string }[];
  metricsRows: MetricRow[];
  history: Turn[];
  chatAvailable: boolean;
}

/**
 * The page is an instrument, and it shows its own signal quality.
 *
 * Every hard bug this project has had was a number that looked real and was
 * not, so the one thing the design must carry is the line between measured and
 * unmeasured. That line is drawn with HUE: a value the system actually
 * measured is lit in the signal colour and its coverage rail fills; a value
 * nobody measured has no hue at all, its rail is a dashed void, and — this is
 * the part that does the work — it never animates. On load every live rail
 * fills and every dead channel just sits there. The absence is what you see.
 *
 * Two families on purpose: the mono carries structure and numbers, because
 * that is the instrument's voice and digits must line up; the system humanist
 * carries prose, because the brief is read half awake and has to be easy.
 * Both ship with the OS — there is no build step here and a webfont that fails
 * to load would take the page's personality with it.
 */
const STYLE = `
/* Dark is the design; light is the honest variant for anyone reading at a
   bright window. Roles swap, meanings do not. */
:root {
  color-scheme: dark light;
  --void: #0A0D12; --panel: #10141C; --rule: #1C2431;
  --ink: #E4E9F1; --dim: #6E7A8C;
  --signal: #FF9E4A; --signal-dim: rgba(255,158,74,.20);
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
  --text: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
@media (prefers-color-scheme: light) {
  :root {
    --void: #EDEFF3; --panel: #FFFFFF; --rule: #D6DAE2;
    --ink: #131721; --dim: #6B7484;
    --signal: #B85C00; --signal-dim: rgba(184,92,0,.16);
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 0 1.25rem 6rem; background: var(--void); color: var(--ink);
  font: 16px/1.65 var(--text); -webkit-font-smoothing: antialiased;
}
.sheet { max-width: 48rem; margin: 0 auto; }

/* ---- header: a thin instrument bar, not a hero card ---- */
.head { display: flex; align-items: baseline; gap: .9rem; flex-wrap: wrap;
  padding: 2.25rem 0 1.5rem; border-bottom: 1px solid var(--rule); }
.mark { font: 600 .78rem/1 var(--mono); letter-spacing: .34em; text-transform: uppercase;
  color: var(--signal); }
.stamp { font: .78rem/1 var(--mono); letter-spacing: .06em; color: var(--dim); }

/* ---- bands: eyebrow in the gutter, content in the column ---- */
.band { display: grid; gap: .35rem 1.75rem; padding: 2.25rem 0;
  border-bottom: 1px solid var(--rule); }
@media (min-width: 46rem) { .band { grid-template-columns: 7.5rem 1fr; } }
.eyebrow { font: .7rem/1.9 var(--mono); letter-spacing: .2em; text-transform: uppercase;
  color: var(--dim); }
.band:last-of-type { border-bottom: 0; }

/* ---- prose ---- */
.body > :first-child { margin-top: 0; }
.body > :last-child { margin-bottom: 0; }
h1, h2 { font: 500 1.35rem/1.3 var(--text); letter-spacing: -.01em; margin: 1.6rem 0 .5rem; }
/* The band eyebrow in the gutter is the page's spine; an analysis heading is a
   divider inside one band. They were the same dim mono uppercase and read as
   two competing spines, so this one keeps the voice but takes the ink and a
   rule of its own. */
h3 { font: 600 .72rem/1.8 var(--mono); letter-spacing: .16em; text-transform: uppercase;
  color: var(--ink); margin: 2.4rem 0 .6rem; padding-top: 1.1rem;
  border-top: 1px solid var(--rule); }
.body > h3:first-child { margin-top: 0; padding-top: 0; border-top: 0; }
p { margin: .7rem 0; }
ul { margin: .7rem 0; padding-left: 1.15rem; }
li { margin: .25rem 0; }
li.task { list-style: none; margin-left: -1.15rem; }
li.task input { accent-color: var(--signal); margin-right: .45rem; }
code { font: .88em var(--mono); background: var(--panel); padding: .12em .35em; border-radius: .2rem; }
strong { font-weight: 600; color: var(--ink); }
.quiet { color: var(--dim); }

/* ---- readouts: the signature ---- */
table { border-collapse: collapse; width: 100%; }
tr { border-bottom: 1px solid var(--rule); }
tr:last-child { border-bottom: 0; }
td { padding: .7rem 0; vertical-align: baseline; }
td:first-child { font: .8rem/1.4 var(--mono); letter-spacing: .02em; color: var(--dim);
  padding-right: 1rem; }
td.value { font: 500 1.05rem/1.4 var(--mono); font-variant-numeric: tabular-nums;
  text-align: right; white-space: nowrap; color: var(--signal); padding-right: 1rem; }
/* No hue is the whole point: an unmeasured value must not read as a reading. */
tr.dead td.value { color: var(--dim); font-weight: 400; font-size: .82rem; letter-spacing: .02em; }
td.ev { width: 9.5rem; }
.rail { display: block; height: 2px; background: var(--rule); position: relative; overflow: hidden; }
.rail::after { content: ""; position: absolute; inset: 0 auto 0 0; width: var(--fill, 0%);
  background: var(--signal); transform-origin: left center; }
.rail.dead { background: none; height: 0; border-top: 1px dashed var(--rule); }
.rail.dead::after { content: none; }
.note { display: block; margin-top: .4rem; font: .68rem/1.4 var(--mono); color: var(--dim); }

/* ---- conversation ---- */
.turn { margin: 1rem 0; padding-left: .9rem; border-left: 2px solid var(--rule); }
.turn.user { border-left-color: var(--signal-dim); }
.who { font: .66rem/1.8 var(--mono); letter-spacing: .18em; text-transform: uppercase; color: var(--dim); }

/* ---- ask ---- */
form { display: flex; gap: .5rem; margin-top: 1.4rem; position: relative; }
form input[type=text] { flex: 1; padding: .7rem .8rem; background: var(--panel);
  border: 1px solid var(--rule); border-radius: .3rem; color: var(--ink); font: inherit; }
form input[type=text]::placeholder { color: var(--dim); }
form input[type=text]:focus-visible { outline: 2px solid var(--signal); outline-offset: 1px; }
form button { padding: .7rem 1.15rem; border: 1px solid var(--signal); border-radius: .3rem;
  background: transparent; color: var(--signal); cursor: pointer;
  font: 600 .72rem/1.4 var(--mono); letter-spacing: .16em; text-transform: uppercase; }
form button:hover:not([disabled]) { background: var(--signal-dim); }
form button:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; }
form [disabled] { opacity: .45; cursor: not-allowed; }
/* The waiting state reuses the rail rather than inventing a spinner: the page
   has one vocabulary for "something is being measured". */
form.busy::after { content: ""; position: absolute; left: 0; right: 0; bottom: -.6rem; height: 2px;
  background: linear-gradient(90deg, transparent, var(--signal), transparent);
  background-size: 40% 100%; background-repeat: no-repeat;
  animation: sweep 1.1s linear infinite; }

/* ---- motion: one orchestrated moment, then nothing ---- */
@keyframes settle { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes rail-in { from { transform: scaleX(0); } to { transform: scaleX(1); } }
@keyframes sweep { from { background-position: -40% 0; } to { background-position: 140% 0; } }
.head, .band { animation: settle .5s cubic-bezier(.2,.8,.2,1) both;
  animation-delay: calc(var(--i, 0) * 60ms); }
.rail::after { animation: rail-in .7s cubic-bezier(.2,.8,.2,1) both;
  animation-delay: calc(320ms + var(--i, 0) * 45ms); }
@media (prefers-reduced-motion: reduce) {
  .head, .band, .rail::after, form.busy::after { animation: none; }
}
`;


export function renderPage(data: PageData): string {
  const metrics = data.metricsRows.map(readout).join("");

  // `--i` orders the load sequence. It is set here rather than in CSS because
  // the count is data, not style: the bands settle in the order they are read.
  const band = (i: number, eyebrow: string, body: string) => [
    `<section class="band" style="--i:${i}">`,
    `<div class="eyebrow">${eyebrow}</div>`,
    `<div class="body">${body}</div>`,
    "</section>",
  ].join("");

  return [
    "<!doctype html>",
    `<html lang="hu"><head><meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<meta name="color-scheme" content="dark light">`,
    "<title>Jarvis</title>",
    `<style>${STYLE}</style></head><body><div class="sheet">`,
    `<header class="head" style="--i:0"><div class="mark">Jarvis</div>`,
    `<div class="stamp">${escapeHtml(data.dateLabel)}</div></header>`,
    // Empty-after-trim counts as absent, not just null. An empty "Briefing"
    // heading with nothing under it is missing data that does not look
    // missing — the one failure this project exists to prevent.
    band(1, "Briefing", data.briefMarkdown === null || data.briefMarkdown.trim() === ""
      ? `<p class="quiet">Ma még nem készült briefing.</p>`
      : renderMarkdown(data.briefMarkdown)),
    band(2, "Elemzés", analysesBlock(data.analyses)),
    band(3, "Számok", `<table>${metrics}</table>`),
    band(4, "Kérdés", chatBlock(data)),
    `</div><script>${SCRIPT}</script>`,
    "</body></html>",
  ].join("");
}
