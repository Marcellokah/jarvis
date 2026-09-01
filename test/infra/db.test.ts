import { describe, it, expect } from "vitest";
import { memoryDb } from "../helpers.ts";

/**
 * `Db.transaction` is reentrant (src/infra/db/index.ts): a depth counter lets
 * a caller nest a call into a repository that already wraps its own write in
 * a transaction, without node:sqlite's "cannot start a transaction within a
 * transaction" error. That counter previously decremented in two places —
 * once at the end of `try`, once in `catch` — so a failing COMMIT (control
 * falls out of `try` into `catch`) decremented twice and wedged every later
 * transaction into silent autocommit for the rest of the process. This file
 * is the direct coverage that regression needs, plus the plain-commit,
 * plain-rollback, and nesting behaviour the counter has to preserve.
 */
describe("Db.transaction", () => {
  function withTable() {
    const db = memoryDb();
    db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    const rows = () => db.all<{ id: number; v: string }>("SELECT id, v FROM t ORDER BY id");
    return { db, rows };
  }

  it("commits a plain transaction", () => {
    const { db, rows } = withTable();
    db.transaction(() => {
      db.run("INSERT INTO t (v) VALUES (?)", "a");
    });
    expect(rows()).toEqual([{ id: 1, v: "a" }]);
    db.close();
  });

  it("rolls back a throwing transaction", () => {
    const { db, rows } = withTable();
    expect(() =>
      db.transaction(() => {
        db.run("INSERT INTO t (v) VALUES (?)", "a");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(rows()).toEqual([]);
    db.close();
  });

  it("commits a nested transaction as one unit", () => {
    const { db, rows } = withTable();
    db.transaction(() => {
      db.run("INSERT INTO t (v) VALUES (?)", "outer");
      db.transaction(() => {
        db.run("INSERT INTO t (v) VALUES (?)", "inner");
      });
    });
    expect(rows().map((r) => r.v)).toEqual(["outer", "inner"]);
    db.close();
  });

  it("rolls back the outer work when an inner scope throws", () => {
    const { db, rows } = withTable();
    expect(() =>
      db.transaction(() => {
        db.run("INSERT INTO t (v) VALUES (?)", "outer");
        db.transaction(() => {
          db.run("INSERT INTO t (v) VALUES (?)", "inner");
          throw new Error("boom");
        });
      }),
    ).toThrow("boom");
    // Neither row lands: there is no SAVEPOINT under the inner scope, so an
    // uncaught inner failure takes the whole outer transaction down with it.
    expect(rows()).toEqual([]);
    db.close();
  });

  it("still begins and rolls back a later transaction after a commit fails", () => {
    const { db, rows } = withTable();

    // Force the outer COMMIT to fail without touching a second connection or
    // the disk: committing manually from inside the callback closes the
    // transaction early, so `transaction()`'s own COMMIT afterwards has
    // nothing left to commit and throws "cannot commit - no transaction is
    // active". That is the same shape SQLITE_BUSY or a full disk would
    // produce at that call site — a COMMIT that throws after `fn` already
    // returned successfully — without depending on real disk or lock
    // contention that would make the test flaky or platform-specific.
    expect(() =>
      db.transaction(() => {
        db.run("INSERT INTO t (v) VALUES (?)", "committed-early");
        db.run("COMMIT");
      }),
    ).toThrow();
    // The early manual commit is a real commit: that row does exist. This is
    // not what the test is about — it exists to force `transaction()`'s own
    // COMMIT to fail, not to be asserted on.

    // The regression: with the double-decrement bug, txDepth was left at -1
    // here, so this call would see itself as non-outermost, skip BEGIN, and
    // the insert below would autocommit instead of rolling back.
    expect(() =>
      db.transaction(() => {
        db.run("INSERT INTO t (v) VALUES (?)", "should-not-land");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(rows().map((r) => r.v)).not.toContain("should-not-land");

    // And a normal, successful transaction after that still commits — the
    // counter is back at a healthy 0, not stuck below it.
    db.transaction(() => {
      db.run("INSERT INTO t (v) VALUES (?)", "after-recovery");
    });
    expect(rows().map((r) => r.v)).toContain("after-recovery");

    db.close();
  });
});
