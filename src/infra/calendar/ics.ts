import { createEvent, type EventAttributes, type DateArray } from "ics";
import type { CalendarProposal } from "../../core/module.ts";

/**
 * Builds a VEVENT for a proposal.
 *
 * Times are emitted as UTC instants rather than floating local times: a
 * floating time would shift when read on a device in another timezone, and
 * a 07:00 fishing trip that becomes 05:00 abroad is a real bug.
 */
export function buildVevent(proposal: CalendarProposal, uid: string, now: Date): string {
  const start = new Date(proposal.start);
  const end = new Date(proposal.end);

  if (Number.isNaN(start.getTime())) throw new Error(`Invalid proposal start: ${proposal.start}`);
  if (Number.isNaN(end.getTime())) throw new Error(`Invalid proposal end: ${proposal.end}`);
  if (end <= start) throw new Error(`Proposal ends before it starts: ${proposal.start} → ${proposal.end}`);

  const attrs: EventAttributes = {
    uid,
    title: proposal.title,
    start: toUtcArray(start),
    startInputType: "utc",
    startOutputType: "utc",
    end: toUtcArray(end),
    endInputType: "utc",
    endOutputType: "utc",
    created: toUtcArray(now),
    lastModified: toUtcArray(now),
    productId: "jarvis/personal-assistant",
    ...(proposal.location ? { location: proposal.location } : {}),
    ...(proposal.notes ? { description: proposal.notes } : {}),
  };

  const { error, value } = createEvent(attrs);
  if (error || !value) throw new Error(`Could not build VEVENT: ${error?.message ?? "unknown"}`);
  return value;
}

function toUtcArray(d: Date): DateArray {
  return [
    d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(),
    d.getUTCHours(), d.getUTCMinutes(),
  ];
}

/** Minimal VEVENT reader — enough for what CalDAV returns for a time range. */
export function parseVevents(ics: string): {
  uid: string; summary: string; start: string; end: string; allDay: boolean; location?: string;
}[] {
  const unfolded = ics.replace(/\r?\n[ \t]/g, "");
  const out: ReturnType<typeof parseVevents> = [];

  for (const block of unfolded.split("BEGIN:VEVENT").slice(1)) {
    const body = block.split("END:VEVENT")[0] ?? "";
    const uid = field(body, "UID") ?? "";
    const summary = unescapeText(field(body, "SUMMARY") ?? "(névtelen)");
    const dtstart = rawField(body, "DTSTART");
    const dtend = rawField(body, "DTEND");
    if (!uid || !dtstart) continue;

    const allDay = /VALUE=DATE(?!-TIME)/.test(dtstart.params);
    const start = parseIcsDate(dtstart.value);
    const end = dtend ? parseIcsDate(dtend.value) : start;
    if (!start) continue;

    const location = field(body, "LOCATION");
    out.push({
      uid, summary, start, end: end ?? start, allDay,
      ...(location ? { location: unescapeText(location) } : {}),
    });
  }
  return out;
}

function rawField(body: string, name: string): { params: string; value: string } | null {
  const re = new RegExp(`^${name}([^:\\r\\n]*):(.*)$`, "m");
  const m = body.match(re);
  return m ? { params: m[1] ?? "", value: (m[2] ?? "").trim() } : null;
}

function field(body: string, name: string): string | undefined {
  return rawField(body, name)?.value;
}

/** Handles both `20260831T062000Z` and the all-day `20260831` forms. */
function parseIcsDate(value: string): string | null {
  const withTime = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (withTime) {
    const [, y, mo, d, h, mi, s] = withTime;
    return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`).toISOString();
  }
  const dateOnly = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dateOnly) {
    const [, y, mo, d] = dateOnly;
    return new Date(`${y}-${mo}-${d}T00:00:00Z`).toISOString();
  }
  return null;
}

/** Reverses RFC 5545 text escaping: `\\n` `\\,` `\\;` `\\\\`. */
const unescapeText = (s: string): string =>
  s.replace(/\\([\\;,nN])/g, (_m, ch: string) => (ch === "n" || ch === "N" ? "\n" : ch));
