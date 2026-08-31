import type { CalendarProposal } from "../../core/module.ts";

export interface CalendarEvent {
  uid: string;
  title: string;
  /** ISO instant. */
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  calendar: string;
}

export interface CreatedEvent {
  uid: string;
  calendar: string;
  url: string;
}

/**
 * Missing credentials is a setup state, not a failure. Reading returns nothing
 * so an unconfigured calendar does not produce an error section every morning;
 * writing still throws, because silently dropping an accepted proposal would
 * be far worse than saying it could not be saved.
 */
export class CalendarNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarNotConfiguredError";
  }
}

export interface CalendarService {
  /** Events overlapping [from, to). Read-only; safe to call on every brief. */
  listEvents(from: Date, to: Date): Promise<CalendarEvent[]>;
  /** Writes an event. Only ever called from an explicit acceptance. */
  createEvent(proposal: CalendarProposal): Promise<CreatedEvent>;
  /** Removes an event Jarvis created. Backs the /undo command. */
  deleteEvent(uid: string, calendar: string): Promise<void>;
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
}

/**
 * Used when no iCloud credentials are configured. Reading yields nothing and
 * writing fails loudly — a proposal that silently vanishes would be worse than
 * one that reports it could not be saved.
 */
export function unavailableCalendar(reason: string): CalendarService {
  return {
    async listEvents() { return []; },
    async createEvent() { throw new Error(`Calendar unavailable: ${reason}`); },
    async deleteEvent() { throw new Error(`Calendar unavailable: ${reason}`); },
    async healthCheck() { return { ok: false, detail: reason }; },
  };
}
