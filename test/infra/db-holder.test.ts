import { describe, it, expect } from "vitest";
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { holdersOf } from "../../src/infra/db/holder.ts";

describe("holdersOf", () => {
  it("reports nobody for a path that does not exist", () => {
    // lsof exits non-zero here, which is the same path a missing lsof takes.
    // Failing open is deliberate: this check warns, it does not guarantee.
    expect(holdersOf("/tmp/jarvis-nonexistent-database.db")).toEqual([]);
  });

  it("names the pid holding a file open, and stops naming it once closed", () => {
    // Two commands lean on this guard, so it has to be exercised against a
    // real open descriptor. Asserting only the empty case would pass for a
    // stub that always returns [] — which is exactly the shape of the bug
    // this test exists to catch, since holdersOf fails open by design.
    const dir = mkdtempSync(join(tmpdir(), "jarvis-holder-"));
    const path = join(dir, "held.db");
    writeFileSync(path, "");

    const fd = openSync(path, "r");
    try {
      expect(holdersOf(path)).toContain(String(process.pid));
    } finally {
      closeSync(fd);
    }

    expect(holdersOf(path)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});
