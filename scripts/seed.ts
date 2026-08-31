/**
 * Loads config/*.yaml into the config-shaped tables. Idempotent — re-running
 * replaces the contents rather than appending.
 *
 *   npm run seed
 */
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { createApp } from "../src/app.ts";
import { createMealRepo, type PlannedMeal } from "../src/infra/db/repositories/meals.ts";
import { createSubscriptionRepo, type SubscriptionSeed } from "../src/infra/db/repositories/subscriptions.ts";
import { fromRoot } from "../src/shared/paths.ts";

const mealSchema = z.object({
  weekday: z.number().int().min(0).max(6),
  meal: z.enum(["reggeli", "ebed", "vacsora"]),
  item: z.string().min(1),
  needs_defrost: z.boolean().default(false),
  defrost_lead_h: z.number().int().min(0).max(72).default(0),
  protein_g: z.number().int().nullable().default(null),
  kcal: z.number().int().nullable().default(null),
});

const subscriptionSchema = z.object({
  name: z.string().min(1),
  amount_huf: z.number().int().positive(),
  cycle: z.enum(["monthly", "quarterly", "annual"]),
  next_renewal: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  category: z.string().nullable().default(null),
  cancel_url: z.string().url().nullable().default(null),
  last_used_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  notes: z.string().nullable().default(null),
});

const app = createApp();

try {
  const raw = parse(readFileSync(fromRoot("config/meal-plan.yaml"), "utf8"));
  const parsed = z.array(mealSchema).safeParse(raw);

  if (!parsed.success) {
    console.error("config/meal-plan.yaml is invalid:");
    for (const issue of parsed.error.issues) {
      console.error(`  [${issue.path.join(".")}] ${issue.message}`);
    }
    process.exit(1);
  }

  const meals: PlannedMeal[] = parsed.data.map((m) => ({
    weekday: m.weekday,
    meal: m.meal,
    item: m.item,
    needsDefrost: m.needs_defrost,
    defrostLeadH: m.defrost_lead_h,
    proteinG: m.protein_g,
    kcal: m.kcal,
  }));

  createMealRepo(app.db).replaceAll(meals);
  console.log(`✓ meal_plan: ${meals.length} étkezés betöltve`);

  const subsRaw = parse(readFileSync(fromRoot("config/subscriptions.yaml"), "utf8"));
  const subsParsed = z.array(subscriptionSchema).safeParse(subsRaw);

  if (!subsParsed.success) {
    console.error("config/subscriptions.yaml is invalid:");
    for (const issue of subsParsed.error.issues) {
      console.error(`  [${issue.path.join(".")}] ${issue.message}`);
    }
    process.exit(1);
  }

  const subs: SubscriptionSeed[] = subsParsed.data.map((s) => ({
    name: s.name,
    amountHuf: s.amount_huf,
    cycle: s.cycle,
    nextRenewal: s.next_renewal,
    category: s.category,
    cancelUrl: s.cancel_url,
    lastUsedAt: s.last_used_at,
    notes: s.notes,
  }));

  // Usage marks recorded via Telegram are preserved by the repository.
  createSubscriptionRepo(app.db).replaceAll(subs);
  console.log(`✓ subscriptions: ${subs.length} előfizetés betöltve`);
} finally {
  app.close();
}
