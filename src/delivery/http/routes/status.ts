import type { FastifyInstance } from "fastify";
import type { JarvisModule } from "../../../core/module.ts";
import type { RunnerDeps } from "../../../core/runner.ts";
import type { Clock } from "../../../infra/clock.ts";
import { runsToday } from "../../../core/registry.ts";
import { buildModuleContext } from "../../../core/runner.ts";

export function registerStatusRoutes(
  app: FastifyInstance,
  deps: { modules: readonly JarvisModule[]; runner: RunnerDeps; clock: Clock },
): void {
  app.get("/healthz", async () => ({ ok: true }));

  app.get("/api/modules", async () => {
    const now = deps.clock.now();

    const statuses = await Promise.all(
      deps.modules.map(async (module) => {
        const base = {
          name: module.name,
          title: module.title,
          enabled: module.enabled,
          runsToday: runsToday(module.schedule, now, deps.runner.tz),
        };
        if (!module.enabled || !module.healthCheck) return { ...base, health: null };

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5_000);
        const ctx = buildModuleContext(deps.runner, module.name, now, controller.signal);
        try {
          return { ...base, health: await module.healthCheck(ctx) };
        } catch (err) {
          return { ...base, health: { ok: false, detail: String(err) } };
        } finally {
          clearTimeout(timer);
        }
      }),
    );

    return { modules: statuses };
  });
}
