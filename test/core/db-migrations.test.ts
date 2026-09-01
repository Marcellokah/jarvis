import { describe, it, expect, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/infra/db/index.ts";
import { silentLogger } from "../../src/infra/logger.ts";

// A throwaway file database per test: the migration bookkeeping only exists
// across connections, which ':memory:' cannot express. Never the real one.
const dirs: string[] = [];
const tmpDbPath = () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-db-"));
  dirs.push(dir);
  return join(dir, "test.db");
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("migrations", () => {
  it("re-opens a migrated database without re-running anything", () => {
    const path = tmpDbPath();
    openDb(path, silentLogger()).close();
    const again = openDb(path, silentLogger());
    expect(again.get<{ n: number }>("SELECT COUNT(*) AS n FROM _migrations")!.n).toBeGreaterThan(0);
    again.close();
  });

  /**
   * Migrations are keyed by filename. This branch renamed 005_health_history.sql
   * to 004_health_history.sql mid-flight: any database that had applied the old
   * name would see the new one as unapplied, re-run its ALTER TABLEs and die on
   * "duplicate column name" with nothing naming the cause. Fail on the rename
   * itself instead, before the schema is touched.
   */
  it("refuses to open when an applied migration has been renamed away", () => {
    const path = tmpDbPath();
    openDb(path, silentLogger()).close();

    // Exactly the state a rename leaves behind: applied under a name that is
    // no longer on disk.
    const raw = new DatabaseSync(path);
    raw.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)")
      .run("005_health_history.sql", new Date().toISOString());
    raw.close();

    expect(() => openDb(path, silentLogger())).toThrow(/005_health_history\.sql/);
    expect(() => openDb(path, silentLogger())).toThrow(/renamed/);
  });

  it("still closes when the database cannot be checkpointed", () => {
    // A second live connection is exactly the situation the checkpoint may not
    // be able to complete in. Tidying up is best effort; closing is not.
    const path = tmpDbPath();
    const first = openDb(path, silentLogger());
    const second = openDb(path, silentLogger());

    expect(() => first.close()).not.toThrow();
    expect(() => second.close()).not.toThrow();
  });
});
