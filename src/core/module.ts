import type { Db } from "../infra/db/index.ts";
import type { Logger } from "../infra/logger.ts";
import type { SeenStore } from "../infra/db/repositories/seen.ts";
import type { ModuleCache } from "../infra/db/repositories/cache.ts";
import type { Fetcher } from "../infra/http-client.ts";
import type { SecretResolver } from "../infra/secrets.ts";
import type { CalendarService } from "../infra/calendar/service.ts";
import type { Tz } from "../shared/dates.ts";

/** Section ordering in the brief. `critical` floats to the top. */
export type Priority = "critical" | "normal" | "fyi";

/** An event Jarvis offers to create. Never written without explicit acceptance. */
export interface CalendarProposal {
  title: string;
  /** ISO 8601 with offset, Europe/Budapest. */
  start: string;
  end: string;
  location?: string;
  notes?: string;
  /** Target calendar name; defaults to the dedicated `Jarvis` calendar. */
  calendar?: string;
}

/**
 * Either something you tick off, or something Jarvis offers to do.
 * Proposals render as inline keyboards in Telegram and degrade to a plain
 * `- [ ]` line everywhere a button cannot exist (iOS notification, API text).
 */
export type ActionItem =
  | { id: string; kind: "checkbox"; text: string }
  | { id: string; kind: "proposal"; text: string; proposal: CalendarProposal };

export interface ModuleResult<T = unknown> {
  /** Structured facts. This is what synthesis reasons over. */
  data: T;
  actions: ActionItem[];
  priority: Priority;
  /** Stable keys for items already reported; see SeenStore. */
  dedupeKeys?: string[];
  /** Set when the module partially failed but still has something useful. */
  degraded?: string;
}

export interface ModuleContext {
  /** Injected clock. Modules must never call `new Date()` themselves. */
  now: Date;
  tz: Tz;
  db: Db;
  http: Fetcher;
  /**
   * Read for context, write only on explicit acceptance. Every module gets it:
   * a 09:00 meeting changes what meal prep is realistic, and a full Saturday
   * changes what the weekend planner should suggest.
   */
  calendar: CalendarService;
  secrets: SecretResolver;
  logger: Logger;
  /** Per-module timeout. Long-running work must respect it. */
  signal: AbortSignal;
  seen: SeenStore;
  /** Scoped to this module. Serves stale data rather than nothing on failure. */
  cache: ModuleCache;
}

/** 'daily' | 'weekly' | specific weekdays (0 = Sunday … 6 = Saturday). */
export type ModuleSchedule = "daily" | { days: number[] };

export interface HealthStatus {
  ok: boolean;
  detail?: string;
}

export interface JarvisModule<TData = unknown> {
  /** Stable identifier; must match the key in config.modules. */
  readonly name: string;
  /** Section heading in the brief, emoji included. */
  readonly title: string;
  /** Resolved from config.ts by the registry. */
  readonly enabled: boolean;
  readonly schedule?: ModuleSchedule;
  readonly timeoutMs?: number;
  readonly cacheTtlMs?: number;

  /** Gather facts. Return null for "nothing worth saying today". */
  execute(ctx: ModuleContext): Promise<ModuleResult<TData> | null>;

  /**
   * Deterministic Hungarian rendering of the section body, without the heading.
   *
   * This is the price of the zero-cost constraint: every module must be able
   * to state its findings with no LLM involved. It is what makes the 07:30
   * notification unconditional, and it is what the test suite asserts against.
   */
  renderPlain(result: ModuleResult<TData>): string;

  followUp?(question: string, ctx: ModuleContext): Promise<ModuleResult<TData> | null>;
  healthCheck?(ctx: ModuleContext): Promise<HealthStatus>;
}

/** What the runner produces for one module — success, skip, or failure. */
export interface ModuleOutcome {
  name: string;
  title: string;
  priority: Priority;
  status: "ok" | "empty" | "failed";
  result: ModuleResult | null;
  /** Section body from renderPlain(), or the failure notice. */
  plain: string;
  actions: ActionItem[];
  durationMs: number;
  error?: string;
}
