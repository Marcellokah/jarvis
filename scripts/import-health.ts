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
 * that agent was up has been observed, three times, to lose imported values.
 * The cause was never established — an earlier version of this comment blamed
 * a discarded WAL, and that explanation has since been contradicted directly
 * (see `src/infra/db/holder.ts`). What survives is the observation, not the
 * mechanism.
 *
 * The response is therefore belt and braces rather than a targeted fix. This
 * script (a) refuses to start if something else already holds the database,
 * which is cheap and rules out the conditions under which the losses were
 * seen, and (b) never reports success from the connection that did the
 * writing — only from a brand new connection opened after that one has fully
 * closed. (b) is the actual guarantee: whatever the mechanism, a fresh
 * connection's count is what every later process will see.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createApp } from "../src/app.ts";
import { loadEnv } from "../src/env.ts";
import { fromRoot } from "../src/shared/paths.ts";
import { readExport } from "../src/infra/health-export/reader.ts";
import { rollup } from "../src/infra/health-export/rollup.ts";
import { withoutPartialDayTotals } from "../src/infra/health-export/partial-day.ts";
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
 * stake, imported values have been observed to go missing under exactly these
 * conditions, and the mechanism behind that is still unknown — which is a
 * reason to be more cautious, not less. Contrast `scripts/analyze.ts`, which
 * only warns: its worst case is a lost analysis, three minutes to redo.
 */
function assertDatabaseFree(): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  const holders = holdersOf(dbPath);

  if (holders.length > 0) {
    console.error(
      `Az adatbázist másik folyamat tartja nyitva (pid ${holders.join(", ")}) — `
      + "valószínűleg a launchd agent (local.jarvis.agent / src/main.ts fut). Pontosan "
      + "ilyen helyzetben veszett már el háromszor a beolvasott adat: az import "
      + "sikert jelentett, az értékek mégsem maradtak meg. Hogy miért, azt nem "
      + "sikerült kideríteni, ezért az import inkább el sem indul. "
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

// The export stops mid-day on the day it was made, so its counters for that
// day are a fraction of the real total — and fillGaps only ever fills holes,
// so writing that fraction would freeze it in the row for good. Said out loud
// for the same reason as the block above: a day total that is deliberately
// absent must not look like one that went missing.
const writable = withoutPartialDayTotals(days);
if (writable.partialDay) {
  console.log(
    `  A(z) ${writable.partialDay} nap még tartott, amikor az export készült — `
    + `${writable.withheld.length} napi összeg kimaradt`
    + `${writable.dayDropped ? ", és így ez a nap egészben kimaradt" : ""}:`,
  );
  console.log(`    ${writable.withheld.join(", ")}`);
  console.log(
    "    (az export csak a nap egy részét látta, ezért ezek az összegek "
    + "üresen maradnak — nem fél napnyi értékkel)",
  );
}

// One transaction for ~2,750 statements: without it each write would fsync on
// its own and the import would take minutes instead of seconds.
app.db.transaction(() => {
  const now = app.clock.now();
  for (const day of writable.days) app.health.fillGaps(day.date, day.values, now);
});
const newWorkouts = app.workouts.save(workouts);

// What the import intended to have on disk afterward, computed from the
// rollup's own output rather than queried — it must not depend on the
// connection whose view is about to become unreliable evidence. `days` is
// already deduped by date (the rollup groups by date internally); workouts
// are deduped here by their natural key, since INSERT OR IGNORE would legally
// collapse duplicates within a single export. Counted from what was actually
// handed to fillGaps, so a partial last day held back above cannot read as a
// day that failed to land.
const intendedDays = writable.days.length;
const intendedWorkouts = new Set(workouts.map((w) => `${w.startedAt} ${w.type}`)).size;

app.close();

// The observation this guards against: the writing connection's own COUNT(*)
// reported success, and the values were gone afterwards anyway. Why is not
// known — see `src/infra/db/holder.ts` for what was and was not established.
// Not knowing the mechanism is precisely the reason to distrust the writer's
// own view: nothing above this line is treated as evidence, and only a fresh
// connection, opened after app.close(), can say what landed on disk.
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
    + `${intendedWorkouts} edzésnek kellene lennie. Valószínűleg valami más folyamat — `
    + "jellemzően a launchd agent — tartotta nyitva az adatbázist import közben; "
    + "hogy pontosan ettől vész-e el az adat, az máig nem tisztázott. Győződj meg "
    + "róla, hogy semmi más nem éri el az adatbázist, majd futtasd újra:\n\n"
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
