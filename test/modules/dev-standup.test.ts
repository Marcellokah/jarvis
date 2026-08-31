import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devStandup, pickTip } from "../../src/modules/dev-standup/index.ts";
import { memoryDb, ctxAt } from "../helpers.ts";
import { createSeenStore } from "../../src/infra/db/repositories/seen.ts";
import type { Db } from "../../src/infra/db/index.ts";

const NOW = "2026-08-31T06:20:00+02:00";
const GH = "https://api.github.com/repos";
const HN = "https://hn.algolia.com/api/v1/search";

// A YAML file per test, so source configuration is part of the case.
function sourcesFile(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-dev-"));
  const path = join(dir, "dev-sources.yaml");
  writeFileSync(path, yaml);
  return path;
}

const cfg = { enabled: true, timeoutMs: 5_000, cacheTtlMs: 60_000 };

const release = (over: Record<string, unknown> = {}) => ({
  tag_name: "v1.0.0", name: "v1.0.0", published_at: "2026-08-30T10:00:00Z",
  html_url: "https://github.com/x/y/releases/tag/v1.0.0",
  prerelease: false, draft: false, body: "Adds streaming support for large payloads.",
  ...over,
});

let db: Db;
beforeEach(() => { db = memoryDb(); });
afterEach(() => db.close());

describe("release filtering", () => {
  it("drops prereleases and drafts", async () => {
    // next.js publishes canaries continuously — 8 of its last 10 releases were
    // prereleases, so without this the section is pure noise.
    const path = sourcesFile("repos: [vercel/next.js]\nprompt_tips: []\n");
    const mod = devStandup(cfg, path);

    const result = await mod.execute(ctxAt(NOW, db, {
      [`${GH}/vercel/next.js/releases`]: [
        release({ tag_name: "v16.4.0-canary.12", prerelease: true }),
        release({ tag_name: "v16.3.3" }),
        release({ tag_name: "v16.3.2", draft: true }),
      ],
      [HN]: { hits: [] },
    }));

    expect(result!.data.releases.map((r) => r.tag)).toEqual(["v16.3.3"]);
  });

  it("drops releases older than the window", async () => {
    const path = sourcesFile("repos: [a/b]\nrelease_window_days: 3\nprompt_tips: []\n");
    const result = await devStandup(cfg, path).execute(ctxAt(NOW, db, {
      [`${GH}/a/b/releases`]: [
        release({ tag_name: "old", published_at: "2026-08-01T10:00:00Z" }),
        release({ tag_name: "new", published_at: "2026-08-30T10:00:00Z" }),
      ],
      [HN]: { hits: [] },
    }));

    expect(result!.data.releases.map((r) => r.tag)).toEqual(["new"]);
  });

  it("survives GitHub answering with an error object instead of a list", async () => {
    // A rate limit returns {"message": "..."} — calling .filter on that throws
    // and would take down the whole module.
    const path = sourcesFile("repos: [a/b, c/d]\nprompt_tips: []\n");
    const result = await devStandup(cfg, path).execute(ctxAt(NOW, db, {
      [`${GH}/a/b/releases`]: { message: "API rate limit exceeded" },
      [`${GH}/c/d/releases`]: [release({ tag_name: "v2.0.0" })],
      [HN]: { hits: [] },
    }));

    expect(result!.data.releases.map((r) => r.tag)).toEqual(["v2.0.0"]);
    expect(result!.data.failed).toEqual(["a/b"]);
    expect(result!.degraded).toContain("a/b");
  });

  it("extracts a useful line from the release notes", async () => {
    const path = sourcesFile("repos: [a/b]\nprompt_tips: []\n");
    const result = await devStandup(cfg, path).execute(ctxAt(NOW, db, {
      [`${GH}/a/b/releases`]: [release({
        body: "## What's Changed\n\n* Full Changelog: https://x\n\nStreaming responses no longer buffer the whole body.",
      })],
      [HN]: { hits: [] },
    }));

    expect(result!.data.releases[0]!.highlight)
      .toBe("Streaming responses no longer buffer the whole body.");
  });
});

describe("Hacker News", () => {
  it("reads the recorded Algolia shape", async () => {
    const fixture = JSON.parse(readFileSync("test/fixtures/api/hn-algolia.json", "utf8"));
    const path = sourcesFile("repos: []\nprompt_tips: []\nhacker_news:\n  max_items: 3\n");

    const result = await devStandup(cfg, path).execute(ctxAt(NOW, db, { [HN]: fixture }));

    expect(result!.data.stories.length).toBeGreaterThan(0);
    expect(result!.data.stories.length).toBeLessThanOrEqual(3);
    for (const story of result!.data.stories) {
      expect(story.title).toBeTruthy();
      expect(story.discussionUrl).toContain("news.ycombinator.com");
    }
    // Sorted by points, descending.
    const points = result!.data.stories.map((s) => s.points);
    expect([...points].sort((a, b) => b - a)).toEqual(points);
  });

  it("keeps the releases when Hacker News is down", async () => {
    const path = sourcesFile("repos: [a/b]\nprompt_tips: []\n");
    const result = await devStandup(cfg, path).execute(ctxAt(NOW, db, {
      [`${GH}/a/b/releases`]: [release()],
      // no HN route → the fixture fetcher throws
    }));

    expect(result!.data.releases).toHaveLength(1);
    expect(result!.data.failed).toContain("Hacker News");
  });
});

describe("dedupe", () => {
  it("does not report the same release two mornings running", async () => {
    // A tip keeps the section alive, so this isolates dedupe rather than
    // colliding with "nothing to say at all".
    const path = sourcesFile('repos: [a/b]\nprompt_tips: ["tipp"]\n');
    const mod = devStandup(cfg, path);
    const routes = { [`${GH}/a/b/releases`]: [release({ tag_name: "v9.9.9" })], [HN]: { hits: [] } };

    const seen = createSeenStore(db);
    const ctx = { ...ctxAt(NOW, db, routes), seen };

    const first = await mod.execute(ctx);
    expect(first!.data.releases).toHaveLength(1);
    seen.record("DevStandup", first!.dedupeKeys!, new Date(NOW));

    const second = await mod.execute({ ...ctxAt(NOW, db, routes), seen });
    expect(second!.data.releases).toHaveLength(0);
  });
});

describe("daily tip", () => {
  it("still produces a section on a completely quiet day", async () => {
    const path = sourcesFile('repos: []\nprompt_tips: ["Egy hasznos tipp."]\n');
    const result = await devStandup(cfg, path).execute(ctxAt(NOW, db, { [HN]: { hits: [] } }));

    expect(result).not.toBeNull();
    expect(result!.data.tip).toBe("Egy hasznos tipp.");
    expect(devStandup(cfg, path).renderPlain(result!)).toContain("Napi tipp");
  });

  it("returns null when there is genuinely nothing, not even a tip", async () => {
    const path = sourcesFile("repos: []\nprompt_tips: []\n");
    expect(await devStandup(cfg, path).execute(ctxAt(NOW, db, { [HN]: { hits: [] } }))).toBeNull();
  });

  it("is stable within a day and rotates across days", () => {
    const tips = ["a", "b", "c"];
    expect(pickTip(tips, "2026-08-31")).toBe(pickTip(tips, "2026-08-31"));
    expect(pickTip(tips, "2026-08-31")).not.toBe(pickTip(tips, "2026-09-01"));
    expect(pickTip([], "2026-08-31")).toBeNull();
  });
});

describe("GitHub quota", () => {
  const RATE = "https://api.github.com/rate_limit";

  it("reports remaining budget without spending any of it", async () => {
    // /rate_limit does not count against the limit, so the health check can run
    // as often as you like — unlike fetching releases to prove reachability.
    const path = sourcesFile("repos: [a/b, c/d]\nprompt_tips: []\n");
    const health = await devStandup(cfg, path).healthCheck!(ctxAt(NOW, db, {
      [RATE]: { resources: { core: { remaining: 57, limit: 60, reset: 1788000000 } } },
    }));

    expect(health.ok).toBe(true);
    expect(health.detail).toContain("57/60");
  });

  it("fails the check when the remaining budget cannot cover one brief", async () => {
    const path = sourcesFile("repos: [a/b, c/d, e/f]\nprompt_tips: []\n");
    const health = await devStandup(cfg, path).healthCheck!(ctxAt(NOW, db, {
      [RATE]: { resources: { core: { remaining: 2, limit: 60, reset: 1788000000 } } },
    }));

    expect(health.ok).toBe(false);
    expect(health.detail).toContain("kvóta kimerült");
    // Points at the free fix rather than just reporting the problem.
    expect(health.detail).toContain("5000/órára");
  });
});
