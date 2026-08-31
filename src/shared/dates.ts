/**
 * Timezone-correct date helpers. Every function takes an explicit `now` and
 * timezone so that "is it Friday?" and "how many hours until 18:00?" are
 * deterministic in tests — no hidden Date.now(), ever.
 */

export type Tz = "Europe/Budapest";
export const TZ: Tz = "Europe/Budapest";

type Parts = Record<string, string>;

function parts(date: Date, tz: string): Parts {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const out: Parts = {};
  for (const p of fmt.formatToParts(date)) out[p.type] = p.value;
  return out;
}

/** 'YYYY-MM-DD' in the given timezone. */
export function isoDate(date: Date, tz: string = TZ): string {
  const p = parts(date, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

/** 'HH:MM' in the given timezone. */
export function isoTime(date: Date, tz: string = TZ): string {
  const p = parts(date, tz);
  return `${p.hour}:${p.minute}`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** 0 = Sunday … 6 = Saturday, evaluated in the given timezone. */
export function dayOfWeek(date: Date, tz: string = TZ): number {
  const idx = WEEKDAYS.indexOf(parts(date, tz).weekday ?? "");
  if (idx === -1) throw new Error(`Unparseable weekday for ${date.toISOString()}`);
  return idx;
}

const HU_DAYS = ["vasárnap", "hétfő", "kedd", "szerda", "csütörtök", "péntek", "szombat"];
const HU_MONTHS = [
  "január", "február", "március", "április", "május", "június",
  "július", "augusztus", "szeptember", "október", "november", "december",
];

/** '2026. augusztus 30., vasárnap' — for the brief header. */
export function huLongDate(date: Date, tz: string = TZ): string {
  const p = parts(date, tz);
  const month = HU_MONTHS[Number(p.month) - 1];
  const day = HU_DAYS[dayOfWeek(date, tz)];
  return `${p.year}. ${month} ${Number(p.day)}., ${day}`;
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

export function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 3_600_000);
}

/** Whole days from `from` to `to`, comparing calendar dates in `tz`. */
export function daysBetween(from: Date, to: Date, tz: string = TZ): number {
  const a = Date.parse(`${isoDate(from, tz)}T00:00:00Z`);
  const b = Date.parse(`${isoDate(to, tz)}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}
