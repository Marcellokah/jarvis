import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { weekendPlanner, nextWeekendDates } from "../../src/modules/weekend-planner/index.ts";
import { memoryDb, ctxAt } from "../helpers.ts";
import { TZ } from "../../src/shared/dates.ts";
import type { CalendarService } from "../../src/infra/calendar/service.ts";
import type { Db } from "../../src/infra/db/index.ts";

// 2026-09-04 is a Friday; the coming weekend is the 5th and 6th.
const FRIDAY = "2026-09-04T06:20:00+02:00";
const METEO = "https://api.open-meteo.com/v1/forecast";

const cfg = {
  enabled: true, runOnDays: [4, 5, 6], timeoutMs: 5_000, cacheTtlMs: 60_000,
  latitude: 47.4979, longitude: 19.0402, maxSuggestions: 3,
};

function destinationsFile(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-weekend-"));
  const path = join(dir, "destinations.yaml");
  writeFileSync(path, yaml);
  return path;
}

/** Open-Meteo returns parallel arrays keyed by date. */
function forecast(days: { date: string; code: number; min: number; max: number; rain: number; wind: number }[]) {
  return {
    daily: {
      time: days.map((d) => d.date),
      weather_code: days.map((d) => d.code),
      temperature_2m_max: days.map((d) => d.max),
      temperature_2m_min: days.map((d) => d.min),
      precipitation_probability_max: days.map((d) => d.rain),
      wind_speed_10m_max: days.map((d) => d.wind),
      sunrise: days.map((d) => `${d.date}T06:20`),
      sunset: days.map((d) => `${d.date}T19:30`),
    },
  };
}

const PERFECT = forecast([
  { date: "2026-09-05", code: 0, min: 12, max: 21, rain: 5, wind: 10 },
  { date: "2026-09-06", code: 0, min: 12, max: 21, rain: 5, wind: 10 },
]);

const HIKE = `
- name: "Normafa"
  kind: hiking
  drive_min: 25
  distance_km: 9
  months: [9]
  min_temp: 5
  max_temp: 26
  max_rain_pct: 30
  note: "Kilátó."
`;

const freeCalendar: CalendarService = {
  listEvents: async () => [],
  createEvent: async () => ({ uid: "u", calendar: "Jarvis", url: "x" }),
  deleteEvent: async () => {},
  healthCheck: async () => ({ ok: true }),
};

let db: Db;
beforeEach(() => { db = memoryDb(); });
afterEach(() => db.close());

describe("weekend dates", () => {
  it("finds the coming Saturday and Sunday from a Friday", () => {
    expect(nextWeekendDates(new Date(FRIDAY), TZ)).toEqual(["2026-09-05", "2026-09-06"]);
  });

  it("treats Saturday itself as the weekend, not next week's", () => {
    expect(nextWeekendDates(new Date("2026-09-05T08:00:00+02:00"), TZ))
      .toEqual(["2026-09-05", "2026-09-06"]);
  });
});

describe("scheduling", () => {
  it("only runs Thursday to Saturday", () => {
    const mod = weekendPlanner(cfg, destinationsFile(HIKE));
    // Suggesting a Saturday hike on a Monday is noise, not a plan.
    expect(mod.schedule).toEqual({ days: [4, 5, 6] });
  });
});

describe("suitability", () => {
  it("suggests a hike in good conditions and proposes it as an event", async () => {
    const mod = weekendPlanner(cfg, destinationsFile(HIKE));
    const result = await mod.execute(ctxAt(FRIDAY, db, { [METEO]: PERFECT }, freeCalendar));

    expect(result!.data.suggestions[0]!.name).toBe("Normafa");

    const proposal = result!.actions[0];
    if (proposal?.kind !== "proposal") throw new Error("expected a calendar proposal");
    expect(proposal.proposal.start).toContain("2026-09-05T09:00");
    expect(proposal.proposal.notes).toContain("25 perc autóval");
  });

  it("rules out a hike that would be too hot", async () => {
    // 34 °C with a 26 °C ceiling: the destination's own limit, not a guess.
    const hot = forecast([
      { date: "2026-09-05", code: 0, min: 22, max: 34, rain: 2, wind: 10 },
      { date: "2026-09-06", code: 0, min: 22, max: 34, rain: 2, wind: 10 },
    ]);
    const result = await weekendPlanner(cfg, destinationsFile(HIKE))
      .execute(ctxAt(FRIDAY, db, { [METEO]: hot }, freeCalendar));

    expect(result).toBeNull();
  });

  it("rules out a destination when rain exceeds its tolerance", async () => {
    const wet = forecast([
      { date: "2026-09-05", code: 61, min: 12, max: 18, rain: 85, wind: 15 },
      { date: "2026-09-06", code: 61, min: 12, max: 18, rain: 85, wind: 15 },
    ]);
    expect(await weekendPlanner(cfg, destinationsFile(HIKE))
      .execute(ctxAt(FRIDAY, db, { [METEO]: wet }, freeCalendar))).toBeNull();
  });

  it("respects the season", async () => {
    const winterOnly = HIKE.replace("months: [9]", "months: [1, 2]");
    expect(await weekendPlanner(cfg, destinationsFile(winterOnly))
      .execute(ctxAt(FRIDAY, db, { [METEO]: PERFECT }, freeCalendar))).toBeNull();
  });

  it("prefers the nearer of two otherwise equal destinations", async () => {
    const two = `
- { name: "Közeli", kind: hiking, drive_min: 20, distance_km: 9, months: [9], min_temp: 5, max_temp: 26, max_rain_pct: 30, note: "" }
- { name: "Távoli", kind: hiking, drive_min: 120, distance_km: 9, months: [9], min_temp: 5, max_temp: 26, max_rain_pct: 30, note: "" }
`;
    const result = await weekendPlanner(cfg, destinationsFile(two))
      .execute(ctxAt(FRIDAY, db, { [METEO]: PERFECT }, freeCalendar));

    expect(result!.data.suggestions[0]!.name).toBe("Közeli");
  });
});

describe("calendar awareness", () => {
  it("does not plan a hike on a day already committed", async () => {
    const busy: CalendarService = {
      ...freeCalendar,
      listEvents: async () => [{
        uid: "e1", title: "Esküvő", calendar: "Személyes", allDay: true,
        start: "2026-09-05T00:00:00Z", end: "2026-09-06T00:00:00Z",
      }],
    };

    const result = await weekendPlanner(cfg, destinationsFile(HIKE))
      .execute(ctxAt(FRIDAY, db, { [METEO]: PERFECT }, busy));

    // Saturday is taken; Sunday is still fair game.
    expect(result!.data.busyDates).toContain("2026-09-05");
    expect(result!.data.suggestions.every((s) => s.date === "2026-09-06")).toBe(true);
  });

  it("plans normally when no calendar is configured", async () => {
    const broken: CalendarService = {
      ...freeCalendar,
      listEvents: async () => { throw new Error("not configured"); },
    };
    const result = await weekendPlanner(cfg, destinationsFile(HIKE))
      .execute(ctxAt(FRIDAY, db, { [METEO]: PERFECT }, broken));

    // One destination, offered once — the same place on both days would be
    // repetition rather than a choice.
    expect(result!.data.suggestions).toHaveLength(1);
    expect(result!.data.busyDates).toEqual([]);
  });

  it("offers each destination only once across the weekend", async () => {
    const two = `
- { name: "A", kind: hiking, drive_min: 20, distance_km: 9, months: [9], min_temp: 5, max_temp: 26, max_rain_pct: 30, note: "" }
- { name: "B", kind: hiking, drive_min: 30, distance_km: 9, months: [9], min_temp: 5, max_temp: 26, max_rain_pct: 30, note: "" }
`;
    const result = await weekendPlanner(cfg, destinationsFile(two))
      .execute(ctxAt(FRIDAY, db, { [METEO]: PERFECT }, freeCalendar));

    const names = result!.data.suggestions.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(["A", "B"]);
  });
});

describe("fishing", () => {
  it("anchors a fishing trip on sunrise", async () => {
    const fishing = `
- { name: "Omszki-tó", kind: fishing, drive_min: 20, distance_km: null, months: [9], min_temp: 10, max_temp: 32, max_rain_pct: 45, note: "" }
`;
    const mod = weekendPlanner(cfg, destinationsFile(fishing));
    const result = await mod.execute(ctxAt(FRIDAY, db, { [METEO]: PERFECT }, freeCalendar));

    const proposal = result!.actions[0];
    if (proposal?.kind !== "proposal") throw new Error("expected a calendar proposal");
    expect(proposal.proposal.start).toContain("06:20");
    expect(mod.renderPlain(result!)).toContain("Napkelte");
  });
});
