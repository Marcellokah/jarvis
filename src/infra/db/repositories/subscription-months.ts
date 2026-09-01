import type { Db } from "../index.ts";

export interface MonthlySubscription {
  name: string;
  amountHuf: number;
  cycle: string;
  active: boolean;
}

export interface SubscriptionMonthRepo {
  /** Replaces the month's snapshot. The month-end state is what is kept. */
  record(month: string, subs: readonly MonthlySubscription[], now: Date): void;
  forMonth(month: string): MonthlySubscription[];
  /** Every month on record, oldest first. */
  months(): string[];
}

interface Row {
  name: string; amount_huf: number; cycle: string; active: number;
}

export function createSubscriptionMonthRepo(db: Db): SubscriptionMonthRepo {
  return {
    record(month, subs, now) {
      db.transaction(() => {
        // Delete-then-insert, not just upsert: a subscription present in an
        // earlier call for this month but absent from `subs` (renamed, or the
        // seed shrank) must not linger as a stale row. The month-end state is
        // the whole snapshot, not a merge with whatever came before it.
        db.run("DELETE FROM subscription_months WHERE month = ?", month);
        for (const s of subs) {
          db.run(
            `INSERT INTO subscription_months (month, name, amount_huf, cycle, active, recorded_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            month, s.name, s.amountHuf, s.cycle, s.active ? 1 : 0, now.toISOString(),
          );
        }
      });
    },

    forMonth(month) {
      return db
        .all<Row>("SELECT * FROM subscription_months WHERE month = ? ORDER BY name", month)
        .map((r) => ({
          name: r.name, amountHuf: r.amount_huf, cycle: r.cycle, active: r.active === 1,
        }));
    },

    months() {
      return db
        .all<{ month: string }>("SELECT DISTINCT month FROM subscription_months ORDER BY month")
        .map((r) => r.month);
    },
  };
}
