import { escapeHtml } from "../markdown.ts";
import { STYLE } from "./theme.ts";
import type { ChannelSummary } from "./channels.ts";

export type Section = "ma" | "elemzes" | "szamok" | "kerdes";

/** Whether each section has anything live to show right now. */
export interface NavState { ma: boolean; elemzes: boolean; kerdes: boolean }

export interface ShellData {
  section: Section;
  dateLabel: string;
  /** How old the brief is, already worded — null when there is none. */
  briefAge: string | null;
  channels: ChannelSummary;
  nav: NavState;
  body: string;
}

/**
 * `szamok` carries no indicator on purpose.
 *
 * It always has history behind it, so its lamp could never go dark — and an
 * indicator that cannot turn off is decoration, not information.
 */
const ITEMS: { section: Section; href: string; label: string; lamp: keyof NavState | null }[] = [
  { section: "ma", href: "/", label: "Ma", lamp: "ma" },
  { section: "elemzes", href: "/elemzes", label: "Elemzés", lamp: "elemzes" },
  { section: "szamok", href: "/szamok", label: "Számok", lamp: null },
  { section: "kerdes", href: "/kerdes", label: "Kérdés", lamp: "kerdes" },
];

function nav(data: ShellData): string {
  const items = ITEMS.map((item) => {
    const active = item.section === data.section;
    const lamp = item.lamp === null ? "" : (data.nav[item.lamp] ? " jelzo el" : " jelzo holt");
    return `<a href="${item.href}" class="menu${lamp}"${active ? ' aria-current="page"' : ""}>`
      + `${escapeHtml(item.label)}</a>`;
  }).join("");
  return `<nav>${items}</nav>`;
}

function statusStrip(data: ShellData): string {
  const { arrived, waiting, missing, missingLabels, total } = data.channels;
  const parts = [
    `<span class="datum">${escapeHtml(data.dateLabel)}</span>`,
    data.briefAge === null
      ? `<span class="halk">nincs mai briefing</span>`
      : `<span class="halk">briefing ${escapeHtml(data.briefAge)}</span>`,
    `<span class="halk">${arrived}/${total} csatorna</span>`,
  ];
  if (waiting > 0) parts.push(`<span class="halk">${waiting} várakozik</span>`);
  // The one place magenta appears: a channel that was due and did not arrive.
  if (missing > 0) {
    parts.push(`<span class="elmaradt">elmaradt: ${escapeHtml(missingLabels.join(", "))}</span>`);
  }
  return `<div class="allapot">${parts.join("")}</div>`;
}

export function layout(data: ShellData): string {
  return [
    "<!doctype html>",
    `<html lang="hu"><head><meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<meta name="color-scheme" content="dark light">`,
    "<title>Jarvis</title>",
    `<style>${STYLE}</style></head><body>`,
    nav(data),
    `<main class="lap">`,
    statusStrip(data),
    data.body,
    "</main></body></html>",
  ].join("");
}
