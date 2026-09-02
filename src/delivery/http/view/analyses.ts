import { escapeHtml, renderMarkdown } from "../markdown.ts";

/**
 * Domain code to the Hungarian heading shown above its latest analysis.
 */
const DOMAIN_TITLE: Record<string, string> = {
  physical: "Fizikai fejlődés",
  recovery: "Regenerálódás és alvás",
  finance: "Pénzügy",
  synthesis: "Összegzés",
};

/**
 * The latest analysis per domain, dated so a stale one is visibly stale.
 *
 * `latestPerDomain()` mixes vintages by design (a failed run still leaves the
 * other domains' last successes in place, see `AnalysisRepo`), so the date is
 * not decoration — it is the only thing that tells the reader how old each
 * finding actually is.
 *
 * Exported alongside `analysesBody` (not just used internally) so a test can
 * assert on the "Elemzés" band's own content directly, without also parsing
 * the `<section>` wrapper `analysesBody` adds around it.
 */
export function analysesBlock(
  items: readonly { domain: string; markdown: string; createdAt: string }[],
): string {
  // Class is `halk`: the new shell's token name for dim, secondary text
  // (see `view/today.ts`'s missing-brief line for the same class).
  if (items.length === 0) {
    return `<p class="halk">Még nem futott mélyelemzés. Indítsd: <code>npm run analyze</code></p>`;
  }
  return items.map((a) => [
    `<h3>${escapeHtml(DOMAIN_TITLE[a.domain] ?? a.domain)}`,
    ` · ${escapeHtml(a.createdAt.slice(0, 10))}</h3>`,
    renderMarkdown(a.markdown),
  ].join("")).join("");
}

export function analysesBody(
  items: readonly { domain: string; markdown: string; createdAt: string }[],
): string {
  return `<section><h2>Elemzés</h2>${analysesBlock(items)}</section>`;
}
