import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gamingAndTech } from "../../src/modules/gaming-tech/index.ts";
import { memoryDb, ctxAt } from "../helpers.ts";
import { createSeenStore } from "../../src/infra/db/repositories/seen.ts";
import type { Db } from "../../src/infra/db/index.ts";

const NOW = "2026-08-31T06:20:00+02:00";
const API = "https://www.cheapshark.com/api/1.0";
const cfg = { enabled: true, timeoutMs: 5_000, minDiscountPct: 30, cacheTtlMs: 60_000 };

function watchlistFile(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-games-"));
  const path = join(dir, "watchlist.yaml");
  writeFileSync(path, yaml);
  return path;
}

const STORES = [
  { storeID: "1", storeName: "Steam", isActive: 1 },
  { storeID: "7", storeName: "GOG", isActive: 1 },
  { storeID: "99", storeName: "Dead Store", isActive: 0 },
];

let db: Db;
beforeEach(() => { db = memoryDb(); });
afterEach(() => db.close());

const routes = (over: Record<string, unknown> = {}) => ({
  [`${API}/stores`]: STORES,
  ...over,
});

describe("title resolution", () => {
  it("prefers an exact title match over a fuzzy hit", async () => {
    // The search is fuzzy and happily ranks a soundtrack or DLC first.
    const path = watchlistFile('- { title: "Elden Ring", target_usd: 25 }\n');

    const result = await gamingAndTech(cfg, path).execute(ctxAt(NOW, db, routes({
      [`${API}/games?title=Elden%20Ring&limit=5`]: [
        { gameID: "111", external: "Elden Ring - Soundtrack" },
        { gameID: "222", external: "Elden Ring" },
      ],
      [`${API}/games?id=222`]: {
        info: { title: "Elden Ring" },
        cheapestPriceEver: { price: "23.99" },
        deals: [{ storeID: "1", dealID: "d1", price: "23.99", retailPrice: "59.99", savings: "60.0" }],
      },
    })));

    expect(result!.data.deals[0]!.title).toBe("Elden Ring");
  });
});

describe("thresholds", () => {
  it("reports a deal that hits the target price even at a modest discount", async () => {
    const path = watchlistFile('- { title: "Game", target_usd: 20 }\n');
    const result = await gamingAndTech(cfg, path).execute(ctxAt(NOW, db, routes({
      [`${API}/games?title=Game&limit=5`]: [{ gameID: "1", external: "Game" }],
      [`${API}/games?id=1`]: {
        info: { title: "Game" }, cheapestPriceEver: { price: "10.00" },
        // Only 20% off — below minDiscountPct — but under the target price.
        deals: [{ storeID: "1", dealID: "d", price: "16.00", retailPrice: "20.00", savings: "20.0" }],
      },
    })));

    expect(result!.data.deals).toHaveLength(1);
    expect(result!.data.deals[0]!.hitTarget).toBe(true);
  });

  it("ignores a shallow discount with no target set", async () => {
    const path = watchlistFile('- { title: "Game", target_usd: null }\n');
    const result = await gamingAndTech(cfg, path).execute(ctxAt(NOW, db, routes({
      [`${API}/games?title=Game&limit=5`]: [{ gameID: "1", external: "Game" }],
      [`${API}/games?id=1`]: {
        info: { title: "Game" }, cheapestPriceEver: { price: "10.00" },
        deals: [{ storeID: "1", dealID: "d", price: "18.00", retailPrice: "20.00", savings: "10.0" }],
      },
    })));

    expect(result).toBeNull();
  });

  it("picks the cheapest store and flags a historic low", async () => {
    const path = watchlistFile('- { title: "Game", target_usd: null }\n');
    const result = await gamingAndTech(cfg, path).execute(ctxAt(NOW, db, routes({
      [`${API}/games?title=Game&limit=5`]: [{ gameID: "1", external: "Game" }],
      [`${API}/games?id=1`]: {
        info: { title: "Game" }, cheapestPriceEver: { price: "12.00" },
        deals: [
          { storeID: "1", dealID: "a", price: "17.99", retailPrice: "59.99", savings: "70.0" },
          { storeID: "7", dealID: "b", price: "12.00", retailPrice: "59.99", savings: "80.0" },
        ],
      },
    })));

    const deal = result!.data.deals[0]!;
    expect(deal.storeName).toBe("GOG");
    expect(deal.priceUsd).toBe(12);
    expect(deal.atHistoricLow).toBe(true);
  });
});

describe("resilience", () => {
  it("keeps the other games when one lookup fails", async () => {
    const path = watchlistFile('- { title: "Good", target_usd: 20 }\n- { title: "Bad", target_usd: 20 }\n');
    const result = await gamingAndTech(cfg, path).execute(ctxAt(NOW, db, routes({
      [`${API}/games?title=Good&limit=5`]: [{ gameID: "1", external: "Good" }],
      [`${API}/games?id=1`]: {
        info: { title: "Good" }, cheapestPriceEver: { price: "5.00" },
        deals: [{ storeID: "1", dealID: "d", price: "9.99", retailPrice: "59.99", savings: "83.0" }],
      },
      // "Bad" has no route → the fixture fetcher throws for it.
    })));

    expect(result!.data.deals.map((d) => d.title)).toEqual(["Good"]);
    expect(result!.data.failed).toEqual(["Bad"]);
  });

  it("resolves store names and skips inactive stores", async () => {
    const path = watchlistFile('- { title: "Game", target_usd: null }\n');
    const result = await gamingAndTech(cfg, path).execute(ctxAt(NOW, db, routes({
      [`${API}/games?title=Game&limit=5`]: [{ gameID: "1", external: "Game" }],
      [`${API}/games?id=1`]: {
        info: { title: "Game" }, cheapestPriceEver: { price: "5.00" },
        deals: [{ storeID: "99", dealID: "d", price: "9.99", retailPrice: "59.99", savings: "83.0" }],
      },
    })));

    // storeID 99 is inactive, so it falls back to a legible placeholder
    // rather than crashing or printing "undefined".
    expect(result!.data.deals[0]!.storeName).toBe("bolt #99");
  });
});

describe("dedupe", () => {
  it("does not re-announce the same price every morning", async () => {
    const path = watchlistFile('- { title: "Game", target_usd: 20 }\n');
    const mod = gamingAndTech(cfg, path);
    const r = routes({
      [`${API}/games?title=Game&limit=5`]: [{ gameID: "1", external: "Game" }],
      [`${API}/games?id=1`]: {
        info: { title: "Game" }, cheapestPriceEver: { price: "5.00" },
        deals: [{ storeID: "1", dealID: "d", price: "9.99", retailPrice: "59.99", savings: "83.0" }],
      },
    });

    const seen = createSeenStore(db);
    const first = await mod.execute({ ...ctxAt(NOW, db, r), seen });
    expect(first!.data.deals).toHaveLength(1);
    seen.record("GamingAndTech", first!.dedupeKeys!, new Date(NOW));

    // A three-week sale must not lead the section until it ends.
    expect(await mod.execute({ ...ctxAt(NOW, db, r), seen })).toBeNull();
  });
});
