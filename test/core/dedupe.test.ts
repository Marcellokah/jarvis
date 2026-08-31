import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devStandup } from "../../src/modules/dev-standup/index.ts";
import { buildTestApp, type TestApp } from "../helpers.ts";
import { createSeenStore } from "../../src/infra/db/repositories/seen.ts";
import { fixtureFetcher } from "../../src/infra/http-client.ts";

const GH = "https://api.github.com/repos";
const HN = "https://hn.algolia.com/api/v1/search";

function sourcesFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-dedupe-"));
  const path = join(dir, "dev-sources.yaml");
  writeFileSync(path, 'repos: [a/b]\nprompt_tips: ["Állandó tipp."]\nhacker_news:\n  max_items: 2\n');
  return path;
}

let app: TestApp;
afterEach(async () => { await app?.close(); app = undefined as unknown as TestApp; });

/**
 * The Phase 3 exit criterion: two consecutive mornings must not repeat an item.
 * This is the single biggest quality lever in a daily brief — without it the
 * same release leads the section until it falls out of the window.
 */
describe("no repeats across consecutive briefs", () => {
  it("reports each release and story exactly once", async () => {
    const path = sourcesFile();
    const routes = {
      [`${GH}/a/b/releases`]: [{
        tag_name: "v9.9.9", name: "v9.9.9", published_at: "2026-08-30T10:00:00Z",
        html_url: "https://github.com/a/b/releases/tag/v9.9.9",
        prerelease: false, draft: false, body: "Nagy újdonság érkezett.",
      }],
      [HN]: {
        hits: [
          { objectID: "111", title: "Első sztori", url: "https://x", points: 400, num_comments: 90 },
          { objectID: "222", title: "Második sztori", url: "https://y", points: 300, num_comments: 40 },
        ],
      },
    };

    app = await buildTestApp({
      modules: [devStandup({ enabled: true, timeoutMs: 5_000, cacheTtlMs: 0 }, path)],
      now: "2026-08-31T07:20:00+02:00",
    });
    // Real dedupe store and a real fetcher over fixtures.
    app.runner.seen = createSeenStore(app.db);
    app.runner.http = fixtureFetcher(routes);

    const monday = await app.briefs.generate(new Date("2026-08-31T07:20:00+02:00"));
    expect(monday.markdown).toContain("v9.9.9");
    expect(monday.markdown).toContain("Első sztori");

    // Same upstream data, next morning.
    const tuesday = await app.briefs.generate(new Date("2026-09-01T07:20:00+02:00"));
    expect(tuesday.markdown).not.toContain("v9.9.9");
    expect(tuesday.markdown).not.toContain("Első sztori");
    expect(tuesday.markdown).not.toContain("Második sztori");

    // The tip keeps the section alive even with nothing new.
    expect(tuesday.markdown).toContain("Napi tipp");
  });

  it("lets an item resurface once its retention window expires", async () => {
    const path = sourcesFile();
    app = await buildTestApp({
      modules: [devStandup({ enabled: true, timeoutMs: 5_000, cacheTtlMs: 0 }, path)],
      now: "2026-08-31T07:20:00+02:00",
    });
    const seen = createSeenStore(app.db);
    app.runner.seen = seen;
    app.runner.http = fixtureFetcher({
      [`${GH}/a/b/releases`]: [{
        tag_name: "v1.0.0", published_at: "2026-08-30T10:00:00Z",
        prerelease: false, draft: false, body: "x",
      }],
      [HN]: { hits: [] },
    });

    const first = await app.briefs.generate(new Date("2026-08-31T07:20:00+02:00"));
    expect(first.markdown).toContain("v1.0.0");

    const second = await app.briefs.generate(new Date("2026-09-01T07:20:00+02:00"));
    expect(second.markdown).not.toContain("v1.0.0");

    // Nightly cleanup drops entries past the retention window. Pruning with a
    // zero-day retention isolates that from the source's own freshness window —
    // by October this release would be filtered out as old regardless.
    expect(seen.prune(0, new Date("2026-09-01T04:00:00+02:00"))).toBeGreaterThan(0);

    const later = await app.briefs.generate(new Date("2026-09-01T07:20:00+02:00"));
    expect(later.markdown).toContain("v1.0.0");
  });

  it("does not record anything when synthesis fails", async () => {
    // Recording before the brief is stored would mean a crash silently ate the
    // news: marked as reported, never actually shown.
    const path = sourcesFile();
    app = await buildTestApp({
      modules: [devStandup({ enabled: true, timeoutMs: 5_000, cacheTtlMs: 0 }, path)],
      now: "2026-08-31T07:20:00+02:00",
      synthesizers: [{
        name: "broken",
        available: async () => true,
        synthesize: async () => { throw new Error("synthesis exploded"); },
      }],
    });
    const seen = createSeenStore(app.db);
    app.runner.seen = seen;
    app.runner.http = fixtureFetcher({
      [`${GH}/a/b/releases`]: [{
        tag_name: "v2.0.0", published_at: "2026-08-30T10:00:00Z",
        prerelease: false, draft: false, body: "x",
      }],
      [HN]: { hits: [] },
    });

    await expect(app.briefs.generate(new Date("2026-08-31T07:20:00+02:00"))).rejects.toThrow();
    expect(seen.filterNew("DevStandup", ["release:a/b:v2.0.0"])).toEqual(["release:a/b:v2.0.0"]);
  });
});
