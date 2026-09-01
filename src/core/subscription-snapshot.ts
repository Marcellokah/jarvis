import type { SubscriptionRepo } from "../infra/db/repositories/subscriptions.ts";
import type { SubscriptionMonthRepo } from "../infra/db/repositories/subscription-months.ts";
import type { Clock } from "../infra/clock.ts";
import { TZ, isoDate } from "../shared/dates.ts";

export interface SubscriptionSnapshotDeps {
  subscriptions: SubscriptionRepo;
  subscriptionMonths: SubscriptionMonthRepo;
  clock: Clock;
}

/**
 * The current month's subscription state, as it stands right now.
 *
 * One implementation, called from both the start-up hook (main.ts) and the
 * nightly sweep (infra/scheduler.ts), so the two call sites cannot drift the
 * way they already had once: differing error handling, and `isoDate(now)`
 * vs. `isoDate(now, TZ)` agreeing only because TZ happens to be that
 * parameter's default.
 */
export function recordSubscriptionMonth(deps: SubscriptionSnapshotDeps): void {
  const now = deps.clock.now();
  const month = isoDate(now, TZ).slice(0, 7);
  deps.subscriptionMonths.record(
    month,
    deps.subscriptions.listAll().map((s) => ({
      name: s.name, amountHuf: s.amountHuf, cycle: s.cycle, active: s.active,
    })),
    now,
  );
}
