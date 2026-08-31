import { createDAVClient } from "tsdav";

// tsdav's factory returns a bag of bound methods, not an instance of the
// exported DAVClient class, so derive the types from the factory itself.
type Dav = Awaited<ReturnType<typeof createDAVClient>>;
type DavCalendar = Awaited<ReturnType<Dav["fetchCalendars"]>>[number];
import { randomUUID } from "node:crypto";
import { CalendarNotConfiguredError, type CalendarService, type CalendarEvent, type CreatedEvent } from "./service.ts";
import type { CalendarProposal } from "../../core/module.ts";
import type { Logger } from "../logger.ts";
import { buildVevent, parseVevents } from "./ics.ts";

export interface CalDavCredentials { username: string; password: string }

export interface CalDavOptions {
  serverUrl: string;
  /**
   * Resolved lazily and only when the calendar is actually used, so secrets can
   * live in the macOS Keychain rather than in a file or an env var.
   */
  credentials: () => Promise<CalDavCredentials>;
  /** Events are only ever written here — never to your main calendar. */
  writeCalendar: string;
  /** Which calendars to read. Empty means all of them. */
  readCalendars?: string[];
  logger: Logger;
  now: () => Date;
}

export const ICLOUD_CALDAV_URL = "https://caldav.icloud.com";

/**
 * iCloud calendar over CalDAV, authenticated with an app-specific password.
 *
 * Writes are deliberately constrained: only into `writeCalendar` (a dedicated
 * `Jarvis` calendar, not your real one), only from an explicit acceptance, and
 * every created UID is handed back so it can be recorded and undone.
 */
export function caldavCalendar(opts: CalDavOptions): CalendarService {
  let clientPromise: Promise<Dav> | null = null;
  let calendarCache: DavCalendar[] | null = null;

  async function client(): Promise<Dav> {
    if (!clientPromise) {
      clientPromise = opts.credentials().then((credentials) =>
        createDAVClient({
          serverUrl: opts.serverUrl,
          credentials,
          authMethod: "Basic",
          defaultAccountType: "caldav",
        }),
      ).catch((err) => {
        // Don't cache a failed login: the next call should retry, e.g. after
        // the password has been added to the Keychain.
        clientPromise = null;
        throw err;
      });
    }
    return clientPromise;
  }

  async function calendars(): Promise<DavCalendar[]> {
    if (!calendarCache) calendarCache = await (await client()).fetchCalendars();
    return calendarCache;
  }

  const displayName = (cal: DavCalendar): string =>
    typeof cal.displayName === "string" ? cal.displayName : "";

  return {
    async listEvents(from: Date, to: Date): Promise<CalendarEvent[]> {
      let all;
      try {
        all = await calendars();
      } catch (err) {
        // Not set up yet is a normal state; don't fail the brief over it.
        if (err instanceof CalendarNotConfiguredError) return [];
        throw err;
      }
      const wanted = opts.readCalendars?.length
        ? all.filter((c) => opts.readCalendars!.includes(displayName(c)))
        : all;

      const dav = await client();
      const events: CalendarEvent[] = [];

      for (const calendar of wanted) {
        let objects;
        try {
          objects = await dav.fetchCalendarObjects({
            calendar,
            timeRange: { start: from.toISOString(), end: to.toISOString() },
          });
        } catch (err) {
          // One unreadable calendar must not cost you the whole schedule.
          opts.logger.warn(
            { calendar: displayName(calendar), err: String(err) },
            "could not read calendar",
          );
          continue;
        }

        for (const object of objects) {
          if (!object.data) continue;
          for (const parsed of parseVevents(String(object.data))) {
            events.push({
              uid: parsed.uid,
              title: parsed.summary,
              start: parsed.start,
              end: parsed.end,
              allDay: parsed.allDay,
              ...(parsed.location ? { location: parsed.location } : {}),
              calendar: displayName(calendar),
            });
          }
        }
      }

      return events.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    },

    async createEvent(proposal: CalendarProposal): Promise<CreatedEvent> {
      const targetName = proposal.calendar ?? opts.writeCalendar;
      const all = await calendars();
      const target = all.find((c) => displayName(c) === targetName);

      if (!target) {
        // Refuse rather than silently writing into whatever calendar is first.
        throw new Error(
          `Calendar "${targetName}" not found. Available: ${all.map(displayName).filter(Boolean).join(", ")}`,
        );
      }

      const uid = `jarvis-${randomUUID()}`;
      const vevent = buildVevent(proposal, uid, opts.now());

      const response = await (await client()).createCalendarObject({
        calendar: target,
        filename: `${uid}.ics`,
        iCalString: vevent,
      });

      if (!response.ok) {
        throw new Error(`CalDAV rejected the event: ${response.status} ${response.statusText ?? ""}`.trim());
      }

      opts.logger.info({ uid, calendar: targetName, title: proposal.title }, "calendar event created");
      return { uid, calendar: targetName, url: `${target.url}${uid}.ics` };
    },

    async deleteEvent(uid: string, calendarName: string): Promise<void> {
      const all = await calendars();
      const target = all.find((c) => displayName(c) === calendarName);
      if (!target) throw new Error(`Calendar "${calendarName}" not found`);

      const response = await (await client()).deleteCalendarObject({
        calendarObject: { url: `${target.url}${uid}.ics`, etag: "" },
      });
      if (!response.ok) {
        throw new Error(`CalDAV rejected the delete: ${response.status}`);
      }
      opts.logger.info({ uid, calendar: calendarName }, "calendar event deleted");
    },

    async healthCheck() {
      try {
        const all = await calendars();
        const names = all.map(displayName).filter(Boolean);
        const hasTarget = names.includes(opts.writeCalendar);
        return {
          ok: hasTarget,
          detail: hasTarget
            ? `${names.length} naptár · írás ide: ${opts.writeCalendar}`
            : `hiányzik a(z) "${opts.writeCalendar}" naptár — hozd létre a Naptár appban. Elérhető: ${names.join(", ")}`,
        };
      } catch (err) {
        if (err instanceof CalendarNotConfiguredError) {
          return { ok: false, detail: err.message };
        }
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, detail: `CalDAV kapcsolat sikertelen: ${message}` };
      }
    },
  };
}
