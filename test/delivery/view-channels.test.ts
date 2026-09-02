import { describe, it, expect } from "vitest";
import { NAPI_MAG, readChannels, summarise } from "../../src/delivery/http/view/channels.ts";
import type { HealthSnapshot } from "../../src/infra/db/repositories/health.ts";

/** Egy mai sor, ahol minden null, kivéve amit a teszt megad. */
const row = (over: Partial<HealthSnapshot>): HealthSnapshot => ({
  date: "2026-09-02", sleepH: null, hrv: null, rhr: null, moveKcal: null,
  exerciseMin: null, steps: null, asleepMin: null, inBedMin: null, coreMin: null,
  remMin: null, deepMin: null, awakenings: null, vo2max: null, hrRecovery: null,
  walkingHr: null, basalKcal: null, flights: null, dietKcal: null,
  dietProteinG: null, dietCarbsG: null, dietFatG: null, distanceKm: null,
  standMin: null, walkingSpeed: null, stepLengthCm: null, doubleSupportPct: null,
  asymmetryPct: null, steadinessPct: null, sixMinWalkM: null, stairUpMs: null,
  stairDownMs: null, ingestedAt: "2026-09-02T06:00:00.000Z",
  ...over,
});

// 2026-09-02 08:00 CEST = 06:00Z; 10:00 CEST = 08:00Z; 00:30 CEST = 22:30Z előző nap.
const DELELOTT = new Date("2026-09-02T08:00:00.000Z"); // 10:00 helyi
const EJFEL_UTAN = new Date("2026-09-02T22:30:00.000Z"); // 2026-09-03 00:30 helyi

describe("napi mag", () => {
  it("csak minden nap érkező mérést tartalmaz, mindegyiket esedékes órával", () => {
    // A ritkán mértek (VO2max, járásstabilitás, hatperces séta) kimaradnak: a
    // hiányuk nem a csővezetékről mond semmit.
    expect(NAPI_MAG.map((c) => c.column)).toEqual(
      ["sleep_h", "hrv", "rhr", "steps", "move_kcal", "exercise_min"],
    );
    expect(NAPI_MAG.every((c) => c.dueHour >= 0 && c.dueHour <= 24)).toBe(true);
  });

  it("délelőtt az esti csatorna várakozik, nem maradt el", () => {
    // A pár első fele. Külön-külön mindkét fele átmegy egy olyan
    // implementáción, ami az esedékességet figyelmen kívül hagyja — együtt nem.
    const r = readChannels(row({ sleepH: 7.1, hrv: 67.7, rhr: 55 }), DELELOTT);
    const steps = r.find((x) => x.channel.column === "steps")!;
    expect(steps.state).toBe("varakozik");
    expect(summarise(r).missing).toBe(0);
  });

  it("éjfél után ugyanaz a hiány már elmaradt", () => {
    const r = readChannels(row({ sleepH: 7.1, hrv: 67.7, rhr: 55 }), EJFEL_UTAN);
    const steps = r.find((x) => x.channel.column === "steps")!;
    expect(steps.state).toBe("elmaradt");
    expect(summarise(r).missingLabels).toContain(steps.channel.label);
  });

  it("a megérkezett értéket embernek formázva adja", () => {
    const r = readChannels(row({ sleepH: 7.1, hrv: 67.7, rhr: 55, steps: 6753 }), EJFEL_UTAN);
    const byColumn = new Map(r.map((x) => [x.channel.column, x]));
    expect(byColumn.get("sleep_h")!.state).toBe("erkezett");
    expect(byColumn.get("sleep_h")!.value).toBe("7,1 óra");
    expect(byColumn.get("steps")!.value).toBe("6 753 lépés");
  });

  it("mai sor nélkül minden csatorna várakozik vagy elmaradt, de egyik sem nulla", () => {
    // Ez a hiba, aminek a megelőzésére az egész rendszer épül: a hiányzó
    // mérés soha nem jelenhet meg nullaként.
    const r = readChannels(undefined, EJFEL_UTAN);
    expect(r).toHaveLength(NAPI_MAG.length);
    expect(r.every((x) => x.value === null)).toBe(true);
    expect(summarise(r).arrived).toBe(0);
  });

  it("a nulla mérés valódi mérés", () => {
    // Nulla lépés egy ágyban töltött napon igaz. Csak a null jelent hiányt.
    const r = readChannels(row({ steps: 0 }), EJFEL_UTAN);
    const steps = r.find((x) => x.channel.column === "steps")!;
    expect(steps.state).toBe("erkezett");
    expect(steps.value).toBe("0 lépés");
  });
});
