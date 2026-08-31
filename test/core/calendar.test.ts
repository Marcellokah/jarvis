import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildVevent, parseVevents } from "../../src/infra/calendar/ics.ts";
import type { CalendarProposal } from "../../src/core/module.ts";

const NOW = new Date("2026-08-31T06:20:00Z");

const proposal: CalendarProposal = {
  title: "Túra: Normafa – Jánoshegy",
  start: "2026-09-05T08:00:00+02:00",
  end: "2026-09-05T12:30:00+02:00",
  location: "Normafa, Budapest",
  notes: "Napos, 22 °C.\nBusz: 21A",
};

describe("VEVENT building", () => {
  it("round-trips a proposal through build and parse without drift", () => {
    const ics = buildVevent(proposal, "jarvis-abc", NOW);
    const [parsed] = parseVevents(ics);

    expect(parsed).toBeDefined();
    expect(parsed!.uid).toBe("jarvis-abc");
    expect(parsed!.summary).toBe("Túra: Normafa – Jánoshegy");
    // 08:00 +02:00 is 06:00 UTC. A floating local time would shift when the
    // event is read on a device in another timezone.
    expect(parsed!.start).toBe("2026-09-05T06:00:00.000Z");
    expect(parsed!.end).toBe("2026-09-05T10:30:00.000Z");
    expect(parsed!.location).toBe("Normafa, Budapest");
  });

  it("emits UTC so the event does not move across timezones", () => {
    const ics = buildVevent(proposal, "uid-1", NOW);
    expect(ics).toContain("DTSTART:20260905T060000Z");
    expect(ics).toContain("DTEND:20260905T103000Z");
  });

  it("refuses an event that ends before it starts", () => {
    expect(() => buildVevent(
      { ...proposal, start: "2026-09-05T12:00:00+02:00", end: "2026-09-05T08:00:00+02:00" },
      "uid", NOW,
    )).toThrow(/ends before it starts/);
  });

  it("refuses an unparseable date rather than writing a broken event", () => {
    expect(() => buildVevent({ ...proposal, start: "holnap reggel" }, "uid", NOW))
      .toThrow(/Invalid proposal start/);
  });
});

describe("VEVENT parsing", () => {
  it("unescapes RFC 5545 text", () => {
    const ics = [
      "BEGIN:VEVENT", "UID:x",
      "SUMMARY:Ebéd Katival\\, a parton\; utána séta",
      "DTSTART:20260831T100000Z", "DTEND:20260831T113000Z",
      "END:VEVENT",
    ].join("\r\n");

    expect(parseVevents(ics)[0]!.summary).toBe("Ebéd Katival, a parton; utána séta");
  });

  it("handles folded lines, which every real server produces", () => {
    // RFC 5545 folds long lines with CRLF + a leading space.
    const ics = [
      "BEGIN:VEVENT", "UID:folded",
      "SUMMARY:Egy nagyon hosszú esemény név ami a hetven", " ötödik oktetnél meg lett törve",
      "DTSTART:20260831T100000Z", "DTEND:20260831T110000Z",
      "END:VEVENT",
    ].join("\r\n");

    expect(parseVevents(ics)[0]!.summary)
      .toBe("Egy nagyon hosszú esemény név ami a hetvenötödik oktetnél meg lett törve");
  });

  it("recognises an all-day event", () => {
    const ics = [
      "BEGIN:VEVENT", "UID:allday",
      "SUMMARY:Szabadság", "DTSTART;VALUE=DATE:20260901", "DTEND;VALUE=DATE:20260902",
      "END:VEVENT",
    ].join("\r\n");

    expect(parseVevents(ics)[0]).toMatchObject({ allDay: true, summary: "Szabadság" });
  });

  it("reads every event in a multi-event response", () => {
    const one = "BEGIN:VEVENT\r\nUID:a\r\nSUMMARY:A\r\nDTSTART:20260831T100000Z\r\nDTEND:20260831T110000Z\r\nEND:VEVENT";
    const two = "BEGIN:VEVENT\r\nUID:b\r\nSUMMARY:B\r\nDTSTART:20260831T120000Z\r\nDTEND:20260831T130000Z\r\nEND:VEVENT";
    expect(parseVevents(`BEGIN:VCALENDAR\r\n${one}\r\n${two}\r\nEND:VCALENDAR`)).toHaveLength(2);
  });

  it("skips a malformed event instead of throwing away the whole response", () => {
    const good = "BEGIN:VEVENT\r\nUID:ok\r\nSUMMARY:Jó\r\nDTSTART:20260831T100000Z\r\nDTEND:20260831T110000Z\r\nEND:VEVENT";
    const bad = "BEGIN:VEVENT\r\nSUMMARY:Nincs UID\r\nEND:VEVENT";
    const parsed = parseVevents(`${bad}\r\n${good}`);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.uid).toBe("ok");
  });
});

// --- the write guard --------------------------------------------------------

const fetchCalendars = vi.fn();
const fetchCalendarObjects = vi.fn();
const createCalendarObject = vi.fn();
const deleteCalendarObject = vi.fn();

// One stable client bag: the service caches the client, so a fresh object per
// call would make injected stubs invisible to it.
vi.mock("tsdav", () => ({
  createDAVClient: async () => ({
    fetchCalendars, fetchCalendarObjects, createCalendarObject, deleteCalendarObject,
  }),
}));

const { caldavCalendar } = await import("../../src/infra/calendar/caldav.ts");
const { silentLogger } = await import("../../src/infra/logger.ts");

function service(writeCalendar = "Jarvis") {
  return caldavCalendar({
    serverUrl: "https://caldav.example.test",
    credentials: async () => ({ username: "u", password: "p" }),
    writeCalendar,
    logger: silentLogger(),
    now: () => NOW,
  });
}

describe("write safety", () => {
  beforeEach(() => {
    fetchCalendars.mockReset();
    fetchCalendarObjects.mockReset();
    createCalendarObject.mockReset();
    deleteCalendarObject.mockReset();
  });
  afterEach(() => vi.clearAllMocks());

  it("refuses to write when the dedicated calendar is missing", async () => {
    // The dangerous alternative is falling back to the first calendar found,
    // which would drop Jarvis events into your real schedule.
    fetchCalendars.mockResolvedValue([
      { url: "https://x/personal/", displayName: "Személyes" },
      { url: "https://x/work/", displayName: "Munka" },
    ]);

    await expect(service().createEvent(proposal)).rejects.toThrow(/not found/);
    expect(createCalendarObject).not.toHaveBeenCalled();
  });

  it("writes only into the dedicated calendar", async () => {
    fetchCalendars.mockResolvedValue([
      { url: "https://x/personal/", displayName: "Személyes" },
      { url: "https://x/jarvis/", displayName: "Jarvis" },
    ]);
    createCalendarObject.mockResolvedValue({ ok: true, status: 201 });

    const created = await service().createEvent(proposal);

    expect(created.uid).toMatch(/^jarvis-/);
    expect(created.calendar).toBe("Jarvis");
    const call = createCalendarObject.mock.calls[0]![0];
    expect(call.calendar.displayName).toBe("Jarvis");
    expect(call.iCalString).toContain("SUMMARY:Túra");
  });

  it("surfaces a server rejection rather than reporting success", async () => {
    fetchCalendars.mockResolvedValue([{ url: "https://x/jarvis/", displayName: "Jarvis" }]);
    createCalendarObject.mockResolvedValue({ ok: false, status: 403, statusText: "Forbidden" });

    await expect(service().createEvent(proposal)).rejects.toThrow(/403/);
  });

  it("reports an unhealthy calendar when the target does not exist", async () => {
    fetchCalendars.mockResolvedValue([{ url: "https://x/personal/", displayName: "Személyes" }]);
    const health = await service().healthCheck();

    expect(health.ok).toBe(false);
    expect(health.detail).toContain("Jarvis");
  });

  it("keeps reading the other calendars when one fails", async () => {
    fetchCalendars.mockResolvedValue([
      { url: "https://x/broken/", displayName: "Hibás" },
      { url: "https://x/ok/", displayName: "Rendben" },
    ]);
    fetchCalendarObjects
      .mockRejectedValueOnce(new Error("500 Internal Server Error"))
      .mockResolvedValueOnce([{
        data: "BEGIN:VEVENT\r\nUID:e1\r\nSUMMARY:Megvan\r\nDTSTART:20260831T100000Z\r\nDTEND:20260831T110000Z\r\nEND:VEVENT",
      }]);

    const events = await service().listEvents(
      new Date("2026-08-31T00:00:00Z"), new Date("2026-09-01T00:00:00Z"),
    );
    expect(events.map((e) => e.title)).toEqual(["Megvan"]);
  });
});
