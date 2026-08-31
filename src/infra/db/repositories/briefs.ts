import type { Db } from "../index.ts";

export interface StoredBrief {
  id: number;
  date: string;
  generatedAt: string;
  synthesizer: string;
  markdown: string;
  durationMs: number;
}

export interface BriefRepo {
  save(brief: Omit<StoredBrief, "id">): void;
  latestForDate(date: string): StoredBrief | undefined;
}

interface Row {
  id: number;
  date: string;
  generated_at: string;
  synthesizer: string;
  markdown: string;
  duration_ms: number;
}

const toBrief = (r: Row): StoredBrief => ({
  id: r.id,
  date: r.date,
  generatedAt: r.generated_at,
  synthesizer: r.synthesizer,
  markdown: r.markdown,
  durationMs: r.duration_ms,
});

export function createBriefRepo(db: Db): BriefRepo {
  return {
    save(b) {
      db.run(
        `INSERT INTO briefs (date, generated_at, synthesizer, markdown, duration_ms)
         VALUES (?, ?, ?, ?, ?)`,
        b.date, b.generatedAt, b.synthesizer, b.markdown, b.durationMs,
      );
    },
    // Tie-break on id: two briefs generated inside the same second share a
    // timestamp, and without this the older one can win — which is exactly
    // what made a regenerated brief serve pre-regeneration data.
    latestForDate(date) {
      const row = db.get<Row>(
        "SELECT * FROM briefs WHERE date = ? ORDER BY generated_at DESC, id DESC LIMIT 1", date,
      );
      return row ? toBrief(row) : undefined;
    },
  };
}
