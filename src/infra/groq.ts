import type { Fetcher } from "./http-client.ts";

/** OpenAI-compatible, which is why this needs no SDK — one endpoint, one shape. */
export const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
export const GROQ_MODELS_URL = "https://api.groq.com/openai/v1/models";

export interface GroqRequest {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
  signal: AbortSignal;
}

interface GroqResponse {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * One completion, returned as text.
 *
 * Everything that could produce a half-brief throws instead of returning:
 * the synthesis chain reads a thrown error as "demote to the next
 * synthesizer", and the template renderer below it cannot fail. A truncated
 * or empty answer that got returned would be published as your brief.
 */
export async function groqComplete(fetcher: Fetcher, req: GroqRequest): Promise<string> {
  const res = await fetcher.json<GroqResponse>(GROQ_CHAT_URL, {
    method: "POST",
    signal: req.signal,
    headers: {
      // The key travels in the header and nowhere else — not the URL, not the
      // body, so a logged request line can never carry it.
      authorization: `Bearer ${req.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: req.model,
      temperature: req.temperature,
      max_completion_tokens: req.maxTokens,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
    }),
  });

  const choice = res.choices?.[0];
  if (!choice) throw new Error("Groq returned no completion");

  if (choice.finish_reason === "length") {
    throw new Error("Groq completion was truncated — raise maxTokens or shorten the prompt");
  }

  const text = (choice.message?.content ?? "").trim();
  if (!text) throw new Error("Groq returned an empty completion");

  return text;
}
