import { escapeHtml, renderMarkdown } from "../markdown.ts";
import type { ChannelReading } from "./channels.ts";

export interface TodayData {
  briefMarkdown: string | null;
  readings: readonly ChannelReading[];
  /** The most recent day that has any data, when today has none. */
  lastSeen: string | null;
  /** When today's row was last written, already worded — null when there is none. */
  writtenAge: string | null;
}

/** A measured channel is lit; a waiting or missing one has no hue and no motion. */
function channelRow(r: ChannelReading): string {
  const shown = r.value ?? (r.state === "varakozik" ? "várakozik" : "nincs mérés");
  return [
    `<div class="csatorna ${r.state}">`,
    `<span class="cimke">${escapeHtml(r.channel.label)}</span>`,
    `<span class="ertek">${escapeHtml(shown)}</span>`,
    "</div>",
  ].join("");
}

export function todayBody(data: TodayData): string {
  // Empty-after-trim counts as absent: an empty "Briefing" heading with
  // nothing under it is missing data that does not look missing.
  const brief = data.briefMarkdown === null || data.briefMarkdown.trim() === ""
    ? `<p class="halk">Ma még nem készült briefing.</p>`
    : renderMarkdown(data.briefMarkdown);

  const stale = data.lastSeen === null
    ? ""
    : `<p class="halk">Ma még nincs adat. A legutóbbi nap: ${escapeHtml(data.lastSeen)}.</p>`;

  // Freshness belongs next to the readings: a row written at 08:15 and one
  // written at 23:55 hold very different amounts of the day, and the numbers
  // themselves cannot say which they are.
  const written = data.writtenAge === null
    ? ""
    : `<p class="halk">A mai sor ${escapeHtml(data.writtenAge)} íródott.</p>`;

  return [
    `<section><h2>Briefing</h2>${brief}</section>`,
    `<section><h2>A mai nap</h2>${stale}${written}`,
    `<div class="csatornak">${data.readings.map(channelRow).join("")}</div></section>`,
  ].join("");
}
