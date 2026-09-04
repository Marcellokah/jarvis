import type { Db } from "../index.ts";

export interface TranscriptEntry {
  step: { name: string; args: Record<string, unknown>; why: string };
  observation: string;
}

export type InvestigationOutcome = "kesz" | "kerdezz" | "kifutott" | "hiba";

export interface StoredInvestigation {
  id: number;
  startedAt: string;
  goal: string;
  outcome: InvestigationOutcome;
  /** The finding, the question asked, or null when there was neither. */
  finding: string | null;
  transcript: TranscriptEntry[];
  usd: number;
}

export interface InvestigationRepo {
  record(entry: {
    startedAt: Date;
    goal: string;
    outcome: InvestigationOutcome;
    finding: string | null;
    transcript: readonly TranscriptEntry[];
    usd: number;
  }): void;
  /** Newest first. */
  recent(n: number): StoredInvestigation[];
  /** ISO instant of the most recent run, or null. */
  lastAt(): string | null;
}

interface Row {
  id: number; started_at: string; goal: string; outcome: InvestigationOutcome;
  finding: string | null; transcript: string; usd: number;
}

const toStored = (r: Row): StoredInvestigation => ({
  id: r.id, startedAt: r.started_at, goal: r.goal, outcome: r.outcome,
  finding: r.finding, usd: r.usd,
  transcript: JSON.parse(r.transcript) as TranscriptEntry[],
});

export function createInvestigationRepo(db: Db): InvestigationRepo {
  return {
    record(entry) {
      db.run(
        "INSERT INTO investigations (started_at, goal, outcome, finding, transcript, usd) VALUES (?, ?, ?, ?, ?, ?)",
        entry.startedAt.toISOString(), entry.goal, entry.outcome, entry.finding,
        JSON.stringify([...entry.transcript]), entry.usd,
      );
    },

    recent(n) {
      return db.all<Row>(
        "SELECT * FROM investigations ORDER BY started_at DESC, id DESC LIMIT ?", n,
      ).map(toStored);
    },

    lastAt() {
      return db.get<{ started_at: string }>(
        "SELECT started_at FROM investigations ORDER BY started_at DESC, id DESC LIMIT 1",
      )?.started_at ?? null;
    },
  };
}
