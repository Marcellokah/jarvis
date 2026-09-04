import { describe, it, expect } from "vitest";
import { memoryDb, snapshot } from "../helpers.ts";
import { createHealthRepo } from "../../src/infra/db/repositories/health.ts";
import { createWorkoutRepo } from "../../src/infra/db/repositories/workouts.ts";
import { unavailableCalendar, type CalendarService } from "../../src/infra/calendar/service.ts";
import { runQuestion, type QuestionContext } from "../../src/core/agent/questions.ts";

/**
 * The observation text alone. `runQuestion` also reports whether the answer
 * is evidence; that flag has its own tests in agent-questions-read.test.ts.
 */
const ask = (name: string, args: Record<string, unknown>, c: QuestionContext): Promise<string> =>
  runQuestion(name, args, c).then((r) => r.observation);


interface CalendarEvent {
  uid: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  calendar: string;
}

const calendarWith = (events: CalendarEvent[]): CalendarService => ({
  ...unavailableCalendar("test"),
  async listEvents(from: Date, to: Date) {
    return events.filter((e) => {
      const start = new Date(e.start).getTime();
      return start >= from.getTime() && start <= to.getTime();
    });
  },
});

function ctx(calendar: CalendarService = unavailableCalendar("test")): QuestionContext {
  const db = memoryDb();
  const workouts = createWorkoutRepo(db);
  workouts.save([{
    date: "2026-09-01", type: "TraditionalStrengthTraining",
    startedAt: "2026-09-01T17:00:00.000Z", durationMin: 54.7, energyKcal: 300, source: "Watch",
  }]);
  return { health: createHealthRepo(db), workouts, calendar, today: "2026-09-04" };
}

describe("edzesek", () => {
  it("lists workouts in the range with rounded durations", async () => {
    const out = await ask("edzesek", { tol: "2026-09-01", ig: "2026-09-04" }, ctx());
    expect(out).toContain("TraditionalStrengthTraining");
    expect(out).toContain("55 perc");
  });

  it("says so when the range is empty", async () => {
    const out = await ask("edzesek", { tol: "2026-01-01", ig: "2026-01-05" }, ctx());
    expect(out).toContain("nincs edzés");
  });

  it("indicates truncation when more than 40 workouts are returned", async () => {
    const db = memoryDb();
    const workouts = createWorkoutRepo(db);
    // Create 50 workouts across distinct days to ensure we have more than 40
    const workoutList = Array.from({ length: 50 }, (_, i) => {
      const month = i < 31 ? "09" : "10";
      const day = (i % 31) + 1;
      return {
        date: `2026-${month}-${String(day).padStart(2, "0")}`,
        type: "Run",
        startedAt: `2026-${month}-${String(day).padStart(2, "0")}T${String(Math.floor(i / 31)).padStart(2, "0")}:00:00.000Z`,
        durationMin: 30,
        energyKcal: 300,
        source: "Watch" as const,
      };
    });
    workouts.save(workoutList);
    const testCtx = { health: createHealthRepo(db), workouts, calendar: unavailableCalendar("test"), today: "2026-10-31" };
    const out = await ask("edzesek", { tol: "2026-09-01", ig: "2026-10-31" }, testCtx);
    expect(out).toContain("… és még 10 edzés a tartományban");
  });
});

describe("naptar", () => {
  it("lists events when the calendar is configured", async () => {
    const out = await ask("naptar", { tol: "2026-09-04", ig: "2026-09-05" }, ctx(calendarWith([{
      uid: "dentist", title: "Fogorvos", start: "2026-09-04T08:00:00.000Z", end: "2026-09-04T09:00:00.000Z",
      allDay: false, calendar: "Naptár",
    }])));
    expect(out).toContain("Fogorvos");
  });

  it("reports an unconfigured calendar as absent, not as an empty day", async () => {
    const out = await ask("naptar", { tol: "2026-09-04", ig: "2026-09-05" }, ctx());
    expect(out).toContain("nincs bekötve");
  });

  it("catches events at local midnight boundary that UTC would drop", async () => {
    // This event is at 2026-09-03T23:30:00Z, which in Budapest (UTC+2 in September)
    // is 2026-09-04 01:30 local time. The UTC-based code would query
    // [2026-09-04T00:00Z, ...] and miss this event because it's before that.
    // The timezone-aware code should catch it because it queries
    // [2026-09-03T22:00Z, ...] (2026-09-04 00:00 local).
    const out = await ask("naptar", { tol: "2026-09-04", ig: "2026-09-04" }, ctx(calendarWith([{
      uid: "boundary", title: "Éjfél körüli", start: "2026-09-03T23:30:00.000Z", end: "2026-09-03T23:45:00.000Z",
      allDay: false, calendar: "Naptár",
    }])));
    expect(out).toContain("Éjfél körüli");
  });

  it("indicates truncation when more than 40 events are returned", async () => {
    // Create 50 events spread across September and October, all within a date range
    const events = Array.from({ length: 50 }, (_, i) => {
      const month = i < 31 ? "09" : "10";
      const day = (i % 31) + 1;
      return {
        uid: `e${i}`,
        title: `Event ${i + 1}`,
        start: `2026-${month}-${String(day).padStart(2, "0")}T08:00:00.000Z`,
        end: `2026-${month}-${String(day).padStart(2, "0")}T09:00:00.000Z`,
        allDay: false,
        calendar: "Naptár",
      };
    });
    const out = await ask("naptar", { tol: "2026-09-01", ig: "2026-10-31" }, ctx(calendarWith(events)));
    expect(out).toContain("… és még 10 esemény a tartományban");
  });
});
