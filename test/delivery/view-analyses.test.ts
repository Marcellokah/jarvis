import { describe, it, expect } from "vitest";
import { analysesBlock, analysesBody } from "../../src/delivery/http/view/analyses.ts";

/**
 * The band `analysesBlock` is exported for.
 *
 * The export carried a comment claiming a test asserted on it directly, and
 * no test did — `readout` and `chatBlock` have theirs, this one only had the
 * claim. Written rather than dropped, because the claim was right about what
 * matters here: the date beside each heading is not decoration.
 * `latestPerDomain()` mixes vintages by design, so the date is the only thing
 * that tells the reader how old a finding is, and asserting it through the
 * route would prove it for one page rather than for this function.
 */
describe("analysesBlock", () => {
  const one = {
    domain: "physical",
    markdown: "### Fizikai\n- Magas.",
    createdAt: "2026-09-01T07:08:45.487Z",
    summary: "Magas.",
  };

  it("dates every finding, so a stale one is visibly stale", () => {
    const html = analysesBlock([one]);
    expect(html).toContain("Fizikai fejlődés");
    expect(html).toContain("2026-09-01");
    // The timestamp is cut to the day: the clock time is noise here, and
    // showing it would make two analyses from the same day look different.
    expect(html).not.toContain("07:08:45");
  });

  it("names an unknown domain instead of dropping it", () => {
    // A domain added to the analyser and not yet to DOMAIN_TITLE must still
    // reach the page under its own code — a silently missing band is exactly
    // the missing-data-that-does-not-look-missing this project forbids.
    const html = analysesBlock([{ ...one, domain: "sleep_debt" }]);
    expect(html).toContain("sleep_debt");
  });

  it("escapes a domain code rather than trusting it as markup", () => {
    const html = analysesBlock([{ ...one, domain: "<img src=x onerror=alert(1)>" }]);
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("says so when nothing has run, and says how to run it", () => {
    const html = analysesBlock([]);
    expect(html).toContain("Még nem futott mélyelemzés");
    expect(html).toContain("npm run analyze");
  });

  it("is what analysesBody wraps, heading and all", () => {
    // Pins the composition too: a future `analysesBody` that stopped calling
    // `analysesBlock` would otherwise leave every test above passing while
    // the page itself rendered something else.
    expect(analysesBody([one])).toContain(analysesBlock([one]));
    expect(analysesBody([one])).toContain("<h2>Elemzés</h2>");
  });
});
