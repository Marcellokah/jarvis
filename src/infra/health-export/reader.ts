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

export type ExportEntry = HealthRecordEntry | WorkoutEntry;

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
  // Distinguishes "the member was empty" from "the member had content but no
  // matching records" — only the former is a silent-failure symptom worth flagging.
  let sawAnyLine = false;

  try {
    for await (const line of lines) {
      sawAnyLine = true;
      const t = line.trimStart();

      if (t.startsWith("<Record ")) {
        const a = attrs(t);
        if (!a.type || !a.startDate) continue;
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
        const a = attrs(t);
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
          pending.energyKcal = Number(a.sum);
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
