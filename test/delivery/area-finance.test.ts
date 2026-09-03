import { describe, it, expect } from "vitest";
import { financeBody } from "../../src/delivery/http/view/area/finance.ts";
import type { Subscription } from "../../src/infra/db/repositories/subscriptions.ts";

const sub = (p: Partial<Subscription> & Pick<Subscription, "name" | "amountHuf">): Subscription => ({
  id: 1, cycle: "monthly", nextRenewal: "2026-09-12", category: null,
  cancelUrl: null, lastUsedAt: null, active: true, notes: null, ...p,
} as Subscription);

const empty = {
  months: [], monthOverMonth: null, annualisedHuf: null, minMonths: 6,
  subscriptions: [], today: "2026-09-03", analysis: undefined, earlier: [],
};

const extractLeadBand = (html: string): string =>
  /<section class="vezeto[^"]*">([\s\S]*?)<\/section>/.exec(html)?.[0] ?? "";

describe("Pénzügy oldal", () => {
  it("a havi terhet mutatja vezető számként", () => {
    const html = financeBody({
      ...empty,
      months: [{ month: "2026-09", totalHuf: 64860, activeCount: 5 }],
    });
    const vezeto = extractLeadBand(html);
    expect(vezeto).toContain("64 860 Ft");
  });

  it("nincs rögzített hónapnál nem mutat számot, hanem hiányzik jelzőt visz", () => {
    // Zero recorded months is the third missing-data rule: show "nincs rögzített hónap",
    // not 0 Ft or any forint amount.
    const html = financeBody({ ...empty });
    const vezeto = extractLeadBand(html);
    expect(vezeto).toContain("nincs rögzített hónap");
    expect(vezeto).toContain("hianyzik");
    expect(vezeto).not.toContain("Ft");
  });

  it("hat hónapnál kevesebb rögzítésnél nem évesít, és nem 0 Ft-ot ír", () => {
    // Egyetlen hónapot tizenkettővel szorozni egy évnyi költést állítana egy
    // hónapnyi bizonyítékból. A küszöb indoklása az aggregate.ts-ben áll.
    const html = financeBody({
      ...empty,
      months: [
        { month: "2026-08", totalHuf: 64860, activeCount: 5 },
        { month: "2026-09", totalHuf: 64860, activeCount: 5 },
      ],
      annualisedHuf: null,
    });
    // Csak az évesítés sávját nézzük: a "64 860 Ft" vezető szám maga is
    // tartalmazza a "0 Ft" részsztringet, tehát a teljes oldalra menő
    // állítás vaklármát adna.
    const sav = /Évesített teher<\/h2>([\s\S]*?)<\/section>/.exec(html)?.[1] ?? "";
    expect(sav).toContain("nincs elég hónap");
    expect(sav).toContain("2 a 6-ból");
    expect(sav).not.toContain("Ft");
  });

  it("elég hónap esetén kiírja az évesített terhet", () => {
    const html = financeBody({ ...empty, annualisedHuf: 778320, minMonths: 6 });
    expect(html).toContain("778 320 Ft");
  });

  it("pozitív delta a vezető számban + előjellel jelenik meg", () => {
    const html = financeBody({
      ...empty,
      months: [
        { month: "2026-08", totalHuf: 64860, activeCount: 5 },
        { month: "2026-09", totalHuf: 70000, activeCount: 5 },
      ],
      monthOverMonth: {
        from: "2026-08",
        to: "2026-09",
        deltaHuf: 5140,
        changes: [],
      },
    });
    const vezeto = extractLeadBand(html);
    expect(vezeto).toContain("+5 140 Ft");
    expect(vezeto).toContain("2026-08 óta");
  });

  it("nulla delta a vezető számban 'változatlan' szóval jelenik meg", () => {
    const html = financeBody({
      ...empty,
      months: [
        { month: "2026-08", totalHuf: 64860, activeCount: 5 },
        { month: "2026-09", totalHuf: 64860, activeCount: 5 },
      ],
      monthOverMonth: {
        from: "2026-08",
        to: "2026-09",
        deltaHuf: 0,
        changes: [],
      },
    });
    const vezeto = extractLeadBand(html);
    expect(vezeto).toContain("változatlan");
    expect(vezeto).toContain("2026-08 óta");
  });

  it("negatív delta a vezető számban - előjellel jelenik meg", () => {
    const html = financeBody({
      ...empty,
      months: [
        { month: "2026-08", totalHuf: 70000, activeCount: 5 },
        { month: "2026-09", totalHuf: 64860, activeCount: 5 },
      ],
      monthOverMonth: {
        from: "2026-08",
        to: "2026-09",
        deltaHuf: -5140,
        changes: [],
      },
    });
    const vezeto = extractLeadBand(html);
    expect(vezeto).toContain("-5 140 Ft");
    expect(vezeto).toContain("2026-08 óta");
  });

  it("a hiányzó utolsó használatot nincs adatként írja, nem sohaként", () => {
    // A mező csak akkor íródik, ha valami feljegyzi. A "soha" azt állítaná,
    // hogy tudjuk: nem használtad.
    const html = financeBody({
      ...empty,
      subscriptions: [sub({ name: "Telekom", amountHuf: 12990, lastUsedAt: null })],
    });
    expect(html).toContain("nincs adat");
    expect(html).not.toContain("soha");
  });

  it("előrejelzett megújulás: 9 nap múlva a teljes kifejezés megjelenik", () => {
    const html = financeBody({
      ...empty, today: "2026-09-03",
      subscriptions: [sub({ name: "Netflix", amountHuf: 4490, nextRenewal: "2026-09-12" })],
    });
    expect(html).toContain("9 nap múlva");
  });

  it("múltbeli megújulás: a teljes kifejezés napja formátumban jelenik meg", () => {
    const html = financeBody({
      ...empty, today: "2026-09-03",
      subscriptions: [sub({ name: "Old", amountHuf: 100, nextRenewal: "2026-08-25" })],
    });
    expect(html).toContain("9 napja");
  });

  it("mai megújulás: 0 nap múlva jelenik meg", () => {
    const html = financeBody({
      ...empty, today: "2026-09-03",
      subscriptions: [sub({ name: "Today", amountHuf: 100, nextRenewal: "2026-09-03" })],
    });
    expect(html).toContain("0 nap múlva");
  });

  it("a havi terhet oszlopdiagramként rajzolja", () => {
    const html = financeBody({
      ...empty,
      months: [
        { month: "2026-08", totalHuf: 64860, activeCount: 5 },
        { month: "2026-09", totalHuf: 64860, activeCount: 5 },
      ],
    });
    expect(html).toContain('class="oszlopok"');
    // Csak a rögzített hónapok szerepelnek: a rögzítés előtti hónapok nem
    // nulla oszlopok, hanem egyáltalán nincsenek a diagramon.
    expect(html).not.toContain("2026-07");
  });

  it("előfizetés nélkül kimondja a hiányt", () => {
    expect(financeBody({ ...empty })).toContain("Nincs rögzített előfizetés");
  });

  it("escape-eli az előfizetés nevét", () => {
    const html = financeBody({
      ...empty, subscriptions: [sub({ name: "<b>X</b>", amountHuf: 100 })],
    });
    expect(html).not.toContain("<b>X</b>");
    expect(html).toContain("&lt;b&gt;");
  });

  it("escape-eli az előfizetés kategóriáját", () => {
    const html = financeBody({
      ...empty, subscriptions: [sub({ name: "Test", amountHuf: 100, category: "<script>" })],
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
