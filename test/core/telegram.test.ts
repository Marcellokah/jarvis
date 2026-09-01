import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  handleBrief, handleCallback, handleModule, handleUsed, handleUndo, questionTooLong,
} from "../../src/delivery/telegram/responses.ts";
import { chunkText } from "../../src/delivery/telegram/bot.ts";
import { acquireInstanceLock } from "../../src/infra/instance-lock.ts";
import { createSubscriptionRepo } from "../../src/infra/db/repositories/subscriptions.ts";
import { createActionRepo } from "../../src/infra/db/repositories/actions.ts";
import { financeAndSubs } from "../../src/modules/finance-subs/index.ts";
import { MAX_QUESTION_CHARS } from "../../src/core/chat.ts";
import { buildTestApp, TEST_TOKEN, type TestApp } from "../helpers.ts";
import { silentLogger } from "../../src/infra/logger.ts";
import type { CalendarService } from "../../src/infra/calendar/service.ts";

const MONDAY = new Date("2026-08-31T06:20:00+02:00");
const createEvent = vi.fn();

let app: TestApp;

async function boot() {
  createEvent.mockReset();
  const calendar: CalendarService = {
    listEvents: async () => [],
    createEvent,
    deleteEvent: async () => {},
    healthCheck: async () => ({ ok: true }),
  };

  app = await buildTestApp({
    modules: [financeAndSubs({ enabled: true, alertDaysBefore: [7, 3, 1], unusedAfterDays: 60 })],
    now: MONDAY.toISOString(),
    calendar,
  });

  createSubscriptionRepo(app.db).replaceAll([{
    name: "PlayStation Plus", amountHuf: 24990, cycle: "annual",
    nextRenewal: "2026-09-03", category: "gaming",
    cancelUrl: "https://playstation.com/cancel", lastUsedAt: "2026-06-01", notes: null,
  }]);

  return {
    briefs: app.briefs,
    proposals: app.proposals,
    actions: createActionRepo(app.db),
    subscriptions: createSubscriptionRepo(app.db),
    modules: app.modules,
    runner: app.runner,
  };
}

afterEach(async () => {
  await app?.close();
  app = undefined as unknown as TestApp;
});

describe("/brief", () => {
  it("renders HTML and offers accept/decline buttons for a proposal", async () => {
    const deps = await boot();
    const reply = await handleBrief(deps, MONDAY, false);

    expect(reply.text).toContain("<b>");
    expect(reply.text).not.toContain("## ");   // headings became bold
    expect(reply.text).not.toContain("**");

    const row = reply.buttons!.find((r) => r.length === 2)!;
    expect(row[0]!.data).toMatch(/^accept:/);
    expect(row[1]!.data).toMatch(/^decline:/);
  });

  it("keeps every callback payload inside Telegram's 64-byte limit", async () => {
    const deps = await boot();
    const reply = await handleBrief(deps, MONDAY, false);

    for (const row of reply.buttons ?? []) {
      for (const button of row) {
        expect(Buffer.byteLength(button.data, "utf8")).toBeLessThanOrEqual(64);
      }
    }
  });
});

describe("callbacks", () => {
  it("accept writes the calendar event", async () => {
    const deps = await boot();
    createEvent.mockResolvedValue({ uid: "jarvis-x", calendar: "Jarvis", url: "u" });

    const reply = await handleBrief(deps, MONDAY, false);
    const accept = reply.buttons!.flat().find((b) => b.data.startsWith("accept:"))!;
    const result = await handleCallback(deps, accept.data, MONDAY);

    expect(createEvent).toHaveBeenCalledOnce();
    expect(result.toast).toBe("Naptárba írva");
    expect(result.reply.text).toContain("Jarvis");
  });

  it("reports a calendar failure instead of claiming success", async () => {
    const deps = await boot();
    createEvent.mockRejectedValue(new Error("403"));

    const reply = await handleBrief(deps, MONDAY, false);
    const accept = reply.buttons!.flat().find((b) => b.data.startsWith("accept:"))!;
    const result = await handleCallback(deps, accept.data, MONDAY);

    expect(result.toast).toBe("Nem sikerült");
    expect(result.reply.text).toContain("⚠️");
  });

  it("refuses a second accept for the same proposal", async () => {
    const deps = await boot();
    createEvent.mockResolvedValue({ uid: "jarvis-x", calendar: "Jarvis", url: "u" });

    const reply = await handleBrief(deps, MONDAY, false);
    const accept = reply.buttons!.flat().find((b) => b.data.startsWith("accept:"))!;
    await handleCallback(deps, accept.data, MONDAY);
    const second = await handleCallback(deps, accept.data, MONDAY);

    expect(second.toast).toBe("Nem sikerült");
    expect(createEvent).toHaveBeenCalledOnce();
  });

  it("ignores an unrecognised button rather than throwing", async () => {
    const result = await handleCallback(await boot(), "bogus:123", MONDAY);
    expect(result.toast).toBe("Ismeretlen gomb");
  });
});

describe("/used", () => {
  it("matches a subscription by fragment", async () => {
    const deps = await boot();
    const reply = await handleUsed(deps, "playstation", MONDAY);
    expect(reply.text).toContain("PlayStation Plus");
    expect(deps.subscriptions.listActive()[0]!.lastUsedAt).toBe("2026-08-31");
  });

  it("lists the options when nothing matches", async () => {
    const reply = await handleUsed(await boot(), "nincsilyen", MONDAY);
    expect(reply.text).toContain("Nincs találat");
    expect(reply.text).toContain("PlayStation Plus");
  });

  it("explains usage when called bare", async () => {
    expect((await handleUsed(await boot(), "", MONDAY)).text).toContain("/used gym");
  });
});

describe("/undo", () => {
  it("says so when there is nothing to undo", async () => {
    expect((await handleUndo(await boot())).text).toContain("Nincs visszavonható");
  });

  it("offers the events Jarvis created", async () => {
    const deps = await boot();
    createEvent.mockResolvedValue({ uid: "jarvis-x", calendar: "Jarvis", url: "u" });
    const brief = await handleBrief(deps, MONDAY, false);
    await handleCallback(deps, brief.buttons!.flat().find((b) => b.data.startsWith("accept:"))!.data, MONDAY);

    const undo = await handleUndo(deps);
    expect(undo.buttons![0]![0]!.data).toBe("undo:jarvis-x");
  });
});

describe("unknown module", () => {
  it("lists what is available", async () => {
    const reply = await handleModule(await boot(), "Nonexistent", MONDAY);
    expect(reply.text).toContain("FinanceAndSubs");
  });
});

describe("message chunking", () => {
  it("leaves a short message alone", () => {
    expect(chunkText("rövid", 4000)).toEqual(["rövid"]);
  });

  it("splits on paragraph boundaries, not mid-sentence", () => {
    const text = ["A".repeat(300), "B".repeat(300), "C".repeat(300)].join("\n\n");
    const chunks = chunkText(text, 700);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(700);
    expect(chunks.join("\n\n")).toBe(text);
  });
});

describe("instance lock", () => {
  it("grants the lock when free", async () => {
    app = await buildTestApp({ modules: [], now: MONDAY.toISOString() });
    expect(acquireInstanceLock(app.db, silentLogger(), MONDAY)).not.toBeNull();
  });

  it("reclaims a lock whose heartbeat has gone stale", async () => {
    app = await buildTestApp({ modules: [], now: MONDAY.toISOString() });
    // A crashed process never releases; the next start must not be locked out.
    app.db.run(
      `INSERT INTO instance_lock (id, pid, hostname, acquired_at, heartbeat_at)
       VALUES (1, 999999, 'other-host', ?, ?)`,
      "2026-08-31T00:00:00Z", "2026-08-31T00:00:00Z",
    );
    expect(acquireInstanceLock(app.db, silentLogger(), MONDAY)).not.toBeNull();
  });

  it("refuses when another live instance holds a fresh lock", async () => {
    app = await buildTestApp({ modules: [], now: MONDAY.toISOString() });
    app.db.run(
      `INSERT INTO instance_lock (id, pid, hostname, acquired_at, heartbeat_at)
       VALUES (1, ?, 'other-host', ?, ?)`,
      process.pid, MONDAY.toISOString(), MONDAY.toISOString(),
    );
    expect(acquireInstanceLock(app.db, silentLogger(), MONDAY)).toBeNull();
  });
});

/**
 * The two doors validate the same way.
 *
 * `POST /api/chat` has capped a question at `MAX_QUESTION_CHARS` from the
 * start. Telegram allows 4,096 characters per message and passed all of them
 * straight into the prompt and into the `conversations` table — the same
 * question accepted at one door and refused at the other.
 */
describe("question length", () => {
  it("lets a question at the cap through", () => {
    expect(questionTooLong("a".repeat(MAX_QUESTION_CHARS))).toBeNull();
  });

  it("refuses a question over the cap, in Hungarian, with the numbers", () => {
    const reply = questionTooLong("a".repeat(MAX_QUESTION_CHARS + 1));
    expect(reply).not.toBeNull();
    expect(reply!.text).toContain(String(MAX_QUESTION_CHARS + 1));
    expect(reply!.text).toContain(String(MAX_QUESTION_CHARS));
    expect(reply!.text).toContain("túl hosszú");
  });

  it("refuses what Telegram itself would still allow", () => {
    // Telegram's own limit is 4,096 characters; ours is lower on purpose.
    expect(questionTooLong("a".repeat(4_096))).not.toBeNull();
  });
});
