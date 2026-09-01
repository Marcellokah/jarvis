import { describe, it, expect } from "vitest";
import { holdersOf } from "../../src/infra/db/holder.ts";

describe("holdersOf", () => {
  it("reports nobody for a path that does not exist", () => {
    // lsof exits non-zero here, which is the same path a missing lsof takes.
    // Failing open is deliberate: this check warns, it does not guarantee.
    expect(holdersOf("/tmp/jarvis-nonexistent-database.db")).toEqual([]);
  });
});
