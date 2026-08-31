import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { healthAndMealPrep } from "../../src/modules/health-mealprep/index.ts";
import { createHealthRepo } from "../../src/infra/db/repositories/health.ts";
import { memoryDb, ctxAt, seedMeals, meal } from "../helpers.ts";
import type { Db } from "../../src/infra/db/index.ts";

const cfg = { enabled: true, defrostHorizonH: 24 };
const mod = healthAndMealPrep(cfg);

// 2026-08-31 is a Monday; 2026-09-01 a Tuesday.
const MONDAY_0620 = "2026-08-31T06:20:00+02:00";

let db: Db;
beforeEach(() => { db = memoryDb(); });
afterEach(() => { db.close(); });

describe("defrost reminders", () => {
  it("flags a deadline that has already passed while the meal is still ahead", async () => {
    // Monday lunch at 12:30 with a 12h lead → freezer deadline was 00:30 Monday.
    // At 06:20 that is overdue, which is exactly when the reminder matters most.
    seedMeals(db, [
      meal({ weekday: 1, meal: "ebed", item: "Csirkemell", needsDefrost: true, defrostLeadH: 12 }),
    ]);

    const result = await mod.execute(ctxAt(MONDAY_0620, db));

    expect(result).not.toBeNull();
    expect(result!.data.defrost).toHaveLength(1);
    expect(result!.data.defrost[0]).toMatchObject({ item: "Csirkemell", overdue: true });
    expect(result!.actions).toHaveLength(1);
    expect(result!.priority).toBe("critical");
  });

  it("covers tomorrow's meal whose deadline falls tonight, before the next brief", async () => {
    // Tuesday lunch 12:30 with a 14h lead → deadline 22:30 Monday. The Monday
    // morning brief is the last chance to mention it.
    seedMeals(db, [
      meal({ weekday: 2, meal: "ebed", item: "Marhapörkölt", needsDefrost: true, defrostLeadH: 14 }),
    ]);

    const result = await mod.execute(ctxAt(MONDAY_0620, db));

    expect(result!.data.defrost.map((d) => d.item)).toEqual(["Marhapörkölt"]);
    expect(result!.data.defrost[0]!.overdue).toBe(false);
  });

  it("ignores a meal that has already been eaten", async () => {
    seedMeals(db, [
      meal({ weekday: 1, meal: "reggeli", item: "Tegnapi maradék", needsDefrost: true, defrostLeadH: 2 }),
    ]);
    // 14:00 Monday — breakfast is long gone.
    const result = await mod.execute(ctxAt("2026-08-31T14:00:00+02:00", db));
    expect(result!.data.defrost).toHaveLength(0);
  });

  it("does not reach past the next brief for a distant deadline", async () => {
    // Wednesday dinner 19:00 with a 4h lead → deadline 15:00 Wednesday,
    // two briefs away. Monday should list its own meals but stay quiet about it.
    seedMeals(db, [
      meal({ weekday: 1, meal: "ebed", item: "Hétfői csirke" }),
      meal({ weekday: 3, meal: "vacsora", item: "Lazac", needsDefrost: true, defrostLeadH: 4 }),
    ]);
    const result = await mod.execute(ctxAt(MONDAY_0620, db));
    expect(result!.data.defrost).toHaveLength(0);
    expect(result!.priority).toBe("normal");
  });
});

describe("brief content", () => {
  it("renders health data pushed by the Shortcut", async () => {
    seedMeals(db, [meal({ weekday: 1, meal: "ebed", item: "Csirke", proteinG: 55 })]);
    createHealthRepo(db).upsert(
      { date: "2026-08-31", sleepH: 8.1, hrv: 62, rhr: 51, moveKcal: 640, exerciseMin: 45, steps: 9000,
        asleepMin: null, inBedMin: null, coreMin: null, remMin: null, deepMin: null,
        awakenings: null, vo2max: null, hrRecovery: null, walkingHr: null,
        basalKcal: null, flights: null, dietKcal: null, dietProteinG: null,
        dietCarbsG: null, dietFatG: null },
      {}, new Date(MONDAY_0620),
    );

    const result = await mod.execute(ctxAt(MONDAY_0620, db));
    const text = mod.renderPlain(result!);

    expect(text).toContain("8.1 óra");
    expect(text).toContain("HRV 62");
    expect(text).toContain("jó");
    expect(text).toContain("Csirke");
  });

  it("returns null when there is genuinely nothing to say", async () => {
    expect(await mod.execute(ctxAt(MONDAY_0620, db))).toBeNull();
  });
});
