import type { Fetcher } from "../../infra/http-client.ts";
import type { Logger } from "../../infra/logger.ts";

export interface Release {
  repo: string;
  tag: string;
  name: string;
  publishedAt: string;
  url: string;
  /** First meaningful line of the release notes. */
  highlight: string | null;
}

export interface Story {
  id: string;
  title: string;
  url: string | null;
  points: number;
  comments: number;
  discussionUrl: string;
}

interface GitHubRelease {
  tag_name?: string;
  name?: string | null;
  published_at?: string | null;
  html_url?: string;
  prerelease?: boolean;
  draft?: boolean;
  body?: string | null;
}

/**
 * Stable releases only.
 *
 * `vercel/next.js` publishes canaries continuously — 8 of its last 10 releases
 * were prereleases — so without this filter the section is pure noise.
 */
/**
 * Unauthenticated GitHub allows 60 requests/hour. A daily brief over six repos
 * uses seven, so it fits — but any burst of testing exhausts it. A free
 * personal access token (no scopes needed for public repos) raises the ceiling
 * to 5000/hour.
 */
export function githubHeaders(token?: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

export interface RateLimit { remaining: number; limit: number; resetsAt: string }

/** `/rate_limit` does not itself count against the limit. */
export async function fetchRateLimit(
  http: Fetcher, token: string | undefined, signal: AbortSignal,
): Promise<RateLimit> {
  const raw = await http.json<{ resources?: { core?: { remaining?: number; limit?: number; reset?: number } } }>(
    "https://api.github.com/rate_limit", { signal, headers: githubHeaders(token) },
  );
  const core = raw.resources?.core ?? {};
  return {
    remaining: core.remaining ?? 0,
    limit: core.limit ?? 0,
    resetsAt: new Date((core.reset ?? 0) * 1000).toISOString(),
  };
}

export async function fetchReleases(
  http: Fetcher, repo: string, since: Date, signal: AbortSignal, token?: string,
): Promise<Release[]> {
  const raw = await http.json<unknown>(
    `https://api.github.com/repos/${repo}/releases?per_page=10`,
    { signal, headers: githubHeaders(token) },
  );

  // GitHub answers rate limits and missing repos with an object, not an array;
  // calling .filter on that throws and would take the whole module down.
  if (!Array.isArray(raw)) {
    const message = (raw as { message?: string })?.message ?? "unexpected response";
    throw new Error(`GitHub returned no release list for ${repo}: ${message}`);
  }

  return (raw as GitHubRelease[])
    .filter((r) => !r.prerelease && !r.draft && r.published_at)
    .filter((r) => Date.parse(r.published_at!) >= since.getTime())
    .map((r) => ({
      repo,
      tag: r.tag_name ?? "?",
      name: r.name?.trim() || (r.tag_name ?? "?"),
      publishedAt: r.published_at!,
      url: r.html_url ?? `https://github.com/${repo}/releases`,
      highlight: firstMeaningfulLine(r.body ?? null),
    }));
}

interface AlgoliaResponse {
  hits?: {
    objectID?: string;
    title?: string | null;
    url?: string | null;
    points?: number | null;
    num_comments?: number | null;
  }[];
}

export async function fetchTopStories(
  http: Fetcher, minPoints: number, since: Date, limit: number, signal: AbortSignal,
): Promise<Story[]> {
  // The comparison operators must be percent-encoded, or Algolia rejects the
  // whole numericFilters expression and returns an HTML error page.
  const filters = encodeURIComponent(
    `points>${minPoints},created_at_i>${Math.floor(since.getTime() / 1000)}`,
  );
  const response = await http.json<AlgoliaResponse>(
    `https://hn.algolia.com/api/v1/search?tags=story&numericFilters=${filters}&hitsPerPage=${limit * 3}`,
    { signal },
  );

  return (response.hits ?? [])
    .filter((h) => h.objectID && h.title)
    .sort((a, b) => (b.points ?? 0) - (a.points ?? 0))
    .slice(0, limit)
    .map((h) => ({
      id: h.objectID!,
      title: h.title!,
      url: h.url ?? null,
      points: h.points ?? 0,
      comments: h.num_comments ?? 0,
      discussionUrl: `https://news.ycombinator.com/item?id=${h.objectID}`,
    }));
}

/** Release notes usually open with headings or boilerplate; find real prose. */
function firstMeaningfulLine(body: string | null): string | null {
  if (!body) return null;

  for (const raw of body.split("\n")) {
    const line = raw
      .replace(/^#+\s*/, "")
      .replace(/^[-*]\s*/, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[*_`]/g, "")
      .trim();

    if (line.length < 12) continue;
    if (/^(what'?s changed|full changelog|new contributors|thanks)/i.test(line)) continue;
    if (/^https?:\/\//.test(line)) continue;

    return line.length > 160 ? `${line.slice(0, 157)}…` : line;
  }
  return null;
}

export function logFailure(logger: Logger, source: string, err: unknown): void {
  logger.warn({ source, err: String(err) }, "dev source unavailable");
}
