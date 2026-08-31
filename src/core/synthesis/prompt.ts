import type { BriefContext } from "./synthesizer.ts";

/**
 * The synthesis prompt. Provider-independent on purpose: every synthesizer
 * sends the same thing, so a model comparison measures the model and not an
 * accidental difference in what it was asked.
 */
export function buildPrompt(ctx: BriefContext): string {
  const payload = {
    date: ctx.date,
    dateLabel: ctx.dateLabel,
    time: ctx.time,
    sections: ctx.outcomes
      .filter((o) => o.status !== "empty")
      .map((o) => ({
        module: o.name,
        title: o.title,
        priority: o.priority,
        status: o.status,
        facts: o.result?.data ?? null,
        degraded: o.result?.degraded ?? null,
        actions: o.actions.map((a) => ({
          text: a.text,
          kind: a.kind,
          ...(a.kind === "proposal" ? { proposal: a.proposal } : {}),
        })),
        fallbackText: o.plain,
      })),
  };

  return [
    "Az alábbi JSON a mai modulok nyers adata. Írd meg belőle a reggeli briefinget",
    "PONTOSAN az OPERATIONAL CONTRACT szerint (lásd a rendszerpromptot).",
    "",
    "Fontos:",
    "- A `title` mezőket szó szerint használd `## ` szekciócímként.",
    "- Minden `actions` elemből legyen egy `- [ ] ` sor, a szekciója végén.",
    "- Csak a megadott adatra támaszkodj; ne találj ki tényeket.",
    "- Ne írj bevezetőt és lezárást.",
    "",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

/**
 * The contract in jarvis.md opens with exactly one `#` date heading, and the
 * renderer splits on that. A model that wants a tool it does not have writes
 * the call out as prose instead — non-empty, so only a shape check keeps it
 * out of your morning. Throwing hands the brief to the template renderer,
 * which is the whole point of having one.
 */
export function assertContract(markdown: string): string {
  const text = markdown.trim();
  if (!text) throw new Error("synthesizer returned an empty result");
  if (!text.startsWith("#")) {
    throw new Error(`output did not start with a '#' heading: ${text.slice(0, 80)}`);
  }
  return markdown;
}
