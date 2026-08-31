import { config } from "../../config/config.ts";
import { healthAndMealPrep } from "./health-mealprep/index.ts";
import { financeAndSubs } from "./finance-subs/index.ts";
import { dailySchedule } from "./daily-schedule/index.ts";
import { devStandup } from "./dev-standup/index.ts";
import { gamingAndTech } from "./gaming-tech/index.ts";
import { weekendPlanner } from "./weekend-planner/index.ts";
import type { JarvisModule } from "../core/module.ts";

/**
 * THE REGISTRATION BARREL.
 *
 * Adding a module is: write the file, add one import, add one line here, and
 * flip its `enabled` in config.ts. Deliberately explicit rather than scanned
 * from disk — a typo should be a type error, not a silently missing section.
 */
export const ALL_MODULES: readonly JarvisModule[] = [
  dailySchedule(config.modules.DailySchedule),
  healthAndMealPrep(config.modules.HealthAndMealPrep),
  financeAndSubs(config.modules.FinanceAndSubs),
  weekendPlanner(config.modules.WeekendPlanner),
  gamingAndTech(config.modules.GamingAndTech),
  devStandup(config.modules.DevStandup),
];
