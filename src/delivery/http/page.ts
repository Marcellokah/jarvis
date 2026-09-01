import { escapeHtml, renderMarkdown } from "./markdown.ts";
import type { Turn } from "../../infra/db/repositories/conversations.ts";
import type { Metric } from "../../core/analysis/stats.ts";
import type { Metrics } from "../../core/analysis/aggregate.ts";

export interface MetricRow {
  label: string;
  /** Already formatted for a person — "nincs mérés" where there is none. */
  value: string;
  detail: string;
}

export interface PageData {
  dateLabel: string;
  briefMarkdown: string | null;
  analyses: { domain: string; markdown: string; createdAt: string }[];
  metricsRows: MetricRow[];
  history: Turn[];
  chatAvailable: boolean;
}

const STYLE = `
:root { color-scheme: light dark; --fg: #1a1a1a; --bg: #fbfbfa; --muted: #6b6b6b; --line: #e3e3e0; --accent: #2f6f4f; }
@media (prefers-color-scheme: dark) { :root { --fg: #e8e8e6; --bg: #16181a; --muted: #9a9a97; --line: #2c2f33; --accent: #7fb99a; } }
* { box-sizing: border-box; }
body { margin: 0 auto; padding: 2rem 1.25rem 6rem; max-width: 46rem; background: var(--bg); color: var(--fg);
  font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
h2 { font-size: 1.15rem; margin: 2.5rem 0 .5rem; padding-bottom: .3rem; border-bottom: 1px solid var(--line); }
h3 { font-size: 1rem; margin: 1.5rem 0 .4rem; }
.date { color: var(--muted); margin: 0 0 2rem; }
ul { padding-left: 1.2rem; } li { margin: .2rem 0; } li.task { list-style: none; margin-left: -1.2rem; }
table { border-collapse: collapse; width: 100%; font-size: .95rem; }
td { padding: .4rem .5rem; border-bottom: 1px solid var(--line); vertical-align: top; }
td.value { font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
td.detail { color: var(--muted); font-size: .85rem; }
.turn { margin: .75rem 0; padding: .6rem .8rem; border-radius: .5rem; border: 1px solid var(--line); }
.turn.user { border-color: var(--accent); }
.who { font-size: .75rem; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
.muted { color: var(--muted); }
form { display: flex; gap: .5rem; margin-top: 1rem; }
input[type=text] { flex: 1; padding: .6rem .7rem; border: 1px solid var(--line); border-radius: .5rem;
  background: var(--bg); color: var(--fg); font: inherit; }
button { padding: .6rem 1rem; border: 0; border-radius: .5rem; background: var(--accent); color: #fff; font: inherit; cursor: pointer; }
button[disabled], input[disabled] { opacity: .5; cursor: not-allowed; }
`;

// Kept inline: there is no build step and no asset pipeline, and a second
// request for a few lines of script would need its own route and its own auth.
const SCRIPT = `
const q = new URLSearchParams(location.search).get("token");
if (q) { sessionStorage.setItem("jarvis-token", q); history.replaceState({}, "", location.pathname); }
const form = document.querySelector("form");
if (form) form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = form.querySelector("input[type=text]");
  const question = input.value.trim();
  if (!question) return;
  const button = form.querySelector("button");
  input.disabled = button.disabled = true;
  button.textContent = "Kérdezek…";
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + (sessionStorage.getItem("jarvis-token") || "") },
      body: JSON.stringify({ question }),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    location.reload();
  } catch (err) {
    button.textContent = "Nem sikerült: " + err.message;
    input.disabled = button.disabled = false;
  }
});
`;

const DOMAIN_TITLE: Record<string, string> = {
  physical: "Fizikai fejlődés",
  recovery: "Regenerálódás és alvás",
  finance: "Pénzügy",
  synthesis: "Összegzés",
};

function analysesBlock(data: PageData): string {
  if (data.analyses.length === 0) {
    return `<p class="muted">Még nem futott mélyelemzés. Indítsd: <code>npm run analyze</code></p>`;
  }
  return data.analyses.map((a) => [
    `<h3>${escapeHtml(DOMAIN_TITLE[a.domain] ?? a.domain)}`,
    ` <span class="muted">· ${escapeHtml(a.createdAt.slice(0, 10))}</span></h3>`,
    renderMarkdown(a.markdown),
  ].join("")).join("");
}

function chatBlock(data: PageData): string {
  const turns = data.history.map((t) => [
    `<div class="turn ${t.role === "user" ? "user" : "assistant"}">`,
    `<div class="who">${t.role === "user" ? "Te" : "Jarvis"}</div>`,
    renderMarkdown(t.content),
    "</div>",
  ].join("")).join("");

  const disabled = data.chatAvailable ? "" : " disabled";
  const notice = data.chatAvailable
    ? ""
    : `<p class="muted">A modell most nem érhető el, de a fenti tartalom teljes.</p>`;

  return [
    turns,
    notice,
    `<form><input type="text" placeholder="Kérdezz valamit…"${disabled}>`,
    `<button type="submit"${disabled}>Kérdés</button></form>`,
  ].join("");
}

export function renderPage(data: PageData): string {
  const metrics = data.metricsRows.map((r) => [
    "<tr>",
    `<td>${escapeHtml(r.label)}</td>`,
    `<td class="value">${escapeHtml(r.value)}</td>`,
    `<td class="detail">${escapeHtml(r.detail)}</td>`,
    "</tr>",
  ].join("")).join("");

  return [
    "<!doctype html>",
    `<html lang="hu"><head><meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    "<title>Jarvis</title>",
    `<style>${STYLE}</style></head><body>`,
    "<h1>Jarvis</h1>",
    `<p class="date">${escapeHtml(data.dateLabel)}</p>`,
    "<h2>Briefing</h2>",
    // Empty-after-trim counts as absent, not just null. An empty "Briefing"
    // heading with nothing under it is missing data that does not look
    // missing — the one failure this project exists to prevent.
    data.briefMarkdown === null || data.briefMarkdown.trim() === ""
      ? `<p class="muted">Ma még nem készült briefing.</p>`
      : renderMarkdown(data.briefMarkdown),
    "<h2>Elemzés</h2>",
    analysesBlock(data),
    "<h2>Számok</h2>",
    `<table>${metrics}</table>`,
    "<h2>Kérdés</h2>",
    chatBlock(data),
    `<script>${SCRIPT}</script>`,
    "</body></html>",
  ].join("");
}

const hu = (n: number, digits = 0) =>
  n.toLocaleString("hu-HU", { minimumFractionDigits: digits, maximumFractionDigits: digits });

/**
 * One row per metric, formatted for a person.
 *
 * A missing measurement reads "nincs mérés" and never 0 — the whole system is
 * built on that distinction, and a table is where it would be easiest to lose.
 * The detail column always carries the evidence: how many days, what coverage.
 */
function row(label: string, m: Metric, digits = 0, unit = ""): MetricRow {
  // Floor, not round: 364 days out of 365 rounds up to "100%", and this table
  // is the one place the owner reads coverage. Only genuine completeness may
  // claim it — incomplete data must never look complete.
  const pct = Math.floor(m.coverage * 100);
  return {
    label,
    value: m.value === null ? "nincs mérés" : `${hu(m.value, digits)}${unit}`,
    detail: `${m.n} nap · ${pct}% lefedettség (${m.window})`,
  };
}

export function metricsRowsFrom(m: Metrics): MetricRow[] {
  const rows: MetricRow[] = [
    {
      label: "Terhelési arány",
      value: m.physical.loadRatio === null ? "nincs alap" : hu(m.physical.loadRatio, 2),
      detail: "28 napos napi átlag a 365 naposhoz mérve",
    },
    row("Lépés (7 nap)", m.physical.steps.d7),
    row("Lépés (365 nap)", m.physical.steps.d365),
    row("VO2max", m.physical.vo2max, 1),
    row("Nyugalmi pulzus", m.physical.rhr, 1, " bpm"),
    row("HRV (7 nap)", m.recovery.hrv.d7, 1, " ms"),
    row("HRV (90 nap)", m.recovery.hrv.d90, 1, " ms"),
    row("Alvás (90 nap)", m.recovery.asleepMin.d90, 0, " perc"),
  ];

  const trend = (label: string, slope: number | null, unit: string) => {
    if (slope === null) return;
    rows.push({
      label: `${label} trendje`,
      value: `${slope > 0 ? "+" : ""}${hu(slope, 2)}${unit}`,
      detail: "30 naponta, 365 napos ablakon",
    });
  };
  trend("VO2max", m.physical.vo2max.slopePer30d, "");
  trend("Nyugalmi pulzus", m.physical.rhr.slopePer30d, " bpm");

  rows.push({
    label: "Előfizetések",
    value: m.finance.months.at(-1) === undefined
      ? "nincs adat"
      : `${hu(m.finance.months.at(-1)!.totalHuf)} Ft`,
    detail: `${m.finance.months.length} rögzített hónap`,
  });

  return rows;
}
