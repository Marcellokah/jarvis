import type { JarvisModule, ModuleContext, ModuleResult } from "../../core/module.ts";
import type { CalendarEvent } from "../../infra/calendar/service.ts";
import { addHours, isoDate } from "../../shared/dates.ts";

export interface ScheduleData {
  today: CalendarEvent[];
  tomorrow: CalendarEvent[];
  firstEvent: CalendarEvent | null;
  /** First commitment starts before the usual 08:30 departure. */
  earlyStart: boolean;
  /** Hours of clear time from now until the first commitment. */
  freeHours: number | null;
  busyHours: number;
}

export interface ScheduleConfig {
  enabled: boolean;
  /** How far past today to look, so tomorrow's early meeting is not a surprise. */
  lookaheadHours: number;
  /** Local hour you normally leave home. */
  departureHour: number;
}

export function dailySchedule(cfg: ScheduleConfig): JarvisModule<ScheduleData> {
  return {
    name: "DailySchedule",
    title: "📅 Mai nap",
    enabled: cfg.enabled,
    schedule: "daily",
    timeoutMs: 12_000,

    async execute(ctx: ModuleContext): Promise<ModuleResult<ScheduleData> | null> {
      const events = await ctx.calendar.listEvents(ctx.now, addHours(ctx.now, cfg.lookaheadHours));
      if (events.length === 0) return null;

      const today = isoDate(ctx.now, ctx.tz);
      const upcoming = events.filter((e) => Date.parse(e.end) > ctx.now.getTime());

      const todays = upcoming.filter((e) => isoDate(new Date(e.start), ctx.tz) === today);
      const tomorrows = upcoming.filter((e) => isoDate(new Date(e.start), ctx.tz) > today);
      const firstEvent = todays[0] ?? tomorrows[0] ?? null;

      const timed = todays.filter((e) => !e.allDay);
      const busyMs = timed.reduce((sum, e) => sum + (Date.parse(e.end) - Date.parse(e.start)), 0);

      const firstTimedToday = timed[0];
      const earlyStart =
        firstTimedToday !== undefined &&
        localHour(new Date(firstTimedToday.start), ctx.tz) < cfg.departureHour + 0.5;

      return {
        data: {
          today: todays,
          tomorrow: tomorrows,
          firstEvent,
          earlyStart,
          freeHours: firstTimedToday
            ? round1((Date.parse(firstTimedToday.start) - ctx.now.getTime()) / 3_600_000)
            : null,
          busyHours: round1(busyMs / 3_600_000),
        },
        actions: [],
        // An early meeting changes when you have to leave, and that is the one
        // thing you cannot fix after the fact.
        priority: earlyStart ? "critical" : "normal",
      };
    },

    renderPlain(result): string {
      const { today, tomorrow, earlyStart, freeHours, busyHours } = result.data;
      const lines: string[] = [];

      if (today.length > 0) {
        for (const event of today) {
          lines.push(`- ${formatWhen(event)} **${event.title}**${event.location ? ` · ${event.location}` : ""}`);
        }
        if (busyHours > 0) lines.push(`- _Összesen ${busyHours} óra lekötve_`);
      } else {
        lines.push("Ma nincs naptárbejegyzés.");
      }

      if (earlyStart && freeHours !== null) {
        lines.unshift(`⏰ **Korai kezdés** — ${freeHours} óra van az első programig.`, "");
      }

      if (tomorrow.length > 0) {
        lines.push("", "**Holnap reggel:**");
        for (const event of tomorrow) {
          lines.push(`- ${formatWhen(event)} ${event.title}`);
        }
      }

      return lines.join("\n");
    },

    async healthCheck(ctx) {
      return ctx.calendar.healthCheck();
    },
  };
}

function formatWhen(event: CalendarEvent): string {
  if (event.allDay) return "egész nap —";
  const fmt = new Intl.DateTimeFormat("hu-HU", {
    timeZone: "Europe/Budapest", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  return `${fmt.format(new Date(event.start))}–${fmt.format(new Date(event.end))}`;
}

function localHour(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return (get("hour") % 24) + get("minute") / 60;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
