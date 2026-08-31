import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import type { JarvisModule, ModuleContext, ModuleResult } from "../../core/module.ts";
import { fetchRateLimit, fetchReleases, fetchTopStories, logFailure, type Release, type Story } from "./sources.ts";
import { fromRoot } from "../../shared/paths.ts";
import { addDays, addHours, isoDate } from "../../shared/dates.ts";

const sourcesSchema = z.object({
  repos: z.array(z.string()).default([]),
  release_window_days: z.number().int().positive().default(3),
  hacker_news: z.object({
    min_points: z.number().int().positive().default(200),
    window_hours: z.number().int().positive().default(24),
    max_items: z.number().int().positive().default(3),
  }).default({}),
  prompt_tips: z.array(z.string()).default([]),
});

export type DevSources = z.infer<typeof sourcesSchema>;

// Not `this.name`: method shorthand binds `this` only while the method is
// called on the object, and a destructured `execute` would silently break.
const MODULE = "DevStandup";

export interface DevStandupData {
  releases: Release[];
  stories: Story[];
  tip: string | null;
  /** Sources that failed, so the brief can say so rather than imply silence. */
  failed: string[];
}

export interface DevStandupConfig {
  enabled: boolean;
  timeoutMs: number;
  /** How long a fetched source stays fresh. */
  cacheTtlMs: number;
}

export function devStandup(cfg: DevStandupConfig, sourcesPath = "config/dev-sources.yaml"): JarvisModule<DevStandupData> {
  let cached: DevSources | null = null;

  const sources = (): DevSources => {
    cached ??= sourcesSchema.parse(parse(readFileSync(fromRoot(sourcesPath), "utf8")));
    return cached;
  };

  return {
    name: MODULE,
    title: "🛠️ Fejlesztés & AI",
    enabled: cfg.enabled,
    schedule: "daily",
    timeoutMs: cfg.timeoutMs,

    async execute(ctx: ModuleContext): Promise<ModuleResult<DevStandupData> | null> {
      const src = sources();
      const failed: string[] = [];
      // Optional and free: raises GitHub's ceiling from 60/h to 5000/h.
      const token = await ctx.secrets.get("GITHUB_TOKEN");

      // Every repo is fetched concurrently and independently: one rate-limited
      // repo must not cost the other five.
      const releaseResults = await Promise.allSettled(
        src.repos.map((repo) =>
          ctx.cache.through(`releases:${repo}`, cfg.cacheTtlMs, () =>
            fetchReleases(ctx.http, repo, addDays(ctx.now, -src.release_window_days), ctx.signal, token),
          ),
        ),
      );

      const releases: Release[] = [];
      releaseResults.forEach((result, index) => {
        if (result.status === "fulfilled") {
          releases.push(...result.value);
        } else {
          failed.push(src.repos[index] ?? "unknown repo");
          logFailure(ctx.logger, src.repos[index] ?? "?", result.reason);
        }
      });

      let stories: Story[] = [];
      try {
        stories = await ctx.cache.through("hn", cfg.cacheTtlMs, () =>
          fetchTopStories(
            ctx.http, src.hacker_news.min_points,
            addHours(ctx.now, -src.hacker_news.window_hours),
            src.hacker_news.max_items, ctx.signal,
          ),
        );
      } catch (err) {
        failed.push("Hacker News");
        logFailure(ctx.logger, "hn", err);
      }

      // Suppress anything already reported, so the same release does not lead
      // the section for three mornings running.
      const releaseKeys = releases.map((r) => `release:${r.repo}:${r.tag}`);
      const freshReleaseKeys = new Set(ctx.seen.filterNew(MODULE, releaseKeys));
      const freshReleases = releases.filter((_r, i) => freshReleaseKeys.has(releaseKeys[i]!));

      const storyKeys = stories.map((s) => `story:${s.id}`);
      const freshStoryKeys = new Set(ctx.seen.filterNew(MODULE, storyKeys));
      const freshStories = stories.filter((_s, i) => freshStoryKeys.has(storyKeys[i]!));

      const tip = pickTip(src.prompt_tips, isoDate(ctx.now, ctx.tz));

      // The tip alone justifies the section: a quiet news day should still
      // deliver something, and this costs nothing to produce.
      if (freshReleases.length === 0 && freshStories.length === 0 && !tip) return null;

      freshReleases.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));

      return {
        data: { releases: freshReleases, stories: freshStories, tip, failed },
        actions: [],
        priority: "fyi",
        dedupeKeys: [...freshReleaseKeys, ...freshStoryKeys],
        ...(failed.length > 0 ? { degraded: `nem elérhető: ${failed.join(", ")}` } : {}),
      };
    },

    renderPlain(result): string {
      const { releases, stories, tip } = result.data;
      const lines: string[] = [];

      if (releases.length > 0) {
        lines.push("**Új kiadások:**");
        for (const release of releases) {
          const detail = release.highlight ? ` — ${release.highlight}` : "";
          lines.push(`- **${shortRepo(release.repo)} ${release.tag}**${detail}`);
        }
      }

      if (stories.length > 0) {
        if (lines.length > 0) lines.push("");
        lines.push("**Hacker News:**");
        for (const story of stories) {
          lines.push(`- ${story.title} _(${story.points} pont, ${story.comments} komment)_`);
        }
      }

      if (tip) {
        if (lines.length > 0) lines.push("");
        lines.push(`💡 **Napi tipp:** ${tip}`);
      }

      return lines.join("\n");
    },

    async healthCheck(ctx) {
      // Checks the budget rather than spending it: /rate_limit does not count
      // against the limit, and it answers the question that actually matters.
      const src = sources();
      const token = await ctx.secrets.get("GITHUB_TOKEN");
      const needed = src.repos.length + 1;

      try {
        const rate = await fetchRateLimit(ctx.http, token, ctx.signal);
        const auth = token ? "tokennel" : "token nélkül";

        if (rate.remaining < needed) {
          return {
            ok: false,
            detail: `GitHub kvóta kimerült (${rate.remaining}/${rate.limit} ${auth}), `
                  + `visszaáll: ${rate.resetsAt.slice(11, 16)} UTC. `
                  + (token ? "" : "Ingyenes personal access token 5000/órára emeli."),
          };
        }
        return {
          ok: true,
          detail: `${src.repos.length} repó · GitHub ${rate.remaining}/${rate.limit} kérés maradt (${auth})`,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, detail: `GitHub nem elérhető: ${message}` };
      }
    },
  };
}

/** Deterministic per day, so the tip is stable within a morning but rotates. */
export function pickTip(tips: string[], date: string): string | null {
  if (tips.length === 0) return null;
  const days = Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
  return tips[((days % tips.length) + tips.length) % tips.length] ?? null;
}

const shortRepo = (repo: string) => repo.split("/")[1] ?? repo;
