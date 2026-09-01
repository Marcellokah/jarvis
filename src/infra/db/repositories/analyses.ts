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
  /**
   * The newest row for each domain, which is not the same as one run's output:
   * the rows may come from different runs, and a domain that has failed for
   * months still returns its last success here with nothing marking it stale.
   * Callers that care about freshness must check `createdAt` themselves.
   */
  latestPerDomain(): AnalysisRow[];
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

    latestPerDomain() {
      // MAX(id) per domain, deliberately not "the rows of the last run": a run
      // can fail one domain and write the other three, and this still returns
      // four rows. It is named for what it does so the caller is forced to
      // notice the mixed vintages rather than assume one run's snapshot.
      return db.all<Row>(
        `SELECT * FROM analyses WHERE id IN (
           SELECT MAX(id) FROM analyses GROUP BY domain
         ) ORDER BY domain`,
      ).map(toAnalysis);
    },
  };
}
