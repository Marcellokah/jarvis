/**
 * THE TOGGLE FILE.
 *
 * Flip `enabled` to drop a module in or out of every brief, on both delivery
 * channels, with no other change anywhere.
 */

export interface ModuleToggle {
  enabled: boolean;
  timeoutMs?: number;
}

export const config = {
  modules: {
    HealthAndMealPrep: {
      enabled: true,
      /**
       * How far ahead to look for freezer deadlines. Keep this >= the gap
       * between briefs, or a deadline can fall between two briefs unmentioned.
       */
      defrostHorizonH: 24,
    },
    FinanceAndSubs: {
      enabled: true,
      /** Alert when a renewal is exactly this many days out. */
      alertDaysBefore: [7, 3, 1],
      /** No recorded use in this long flags it as a cancellation candidate. */
      unusedAfterDays: 60,
    },
    DailySchedule: {
      /** Needs ICLOUD_USERNAME + ICLOUD_APP_PASSWORD; inert without them. */
      enabled: true,
      lookaheadHours: 30,
      /** Local hour you normally leave home — drives the early-start warning. */
      departureHour: 8.5,
    },
    DevStandup: {
      enabled: true,
      timeoutMs: 12_000,
      /** GitHub allows 60 unauthenticated requests/hour; caching keeps us well under. */
      cacheTtlMs: 6 * 3_600_000,
    },
    GamingAndTech: {
      enabled: true,
      timeoutMs: 12_000,
      /** Report a discount at least this deep even without a target price. */
      minDiscountPct: 30,
      cacheTtlMs: 6 * 3_600_000,
    },
    WeekendPlanner: {
      enabled: true,
      /** Thu–Sat: early enough to plan, late enough to trust the forecast. */
      runOnDays: [4, 5, 6],
      timeoutMs: 12_000,
      cacheTtlMs: 3 * 3_600_000,
      /** Budapest belváros, Budapest. */
      latitude: 47.4979,
      longitude: 19.0402,
      maxSuggestions: 3,
    },
  },

  synthesis: {
    /**
     * `groq` first, `template` last. The template can never fail, which is what
     * makes every other entry optional rather than load-bearing.
     */
    chain: ["groq", "template"] as const,
    /** 'sonnet' | 'opus' | 'haiku', or a full model id. */
    model: "sonnet",
    /** Phase 3: let the CLI use its own WebSearch to fill gaps in feed data. */
    webGapFill: false,
    /** Hard ceiling; a wedged CLI is killed rather than holding the brief open. */
    timeoutMs: 90_000,
  },

  groq: {
    /**
     * Chosen by measurement, not by Groq's docs: npm run eval-models lists
     * what the endpoint actually serves, then runs today's real brief through
     * each candidate. openai/gpt-oss-120b, openai/gpt-oss-20b, and
     * qwen/qwen3.6-27b all burned the 1,500-token budget on hidden reasoning
     * before writing an answer and came back truncated; qwen/qwen3.8-27b was
     * the only candidate that reliably held the format contract (verbatim
     * `## ` titles, `- [ ] ` todos) — format fidelity decided it.
     * Compare candidates with: npm run eval-models
     */
    model: "qwen/qwen3.8-27b",
    chatModel: "qwen/qwen3.8-27b",
    /**
     * The free tier allows 6,000 tokens per minute across prompt and
     * completion. jarvis.md plus the payload is roughly 4,200, so the answer
     * has to stay well under two thousand.
     */
    maxTokens: 1_500,
    chatMaxTokens: 800,
    /** Low: the output contract is strict, and invention is the failure mode. */
    temperature: 0.3,
    timeoutMs: 60_000,
  },

  // Unused since app.ts switched Telegram follow-ups to groqChat (see
  // config.groq.chatModel). Kept, along with the still-exported claudeChat in
  // core/chat.ts, so reverting to the Claude Code subscription for chat is a
  // one-line swap in app.ts rather than a rebuild of this block.
  chat: {
    /** Telegram follow-ups. Cheaper and faster than the brief model. */
    model: "haiku",
    timeoutMs: 60_000,
  },

  calendar: {
    /**
     * Jarvis writes ONLY here. Create this calendar in the Naptár app first —
     * a dedicated target means an accepted proposal can never land in the
     * middle of your real schedule, and makes everything it wrote easy to see.
     */
    writeCalendar: "Jarvis",
    /** Calendars to read for context. Empty means all of them. */
    readCalendars: [] as readonly string[],
  },

  schedule: {
    /** After this, a previously reported item may resurface. */
    seenRetentionDays: 21,
  },

  brief: {
    /** A cached brief older than this is regenerated on request. */
    freshnessMinutes: 90,
    /** Cap on how long GET /api/morning-brief will wait for a running generation. */
    maxWaitSeconds: 45,
  },
} as const;

export type Config = typeof config;
