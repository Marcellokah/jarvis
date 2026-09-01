import { readFile } from "node:fs/promises";
import type { Fetcher } from "../../infra/http-client.ts";
import type { Logger } from "../../infra/logger.ts";
import { groqComplete } from "../../infra/groq.ts";
import { withTimeout } from "../../infra/abort.ts";
import type { Candidate } from "./candidates.ts";

/** The plain listing. It cannot fail, which is the point of having it. */
export function renderNotifyTemplate(cs: readonly Candidate[]): string {
  if (cs.length === 0) return "";
  return cs.map((c) => `• ${c.text}`).join("\n");
}

export function buildNotifyPrompt(cs: readonly Candidate[]): { system: string; user: string } {
  return {
    system: [
      "Egy személyes asszisztens vagy. A feladatod EGYETLEN rövid Telegram-üzenet",
      "megfogalmazása az alábbi, már eldöntött tételekből.",
      "",
      "Szabályok:",
      "- Csak a megadott tételekről írj. Ne tegyél hozzá újat, és ne találj ki adatot.",
      "- Ne mérlegeld, hogy egy tétel fontos-e — ezt már eldöntötték helyetted.",
      "- Tartsd meg a tételekben szereplő számokat, mert azok a bizonyíték.",
      "- Magyarul, tömören. Legfeljebb néhány sor. Ne írj bevezetőt és lezárást.",
      "",
      "FONTOS: Ez nem napi összefoglalás. Ne használj markdown címsorokat (#, ##, stb.).",
      "Csak folyamatos szöveget írj.",
    ].join("\n"),
    user: ["A tételek:", ...cs.map((c) => `- [${c.urgency}] ${c.text}`)].join("\n"),
  };
}

export interface ComposeOptions {
  fetcher: Fetcher;
  model: string;
  systemPromptFile: string;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  logger: Logger;
  apiKey: () => Promise<string | undefined>;
}

/**
 * The wording, with a floor under it.
 *
 * The model only phrases what the thresholds already decided to send. If it is
 * unreachable, slow, or returns nothing, the template goes out instead: a
 * notification must never be lost to a failure of phrasing. An ugly sentence
 * is better than a missed defrost deadline.
 */
export async function composeNotification(
  cs: readonly Candidate[],
  opts: ComposeOptions,
  signal: AbortSignal,
): Promise<{ text: string; source: "groq" | "template" }> {
  const fallback = renderNotifyTemplate(cs);

  // Short-circuit for empty list: no request needed if there is nothing to say.
  if (cs.length === 0) {
    return { text: fallback, source: "template" };
  }

  try {
    const apiKey = await opts.apiKey();
    if (!apiKey) throw new Error("GROQ_API_KEY is not set");

    const { system, user } = buildNotifyPrompt(cs);
    const answer = await withTimeout(signal, opts.timeoutMs, async (abortSignal) => {
      // The persona lives in jarvis.md; the notification rules are appended so
      // one short message still sounds like the rest of the assistant.
      const persona = await readFile(opts.systemPromptFile, "utf8");
      return groqComplete(opts.fetcher, {
        apiKey, model: opts.model,
        system: `${persona}\n\n---\n\n${system}`,
        user, maxTokens: opts.maxTokens, temperature: opts.temperature,
        signal: abortSignal,
      });
    });

    if (!answer.trim()) throw new Error("the model returned an empty answer");

    // Reject answers that look like brief format (start with markdown heading).
    // The persona's output contract should not leak into a short notification.
    if (answer.trim().startsWith("#")) {
      throw new Error("the model answered in brief format instead of one short message");
    }

    return { text: answer.trim(), source: "groq" };
  } catch (err) {
    opts.logger.warn({ err: String(err) }, "notification wording fell back to the template");
    return { text: fallback, source: "template" };
  }
}
