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

  let stream: Readable;
  let child: ReturnType<typeof spawn> | undefined;

  if (path.endsWith(".zip")) {
    child = spawn("unzip", ["-p", path, "apple_health_export/export.xml"]);
    stream = child.stdout!;
  } else {
    stream = createReadStream(path);
  }

  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  // A workout's energy arrives in a child element after its opening tag, so the
  // workout is held back until its block closes.
  let pending: WorkoutEntry | undefined;

  try {
    for await (const line of lines) {
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
  } finally {
    lines.close();
    child?.kill();
  }
}
