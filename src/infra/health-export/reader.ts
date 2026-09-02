import { createReadStream, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

export interface HealthRecordEntry {
  kind: "record";
  /** Apple's identifier prefix stripped: 'RestingHeartRate', 'SleepAnalysis'. */
  type: string;
  unit: string | null;
  /** Raw. Numeric parsing belongs to the rollup, which knows what each type means. */
  value: string;
  /** Verbatim, e.g. '2026-03-01 23:10:00 +0100'. Not ISO 8601. */
  startDate: string;
  endDate: string;
  source: string;
}

export interface WorkoutEntry {
  kind: "workout";
  type: string;
  durationMin: number;
  energyKcal: number | null;
  startDate: string;
  endDate: string;
  source: string;
}

/**
 * A piece of the export this reader did not turn into a record.
 *
 * Two different things travel this channel, and the difference matters:
 *
 *  - Read but *not trusted*: a <Record> with no type or start, a value in a
 *    unit this project does not store. Something was measured and is now not
 *    being stored — a real, if small, loss.
 *  - Read but *already counted*: the second copy of a food entry, the one
 *    Apple nests inside a <Correlation>. Nothing is lost; the identical
 *    top-level <Record> is what gets stored.
 *
 * Both are yielded rather than silently dropped, because a silent drop is
 * indistinguishable downstream from data that was never recorded, and the
 * rollup's `skipped` map is what the import prints. `reason` is the stable,
 * human-readable key that groups them there — one line per reason, with a
 * count, not one line per discarded record. The import splits the two apart
 * when it prints, so a de-duplication never reads as a loss.
 */
export interface DroppedEntry {
  kind: "dropped";
  reason: string;
}

/**
 * The `reason` for the nested half of a food entry.
 *
 * Exported so `scripts/import-health.ts` can pull it out of the "skipped"
 * list by identity instead of by matching on prose. Everything else in that
 * list is data that did not make it in; this one is data that made it in
 * exactly once, and printing it alongside the others would say the opposite.
 */
export const FOOD_CORRELATION_DUPLICATE =
  "Correlation: ugyanaz az étel-rekord, felül önállóan is szerepel";

export type ExportEntry = HealthRecordEntry | WorkoutEntry | DroppedEntry;

/**
 * Units this reader refuses to reinterpret.
 *
 * Apple writes `durationUnit` on every workout and a `unit` on every
 * statistic, both following the phone's locale. Nothing here converts: a
 * duration silently read as hours instead of minutes, or kJ read as kcal,
 * produces a confident number that is simply wrong. Mismatches are reported.
 */
const WORKOUT_DURATION_UNIT = "min";
const WORKOUT_ENERGY_UNIT = "kcal";

/** Fixed location of the XML inside every Apple Health export archive. */
const ZIP_MEMBER = "apple_health_export/export.xml";

/** Outcome of the `unzip` child process, resolved once — never sampled mid-flight. */
interface ZipExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: Error;
}

const ATTR = /(\w+)="([^"]*)"/g;

function attrs(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of line.matchAll(ATTR)) out[m[1]!] = m[2]!;
  return out;
}

/** 'HKQuantityTypeIdentifierRestingHeartRate' -> 'RestingHeartRate'. */
function shortType(raw: string): string {
  return raw
    .replace("HKQuantityTypeIdentifier", "")
    .replace("HKCategoryTypeIdentifier", "")
    .replace("HKWorkoutActivityType", "");
}

/**
 * Streams the export.
 *
 * Node has no built-in zip reader and this project takes no new runtime
 * dependencies, so a `.zip` is piped through `unzip -p`. Accepting a plain
 * `.xml` as well is what lets the tests use a hand-written fixture with no
 * archive machinery at all — the 1 GB real export never belongs in a test.
 */
export async function* readExport(path: string): AsyncGenerator<ExportEntry> {
  if (!existsSync(path)) throw new Error(`No such export file: ${path}`);

  const isZip = path.endsWith(".zip");

  let stream: Readable;
  let child: ReturnType<typeof spawn> | undefined;
  // Resolved once, from the child's 'close'/'error' event. Awaited only after the
  // line loop ends, so it never races: the loop already reflects everything the
  // child wrote to stdout by the time this settles, whichever fires first.
  let exitInfo: Promise<ZipExit> | undefined;
  const stderrChunks: Buffer[] = [];

  if (isZip) {
    child = spawn("unzip", ["-p", path, ZIP_MEMBER]);
    stream = child.stdout!;
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    exitInfo = new Promise((resolveExit) => {
      child!.on("error", (spawnError) => resolveExit({ code: null, signal: null, spawnError }));
      child!.on("close", (code, signal) => resolveExit({ code, signal }));
    });
  } else {
    stream = createReadStream(path);
  }

  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  // A workout's energy arrives in a child element after its opening tag, so the
  // workout is held back until its block closes.
  let pending: WorkoutEntry | undefined;
  // How many <Correlation> elements are currently open around this line.
  //
  // Apple writes every food entry into the export twice: once as a top-level
  // <Record>, and again — byte for byte the same measurement, same source,
  // same timestamps, same value — as a child of a
  // <Correlation type="HKCorrelationTypeIdentifierFood">. Counting both is
  // what made every dietary column in the database exactly double.
  //
  // Depth is what tells the two copies apart. Indentation cannot: whitespace
  // is not part of the export's contract, and a Correlation's records are
  // indented no differently from a workout's statistics. Nor can the record's
  // own attributes, which are identical in both copies by construction.
  //
  // A counter rather than a boolean: Correlations do not nest in any export
  // seen so far, but a boolean would quietly mis-track if one ever did, and
  // the counter costs nothing.
  let correlationDepth = 0;
  // Distinguishes "the member was empty" from "the member had content but no
  // matching records" — only the former is a silent-failure symptom worth flagging.
  let sawAnyLine = false;

  try {
    for await (const line of lines) {
      sawAnyLine = true;
      const t = line.trimStart();

      if (t.startsWith("<Correlation")) {
        // A self-closing <Correlation .../>, and one opened and closed on the
        // same line, both wrap nothing — and a Correlation may legitimately
        // hold only <MetadataEntry> children and no records at all. Only a
        // tag that really stays open until a later line raises the depth.
        if (!t.endsWith("/>") && !t.includes("</Correlation>")) correlationDepth += 1;
        continue;
      }

      if (t.startsWith("</Correlation>")) {
        // Never below zero: an unmatched close in a truncated export must not
        // leave the counter negative and switch the *next* Correlation's
        // nested records back on.
        if (correlationDepth > 0) correlationDepth -= 1;
        continue;
      }

      if (t.startsWith("<Record ")) {
        if (correlationDepth > 0) {
          // The same measurement the top-level <Record> already carries.
          // Skipped, not lost — and still yielded, so the import can say how
          // many it collapsed instead of quietly halving a number.
          yield { kind: "dropped", reason: FOOD_CORRELATION_DUPLICATE };
          continue;
        }
        const a = attrs(t);
        if (!a.type || !a.startDate) {
          yield { kind: "dropped", reason: "Record: hiányzó type vagy startDate" };
          continue;
        }
        yield {
          kind: "record",
          type: shortType(a.type),
          unit: a.unit ?? null,
          value: a.value ?? "",
          startDate: a.startDate,
          endDate: a.endDate ?? a.startDate,
          source: a.sourceName ?? "",
        };
        continue;
      }

      if (t.startsWith("<Workout ")) {
        if (pending) yield pending;
        pending = undefined;
        const a = attrs(t);
        const durationUnit = a.durationUnit ?? "";
        if (durationUnit !== WORKOUT_DURATION_UNIT) {
          // `pending` stays undefined, so this workout's own statistics and
          // closing tag fall through the handlers below without effect.
          yield {
            kind: "dropped",
            reason: `Workout: nem várt időtartam-egység (${durationUnit || "hiányzik"})`,
          };
          continue;
        }
        pending = {
          kind: "workout",
          type: shortType(a.workoutActivityType ?? ""),
          durationMin: Number(a.duration ?? 0),
          energyKcal: null,
          startDate: a.startDate ?? "",
          endDate: a.endDate ?? a.startDate ?? "",
          source: a.sourceName ?? "",
        };
        // A self-closing workout has no statistics to wait for.
        if (t.endsWith("/>")) { yield pending; pending = undefined; }
        continue;
      }

      if (pending && t.startsWith("<WorkoutStatistics ")) {
        const a = attrs(t);
        if (a.type?.endsWith("ActiveEnergyBurned") && a.sum) {
          // A workout without its energy is still a workout worth storing, so
          // only the energy is dropped here — but it is dropped, not rescaled.
          if (a.unit === WORKOUT_ENERGY_UNIT) pending.energyKcal = Number(a.sum);
          else {
            yield {
              kind: "dropped",
              reason: `WorkoutStatistics: nem várt energia-egység (${a.unit ?? "hiányzik"})`,
            };
          }
        }
        continue;
      }

      if (pending && t.startsWith("</Workout>")) {
        yield pending;
        pending = undefined;
      }
    }
    if (pending) yield pending;

    // "Missing data beats confidently wrong data": a bad member name (locale or
    // export-version drift) or a corrupt archive must never look like "0 days of
    // health data" downstream. `unzip -p` failing produces no stdout either way —
    // EOF on an empty pipe is indistinguishable from EOF on a genuinely empty
    // export unless the exit status and stderr are checked explicitly.
    if (isZip) {
      const outcome = await exitInfo!;
      if (outcome.spawnError) {
        throw new Error(`Failed to run unzip for ${path}: ${outcome.spawnError.message}`);
      }
      if (outcome.code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        const status = `exit ${outcome.code}${outcome.signal ? `, signal ${outcome.signal}` : ""}`;
        throw new Error(`unzip failed for ${path} (${status})${stderr ? `: ${stderr}` : ""}`);
      }
      // unzip can exit 0 while writing nothing at all — a matched-but-empty member,
      // or (on some builds) a missing one. Either way that is not "no health data".
      if (!sawAnyLine) {
        throw new Error(`${ZIP_MEMBER} was empty or not found in ${path}`);
      }
    }
  } finally {
    lines.close();
    child?.kill();
  }
}
