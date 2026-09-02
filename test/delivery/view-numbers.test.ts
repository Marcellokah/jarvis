import { describe, it, expect } from "vitest";
import { readout, numbersBody, type MetricRow } from "../../src/delivery/http/view/numbers.ts";

const base: MetricRow = {
  label: "Terhelési arány", value: "1,41", detail: "28 nap / 365 nap", coverage: null, series: null,
};

// `readout` had no test of its own before this file: the old
// `page.test.ts` `describe("renderPage")` exercised it only indirectly,
// through the whole-document `renderPage` (now deleted). These are the
// direct successors of that block's rail/dead-channel assertions — the
// distinction the whole system exists to protect, made visible.
describe("readout", () => {
  it("passes a missing measurement's value through untouched, never rewriting it to 0", () => {
    const html = readout({ ...base, label: "Alvás (90 nap)", value: "nincs mérés", coverage: 0 }, 0, "");
    expect(html).toContain(`<td>Alvás (90 nap)</td><td class="value">nincs mérés</td>`);
  });

  it("draws a coverage rail only as wide as the measurement really is", () => {
    // 6/7 days is 85.7%, and the rail says so to a tenth.
    const html = readout({ ...base, coverage: 6 / 7 }, 0, "");
    expect(html).toContain(`<span class="rail" style="--fill:85.7%">`);
  });

  it("gives an unmeasured row a dead channel, not a rail at zero", () => {
    // The row is marked dead, so it loses the signal colour, and its rail is
    // the dashed variant that never animates. A 0%-wide live rail would read
    // as a bad measurement rather than as no measurement.
    const html = readout({ ...base, coverage: 0 }, 0, "");
    expect(html).toContain(`<tr class="dead"`);
    expect(html).toContain(`class="rail dead"`);
  });

  it("gives a row with no window no rail at all", () => {
    // A ratio between two windows has no single window to be complete over.
    // Drawing any rail there — full or empty — would answer a question the
    // number does not ask.
    const html = readout({ ...base, coverage: null }, 0, "");
    expect(html).not.toContain("rail");
  });
});

describe("numbersBody", () => {
  it("sorozat nélküli sor nem kap sem sparkline-t, sem linket", () => {
    // A terhelési arány két ablak hányadosa: nincs egyetlen oszlopa, amit ki
    // lehetne rajzolni, és egy link a semmibe vinne.
    const html = numbersBody(
      [{ label: "Terhelési arány", value: "1,41", detail: "28/365", coverage: null, series: null }],
      new Map(),
    );
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<a ");
  });

  it("sorozattal rendelkező sor linkel a részletoldalra", () => {
    const html = numbersBody(
      [{ label: "Lépés (7 nap)", value: "9 283", detail: "6 nap", coverage: 6 / 7, series: { column: "steps", days: 7 } }],
      new Map([["Lépés (7 nap)", "<svg class=\"spark\"></svg>"]]),
    );
    expect(html).toContain('href="/szamok/steps?tart=7"');
    expect(html).toContain('class="spark"');
  });
});
