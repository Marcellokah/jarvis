import type { Db } from "../index.ts";

export type Domain = "physical" | "recovery" | "finance" | "synthesis";

export interface AnalysisRow {
  id: number;
  createdAt: string;
  domain: Domain;
  markdown: string;
  /** One paragraph. This, not `markdown`, is what the next run reads back. */
  summary: string;
  /** The metrics the finding came from, as JSON. */
  metrics: string;
}

export interface AnalysisRepo {
  save(row: Omit<AnalysisRow, "id">): void;
  /** Newest first — the prompt wants the most recent context at the top. */
  recent(domain: Domain, n: number): AnalysisRow[];
  /** Every domain written by the most recent run. */
  latestRun(): AnalysisRow[];
}

interface Row {
  id: number; created_at: string; domain: Domain;
  markdown: string; summary: string; metrics: string;
}

const toAnalysis = (r: Row): AnalysisRow => ({
  id: r.id, createdAt: r.created_at, domain: r.domain,
  markdown: r.markdown, summary: r.summary, metrics: r.metrics,
});

export function createAnalysisRepo(db: Db): AnalysisRepo {
  return {
    save(row) {
      db.run(
        `INSERT INTO analyses (created_at, domain, markdown, summary, metrics)
         VALUES (?, ?, ?, ?, ?)`,
        row.createdAt, row.domain, row.markdown, row.summary, row.metrics,
      );
    },

    recent(domain, n) {
      return db.all<Row>(
        "SELECT * FROM analyses WHERE domain = ? ORDER BY created_at DESC, id DESC LIMIT ?",
        domain, n,
      ).map(toAnalysis);
    },

    latestRun() {
      // A run writes its domains seconds apart, so "the latest run" is the
      // latest row per domain rather than everything sharing one timestamp.
      return db.all<Row>(
        `SELECT * FROM analyses WHERE id IN (
           SELECT MAX(id) FROM analyses GROUP BY domain
         ) ORDER BY domain`,
      ).map(toAnalysis);
    },
  };
}
