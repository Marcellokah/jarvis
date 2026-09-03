import { describe, it, expect } from "vitest";
import { financeBody } from "../../src/delivery/http/view/area/finance.ts";
import type { Subscription } from "../../src/infra/db/repositories/subscriptions.ts";

const sub = (p: Partial<Subscription> & Pick<Subscription, "name" | "amountHuf">): Subscription => ({
  id: 1, cycle: "monthly", nextRenewal: "2026-09-12", category: null,
  cancelUrl: null, lastUsedAt: null, active: true, notes: null, ...p,
} as Subscription);

const empty = {
  months: [], monthOverMonth: null, annualisedHuf: null, minMonths: 6,
  subscriptions: [], today: "2026-09-03", analysis: undefined,
};

describe("Pénzügy oldal", () => {
  it("a havi terhet mutatja vezető számként", () => {
    const html = financeBody({
      ...empty,
      months: [{ month: "2026-09", totalHuf: 64860, activeCount: 5 }],
    });
    expect(html).toContain("64 860 Ft");
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

  it("megmondja, hány nap múlva újul meg", () => {
    const html = financeBody({
      ...empty, today: "2026-09-03",
      subscriptions: [sub({ name: "Netflix", amountHuf: 4490, nextRenewal: "2026-09-12" })],
    });
    expect(html).toContain("9 nap");
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
});
