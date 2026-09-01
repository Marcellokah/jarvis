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
    /**
     * How many previous turns of a thread the model sees. A turn is one
     * message, so 2 is the last exchange: the previous question and its answer.
     *
     * Measured, and the arithmetic has to close against 6,000 tokens per
     * minute covering prompt AND completion — not prompt alone. The design's
     * original ~2,900 left out jarvis.md entirely; the first correction put it
     * back but still compared an input-only total against the ceiling, which
     * is the same under-count one order smaller.
     *
     *   jarvis.md, the system prompt, every call   ~2,300
     *   the per-domain analysis summaries          ~  600
     *   the trimmed statistics                     ~1,100
     *   today's brief                              ~  350
     *   ------------------------------------------------
     *   input with an empty thread                 ~4,350   (matches the ~4,300 measured)
     *   2 turns, at 125–325 tokens each              250–650
     *   ------------------------------------------------
     *   input, worst case                          ~5,000
     *   + chatMaxTokens                                800
     *   ================================================
     *   worst case, prompt + completion            ~5,800   under 6,000, by 200
     *
     * The per-turn range is measured across real threads (a six-turn thread
     * cost 5,100–6,300 in total, so 750–1,950 for the thread itself). It is
     * not a hard bound: a deliberately maximal turn — a question at the
     * 2,000-character cap plus an answer at the full 800 tokens — is ~1,400
     * tokens on its own, and no depth above 1 can bound that arithmetically.
     * That case is a Groq 429, which both doors report rather than swallow;
     * a visible failure, not a quietly truncated answer.
     *
     * Every step above six is what pushed this down: 4 turns is ~5,650 input
     * and ~6,450 with the completion, over the ceiling. 3 is ~6,125, still over.
     */
    chatHistoryDepth: 2,
    /** Low: the output contract is strict, and invention is the failure mode. */
    temperature: 0.3,
    timeoutMs: 60_000,
  },

  analysis: {
    /** The same model the brief settled on after measurement. */
    model: "qwen/qwen3.8-27b",
    maxTokens: 1_200,
    temperature: 0.3,
    timeoutMs: 60_000,
    /** Wait between calls: the free tier allows 6,000 tokens a minute. */
    paceMs: 60_000,
    /** How many previous summaries a domain sees. Each one costs budget. */
    memoryDepth: 3,
    /** Below this many paired days a correlation never reaches the prompt. */
    minCorrelationN: 30,
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
    /**
     * A conversation thread is not durable memory — that is the `analyses`
     * table's job — only the recent back-and-forth a follow-up question
     * depends on. Nobody asks a follow-up to a turn from last month.
     */
    conversationRetentionDays: 30,
  },

  brief: {
    /** A cached brief older than this is regenerated on request. */
    freshnessMinutes: 90,
    /** Cap on how long GET /api/morning-brief will wait for a running generation. */
    maxWaitSeconds: 45,
  },

  notify: {
    /** How often the tick runs. The gates decide whether it does anything. */
    cron: "*/15 * * * *",
    /** Never speak twice inside this many hours. */
    minHoursBetween: 4,
    /** Quiet from this local hour (inclusive) until that one (exclusive). */
    quietFromHour: 22,
    quietToHour: 7,
    model: "qwen/qwen3.8-27b",
    /**
     * Output budget for the phrased message, not the input. `groqComplete`
     * throws away a truncated completion whole rather than returning the
     * partial text, so an undersized budget does not shorten the message —
     * it silently loses the model's wording and falls back to the template.
     * 300 was too small: four real candidates alone were 1,257 characters,
     * and qwen also spends from this same budget on hidden reasoning before
     * it writes the answer. 800 leaves headroom for both.
     */
    maxTokens: 800,
    temperature: 0.4,
    timeoutMs: 30_000,
  },
} as const;

export type Config = typeof config;
