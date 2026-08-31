import { describe, it, expect, afterEach } from "vitest";
import { runModules } from "../../src/core/runner.ts";
import { memoryDb, stubModule } from "../helpers.ts";
import { silentLogger } from "../../src/infra/logger.ts";
import { nullSeenStore } from "../../src/infra/db/repositories/seen.ts";
import { staticSecrets } from "../../src/infra/secrets.ts";
import { fixtureFetcher } from "../../src/infra/http-client.ts";
import { unavailableCalendar } from "../../src/infra/calendar/service.ts";
import { TZ } from "../../src/shared/dates.ts";
import type { Db } from "../../src/infra/db/index.ts";

const NOW = new Date("2026-08-31T06:20:00+02:00");

let db: Db;
const deps = () => {
  db = memoryDb();
  return {
    db, http: fixtureFetcher({}), calendar: unavailableCalendar("test"), secrets: staticSecrets({}),
    logger: silentLogger(), seen: nullSeenStore(), tz: TZ,
  };
};
afterEach(() => db?.close());

describe("runner resilience", () => {
  it("keeps the good sections when one module throws", async () => {
    const outcomes = await runModules(
      [
        stubModule({ name: "Good" }),
        stubModule({ name: "Broken", execute: async () => { throw new Error("feed is down"); } }),
      ],
      NOW, deps(),
    );

    expect(outcomes.find((o) => o.name === "Good")!.status).toBe("ok");
    const broken = outcomes.find((o) => o.name === "Broken")!;
    expect(broken.status).toBe("failed");
    expect(broken.plain).toContain("feed is down");
  });

  it("times out a module that hangs, without hanging the brief", async () => {
    const outcomes = await runModules(
      [stubModule({
        name: "Slow",
        timeoutMs: 50,
        execute: (ctx) => new Promise((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        }),
      })],
      NOW, deps(),
    );

    expect(outcomes[0]!.status).toBe("failed");
    expect(outcomes[0]!.plain).toContain("időtúllépés");
  });

  it("survives a module whose renderer throws, keeping its data and actions", async () => {
    const outcomes = await runModules(
      [stubModule({
        name: "BadRenderer",
        execute: async () => ({
          data: { n: 1 },
          actions: [{ id: "a1", kind: "checkbox" as const, text: "megmarad" }],
          priority: "normal" as const,
        }),
        renderPlain: () => { throw new Error("template blew up"); },
      })],
      NOW, deps(),
    );

    expect(outcomes[0]!.status).toBe("ok");
    expect(outcomes[0]!.result!.data).toEqual({ n: 1 });
    expect(outcomes[0]!.actions).toHaveLength(1);
  });

  it("floats critical sections above normal ones", async () => {
    const outcomes = await runModules(
      [
        stubModule({ name: "Normal" }),
        stubModule({
          name: "Urgent",
          execute: async () => ({ data: {}, actions: [], priority: "critical" as const }),
        }),
      ],
      NOW, deps(),
    );

    expect(outcomes.map((o) => o.name)).toEqual(["Urgent", "Normal"]);
  });

  it("marks a module that returns null as empty rather than failed", async () => {
    const outcomes = await runModules(
      [stubModule({ name: "Quiet", execute: async () => null })],
      NOW, deps(),
    );
    expect(outcomes[0]!.status).toBe("empty");
  });
});
