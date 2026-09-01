import { Bot, InlineKeyboard, type Context } from "grammy";
import type { Clock } from "../../infra/clock.ts";
import type { Logger } from "../../infra/logger.ts";
import type { ChatService } from "../../core/chat.ts";
import {
  handleBrief, handleCallback, handleModule, handleModules, handleSynth, handleUndo, handleUsed,
  questionTooLong, HELP, escapeHtml, type BotReply, type TelegramDeps,
} from "./responses.ts";

export interface TelegramOptions extends TelegramDeps {
  token: string;
  /** Only this chat may talk to the bot. Unset means anyone who finds it can. */
  allowedChatId?: string;
  chat: ChatService;
  clock: Clock;
  logger: Logger;
}

/** Module shortcut commands, so `/finance` works as well as the full brief. */
const MODULE_COMMANDS: Record<string, string> = {
  ma: "DailySchedule",
  health: "HealthAndMealPrep",
  finance: "FinanceAndSubs",
  dev: "DevStandup",
  gaming: "GamingAndTech",
  weekend: "WeekendPlanner",
};

export function buildBot(opts: TelegramOptions): Bot {
  const bot = new Bot(opts.token);

  // An unrestricted personal assistant would happily read out your calendar
  // and finances to anyone who found the bot.
  bot.use(async (ctx, next) => {
    const chatId = String(ctx.chat?.id ?? "");
    if (opts.allowedChatId && chatId !== opts.allowedChatId) {
      opts.logger.warn({ chatId }, "rejected message from an unauthorised chat");
      return;
    }
    await next();
  });

  bot.catch((err) => {
    opts.logger.error({ err: String(err.error) }, "telegram handler failed");
  });

  bot.command(["start", "help"], (ctx) => reply(ctx, { text: HELP }));

  bot.command("brief", async (ctx) => {
    await ctx.replyWithChatAction("typing");
    await reply(ctx, await handleBrief(opts, opts.clock.now(), false));
  });

  bot.command("uj", async (ctx) => {
    await ctx.replyWithChatAction("typing");
    await reply(ctx, await handleBrief(opts, opts.clock.now(), true));
  });

  for (const [command, moduleName] of Object.entries(MODULE_COMMANDS)) {
    bot.command(command, async (ctx) => {
      await ctx.replyWithChatAction("typing");
      await reply(ctx, await handleModule(opts, moduleName, opts.clock.now()));
    });
  }

  bot.command("modules", async (ctx) => reply(ctx, await handleModules(opts, opts.clock.now())));
  bot.command("synth", async (ctx) => reply(ctx, await handleSynth(opts, opts.clock.now())));
  bot.command("undo", async (ctx) => reply(ctx, await handleUndo(opts)));
  bot.command("used", async (ctx) => reply(ctx, await handleUsed(opts, ctx.match ?? "", opts.clock.now())));

  bot.on("callback_query:data", async (ctx) => {
    const { reply: response, toast } = await handleCallback(opts, ctx.callbackQuery.data, opts.clock.now());
    await ctx.answerCallbackQuery({ text: toast });
    // Retire the buttons so a proposal cannot be accepted twice by tapping again.
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    await reply(ctx, response);
  });

  // Anything else is a follow-up about today's brief.
  bot.on("message:text", async (ctx) => {
    const question = ctx.message.text.trim();
    if (!question || question.startsWith("/")) return;

    // The same cap POST /api/chat enforces. Telegram allows 4,096 characters
    // per message, and without this the two doors would disagree about what
    // reaches the prompt and the conversations table.
    const tooLong = questionTooLong(question);
    if (tooLong) {
      await reply(ctx, tooLong);
      return;
    }

    if (!(await opts.chat.available())) {
      await reply(ctx, {
        text: "A beszélgetés a Groq ingyenes tierjét használja, aminek most nincs beállítva a kulcsa.\n"
            + "Futtasd egyszer: <code>./scripts/set-secret.sh GROQ_API_KEY</code>\n\n"
            + "A <code>/brief</code> és a modulparancsok addig is működnek.",
      });
      return;
    }

    await ctx.replyWithChatAction("typing");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);
    try {
      const answer = await opts.chat.ask(String(ctx.chat.id), question, controller.signal);
      await reply(ctx, { text: escapeHtml(answer) });
    } catch (err) {
      opts.logger.warn({ err: String(err) }, "follow-up failed");
      await reply(ctx, { text: `⚠️ Nem sikerült válaszolni: ${escapeHtml(String(err))}` });
    } finally {
      clearTimeout(timer);
    }
  });

  return bot;
}

async function reply(ctx: Context, response: BotReply): Promise<void> {
  const keyboard = response.buttons
    ? response.buttons.reduce((kb, row, index) => {
        if (index > 0) kb.row();
        for (const button of row) kb.text(button.text, button.data);
        return kb;
      }, new InlineKeyboard())
    : undefined;

  // Telegram caps a message at 4096 characters. Buttons go on the last chunk
  // only — repeating them would let one proposal be accepted several times.
  const chunks = chunkText(response.text, 4000);
  for (const [index, chunk] of chunks.entries()) {
    const isLast = index === chunks.length - 1;
    await ctx.reply(chunk, {
      parse_mode: "HTML",
      ...(keyboard && isLast ? { reply_markup: keyboard } : {}),
    });
  }
}

/** Splits on paragraph boundaries so a section is not cut mid-sentence. */
export function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let current = "";
  for (const paragraph of text.split("\n\n")) {
    if (current && current.length + paragraph.length + 2 > limit) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
