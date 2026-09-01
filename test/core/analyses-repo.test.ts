import { describe, it, expect } from "vitest";
import { memoryDb } from "../helpers.ts";
import { createAnalysisRepo } from "../../src/infra/db/repositories/analyses.ts";
import { createHealthRepo } from "../../src/infra/db/repositories/health.ts";

const base = { markdown: "# szöveg", summary: "összegzés", metrics: "{}" };

describe("analysis repo", () => {
  it("returns the most recent entries for one domain, newest first", () => {
    const db = memoryDb();
    const repo = createAnalysisRepo(db);

    repo.save({ createdAt: "2026-06-01T08:00:00.000Z", domain: "physical", ...base, summary: "első" });
    repo.save({ createdAt: "2026-07-01T08:00:00.000Z", domain: "physical", ...base, summary: "második" });
    repo.save({ createdAt: "2026-08-01T08:00:00.000Z", domain: "physical", ...base, summary: "harmadik" });
    repo.save({ createdAt: "2026-08-02T08:00:00.000Z", domain: "recovery", ...base, summary: "más terület" });

    expect(repo.recent("physical", 2).map((r) => r.summary)).toEqual(["harmadik", "második"]);
    db.close();
  });

  it("keeps domains apart", () => {
    const db = memoryDb();
    const repo = createAnalysisRepo(db);
    repo.save({ createdAt: "2026-08-01T08:00:00.000Z", domain: "finance", ...base });
    expect(repo.recent("physical", 3)).toEqual([]);
    db.close();
  });

  it("returns every domain from the latest run", () => {
    const db = memoryDb();
    const repo = createAnalysisRepo(db);
    repo.save({ createdAt: "2026-07-01T08:00:00.000Z", domain: "physical", ...base, summary: "régi" });
    repo.save({ createdAt: "2026-08-01T09:00:00.000Z", domain: "physical", ...base, summary: "friss fizikai" });
    repo.save({ createdAt: "2026-08-01T09:01:00.000Z", domain: "recovery", ...base, summary: "friss regen" });

    const run = repo.latestRun();
    expect(run.map((r) => r.summary).sort()).toEqual(["friss fizikai", "friss regen"]);
    db.close();
  });

  it("stores the metrics that produced a finding, so it can be checked later", () => {
    const db = memoryDb();
    const repo = createAnalysisRepo(db);
    repo.save({ createdAt: "2026-08-01T08:00:00.000Z", domain: "physical", ...base, metrics: '{"loadRatio":0.8}' });
    expect(JSON.parse(repo.recent("physical", 1)[0]!.metrics)).toEqual({ loadRatio: 0.8 });
    db.close();
  });
});

describe("health repo between", () => {
  it("returns the range inclusive at both ends, oldest first", () => {
    const db = memoryDb();
    const repo = createHealthRepo(db);
    const now = new Date("2026-08-31T00:00:00.000Z");
    for (const d of ["2026-08-01", "2026-08-15", "2026-08-31", "2026-09-01"]) {
      repo.fillGaps(d, { steps: 1000 }, now);
    }
    expect(repo.between("2026-08-01", "2026-08-31").map((r) => r.date))
      .toEqual(["2026-08-01", "2026-08-15", "2026-08-31"]);
    db.close();
  });
});
