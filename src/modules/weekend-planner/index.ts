import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import type { JarvisModule, ModuleContext, ModuleResult, ActionItem } from "../../core/module.ts";
import { fromRoot } from "../../shared/paths.ts";
import { addDays, dayOfWeek, isoDate } from "../../shared/dates.ts";

const MODULE = "WeekendPlanner";

const destinationSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(["hiking", "fishing", "trip"]),
  drive_min: z.number().int().positive(),
  distance_km: z.number().positive().nullable().default(null),
  months: z.array(z.number().int().min(1).max(12)),
  min_temp: z.number(),
  max_temp: z.number(),
  max_rain_pct: z.number().min(0).max(100),
  note: z.string().default(""),
});

type Destination = z.infer<typeof destinationSchema>;

export interface DayForecast {
  date: string;
  weatherCode: number;
  tempMin: number;
  tempMax: number;
  rainPct: number;
  windKmh: number;
  sunrise: string;
  sunset: string;
}

export interface Suggestion {
  name: string;
  kind: Destination["kind"];
  date: string;
  driveMin: number;
  distanceKm: number | null;
  note: string;
  score: number;
  reason: string;
  forecast: DayForecast;
}

export interface WeekendData {
  suggestions: Suggestion[];
  forecast: DayForecast[];
  /** Days already committed in the calendar, so a full Saturday is not offered. */
  busyDates: string[];
}

export interface WeekendConfig {
  enabled: boolean;
  /** 0 = Sunday … 6 = Saturday. Runs Thu–Sat by default. */
  runOnDays: readonly number[];
  timeoutMs: number;
  cacheTtlMs: number;
  latitude: number;
  longitude: number;
  maxSuggestions: number;
}

const KIND_LABEL: Record<Destination["kind"], string> = {
  hiking: "🥾 Túra", fishing: "🎣 Horgászat", trip: "🚗 Kirándulás",
};

/** Open-Meteo WMO codes, grouped into what actually matters for a plan. */
function describeWeather(code: number): { label: string; penalty: number } {
  if (code === 0) return { label: "derült", penalty: 0 };
  if (code <= 2) return { label: "napos, kevés felhő", penalty: 0 };
  if (code === 3) return { label: "felhős", penalty: 5 };
  if (code <= 48) return { label: "ködös", penalty: 20 };
  if (code <= 57) return { label: "szitálás", penalty: 30 };
  if (code <= 67) return { label: "eső", penalty: 45 };
  if (code <= 77) return { label: "havazás", penalty: 50 };
  if (code <= 82) return { label: "zápor", penalty: 40 };
  return { label: "zivatar", penalty: 70 };
}

export function weekendPlanner(
  cfg: WeekendConfig, destinationsPath = "config/destinations.yaml",
): JarvisModule<WeekendData> {
  let cached: Destination[] | null = null;
  const destinations = () => {
    cached ??= z.array(destinationSchema).parse(parse(readFileSync(fromRoot(destinationsPath), "utf8")));
    return cached;
  };

  return {
    name: MODULE,
    title: "🥾 Hétvége",
    enabled: cfg.enabled,
    // Suggesting a Saturday hike on a Monday is noise; Thursday onwards it is
    // a plan you can actually act on.
    schedule: { days: [...cfg.runOnDays] },
    timeoutMs: cfg.timeoutMs,

    async execute(ctx: ModuleContext): Promise<ModuleResult<WeekendData> | null> {
      const weekend = nextWeekendDates(ctx.now, ctx.tz);
      if (weekend.length === 0) return null;

      const forecast = await ctx.cache.through("forecast", cfg.cacheTtlMs, () =>
        fetchForecast(ctx, cfg.latitude, cfg.longitude),
      );

      const relevant = forecast.filter((f) => weekend.includes(f.date));
      if (relevant.length === 0) return null;

      // A day already full in the calendar is not a day to plan a hike on.
      let busyDates: string[] = [];
      try {
        const events = await ctx.calendar.listEvents(ctx.now, addDays(ctx.now, 9));
        busyDates = [...new Set(
          events
            .filter((e) => e.allDay || (Date.parse(e.end) - Date.parse(e.start)) >= 4 * 3_600_000)
            .map((e) => isoDate(new Date(e.start), ctx.tz)),
        )];
      } catch {
        // No calendar configured is fine; just plan without it.
      }

      const month = Number(isoDate(ctx.now, ctx.tz).slice(5, 7));
      const suggestions: Suggestion[] = [];

      for (const day of relevant) {
        if (busyDates.includes(day.date)) continue;

        for (const destination of destinations()) {
          const scored = score(destination, day, month);
          if (!scored) continue;
          suggestions.push({
            name: destination.name,
            kind: destination.kind,
            date: day.date,
            driveMin: destination.drive_min,
            distanceKm: destination.distance_km,
            note: destination.note,
            forecast: day,
            ...scored,
          });
        }
      }

      if (suggestions.length === 0) return null;

      suggestions.sort((a, b) => b.score - a.score);
      const top = dedupeByName(suggestions).slice(0, cfg.maxSuggestions);

      return {
        data: { suggestions: top, forecast: relevant, busyDates },
        actions: top.slice(0, 2).map(toProposal),
        priority: "normal",
        dedupeKeys: top.map((s) => `weekend:${s.date}:${s.name}`),
      };
    },

    renderPlain(result): string {
      const { suggestions, forecast } = result.data;
      const lines: string[] = [];

      if (forecast.length > 0) {
        lines.push("**Hétvégi időjárás:**");
        for (const day of forecast) {
          const { label } = describeWeather(day.weatherCode);
          lines.push(
            `- ${huDay(day.date)}: ${label}, ${Math.round(day.tempMin)}–${Math.round(day.tempMax)} °C, `
            + `eső ${day.rainPct}%, szél ${Math.round(day.windKmh)} km/h`,
          );
        }
        lines.push("");
      }

      lines.push("**Javaslatok:**");
      for (const s of suggestions) {
        const distance = s.distanceKm ? `, ${s.distanceKm} km` : "";
        lines.push(
          `- ${KIND_LABEL[s.kind]} **${s.name}** — ${huDay(s.date)} · ${s.driveMin} perc autóval${distance}`,
        );
        if (s.note) lines.push(`  _${s.note}_`);
        if (s.kind === "fishing") {
          lines.push(`  _Napkelte ${s.forecast.sunrise.slice(11, 16)}, napnyugta ${s.forecast.sunset.slice(11, 16)}_`);
        }
      }

      return lines.join("\n");
    },

    async healthCheck(ctx) {
      try {
        const forecast = await fetchForecast(ctx, cfg.latitude, cfg.longitude);
        return { ok: forecast.length > 0, detail: `${destinations().length} célpont · ${forecast.length} napos előrejelzés` };
      } catch (err) {
        return { ok: false, detail: String(err) };
      }
    },
  };
}

interface OpenMeteoResponse {
  daily?: {
    time?: string[];
    weather_code?: number[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_probability_max?: (number | null)[];
    wind_speed_10m_max?: number[];
    sunrise?: string[];
    sunset?: string[];
  };
}

async function fetchForecast(ctx: ModuleContext, lat: number, lon: number): Promise<DayForecast[]> {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("daily",
    "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,sunrise,sunset");
  url.searchParams.set("timezone", "Europe/Budapest");
  url.searchParams.set("forecast_days", "10");

  const response = await ctx.http.json<OpenMeteoResponse>(url.toString(), { signal: ctx.signal });
  const daily = response.daily;
  if (!daily?.time) throw new Error("Open-Meteo returned no daily forecast");

  return daily.time.map((date, i) => ({
    date,
    weatherCode: daily.weather_code?.[i] ?? 0,
    tempMin: daily.temperature_2m_min?.[i] ?? 0,
    tempMax: daily.temperature_2m_max?.[i] ?? 0,
    rainPct: daily.precipitation_probability_max?.[i] ?? 0,
    windKmh: daily.wind_speed_10m_max?.[i] ?? 0,
    sunrise: daily.sunrise?.[i] ?? "",
    sunset: daily.sunset?.[i] ?? "",
  }));
}

/** Saturday and Sunday of the coming weekend. */
export function nextWeekendDates(now: Date, tz: string): string[] {
  const today = dayOfWeek(now, tz);
  const daysToSaturday = (6 - today + 7) % 7;
  const saturday = addDays(now, daysToSaturday);
  return [isoDate(saturday, tz), isoDate(addDays(saturday, 1), tz)];
}

/** Returns null when the destination is out of season or the weather rules it out. */
function score(
  destination: Destination, day: DayForecast, month: number,
): { score: number; reason: string } | null {
  if (!destination.months.includes(month)) return null;
  if (day.rainPct > destination.max_rain_pct) return null;
  if (day.tempMax < destination.min_temp || day.tempMax > destination.max_temp) return null;

  const weather = describeWeather(day.weatherCode);
  let points = 100 - weather.penalty;
  const reasons: string[] = [weather.label];

  points -= day.rainPct * 0.4;
  if (day.rainPct <= 10) reasons.push("gyakorlatilag esőmentes");

  // Comfortable is the middle of the destination's own range.
  const ideal = (destination.min_temp + destination.max_temp) / 2;
  points -= Math.abs(day.tempMax - ideal) * 1.2;

  if (day.windKmh > 35) { points -= 20; reasons.push("szeles"); }
  // Every hour in the car is an hour not spent there.
  points -= destination.drive_min * 0.15;

  return { score: Math.round(points), reason: reasons.join(", ") };
}

function dedupeByName(suggestions: Suggestion[]): Suggestion[] {
  const seen = new Set<string>();
  return suggestions.filter((s) => {
    if (seen.has(s.name)) return false;
    seen.add(s.name);
    return true;
  });
}

function toProposal(suggestion: Suggestion): ActionItem {
  // Anglers want first light; everyone else wants a civilised start.
  const start = suggestion.kind === "fishing"
    ? (suggestion.forecast.sunrise || `${suggestion.date}T06:00`).slice(0, 16)
    : `${suggestion.date}T09:00`;
  const hours = suggestion.kind === "trip" ? 5 : 6;
  const startIso = `${start}:00+02:00`;
  const endIso = new Date(Date.parse(startIso) + hours * 3_600_000).toISOString();

  return {
    id: `weekend:${suggestion.date}:${suggestion.name}`,
    kind: "proposal",
    text: `${KIND_LABEL[suggestion.kind]} ${suggestion.name} — ${huDay(suggestion.date)}`,
    proposal: {
      title: `${KIND_LABEL[suggestion.kind]} ${suggestion.name}`,
      start: startIso,
      end: endIso,
      location: suggestion.name,
      notes: [
        suggestion.note,
        `${suggestion.driveMin} perc autóval${suggestion.distanceKm ? `, ${suggestion.distanceKm} km túra` : ""}`,
        `Időjárás: ${suggestion.reason}, ${Math.round(suggestion.forecast.tempMax)} °C, eső ${suggestion.forecast.rainPct}%`,
      ].filter(Boolean).join("\n"),
    },
  };
}

const HU_DAYS = ["vasárnap", "hétfő", "kedd", "szerda", "csütörtök", "péntek", "szombat"];
function huDay(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return `${HU_DAYS[d.getUTCDay()]} (${date.slice(8, 10)}.)`;
}
