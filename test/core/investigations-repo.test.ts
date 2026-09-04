import { describe, it, expect } from "vitest";
import { memoryDb } from "../helpers.ts";
import { createInvestigationRepo } from "../../src/infra/db/repositories/investigations.ts";

describe("investigations repo", () => {
  it("stores a finished investigation and reads it back whole", () => {
    const repo = createInvestigationRepo(memoryDb());
    repo.record({
      startedAt: new Date("2026-09-04T05:00:00.000Z"),
      goal: "Miért alacsonyabb ma a regeneráció?",
      outcome: "kesz",
      finding: "Két rossz éjszaka után vagy.",
      falsifiedBy: 2,
      cites: [1, 2],
      transcript: [
        { step: { name: "nap", args: { datum: "2026-09-04" }, why: "a mai nap" }, observation: "alvas=6.6", evidence: true },
        { step: { name: "hipotezis", args: { allitas: "X" }, why: "" }, observation: "rögzítve" },
      ],
      usd: 0.21,
    });

    const [row] = repo.recent(10);
    expect(row!.goal).toBe("Miért alacsonyabb ma a regeneráció?");
    expect(row!.outcome).toBe("kesz");
    expect(row!.finding).toBe("Két rossz éjszaka után vagy.");
    expect(row!.transcript).toHaveLength(2);
    expect(row!.transcript[0]!.step.name).toBe("nap");
    expect(row!.usd).toBeCloseTo(0.21, 4);
  });

  /**
   * 009's comment promises the stored row can be audited: that a fluent wrong
   * conclusion is caught by reading the steps behind it. Without these two
   * columns it could not answer the first question of that audit — which step
   * tested the claim — because the accepted "kesz" is the one step the loop
   * never pushes onto the transcript.
   */
  it("keeps the falsification step and the citations next to the finding", () => {
    const repo = createInvestigationRepo(memoryDb());
    repo.record({
      startedAt: new Date("2026-09-04T05:00:00.000Z"),
      goal: "Miért 203,6 a HRV?", outcome: "kesz",
      finding: "A mérési mód változott.",
      falsifiedBy: 3, cites: [1, 3],
      transcript: [], usd: 0.23,
    });
    const [row] = repo.recent(10);
    expect(row!.falsifiedBy).toBe(3);
    expect(row!.cites).toEqual([1, 3]);
  });

  it("leaves them empty for an outcome that never produced a finding", () => {
    const repo = createInvestigationRepo(memoryDb());
    repo.record({
      startedAt: new Date("2026-09-04T05:00:00.000Z"),
      goal: "cél", outcome: "kerdezz", finding: "Mi változott?", transcript: [], usd: 0.02,
    });
    const [row] = repo.recent(10);
    expect(row!.falsifiedBy).toBeNull();
    expect(row!.cites).toEqual([]);
  });

  it("keeps the evidence flag through a round trip, so the audit sees what refuted what", () => {
    const repo = createInvestigationRepo(memoryDb());
    repo.record({
      startedAt: new Date("2026-09-04T05:00:00.000Z"),
      goal: "cél", outcome: "kesz", finding: "x", falsifiedBy: 1, cites: [1],
      transcript: [
        { step: { name: "nap", args: {}, why: "" }, observation: "adat", evidence: true },
        { step: { name: "nap", args: {}, why: "" }, observation: "nincs sor", evidence: false },
      ],
      usd: 0,
    });
    const [row] = repo.recent(10);
    expect(row!.transcript.map((e) => e.evidence)).toEqual([true, false]);
  });

  it("keeps a run that ran out of steps, with no finding", () => {
    const repo = createInvestigationRepo(memoryDb());
    repo.record({
      startedAt: new Date("2026-09-04T05:00:00.000Z"),
      goal: "cél", outcome: "kifutott", finding: null, transcript: [], usd: 0.05,
    });
    const [row] = repo.recent(10);
    expect(row!.outcome).toBe("kifutott");
    expect(row!.finding).toBeNull();
  });

  it("returns newest first, and null when nothing was ever run", () => {
    const repo = createInvestigationRepo(memoryDb());
    expect(repo.lastAt()).toBeNull();
    for (const iso of ["2026-09-01T05:00:00.000Z", "2026-09-03T05:00:00.000Z", "2026-09-02T05:00:00.000Z"]) {
      repo.record({ startedAt: new Date(iso), goal: iso, outcome: "kifutott", finding: null, transcript: [], usd: 0 });
    }
    expect(repo.recent(3).map((r) => r.goal)).toEqual([
      "2026-09-03T05:00:00.000Z", "2026-09-02T05:00:00.000Z", "2026-09-01T05:00:00.000Z",
    ]);
    expect(repo.lastAt()).toBe("2026-09-03T05:00:00.000Z");
  });
});
