import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import type { JarvisModule, ModuleContext, ModuleResult } from "../../core/module.ts";
import { fromRoot } from "../../shared/paths.ts";

const MODULE = "GamingAndTech";

const watchlistSchema = z.array(z.object({
  title: z.string().min(1),
  /** Alert at or below this price, in USD. Optional. */
  target_usd: z.number().positive().nullable().default(null),
}));

export interface GameDeal {
  title: string;
  storeName: string;
  priceUsd: number;
  retailUsd: number;
  savingsPct: number;
  cheapestEverUsd: number | null;
  /** Whether this is the lowest it has ever been. */
  atHistoricLow: boolean;
  hitTarget: boolean;
  dealUrl: string;
}

export interface GamingData {
  deals: GameDeal[];
  watchedCount: number;
  failed: string[];
}

export interface GamingConfig {
  enabled: boolean;
  timeoutMs: number;
  /** Report a deal at or above this discount even without a target price. */
  minDiscountPct: number;
  cacheTtlMs: number;
}

const API = "https://www.cheapshark.com/api/1.0";

interface SearchHit { gameID?: string; external?: string; cheapest?: string }
interface StoreRow { storeID?: string; storeName?: string; isActive?: number }
interface GameLookup {
  info?: { title?: string };
  cheapestPriceEver?: { price?: string };
  deals?: { storeID?: string; dealID?: string; price?: string; retailPrice?: string; savings?: string }[];
}

/**
 * A universal price watcher rather than a Steam wishlist scraper.
 *
 * CheapShark covers Steam, GOG, Epic, Humble, Fanatical and others through one
 * free, keyless API, so there is no private endpoint to break and no dependency
 * on a wishlist being public. Prices are USD, which is what the API returns.
 */
export function gamingAndTech(cfg: GamingConfig, watchlistPath = "config/watchlist.yaml"): JarvisModule<GamingData> {
  let cached: z.infer<typeof watchlistSchema> | null = null;

  const watchlist = () => {
    cached ??= watchlistSchema.parse(parse(readFileSync(fromRoot(watchlistPath), "utf8")));
    return cached;
  };

  return {
    name: MODULE,
    title: "🎮 Gaming & Tech",
    enabled: cfg.enabled,
    schedule: "daily",
    timeoutMs: cfg.timeoutMs,

    async execute(ctx: ModuleContext): Promise<ModuleResult<GamingData> | null> {
      const watched = watchlist();
      if (watched.length === 0) return null;

      const stores = await ctx.cache.through("stores", 7 * 86_400_000, async () => {
        const rows = await ctx.http.json<StoreRow[]>(`${API}/stores`, { signal: ctx.signal });
        return Object.fromEntries(
          rows.filter((s) => s.isActive === 1 && s.storeID && s.storeName)
              .map((s) => [s.storeID!, s.storeName!]),
        ) as Record<string, string>;
      });

      const failed: string[] = [];
      const deals: GameDeal[] = [];

      const results = await Promise.allSettled(
        watched.map((entry) => bestDeal(ctx, entry.title, cfg.cacheTtlMs, stores)),
      );

      results.forEach((result, index) => {
        const entry = watched[index]!;
        if (result.status === "rejected") {
          failed.push(entry.title);
          ctx.logger.warn({ title: entry.title, err: String(result.reason) }, "price lookup failed");
          return;
        }
        const best = result.value;
        if (!best) return;

        const hitTarget = entry.target_usd !== null && best.priceUsd <= entry.target_usd;
        if (!hitTarget && best.savingsPct < cfg.minDiscountPct) return;

        deals.push({ ...best, hitTarget });
      });

      // Only announce a price once: a three-week sale must not lead the section
      // every morning until it ends.
      const keys = deals.map((d) => `deal:${d.title}:${d.storeName}:${d.priceUsd.toFixed(2)}`);
      const fresh = new Set(ctx.seen.filterNew(MODULE, keys));
      const newDeals = deals.filter((_d, i) => fresh.has(keys[i]!));

      if (newDeals.length === 0) return null;

      newDeals.sort((a, b) => b.savingsPct - a.savingsPct);

      return {
        data: { deals: newDeals, watchedCount: watched.length, failed },
        actions: [],
        priority: newDeals.some((d) => d.hitTarget || d.atHistoricLow) ? "normal" : "fyi",
        dedupeKeys: [...fresh],
        ...(failed.length > 0 ? { degraded: `nem sikerült lekérdezni: ${failed.join(", ")}` } : {}),
      };
    },

    renderPlain(result): string {
      const { deals, watchedCount } = result.data;
      const lines: string[] = ["**Akciók a figyelt játékokra:**"];

      for (const deal of deals) {
        const flags = [
          deal.hitTarget ? "🎯 célár alatt" : null,
          deal.atHistoricLow ? "📉 eddigi legolcsóbb" : null,
        ].filter(Boolean).join(", ");

        lines.push(
          `- **${deal.title}** · $${deal.priceUsd.toFixed(2)} `
          + `(~~$${deal.retailUsd.toFixed(2)}~~, −${Math.round(deal.savingsPct)}%) · ${deal.storeName}`
          + (flags ? ` — ${flags}` : ""),
        );
      }

      lines.push("", `_${watchedCount} játék figyelve · árak USD-ben_`);
      return lines.join("\n");
    },

    async healthCheck(ctx) {
      try {
        const rows = await ctx.http.json<StoreRow[]>(`${API}/stores`, { signal: ctx.signal });
        const active = rows.filter((s) => s.isActive === 1).length;
        return { ok: active > 0, detail: `${watchlist().length} figyelt játék · ${active} bolt` };
      } catch (err) {
        return { ok: false, detail: String(err) };
      }
    },
  };
}

async function bestDeal(
  ctx: ModuleContext, title: string, ttlMs: number, stores: Record<string, string>,
): Promise<Omit<GameDeal, "hitTarget"> | null> {
  const gameId = await ctx.cache.through(`id:${title}`, 30 * 86_400_000, async () => {
    const hits = await ctx.http.json<SearchHit[]>(
      `${API}/games?title=${encodeURIComponent(title)}&limit=5`, { signal: ctx.signal },
    );
    // Prefer an exact title match; the search is fuzzy and will happily return
    // a soundtrack or a DLC ahead of the game itself.
    const exact = hits.find((h) => h.external?.toLowerCase() === title.toLowerCase());
    return (exact ?? hits[0])?.gameID ?? null;
  });

  if (!gameId) return null;

  const game = await ctx.cache.through(`game:${gameId}`, ttlMs, () =>
    ctx.http.json<GameLookup>(`${API}/games?id=${encodeURIComponent(gameId)}`, { signal: ctx.signal }),
  );

  const candidates = (game.deals ?? [])
    .map((d) => ({
      storeName: stores[d.storeID ?? ""] ?? `bolt #${d.storeID}`,
      priceUsd: Number(d.price),
      retailUsd: Number(d.retailPrice),
      savingsPct: Number(d.savings),
      dealUrl: d.dealID ? `https://www.cheapshark.com/redirect?dealID=${d.dealID}` : "",
    }))
    .filter((d) => Number.isFinite(d.priceUsd) && Number.isFinite(d.savingsPct));

  if (candidates.length === 0) return null;

  const best = candidates.reduce((a, b) => (b.priceUsd < a.priceUsd ? b : a));
  const cheapestEver = Number(game.cheapestPriceEver?.price);

  return {
    title: game.info?.title ?? title,
    ...best,
    cheapestEverUsd: Number.isFinite(cheapestEver) ? cheapestEver : null,
    // A cent of tolerance: the historic low is stored rounded.
    atHistoricLow: Number.isFinite(cheapestEver) && best.priceUsd <= cheapestEver + 0.01,
  };
}
