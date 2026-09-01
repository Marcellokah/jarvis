import type { Db } from "../index.ts";

export type Role = "user" | "assistant";

export interface Turn {
  id: number;
  chatId: string;
  role: Role;
  content: string;
  createdAt: string;
}

export interface ConversationRepo {
  /**
   * A question and its answer, written together.
   *
   * There is deliberately no way to store a question on its own: a thread
   * containing a question with no answer reads, on the next turn, as a model
   * that refused to reply, and the model then explains the refusal instead of
   * answering. Storing only after a successful call keeps that state
   * unreachable.
   */
  appendExchange(chatId: string, question: string, answer: string, now: Date): void;
  /** The last `n` turns of a thread, oldest first — a prompt reads forwards. */
  recent(chatId: string, n: number): Turn[];
  /** Deletes turns created strictly before `before`; returns how many. */
  prune(before: Date): number;
}

interface Row {
  id: number; chat_id: string; role: Role; content: string; created_at: string;
}

const toTurn = (r: Row): Turn => ({
  id: r.id, chatId: r.chat_id, role: r.role, content: r.content, createdAt: r.created_at,
});

export function createConversationRepo(db: Db): ConversationRepo {
  return {
    appendExchange(chatId, question, answer, now) {
      if (!question.trim() || !answer.trim()) {
        throw new Error("A kérdés és a válasz sem lehet üres.");
      }
      const at = now.toISOString();
      db.transaction(() => {
        const insert = "INSERT INTO conversations (chat_id, role, content, created_at) VALUES (?, ?, ?, ?)";
        db.run(insert, chatId, "user", question, at);
        db.run(insert, chatId, "assistant", answer, at);
      });
    },

    recent(chatId, n) {
      // Newest-first with a limit, then reversed: taking the last n turns and
      // presenting them forwards. Ordering by id as well as time matters
      // because both turns of one exchange share a timestamp.
      return db.all<Row>(
        `SELECT * FROM (
           SELECT * FROM conversations WHERE chat_id = ?
           ORDER BY created_at DESC, id DESC LIMIT ?
         ) ORDER BY created_at, id`,
        chatId, n,
      ).map(toTurn);
    },

    prune(before) {
      const cutoff = before.toISOString();
      const doomed = db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM conversations WHERE created_at < ?", cutoff,
      )?.n ?? 0;
      db.run("DELETE FROM conversations WHERE created_at < ?", cutoff);
      return doomed;
    },
  };
}
