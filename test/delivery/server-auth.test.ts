import { describe, it, expect } from "vitest";
import { buildTestApp, TEST_TOKEN, stubModule } from "../helpers.ts";

/**
 * Auth-hook regression tests, separate from `page.test.ts`: these exercise
 * `buildServer`'s `onRequest` hook across the WHOLE route table (brief,
 * ingest, actions, status, pages), not just the two page routes Task 5 added.
 * A code-review round on Task 5 found the hook comparing raw, undecoded
 * `request.url` against a hand-written allow list — a percent-encoded path
 * matched no entry, so `find-my-way` (which decodes before routing) happily
 * dispatched it while the hook waved it through unauthenticated.
 */
describe("server auth hook", () => {
  const boot = () => buildTestApp({ modules: [stubModule({ name: "Teszt" })], now: "2026-09-01T08:00:00.000Z" });

  it("refuses a percent-encoded page path with no credential", async () => {
    // `/%73zamok` decodes to `/szamok`. The old hook string-matched the raw
    // URL, never recognised this as the guarded page, and let it through with
    // the full metrics table — the Critical this test pins down.
    const a = await boot();
    const res = await a.server.inject({ method: "GET", url: "/%73zamok" });
    expect(res.statusCode).toBe(401);
    await a.close();
  });

  it("refuses a percent-encoded api path with no credential", async () => {
    // Same bug, the `/api/` half: `/%61pi/morning-brief` decodes to
    // `/api/morning-brief` and used to slip past the `startsWith("/api/")`
    // check the identical way.
    const a = await boot();
    const res = await a.server.inject({ method: "GET", url: "/%61pi/morning-brief" });
    expect(res.statusCode).toBe(401);
    await a.close();
  });

  it("never serves a page for a path that fails to percent-decode", async () => {
    // `/%zz` is not valid percent-encoding, and neither is `/%E0%A4` (valid
    // hex pairs, invalid UTF-8) — both are things `decodeURIComponent` itself
    // throws on. In practice Fastify's own router rejects both before the
    // request ever reaches routing or this app's hooks (`FST_ERR_BAD_URL`,
    // 400), so `decodedPath`'s `null` branch in `server.ts` is a defensive
    // backstop rather than the live path today. This test pins the outward
    // behaviour that matters regardless of which layer produces it: a
    // malformed path never serves page content.
    const a = await boot();
    const res = await a.server.inject({ method: "GET", url: "/%zz" });
    expect(res.statusCode).not.toBe(200);
    expect(res.body).not.toContain("Terhelési arány");
    await a.close();
  });

  it("still reaches the real page through a percent-encoded path once authorized", async () => {
    // The fix is a decode, not a blanket refusal: with the token, the
    // percent-encoded request must resolve to the exact same page a plain
    // `/szamok` request does.
    const a = await boot();
    const res = await a.server.inject({
      method: "GET", url: "/%73zamok", headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Terhelési arány");
    await a.close();
  });

  it("guards every route the app actually registers, except the declared public one", async () => {
    // Reads the real route table off the running server (populated by an
    // `onRoute` hook in `buildServer`, not copied here by hand) so a route
    // added anywhere — `routes/page.ts`, `routes/brief.ts`, a future file —
    // is checked automatically. A hand-written list of "known" paths, like
    // the `PAGE_ROUTES` allow list this replaces, cannot catch a route it was
    // never updated to know about; this can.
    const a = await boot();
    const routes = (a.server as unknown as { registeredRoutes: { method: string; url: string }[] })
      .registeredRoutes;

    // Guards the guard: if the audit ever came back empty, every assertion
    // below would vacuously pass without checking anything.
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.some((r) => r.url === "/szamok")).toBe(true);

    for (const { method, url } of routes) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await a.server.inject({ method: method as any, url });
      if (url === "/healthz") {
        expect(res.statusCode, `${method} ${url} should stay public`).not.toBe(401);
      } else {
        expect(res.statusCode, `${method} ${url} should refuse an unauthenticated request`).toBe(401);
      }
    }
    await a.close();
  });

  it("dims the Kérdés lamp instead of failing the page when chat.available() throws", async () => {
    // `navState` used to call `await deps.chat.available()` with no try/catch
    // — the review's Important finding. Every other nav source dims its own
    // lamp on failure; this one used to take the whole page down with it.
    const a = await boot();
    (a.chat as unknown as { available: () => never }).available = () => {
      throw new Error("szándékos hiba");
    };

    const home = await a.server.inject({
      method: "GET", url: "/", headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(home.statusCode).toBe(200);

    const numbers = await a.server.inject({
      method: "GET", url: "/szamok", headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(numbers.statusCode).toBe(200);
    await a.close();
  });
});
