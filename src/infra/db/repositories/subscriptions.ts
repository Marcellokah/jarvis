import type { Db } from "../index.ts";

export type BillingCycle = "monthly" | "quarterly" | "annual";

export interface Subscription {
  id: number;
  name: string;
  amountHuf: number;
  cycle: BillingCycle;
  nextRenewal: string;
  category: string | null;
  cancelUrl: string | null;
  lastUsedAt: string | null;
  active: boolean;
  notes: string | null;
}

export type SubscriptionSeed = Omit<Subscription, "id" | "active"> & { active?: boolean };

export interface SubscriptionRepo {
  listActive(): Subscription[];
  /** Every row, active or not — needed wherever a cancellation must stay visible. */
  listAll(): Subscription[];
  replaceAll(subs: SubscriptionSeed[]): void;
  markUsed(nameFragment: string, at: Date): Subscription | undefined;
  count(): number;
}

interface Row {
  id: number; name: string; amount_huf: number; cycle: BillingCycle;
  next_renewal: string; category: string | null; cancel_url: string | null;
  last_used_at: string | null; active: number; notes: string | null;
}

const toSub = (r: Row): Subscription => ({
  id: r.id, name: r.name, amountHuf: r.amount_huf, cycle: r.cycle,
  nextRenewal: r.next_renewal, category: r.category, cancelUrl: r.cancel_url,
  lastUsedAt: r.last_used_at, active: r.active === 1, notes: r.notes,
});

export function createSubscriptionRepo(db: Db): SubscriptionRepo {
  return {
    listActive() {
      return db.all<Row>("SELECT * FROM subscriptions WHERE active = 1 ORDER BY name").map(toSub);
    },

    listAll() {
      return db.all<Row>("SELECT * FROM subscriptions ORDER BY name").map(toSub);
    },

    replaceAll(subs) {
      db.transaction(() => {
        // Usage marks are recorded through Telegram, not in the YAML, so they
        // must survive a re-seed.
        const usage = new Map(
          db.all<{ name: string; last_used_at: string | null }>(
            "SELECT name, last_used_at FROM subscriptions",
          ).map((r) => [r.name, r.last_used_at]),
        );
        db.run("DELETE FROM subscriptions");
        for (const s of subs) {
          db.run(
            `INSERT INTO subscriptions
               (name, amount_huf, cycle, next_renewal, category, cancel_url, last_used_at, active, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            s.name, s.amountHuf, s.cycle, s.nextRenewal, s.category, s.cancelUrl,
            usage.get(s.name) ?? s.lastUsedAt, s.active === false ? 0 : 1, s.notes,
          );
        }
      });
    },

    markUsed(nameFragment, at) {
      const row = db.get<Row>(
        "SELECT * FROM subscriptions WHERE active = 1 AND lower(name) LIKE lower(?) ORDER BY length(name) LIMIT 1",
        `%${nameFragment}%`,
      );
      if (!row) return undefined;
      db.run("UPDATE subscriptions SET last_used_at = ? WHERE id = ?", at.toISOString().slice(0, 10), row.id);
      return { ...toSub(row), lastUsedAt: at.toISOString().slice(0, 10) };
    },

    count() {
      return db.get<{ n: number }>("SELECT COUNT(*) AS n FROM subscriptions WHERE active = 1")?.n ?? 0;
    },
  };
}
