/**
 * Hungarian number formatting, in one place.
 *
 * Three copies of this had grown across the view layer, and they had drifted
 * in two ways: (a) two folded the grouping separator to a plain space, but one
 * did not, so `/szamok` rendered "64 860" with U+00A0 while the status strip
 * rendered the same figure with a plain space; and (b) `numbers.ts` omitted
 * `useGrouping: true`, so it relied on hu-HU's "auto" grouping which suppresses
 * the separator on four-digit numbers, while `channels.ts` and `chart/registry.ts`
 * forced grouping on, so the same step count read `6753` on the Számok page and
 * `6 753` in the Ma page's channel row. Two voices for one number on one page
 * is exactly the kind of small inconsistency that makes a readout look less
 * trustworthy than it is.
 *
 * This formatter resolves both: it always folds U+00A0 to a plain space, and it
 * always passes `useGrouping: true` to consistently group all sizes.
 */
export function hu(n: number, digits = 0): string {
  return n
    .toLocaleString("hu-HU", {
      minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: true,
    })
    .replace(/ /g, " ");
}

/** Forint, with its unit — the one currency this system knows. */
export function huFt(n: number): string {
  return `${hu(n)} Ft`;
}
