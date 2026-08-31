import { describe, it, expect, afterEach } from "vitest";
import { buildTestApp, stubModule, recordingLogger, TEST_TOKEN, type TestApp } from "../helpers.ts";

let app: TestApp | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

const auth = { authorization: `Bearer ${TEST_TOKEN}` };

/**
 * The contact tracking that used to live here is gone: it watched an unattended
 * morning, and there is no longer one. The request log stays — it is what makes
 * a failed call visible after the fact, whoever triggered it.
 */
describe("request log", () => {
  it("logs every request", async () => {
    const logger = recordingLogger();
    app = await buildTestApp({
      modules: [stubModule({ name: "M" })], now: "2026-09-04T05:30:00Z", logger,
    });

    await app.server.inject({ method: "GET", url: "/api/morning-brief?format=text", headers: auth });

    const request = logger.entries.find((e) => e.msg === "request" && e.level === "info");
    expect(request).toBeDefined();
    expect(request!.obj).toMatchObject({ method: "GET", status: 200 });
  });

  it("keeps the liveness probe out of the info log", async () => {
    const logger = recordingLogger();
    app = await buildTestApp({
      modules: [stubModule({ name: "M" })], now: "2026-09-04T05:30:00Z", logger,
    });

    await app.server.inject({ method: "GET", url: "/healthz" });

    expect(logger.entries.some((e) => e.msg === "request" && e.level === "info")).toBe(false);
    expect(logger.entries.some((e) => e.msg === "request" && e.level === "debug")).toBe(true);
  });
});
