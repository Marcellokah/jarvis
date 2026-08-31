import type { Db } from "../index.ts";

export type MealSlot = "reggeli" | "ebed" | "vacsora";

export interface PlannedMeal {
  weekday: number;
  meal: MealSlot;
  item: string;
  needsDefrost: boolean;
  defrostLeadH: number;
  proteinG: number | null;
  kcal: number | null;
}

export interface MealRepo {
  forWeekday(weekday: number): PlannedMeal[];
  replaceAll(meals: PlannedMeal[]): void;
  count(): number;
}

interface Row {
  weekday: number;
  meal: MealSlot;
  item: string;
  needs_defrost: number;
  defrost_lead_h: number;
  protein_g: number | null;
  kcal: number | null;
}

const ORDER: Record<MealSlot, number> = { reggeli: 0, ebed: 1, vacsora: 2 };

const toMeal = (r: Row): PlannedMeal => ({
  weekday: r.weekday,
  meal: r.meal,
  item: r.item,
  needsDefrost: r.needs_defrost === 1,
  defrostLeadH: r.defrost_lead_h,
  proteinG: r.protein_g,
  kcal: r.kcal,
});

export function createMealRepo(db: Db): MealRepo {
  return {
    forWeekday(weekday) {
      return db
        .all<Row>("SELECT * FROM meal_plan WHERE weekday = ?", weekday)
        .map(toMeal)
        .sort((a, b) => ORDER[a.meal] - ORDER[b.meal]);
    },
    replaceAll(meals) {
      db.transaction(() => {
        db.run("DELETE FROM meal_plan");
        for (const m of meals) {
          db.run(
            `INSERT INTO meal_plan (weekday, meal, item, needs_defrost, defrost_lead_h, protein_g, kcal)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            m.weekday, m.meal, m.item, m.needsDefrost ? 1 : 0, m.defrostLeadH, m.proteinG, m.kcal,
          );
        }
      });
    },
    count() {
      return db.get<{ n: number }>("SELECT COUNT(*) AS n FROM meal_plan")?.n ?? 0;
    },
  };
}
