/**
 * Imports an Apple Health export into the daily history.
 *
 *   npm run import-health -- ~/Downloads/export.zip
 *   npm run import-health -- ./export.xml          # already unzipped
 *
 * Safe to re-run. The export is a snapshot of everything Health holds, so a
 * monthly run replays years of the same days — the writes are built to be
 * no-ops for anything already stored, and to never overwrite a measurement the
 * phone posted.
 *
 * The launchd agent (`local.jarvis.agent`, running `src/main.ts`) holds its
 * own long-lived connection to the same database. Running this import while
 * that agent is up has been observed, repeatedly, to lose every row: the
 * writes commit, are even briefly visible to an outside reader, and then
 * vanish once the agent's connection is eventually the one to close the
 * database and discard its WAL. So this script (a) refuses to start if
 * something else already holds the database, and (b) never reports success
 * from the connection that did the writing — only from a brand new
 * connection opened after that one has fully closed, because that is the
 * only view that matches what every later process will actually see.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createApp } from "../src/app.ts";
import { loadEnv } from "../src/env.ts";
import { fromRoot } from "../src/shared/paths.ts";
import { readExport } from "../src/infra/health-export/reader.ts";
import { rollup } from "../src/infra/health-export/rollup.ts";
import { agentFix, holdersOf } from "../src/infra/db/holder.ts";

process.env.LOG_LEVEL ??= "error";

const path = process.argv[2];
if (!path) {
  console.error("Használat: npm run import-health -- <export.zip vagy export.xml>");
  process.exit(64);
}

const env = loadEnv();
const dbPath = fromRoot(env.JARVIS_DB);

/**
 * Fails fast, before the several-second read of a ~1 GB export, if the
 * database is already held open by another process — in practice, the
 * launchd agent (`local.jarvis.agent`, running `src/main.ts`).
 *
 * This refuses to run rather than warn: seven years of health history is at
 * stake here, and losing it to a silently-dropped WAL is not recoverable by
 * re-running the import. Contrast `scripts/analyze.ts`, which only warns —
 * its worst case is a lost analysis, three minutes to redo.
 */
function assertDatabaseFree(): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  const holders = holdersOf(dbPath);

  if (holders.length > 0) {
    console.error(
      `Az adatbázist másik folyamat tartja nyitva (pid ${holders.join(", ")}) — `
      + "valószínűleg a launchd agent (local.jarvis.agent / src/main.ts fut). Amíg az "
      + "fut, az import azt hiheti, hogy sikerült, de az adat nem marad meg: a "
      + "WAL-ban landol, és eltűnik, amikor az agent zárja be utoljára a kapcsolatot. "
      + "Állítsd le, importálj, indítsd újra:\n\n"
      + agentFix("npm run import-health -- ~/Downloads/export.zip"),
    );
    process.exit(1);
  }
}

assertDatabaseFree();

const app = createApp({ env });
const started = Date.now();

console.log(`Olvasás: ${path}`);
const { days, workouts, skipped, range } = await rollup(readExport(path));

if (!range) {
  console.error("Az export nem tartalmazott feldolgozható rekordot.");
  app.close();
  process.exit(1);
}

console.log(`  ${days.length} nap · ${workouts.length} edzés · ${range.from} .. ${range.to}`);

// Days where more than one source recorded the same thing: iPhone, Watch and
// third-party apps all write raw samples over the same minutes, and the rollup
// has to union or choose between them. The number stored on such a day is the
// result of that decision rather than of a single measurement, so it is said
// out loud here — this is where a later "why does that day look like that?"
// gets answered.
const contested = days.filter((d) => Object.keys(d.contested).length > 0);
if (contested.length > 0) {
  const marks = contested.flatMap((d) => Object.values(d.contested));
  const unions = marks.filter((m) => m.resolution === "union").length;
  const picks = marks.length - unions;
  console.log(
    `  Több forrás versengett ${contested.length} napon `
    + `(${unions} idősáv egyesítve, ${picks} forrásválasztás):`,
  );
  for (const d of contested.slice(0, 3)) {
    const detail = Object.entries(d.contested)
      .map(([column, m]) => `${column}=${m.chosen ?? "egyesítve"} [${m.sources.join(", ")}]`)
      .join(" · ");
    console.log(`    ${d.date}  ${detail}`);
  }
  if (contested.length > 3) console.log(`    … és további ${contested.length - 3} nap`);
}

// One transaction for ~2,750 statements: without it each write would fsync on
// its own and the import would take minutes instead of seconds.
app.db.transaction(() => {
  const now = app.clock.now();
  for (const day of days) app.health.fillGaps(day.date, day.values, now);
});
const newWorkouts = app.workouts.save(workouts);

// What the import intended to have on disk afterward, computed from the
// rollup's own output rather than queried — it must not depend on the
// connection whose view is about to become unreliable evidence. `days` is
// already deduped by date (the rollup groups by date internally); workouts
// are deduped here by their natural key, since INSERT OR IGNORE would legally
// collapse duplicates within a single export.
const intendedDays = days.length;
const intendedWorkouts = new Set(workouts.map((w) => `${w.startedAt} ${w.type}`)).size;

app.close();

// The defect this guards against: the writing connection's own COUNT(*) kept
// reporting success right up until the database was closed, because the
// launchd agent's long-held connection silently discarded the WAL when IT
// was eventually the last one to close. Nothing above this line is trusted
// as evidence — only a fresh connection, opened after app.close(), can say
// what actually landed on disk.
const verify = new DatabaseSync(dbPath, { readOnly: true });
const stored =
  (verify.prepare("SELECT COUNT(*) AS n FROM health_snapshots").get() as { n: number }).n;
const totalWorkouts =
  (verify.prepare("SELECT COUNT(*) AS n FROM workouts").get() as { n: number }).n;
verify.close();

if (stored < intendedDays || totalWorkouts < intendedWorkouts) {
  console.error(
    `\nAz import nem maradt meg: egy friss kapcsolat csak ${stored} napot és `
    + `${totalWorkouts} edzést lát, pedig legalább ${intendedDays} napnak és `
    + `${intendedWorkouts} edzésnek kellene lennie. Valami más folyamat — `
    + "valószínűleg a launchd agent — tartotta nyitva az adatbázist import közben, "
    + "és eldobta a WAL-t záráskor. Győződj meg róla, hogy semmi más nem éri el az "
    + "adatbázist, majd futtasd újra:\n\n"
    + agentFix("npm run import-health -- ~/Downloads/export.zip"),
  );
  process.exit(1);
}

console.log();
console.log(`✓ ${stored} nap az adatbázisban · ${totalWorkouts} edzés (ebből most új: ${newWorkouts})`);
console.log(`  ${((Date.now() - started) / 1000).toFixed(1)} másodperc`);

const ignored = Object.entries(skipped).sort((a, b) => b[1] - a[1]);

// A unit mismatch drops a whole column, and the affected types are low-volume
// (VO2Max: a few hundred records in seven years). Ranked by count they would sit
// far below the types we ignore on purpose and fall outside any top-N, so the
// column would vanish in silence -- the one outcome the unit check exists to
// prevent. These print in full, and separately.
const unitProblems = ignored.filter(([type]) => type.includes("nem várt egység"));
const onPurpose = ignored.filter(([type]) => !type.includes("nem várt egység"));

if (unitProblems.length > 0) {
  console.log();
  console.log(`⚠ Nem várt mértékegység (${unitProblems.length}) — ezek az oszlopok üresen maradtak:`);
  for (const [type, n] of unitProblems) {
    console.log(`  ${type.padEnd(52)} ${n.toLocaleString("hu-HU")}`);
  }
}

if (onPurpose.length > 0) {
  console.log();
  console.log(`Kihagyott típusok (${onPurpose.length}), a legnagyobbak:`);
  for (const [type, n] of onPurpose.slice(0, 8)) {
    console.log(`  ${type.padEnd(34)} ${n.toLocaleString("hu-HU")}`);
  }
}
