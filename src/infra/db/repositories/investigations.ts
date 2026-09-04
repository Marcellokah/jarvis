import type { Db } from "../index.ts";

export interface TranscriptEntry {
  step: { name: string; args: Record<string, unknown>; why: string };
  observation: string;
  /**
   * Whether this step actually produced data.
   *
   * Present on question steps only — a "hipotezis" or a bounced-back "kesz"
   * ran no query, so the field is simply absent on those, and the stored JSON
   * stays readable. The falsification gate requires it to be `true` on the
   * step a finding cites: a name from the menu is not a result, and a step
   * that read nothing can refute nothing.
   */
  evidence?: boolean;
}

export type InvestigationOutcome = "kesz" | "kerdezz" | "kifutott" | "hiba";

export interface StoredInvestigation {
  id: number;
  startedAt: string;
  goal: string;
  outcome: InvestigationOutcome;
  /** The finding, the question asked, or null when there was neither. */
  finding: string | null;
  /** The step number that tested the claim, 1-based; null unless a finding stood. */
  falsifiedBy: number | null;
  /** The step numbers the finding rests on; empty unless a finding stood. */
  cites: number[];
  transcript: TranscriptEntry[];
  usd: number;
}

export interface InvestigationRepo {
  record(entry: {
    startedAt: Date;
    goal: string;
    outcome: InvestigationOutcome;
    finding: string | null;
    /** Only a "kesz" has these; every other outcome leaves them out. */
    falsifiedBy?: number | null;
    cites?: readonly number[];
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
  finding: string | null; falsified_by: number | null; cites: string | null;
  transcript: string; usd: number;
}

const toStored = (r: Row): StoredInvestigation => ({
  id: r.id, startedAt: r.started_at, goal: r.goal, outcome: r.outcome,
  finding: r.finding, usd: r.usd,
  falsifiedBy: r.falsified_by,
  // Rows written before 010 have no cites column value; an empty list reads
  // the same as "this outcome carried no citations", which is what they were.
  cites: r.cites === null ? [] : JSON.parse(r.cites) as number[],
  transcript: JSON.parse(r.transcript) as TranscriptEntry[],
});

export function createInvestigationRepo(db: Db): InvestigationRepo {
  return {
    record(entry) {
      db.run(
        "INSERT INTO investigations "
        + "(started_at, goal, outcome, finding, falsified_by, cites, transcript, usd) "
        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        entry.startedAt.toISOString(), entry.goal, entry.outcome, entry.finding,
        entry.falsifiedBy ?? null,
        entry.cites === undefined ? null : JSON.stringify([...entry.cites]),
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
