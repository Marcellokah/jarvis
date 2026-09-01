import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "../logger.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, "migrations");

/**
 * Thin wrapper over node:sqlite. Modules depend on this rather than the raw
 * handle, which keeps the sqlite API out of module code and makes stubbing easy.
 */
export interface Db {
  get<T>(sql: string, ...params: unknown[]): T | undefined;
  all<T>(sql: string, ...params: unknown[]): T[];
  run(sql: string, ...params: unknown[]): void;
  transaction<T>(fn: () => T): T;
  close(): void;
}

export function openDb(path: string, logger: Logger): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  const handle = new DatabaseSync(path);
  handle.exec("PRAGMA journal_mode = WAL");
  handle.exec("PRAGMA foreign_keys = ON");
  handle.exec("PRAGMA busy_timeout = 5000");

  // node:sqlite refuses a second BEGIN on the same connection, but a caller
  // that wants two repositories' writes atomic (e.g. a notification row and
  // its dedupe keys) has no way to avoid calling into a repository that
  // already wraps its own single write in a transaction. Depth tracking makes
  // `transaction` reentrant: only the outermost call touches BEGIN/COMMIT: an
  // inner failure still rolls back the whole thing, since its error
  // propagates up to the outermost catch.
  let txDepth = 0;

  const db: Db = {
    get<T>(sql: string, ...params: unknown[]): T | undefined {
      return handle.prepare(sql).get(...(params as never[])) as T | undefined;
    },
    all<T>(sql: string, ...params: unknown[]): T[] {
      return handle.prepare(sql).all(...(params as never[])) as T[];
    },
    run(sql: string, ...params: unknown[]): void {
      handle.prepare(sql).run(...(params as never[]));
    },
    transaction<T>(fn: () => T): T {
      const outermost = txDepth === 0;
      if (outermost) handle.exec("BEGIN");
      txDepth++;
      try {
        const out = fn();
        txDepth--;
        if (outermost) handle.exec("COMMIT");
        return out;
      } catch (err) {
        txDepth--;
        if (outermost) handle.exec("ROLLBACK");
        throw err;
      }
    },
    close() {
      // Fold the WAL back into the database file before letting go of it, so
      // every process leaves the database self-contained on disk. Best effort
      // on purpose: a checkpoint can legitimately fail (another connection is
      // still reading), and failing to tidy up must never turn into a failure
      // to close.
      try {
        handle.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch (err) {
        logger.debug({ err: String(err) }, "wal checkpoint before close failed");
      }
      handle.close();
    },
  };

  migrate(handle, logger);
  return db;
}

function migrate(handle: DatabaseSync, logger: Logger): void {
  handle.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = new Set(
    (handle.prepare("SELECT name FROM _migrations").all() as { name: string }[]).map((r) => r.name),
  );

  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  const onDisk = new Set(files);

  // Migrations are keyed by filename and nothing else, so renaming one that has
  // already run makes it look unapplied: it re-runs, an ALTER TABLE hits a
  // column that already exists, and the process dies on "duplicate column name"
  // with nothing pointing at the rename. Refuse before touching the schema, and
  // say what happened — this has already been a live hazard once, when
  // 005_health_history.sql became 004_health_history.sql mid-branch.
  for (const name of applied) {
    if (onDisk.has(name)) continue;
    throw new Error(
      `Migration ${name} is recorded as applied but no longer exists in ${MIGRATIONS_DIR}. `
      + "An applied migration must never be renamed or deleted: the database identifies "
      + "migrations by filename, so the file under its new name would be re-applied against "
      + "a schema that already has it. Restore the original filename.",
    );
  }

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    handle.exec("BEGIN");
    try {
      handle.exec(sql);
      handle
        .prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)")
        .run(file, new Date().toISOString());
      handle.exec("COMMIT");
      logger.info({ migration: file }, "migration applied");
    } catch (err) {
      handle.exec("ROLLBACK");
      throw new Error(`Migration ${file} failed: ${String(err)}`);
    }
  }
}
