import { describe, it, expect, afterEach } from "vitest";
import { buildTestApp, stubModule, recordingLogger, memoryDb, TEST_TOKEN, type TestApp } from "../helpers.ts";
import { createContactRepo } from "../../src/infra/db/repositories/contacts.ts";
import { checkClientContact } from "../../src/infra/scheduler.ts";
import { TZ } from "../../src/shared/dates.ts";

let app: TestApp | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

const auth = { authorization: `Bearer ${TEST_TOKEN}` };

/**
 * The 07:30 brief is one HTTP request a day. Until now a successful one left no
 * trace at all — which is exactly what made a silent morning silent: no log, no
 * row, nothing to check afterwards.
 */
describe("client contact", () => {
  it("records the call when the Shortcut fetches the brief", async () => {
    app = await buildTestApp({ modules: [stubModule({ name: "M" })], now: "2026-09-04T05:30:00Z" });

    const res = await app.server.inject({ method: "GET", url: "/api/morning-brief", headers: auth });
    expect(res.statusCode).toBe(200);

    const last = app.contacts.last();
    expect(last?.route).toBe("/api/morning-brief");
    expect(last?.status).toBe(200);
  });

  it("records the health snapshot POST too, so either half of the Shortcut counts", async () => {
    app = await buildTestApp({ modules: [stubModule({ name: "M" })], now: "2026-09-04T05:30:00Z" });

    const res = await app.server.inject({
      method: "POST", url: "/api/ingest/health", headers: auth, payload: { hrv: 70 },
    });
    expect(res.statusCode).toBe(202);
    expect(app.contacts.last()?.route).toBe("/api/ingest/health");
  });

  it("ignores an unauthorized request — a stranger probing is not your phone", async () => {
    app = await buildTestApp({ modules: [stubModule({ name: "M" })], now: "2026-09-04T05:30:00Z" });

    const res = await app.server.inject({ method: "GET", url: "/api/morning-brief" });
    expect(res.statusCode).toBe(401);
    expect(app.contacts.last()).toBeUndefined();
  });

  it("ignores the liveness probe", async () => {
    app = await buildTestApp({ modules: [stubModule({ name: "M" })], now: "2026-09-04T05:30:00Z" });

    const res = await app.server.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(app.contacts.last()).toBeUndefined();
  });

  it("logs every request, so an unanswered morning is visible afterwards", async () => {
    const logger = recordingLogger();
    app = await buildTestApp({
      modules: [stubModule({ name: "M" })], now: "2026-09-04T05:30:00Z", logger,
    });

    await app.server.inject({ method: "GET", url: "/api/morning-brief?format=text", headers: auth });

    const request = logger.entries.find((e) => e.msg === "request" && e.level === "info");
    expect(request).toBeDefined();
    expect(request!.obj).toMatchObject({ method: "GET", status: 200 });
    expect(String(request!.obj.url)).toContain("/api/morning-brief");
  });

  it("keeps the liveness probe out of the info log", async () => {
    const logger = recordingLogger();
    app = await buildTestApp({
      modules: [stubModule({ name: "M" })], now: "2026-09-04T05:30:00Z", logger,
    });

    await app.server.inject({ method: "GET", url: "/healthz" });

    expect(logger.entries.some((e) => e.msg === "request" && e.level === "info")).toBe(false);
    expect(logger.entries.some((e) => e.msg === "request" && e.level === "debug")).toBe(true);
  });
});

describe("missing contact detection", () => {
  it("reports missing when nothing has ever called", () => {
    const db = memoryDb();
    const contacts = createContactRepo(db);
    expect(contacts.missingOn(new Date("2026-09-04T06:00:00Z"), TZ)).toBe(true);
    db.close();
  });

  it("reports present once today's call has landed", () => {
    const db = memoryDb();
    const contacts = createContactRepo(db);
    // 07:31 Budapest on 2026-09-04.
    contacts.record(new Date("2026-09-04T05:31:00Z"), "/api/morning-brief", 200);
    expect(contacts.missingOn(new Date("2026-09-04T06:00:00Z"), TZ)).toBe(false);
    db.close();
  });

  it("reports missing when the last call was yesterday", () => {
    const db = memoryDb();
    const contacts = createContactRepo(db);
    contacts.record(new Date("2026-09-03T05:31:00Z"), "/api/morning-brief", 200);
    expect(contacts.missingOn(new Date("2026-09-04T06:00:00Z"), TZ)).toBe(true);
    db.close();
  });

  it("judges the day in Budapest, not UTC", () => {
    const db = memoryDb();
    const contacts = createContactRepo(db);
    // 00:30 on the 4th in Budapest is still 22:30 on the 3rd in UTC. A UTC
    // comparison would call this yesterday and alert on a phone that did check in.
    contacts.record(new Date("2026-09-03T22:30:00Z"), "/api/morning-brief", 200);
    expect(contacts.missingOn(new Date("2026-09-04T06:00:00Z"), TZ)).toBe(false);
    db.close();
  });

  it("keeps only the latest call", () => {
    const db = memoryDb();
    const contacts = createContactRepo(db);
    contacts.record(new Date("2026-09-04T05:31:00Z"), "/api/ingest/health", 202);
    contacts.record(new Date("2026-09-04T05:31:02Z"), "/api/morning-brief", 200);
    expect(contacts.last()?.route).toBe("/api/morning-brief");
    db.close();
  });
});

describe("the missing-contact alert", () => {
  const at = (iso: string) => ({ now: () => new Date(iso) });

  function setup(lastContact?: string) {
    const db = memoryDb();
    const contacts = createContactRepo(db);
    if (lastContact) contacts.record(new Date(lastContact), "/api/morning-brief", 200);
    const sent: string[] = [];
    return {
      db, contacts, sent,
      notify: async (text: string) => { sent.push(text); },
    };
  }

  it("alerts when the phone never called today", async () => {
    const t = setup("2026-09-03T05:31:00Z");
    const alerted = await checkClientContact({
      contacts: t.contacts, contactAlert: true,
      clock: at("2026-09-04T06:00:00Z"), logger: recordingLogger(), notify: t.notify,
    });

    expect(alerted).toBe(true);
    expect(t.sent).toHaveLength(1);
    // The alert has to name the thing that actually broke it last time.
    expect(t.sent[0]).toContain("Use Tailscale DNS");
    expect(t.sent[0]).toContain("2026-09-03T05:31:00.000Z");
    t.db.close();
  });

  it("says so plainly when the phone has never called at all", async () => {
    const t = setup();
    await checkClientContact({
      contacts: t.contacts, contactAlert: true,
      clock: at("2026-09-04T06:00:00Z"), logger: recordingLogger(), notify: t.notify,
    });

    expect(t.sent[0]).toContain("még soha nem hívta meg");
    t.db.close();
  });

  it("stays quiet when the phone did call", async () => {
    const t = setup("2026-09-04T05:31:00Z");
    const alerted = await checkClientContact({
      contacts: t.contacts, contactAlert: true,
      clock: at("2026-09-04T06:00:00Z"), logger: recordingLogger(), notify: t.notify,
    });

    expect(alerted).toBe(false);
    expect(t.sent).toHaveLength(0);
    t.db.close();
  });

  it("stays quiet while the alert is switched off", async () => {
    const t = setup();
    const alerted = await checkClientContact({
      contacts: t.contacts, contactAlert: false,
      clock: at("2026-09-04T06:00:00Z"), logger: recordingLogger(), notify: t.notify,
    });

    expect(alerted).toBe(false);
    expect(t.sent).toHaveLength(0);
    t.db.close();
  });

  it("survives a Telegram failure — the scheduler must not die with it", async () => {
    const t = setup();
    const logger = recordingLogger();
    const alerted = await checkClientContact({
      contacts: t.contacts, contactAlert: true,
      clock: at("2026-09-04T06:00:00Z"), logger,
      notify: async () => { throw new Error("telegram down"); },
    });

    expect(alerted).toBe(true);
    expect(logger.entries.some((e) => e.level === "error")).toBe(true);
    t.db.close();
  });

  it("logs the warning even with no way to notify", async () => {
    const t = setup();
    const logger = recordingLogger();
    await checkClientContact({
      contacts: t.contacts, contactAlert: true,
      clock: at("2026-09-04T06:00:00Z"), logger,
    });

    expect(logger.entries.some((e) => e.msg === "no client contact today")).toBe(true);
    t.db.close();
  });
});
