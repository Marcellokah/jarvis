import { randomUUID } from "node:crypto";
import type { Db } from "../index.ts";
import type { ActionItem, CalendarProposal } from "../../../core/module.ts";

export type ActionStatus = "open" | "done" | "accepted" | "declined";

export interface StoredAction {
  id: string;
  date: string;
  module: string;
  kind: "checkbox" | "proposal";
  text: string;
  proposal: CalendarProposal | null;
  status: ActionStatus;
}

export interface ActionRepo {
  replaceForDate(date: string, items: { module: string; action: ActionItem }[], now: Date): StoredAction[];
  listOpen(date: string): StoredAction[];
  /**
   * Every open action, whatever day it belongs to, newest day first.
   *
   * `listOpen(date)` asks about one day, and that is the wrong question for
   * the page: `replaceForDate` only ever replaces the actions of the day it
   * runs for, so an action from any other day stays open until someone closes
   * it. On the real database `listOpen(today)` currently answers with nothing
   * while nine actions sit open — a page built on it would claim there is
   * nothing to do.
   */
  listAllOpen(): StoredAction[];
  find(id: string): StoredAction | undefined;
  setStatus(id: string, status: ActionStatus, now: Date): void;
}

interface Row {
  id: string;
  date: string;
  module: string;
  kind: "checkbox" | "proposal";
  text: string;
  proposal_json: string | null;
  status: ActionStatus;
}

function toStored(row: Row): StoredAction {
  return {
    id: row.id,
    date: row.date,
    module: row.module,
    kind: row.kind,
    text: row.text,
    proposal: row.proposal_json ? (JSON.parse(row.proposal_json) as CalendarProposal) : null,
    status: row.status,
  };
}

export function createActionRepo(db: Db): ActionRepo {
  return {
    /**
     * Rewrites the day's actions, preserving the status of any that survive a
     * regeneration — so re-running the brief never un-ticks something you did.
     */
    replaceForDate(date, items, now) {
      return db.transaction(() => {
        const prior = new Map(
          db
            .all<Row>("SELECT * FROM action_items WHERE date = ?", date)
            .map((r) => [`${r.module}::${r.text}`, r]),
        );
        db.run("DELETE FROM action_items WHERE date = ?", date);

        const stored: StoredAction[] = [];
        for (const { module, action } of items) {
          const previous = prior.get(`${module}::${action.text}`);
          const id = previous?.id ?? randomUUID();
          const status: ActionStatus = previous?.status ?? "open";
          const proposalJson = action.kind === "proposal" ? JSON.stringify(action.proposal) : null;

          db.run(
            `INSERT INTO action_items (id, date, module, kind, text, proposal_json, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            id, date, module, action.kind, action.text, proposalJson, status, now.toISOString(),
          );
          stored.push({ id, date, module, kind: action.kind, text: action.text, proposal: action.kind === "proposal" ? action.proposal : null, status });
        }
        return stored;
      });
    },

    listOpen(date) {
      return db
        .all<Row>("SELECT * FROM action_items WHERE date = ? AND status = 'open'", date)
        .map(toStored);
    },

    listAllOpen() {
      return db
        .all<Row>(
          "SELECT * FROM action_items WHERE status = 'open' ORDER BY date DESC, created_at DESC, id",
          )
        .map(toStored);
    },

    find(id) {
      const row = db.get<Row>("SELECT * FROM action_items WHERE id = ?", id);
      return row ? toStored(row) : undefined;
    },

    setStatus(id, status, now) {
      db.run("UPDATE action_items SET status = ?, resolved_at = ? WHERE id = ?", status, now.toISOString(), id);
    },
  };
}
