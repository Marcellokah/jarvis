/**
 * Verifies the Telegram bot token and finds your chat id — without involving a
 * third-party bot, which would otherwise see your profile just to tell you a
 * number your own bot already knows.
 *
 *   ./scripts/set-secret.sh TELEGRAM_BOT_TOKEN
 *   npm run telegram:setup
 */
import { createApp } from "../src/app.ts";

process.env.LOG_LEVEL ??= "error";
const app = createApp();

interface TgResponse<T> { ok: boolean; result?: T; description?: string }
interface TgChat { id: number; type: string; title?: string; username?: string; first_name?: string }
interface TgUpdate { message?: { chat?: TgChat; text?: string }; edited_message?: { chat?: TgChat } }

try {
  const token = await app.runner.secrets.get("TELEGRAM_BOT_TOKEN");
  if (!token) {
    console.error("✗ Nincs TELEGRAM_BOT_TOKEN.\n");
    console.error("  1. Telegramban írj a @BotFather-nek:  /newbot");
    console.error("  2. Adj neki nevet, majd egy 'bot'-ra végződő felhasználónevet.");
    console.error("  3. A kapott tokent tedd el:");
    console.error("       ./scripts/set-secret.sh TELEGRAM_BOT_TOKEN\n");
    process.exit(1);
  }

  const api = `https://api.telegram.org/bot${token}`;

  const me = await fetch(`${api}/getMe`).then((r) => r.json() as Promise<TgResponse<TgChat>>);
  if (!me.ok) {
    console.error(`✗ A token érvénytelen: ${me.description ?? "ismeretlen hiba"}`);
    console.error("  Kérj újat a @BotFather-től: /mybots → API Token");
    process.exit(1);
  }
  console.log(`✓ Bot: @${me.result?.username} (${me.result?.first_name})`);

  const updates = await fetch(`${api}/getUpdates?limit=100`)
    .then((r) => r.json() as Promise<TgResponse<TgUpdate[]>>);

  const chats = new Map<number, TgChat>();
  for (const update of updates.result ?? []) {
    const chat = update.message?.chat ?? update.edited_message?.chat;
    if (chat) chats.set(chat.id, chat);
  }

  if (chats.size === 0) {
    console.log("\n⚠️  Még nem írtál a botnak, ezért nincs mit azonosítani.");
    console.log(`  1. Nyisd meg: https://t.me/${me.result?.username}`);
    console.log("  2. Küldj neki egy üzenetet (bármit, pl. /start).");
    console.log("  3. Futtasd újra: npm run telegram:setup");
    process.exit(1);
  }

  console.log("\nChat azonosítók:");
  for (const chat of chats.values()) {
    const who = chat.title ?? [chat.first_name, chat.username && `@${chat.username}`].filter(Boolean).join(" ");
    console.log(`  ${String(chat.id).padEnd(16)} ${chat.type.padEnd(8)} ${who}`);
  }

  const own = [...chats.values()].filter((c) => c.type === "private");
  if (own.length === 1) {
    console.log(`\nEz a tiéd. Tedd el:`);
    console.log(`  ./scripts/set-secret.sh TELEGRAM_ALLOWED_CHAT_ID`);
    console.log(`  → ${own[0]!.id}`);
    console.log("\nEnélkül bárki, aki megtalálja a botot, elolvashatja a naptáradat és a pénzügyeidet.");
  }
} finally {
  app.close();
}
