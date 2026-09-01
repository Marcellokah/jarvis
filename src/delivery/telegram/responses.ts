import type { BriefService } from "../../core/brief-service.ts";
import { MAX_QUESTION_CHARS } from "../../core/chat.ts";
import type { ProposalService } from "../../core/proposals.ts";
import { ProposalError } from "../../core/proposals.ts";
import type { ActionRepo } from "../../infra/db/repositories/actions.ts";
import type { SubscriptionRepo } from "../../infra/db/repositories/subscriptions.ts";
import type { JarvisModule } from "../../core/module.ts";

import { toTelegramHtml } from "../../core/renderer.ts";
import { isoDate } from "../../shared/dates.ts";
import { buildModuleContext, type RunnerDeps } from "../../core/runner.ts";

export interface Button { text: string; data: string }
export interface BotReply { text: string; buttons?: Button[][] }

export interface TelegramDeps {
  briefs: BriefService;
  proposals: ProposalService;
  actions: ActionRepo;
  subscriptions: SubscriptionRepo;
  modules: readonly JarvisModule[];
  runner: RunnerDeps;
}

/**
 * Handlers are pure with respect to grammY: they take deps and return text
 * plus optional buttons. That keeps every command testable without a bot token
 * or a network connection.
 */

/**
 * The reply for a question that is too long, or null when it fits.
 *
 * Extracted rather than inlined in the bot: `POST /api/chat` rejects anything
 * over `MAX_QUESTION_CHARS`, and Telegram allows 4,096 characters per message.
 * Two doors onto the same prompt and the same `conversations` table must agree
 * on what fits, and the only way to keep them agreeing is to make this
 * testable on its own.
 */
export function questionTooLong(question: string): BotReply | null {
  if (question.length <= MAX_QUESTION_CHARS) return null;
  return {
    text: `A kérdés túl hosszú: ${question.length} karakter, a határ ${MAX_QUESTION_CHARS}.\n`
        + "Bontsd rövidebbre — a modell keretébe így sem férne bele.",
  };
}

export async function handleBrief(deps: TelegramDeps, now: Date, force: boolean): Promise<BotReply> {
  const brief = await deps.briefs.get(now, { force });
  const open = deps.actions.listOpen(brief.date);

  return {
    text: toTelegramHtml(brief.markdown),
    buttons: buildActionButtons(open),
  };
}

export async function handleModule(deps: TelegramDeps, name: string, now: Date): Promise<BotReply> {
  const outcome = await deps.briefs.runOne(name, now);

  if (!outcome) {
    const available = deps.modules.filter((m) => m.enabled).map((m) => m.name).join(", ");
    return { text: `Nincs <b>${escapeHtml(name)}</b> nevű aktív modul.\nElérhető: ${escapeHtml(available)}` };
  }
  if (outcome.status === "empty") {
    return { text: `<b>${escapeHtml(outcome.title)}</b>\n\nMa nincs jelenteni való.` };
  }

  return {
    text: `<b>${escapeHtml(outcome.title)}</b>\n\n${toTelegramHtml(outcome.plain)}`,
    buttons: buildActionButtons(
      deps.actions.listOpen(isoDate(now, deps.runner.tz)).filter((a) => a.module === outcome.name),
    ),
  };
}

export async function handleModules(deps: TelegramDeps, now: Date): Promise<BotReply> {
  const lines: string[] = ["<b>Modulok</b>", ""];

  for (const module of deps.modules) {
    if (!module.enabled) { lines.push(`⚪ ${escapeHtml(module.name)} — kikapcsolva`); continue; }
    if (!module.healthCheck) { lines.push(`✅ ${escapeHtml(module.name)}`); continue; }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    const ctx = buildModuleContext(deps.runner, module.name, now, controller.signal);
    try {
      const health = await module.healthCheck(ctx);
      lines.push(`${health.ok ? "✅" : "⚠️"} ${escapeHtml(module.name)}${health.detail ? ` — ${escapeHtml(health.detail)}` : ""}`);
    } catch (err) {
      lines.push(`❌ ${escapeHtml(module.name)} — ${escapeHtml(String(err))}`);
    } finally {
      clearTimeout(timer);
    }
  }

  return { text: lines.join("\n") };
}

export async function handleUsed(deps: TelegramDeps, fragment: string, now: Date): Promise<BotReply> {
  if (!fragment.trim()) return { text: "Használat: <code>/used gym</code>" };

  const updated = deps.subscriptions.markUsed(fragment.trim(), now);
  if (!updated) {
    const names = deps.subscriptions.listActive().map((s) => s.name).join(", ");
    return { text: `Nincs találat erre: <b>${escapeHtml(fragment)}</b>\nAktív: ${escapeHtml(names)}` };
  }
  return { text: `✅ <b>${escapeHtml(updated.name)}</b> — használat rögzítve (${updated.lastUsedAt}).` };
}

export async function handleSynth(deps: TelegramDeps, now: Date): Promise<BotReply> {
  const brief = await deps.briefs.get(now, { wait: false });
  return {
    text: [
      `<b>Szintetizáló:</b> ${escapeHtml(brief.synthesizer)}`,
      `<b>Generálva:</b> ${escapeHtml(brief.generatedAt)}`,
      `<b>Időtartam:</b> ${brief.durationMs} ms`,
      brief.synthesizer === "template"
        ? "\n⚠️ A template fallback fut. Prózához: <code>./scripts/set-secret.sh GROQ_API_KEY</code>."
        : "",
    ].filter(Boolean).join("\n"),
  };
}

export async function handleUndo(deps: TelegramDeps): Promise<BotReply> {
  const writes = deps.proposals.listUndoable(5);
  if (writes.length === 0) return { text: "Nincs visszavonható naptárbejegyzés." };

  return {
    text: "<b>Jarvis által létrehozott események</b>\nVálaszd ki, melyiket vonjam vissza:",
    buttons: writes.map((w) => [{
      text: `🗑 ${w.title}`,
      data: `undo:${w.eventUid}`,
    }]),
  };
}

/** Inline keyboard callbacks: accept / decline a proposal, tick a checkbox, undo a write. */
export async function handleCallback(
  deps: TelegramDeps, data: string, now: Date,
): Promise<{ reply: BotReply; toast: string }> {
  const [verb, ...rest] = data.split(":");
  const id = rest.join(":");

  try {
    switch (verb) {
      case "accept": {
        const result = await deps.proposals.accept(id, now);
        return {
          toast: "Naptárba írva",
          reply: { text: `✅ <b>${escapeHtml(result.action.text)}</b>\nBekerült a(z) ${escapeHtml(result.calendar)} naptárba.` },
        };
      }
      case "decline": {
        const action = await deps.proposals.decline(id, now);
        return { toast: "Elvetve", reply: { text: `🚫 Elvetve: ${escapeHtml(action.text)}` } };
      }
      case "done": {
        const action = await deps.proposals.complete(id, now);
        return { toast: "Kész", reply: { text: `☑️ ${escapeHtml(action.text)}` } };
      }
      case "undo": {
        await deps.proposals.undo(id, now);
        return { toast: "Visszavonva", reply: { text: "🗑 Az esemény törölve a naptárból." } };
      }
      default:
        return { toast: "Ismeretlen gomb", reply: { text: "Ismeretlen művelet." } };
    }
  } catch (err) {
    const message = err instanceof ProposalError ? err.message : String(err);
    return { toast: "Nem sikerült", reply: { text: `⚠️ ${escapeHtml(message)}` } };
  }
}

function buildActionButtons(actions: ReturnType<ActionRepo["listOpen"]>): Button[][] | undefined {
  if (actions.length === 0) return undefined;

  return actions.map((action) =>
    action.kind === "proposal"
      ? [
          { text: `✅ ${truncate(action.text, 24)}`, data: `accept:${action.id}` },
          { text: "🚫 Elvetem", data: `decline:${action.id}` },
        ]
      : [{ text: `☑️ ${truncate(action.text, 40)}`, data: `done:${action.id}` }],
  );
}

/** Telegram rejects callback_data over 64 bytes and button text that is too long. */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const HELP = [
  "<b>Jarvis</b>",
  "",
  "/brief — a mai briefing",
  "/uj — friss briefing (cache megkerülése)",
  "/ma — mai naptár",
  "/health — egészség &amp; meal prep",
  "/finance — pénzügy &amp; előfizetések",
  "/modules — modulok állapota",
  "/used &lt;név&gt; — előfizetés használat rögzítése",
  "/undo — naptárbejegyzés visszavonása",
  "/synth — melyik szintetizáló futott",
  "",
  "Bármi mást írsz, arra a mai briefing kontextusában válaszolok.",
].join("\n");
