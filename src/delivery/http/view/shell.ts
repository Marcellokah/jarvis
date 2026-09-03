import { escapeHtml } from "../markdown.ts";
import { STYLE } from "./theme.ts";
import type { ChannelSummary } from "./channels.ts";

export type Section = "ma" | "terulet" | "szamok" | "kerdes";

/**
 * Removes `?token=` from the address bar.
 *
 * This belongs to *arriving with a token*, not to any one page: the
 * documented entry URL is `/?token=<TOKEN>` (`deploy/README.md`), and the
 * shell is the only thing all four pages share. While this shipped with the
 * question box alone, the token stayed in the address bar of the very page
 * the owner is told to open, and from there in the history entry and in any
 * bookmark made from it — the exact opposite of what `deploy/README.md` and
 * `pageAuth` both promise.
 *
 * `pageAuth` has already traded the query token for an HttpOnly cookie by the
 * time this runs, so cleaning the URL is the whole job; the page needs no
 * copy of the token for anything else. Other query parameters are kept —
 * only the token is a secret. The braces keep `u` out of the global scope
 * shared with `view/ask.ts`'s script.
 */
export const SCRUB_SCRIPT = `
{
  const u = new URL(location.href);
  if (u.searchParams.has("token")) {
    u.searchParams.delete("token");
    history.replaceState({}, "", u.pathname + u.search + u.hash);
  }
}
`;

/** Whether each section has anything live to show right now. */
export interface NavState { ma: boolean; terulet: boolean; kerdes: boolean }

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
 * indicator that cannot turn off is decoration, not information. `terulet`'s
 * lamp CAN go dark, which is why it has one: it is lit while the deep
 * analysis is fresh, and the analysis is started by hand (`npm run analyze`),
 * so a dark lamp is an actionable state rather than a permanent decoration.
 * This is exactly what the old `/elemzes` lamp ("there is at least one
 * analysis") could never be — after the first run it stayed lit forever.
 */
const ITEMS: { section: Section; href: string; label: string; lamp: keyof NavState | null }[] = [
  { section: "ma", href: "/", label: "Ma", lamp: "ma" },
  { section: "terulet", href: "/terulet", label: "Terület", lamp: "terulet" },
  { section: "szamok", href: "/szamok", label: "Számok", lamp: null },
  { section: "kerdes", href: "/kerdes", label: "Kérdés", lamp: "kerdes" },
];

/**
 * The four areas, listed under "Terület" — on the desktop rail only.
 *
 * On a phone the nav is the bottom row, and the four top-level items already
 * fill it; a sub-list there would either shrink every label past reading or
 * push the row off the thumb's reach. The hub page is the phone's way in, and
 * it carries the same four as cards.
 */
const TERULETEK: { href: string; label: string }[] = [
  { href: "/terulet/terheles", label: "Terhelés" },
  { href: "/terulet/regeneracio", label: "Regeneráció" },
  { href: "/terulet/taplalkozas", label: "Táplálkozás" },
  { href: "/terulet/penzugy", label: "Pénzügy" },
];

function nav(data: ShellData): string {
  const items = ITEMS.map((item) => {
    const active = item.section === data.section;
    const lamp = item.lamp === null ? "" : (data.nav[item.lamp] ? " jelzo el" : " jelzo holt");
    const link = `<a href="${item.href}" class="menu${lamp}"${active ? ' aria-current="page"' : ""}>`
      + `${escapeHtml(item.label)}</a>`;
    // The sub-list is rendered only while the reader is inside the section:
    // on every other page it would be four links to somewhere they did not
    // ask about, in a rail that has held four items since F1.
    if (item.section !== "terulet" || !active) return link;
    const sub = TERULETEK.map((t) =>
      `<a href="${t.href}" class="alelem">${escapeHtml(t.label)}</a>`).join("");
    return `${link}<span class="almenu">${sub}</span>`;
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
    `<style>${STYLE}</style>`,
    // In the head, so the token leaves the address bar before the page has
    // even drawn — there is no DOM for it to wait for.
    `<script>${SCRUB_SCRIPT}</script></head><body>`,
    nav(data),
    `<main class="lap">`,
    statusStrip(data),
    data.body,
    "</main></body></html>",
  ].join("");
}
