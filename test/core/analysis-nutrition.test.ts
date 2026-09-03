import { describe, it, expect } from "vitest";
import { aggregate } from "../../src/core/analysis/aggregate.ts";
import type { HealthSnapshot } from "../../src/infra/db/repositories/health.ts";
import type { PlannedMeal } from "../../src/infra/db/repositories/meals.ts";

/** Every field null but the ones a test names. */
function snap(date: string, over: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return { date, ingestedAt: `${date}T20:00:00.000Z`,
    sleepH: null, hrv: null, rhr: null, moveKcal: null, exerciseMin: null,
    steps: null, asleepMin: null, inBedMin: null, coreMin: null, remMin: null,
    deepMin: null, awakenings: null, vo2max: null, hrRecovery: null,
    walkingHr: null, basalKcal: null, flights: null, dietKcal: null,
    dietProteinG: null, dietCarbsG: null, dietFatG: null, distanceKm: null,
    standMin: null, walkingSpeed: null, stepLengthCm: null, doubleSupportPct: null,
    asymmetryPct: null, steadinessPct: null, sixMinWalkM: null, stairUpMs: null,
    stairDownMs: null, ...over } as HealthSnapshot;
}

const meal = (weekday: number, m: string, kcal: number | null, proteinG: number | null): PlannedMeal =>
  ({ weekday, meal: m as PlannedMeal["meal"], item: "x",
     needsDefrost: false, defrostLeadH: 0, proteinG, kcal });

const run = (snapshots: HealthSnapshot[], plan: PlannedMeal[] = [], today = "2026-09-10") =>
  aggregate({ today, snapshots, workouts: [], months: [], plan }).nutrition;

describe("táplálkozási mutatók", () => {
  it("az energiaegyensúly kihagyja a hiányos napot, nem veszi nullának", () => {
    // EZ A LEGFONTOSABB ÁLLÍTÁS AZ EGÉSZ DARABBAN. Egy hiányzó aktív kalória
    // nem nulla aktivitás; nullaként beszámítva a napi egyenleg több száz
    // kalóriát hazudna.
    const m = run([
      snap("2026-09-01", { dietKcal: 2000, basalKcal: 1600, moveKcal: 400 }), // -0
      snap("2026-09-02", { dietKcal: 2000, basalKcal: 1600 }),                // kihagyva
      snap("2026-09-03", { dietKcal: 2500, basalKcal: 1600, moveKcal: 400 }), // +500
    ]);
    expect(m.balance.n).toBe(2);
    expect(m.balance.dropped).toBe(1);
    expect(m.balance.mean).toBe(250);
  });

  it("együtt-mért nap nélkül az egyenleg null, nem 0", () => {
    const m = run([snap("2026-09-01", { dietKcal: 2000 })]);
    expect(m.balance.mean).toBeNull();
    expect(m.balance.n).toBe(0);
    expect(m.balance.dropped).toBe(1);
  });

  it("megszámolja a többletes és a hiányos napokat", () => {
    const m = run([
      snap("2026-09-01", { dietKcal: 2500, basalKcal: 1600, moveKcal: 400 }),
      snap("2026-09-02", { dietKcal: 1500, basalKcal: 1600, moveKcal: 400 }),
      snap("2026-09-03", { dietKcal: 1000, basalKcal: 1600, moveKcal: 400 }),
    ]);
    expect(m.balance.over).toBe(1);
    expect(m.balance.under).toBe(2);
  });

  it("a következetesség nevezője az ELSŐ bevitel óta eltelt napok száma", () => {
    // A 2019-es napokról nem azért nincs bevitel, mert kihagytad — a rendszer
    // akkor még nem gyűjtötte. A teljes előzményre osztani hazug arányt adna.
    const m = run([
      snap("2026-01-01"),                       // jóval a bevitel előtt
      snap("2026-09-01", { dietKcal: 2000 }),
      snap("2026-09-02", { dietKcal: 2100 }),
    ]);
    expect(m.measuredDays).toBe(2);
    expect(m.windowDays).toBe(10); // 09-01 .. 09-10 bezárólag
  });

  it("a leghosszabb sorozatot a megszakítás vágja el", () => {
    const m = run([
      snap("2026-09-01", { dietKcal: 1 }),
      snap("2026-09-02", { dietKcal: 1 }),
      snap("2026-09-03", { dietKcal: 1 }),
      snap("2026-09-05", { dietKcal: 1 }),
    ]);
    expect(m.longestStreak).toEqual({ days: 3, endedOn: "2026-09-03" });
  });

  it("nulla mért napnál a sorozat null, egynél 1", () => {
    expect(run([snap("2026-09-01")]).longestStreak).toBeNull();
    expect(run([snap("2026-09-01", { dietKcal: 1 })]).longestStreak)
      .toEqual({ days: 1, endedOn: "2026-09-01" });
  });

  it("a legutóbbi mért nap dátuma a legkésőbbi, nem az utolsó sor", () => {
    const m = run([
      snap("2026-09-03", { dietKcal: 1 }),
      snap("2026-09-01", { dietKcal: 1 }),
    ]);
    expect(m.lastDate).toBe("2026-09-03");
  });

  it("a tervezett fehérje csak a teljesen beárazott napokból jön", () => {
    // Ugyanaz a szabály, amit a Táplálkozás oldal már használ: egy részösszeg
    // a teljes helyén a teljesnek olvasódik.
    const m = run([], [
      meal(1, "reggeli", 500, 30), meal(1, "ebed", 700, 50), meal(1, "vacsora", 400, 30), // 110
      meal(2, "reggeli", 500, 30), meal(2, "ebed", 700, null),                            // kihagyva
    ]);
    expect(m.plannedProteinG).toBe(110);
    expect(m.plannedKcal).toBe(1600);
  });

  it("étrend nélkül a tervezett értékek null-ok", () => {
    const m = run([snap("2026-09-01", { dietKcal: 2000 })], []);
    expect(m.plannedProteinG).toBeNull();
    expect(m.plannedKcal).toBeNull();
  });

  it("egyetlen beárazatlan nap sem ad részösszeget", () => {
    const m = run([], [meal(1, "reggeli", 500, null)]);
    expect(m.plannedProteinG).toBeNull();
  });

  it("a mért bevitel a saját mintaszámával jön", () => {
    const m = run([
      snap("2026-09-01", { dietKcal: 2000, dietProteinG: 100 }),
      snap("2026-09-02", { dietKcal: 2200, dietProteinG: null }),
    ]);
    expect(m.kcal.value).toBe(2100);
    expect(m.kcal.n).toBe(2);
    expect(m.proteinG.value).toBe(100);
    expect(m.proteinG.n).toBe(1);
  });

  it("bevitel nélkül minden mutató hiányt mond, nem nullát", () => {
    const m = run([snap("2026-09-01")]);
    expect(m.measuredDays).toBe(0);
    expect(m.lastDate).toBeNull();
    expect(m.kcal.value).toBeNull();
    expect(m.balance.mean).toBeNull();
  });

  it("két különböző, teljesen beárazott nap átlagolódik a napi tervezett fehérjében", () => {
    // weekday 1 összesen 110g, weekday 2 összesen 80g — az átlaguk a napi
    // tervezett érték (95), nem az összegük (190) és nem is csak az egyik nap.
    const m = run([], [
      meal(1, "reggeli", 500, 30), meal(1, "ebed", 700, 50), meal(1, "vacsora", 400, 30),
      meal(2, "reggeli", 300, 20), meal(2, "ebed", 600, 40), meal(2, "vacsora", 300, 20),
    ]);
    expect(m.plannedProteinG).toBe(95); // (110 + 80) / 2
  });
});
