import { describe, it, expect } from "vitest";
import { memoryDb, snapshot } from "../helpers.ts";
import { createHealthRepo } from "../../src/infra/db/repositories/health.ts";
import { createWorkoutRepo } from "../../src/infra/db/repositories/workouts.ts";
import { unavailableCalendar, type CalendarService } from "../../src/infra/calendar/service.ts";
import { runQuestion, type QuestionContext } from "../../src/core/agent/questions.ts";

const calendarWith = (titles: string[]): CalendarService => ({
  ...unavailableCalendar("test"),
  async listEvents() {
    return titles.map((title, i) => ({
      uid: `u${i}`, title, start: "2026-09-04T08:00:00.000Z", end: "2026-09-04T09:00:00.000Z",
      allDay: false, calendar: "Naptár",
    }));
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
    const out = await runQuestion("edzesek", { tol: "2026-09-01", ig: "2026-09-04" }, ctx());
    expect(out).toContain("TraditionalStrengthTraining");
    expect(out).toContain("55 perc");
  });

  it("says so when the range is empty", async () => {
    const out = await runQuestion("edzesek", { tol: "2026-01-01", ig: "2026-01-05" }, ctx());
    expect(out).toContain("nincs edzés");
  });
});

describe("naptar", () => {
  it("lists events when the calendar is configured", async () => {
    const out = await runQuestion("naptar", { tol: "2026-09-04", ig: "2026-09-05" }, ctx(calendarWith(["Fogorvos"])));
    expect(out).toContain("Fogorvos");
  });

  it("reports an unconfigured calendar as absent, not as an empty day", async () => {
    const out = await runQuestion("naptar", { tol: "2026-09-04", ig: "2026-09-05" }, ctx());
    expect(out).toContain("nincs bekötve");
  });
});
