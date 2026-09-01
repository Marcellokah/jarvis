import { describe, it, expect } from "vitest";
import { memoryDb } from "../helpers.ts";
import { createConversationRepo } from "../../src/infra/db/repositories/conversations.ts";

const AT = (iso: string) => new Date(iso);

describe("conversation repo", () => {
  it("stores an exchange as two turns, question first", () => {
    const db = memoryDb();
    const repo = createConversationRepo(db);

    repo.appendExchange("web", "Miért esett a VO2max-om?", "Mert kevesebbet futottál.", AT("2026-09-01T08:00:00.000Z"));

    const turns = repo.recent("web", 10);
    expect(turns.map((t) => [t.role, t.content])).toEqual([
      ["user", "Miért esett a VO2max-om?"],
      ["assistant", "Mert kevesebbet futottál."],
    ]);
    db.close();
  });

  it("returns the thread oldest first, because a prompt reads it forwards", () => {
    const db = memoryDb();
    const repo = createConversationRepo(db);

    repo.appendExchange("web", "első", "válasz1", AT("2026-09-01T08:00:00.000Z"));
    repo.appendExchange("web", "második", "válasz2", AT("2026-09-01T09:00:00.000Z"));

    expect(repo.recent("web", 10).map((t) => t.content))
      .toEqual(["első", "válasz1", "második", "válasz2"]);
    db.close();
  });

  it("keeps the LAST n turns when the thread is longer, still oldest first", () => {
    const db = memoryDb();
    const repo = createConversationRepo(db);

    repo.appendExchange("web", "régi", "régi-válasz", AT("2026-09-01T08:00:00.000Z"));
    repo.appendExchange("web", "friss", "friss-válasz", AT("2026-09-01T09:00:00.000Z"));

    // A limit must drop the oldest, not the newest: the recent turns are the
    // ones a follow-up question depends on.
    expect(repo.recent("web", 2).map((t) => t.content)).toEqual(["friss", "friss-válasz"]);
    db.close();
  });

  it("keeps threads apart", () => {
    const db = memoryDb();
    const repo = createConversationRepo(db);

    repo.appendExchange("web", "gépnél", "válasz", AT("2026-09-01T08:00:00.000Z"));
    repo.appendExchange("123456", "telefonon", "válasz", AT("2026-09-01T08:00:00.000Z"));

    expect(repo.recent("web", 10)).toHaveLength(2);
    expect(repo.recent("123456", 10).map((t) => t.content)).toEqual(["telefonon", "válasz"]);
    db.close();
  });

  it("prunes strictly before the cutoff, and reports how many went", () => {
    const db = memoryDb();
    const repo = createConversationRepo(db);

    repo.appendExchange("web", "régi", "válasz", AT("2026-08-01T08:00:00.000Z"));
    repo.appendExchange("web", "határon", "válasz", AT("2026-08-15T00:00:00.000Z"));
    repo.appendExchange("web", "friss", "válasz", AT("2026-09-01T08:00:00.000Z"));

    // The boundary turn is kept: `before` means before, not up to and including.
    expect(repo.prune(AT("2026-08-15T00:00:00.000Z"))).toBe(2);
    expect(repo.recent("web", 10).map((t) => t.content))
      .toEqual(["határon", "válasz", "friss", "válasz"]);
    db.close();
  });

  it("writes both turns or neither", () => {
    const db = memoryDb();
    const repo = createConversationRepo(db);

    // A question stored without its answer would read, on the next turn, as a
    // model that declined to reply — and the model would explain that instead
    // of answering. The pair is written in one transaction for that reason.
    expect(() => repo.appendExchange("web", "kérdés", "", AT("2026-09-01T08:00:00.000Z")))
      .toThrow(/üres/);
    expect(repo.recent("web", 10)).toEqual([]);
    db.close();
  });
});
