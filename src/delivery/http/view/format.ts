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

/**
 * Duration in Hungarian: "1 óra 32 perc", or just "32 perc" if less than an hour.
 *
 * CRITICAL: Round to whole minutes FIRST, then split into hours and minutes.
 * Apple's health export carries fractional durations (e.g., 119.5 minutes from
 * a GPS record). If you floor the hours before rounding the minutes, a carry
 * case like 119.5 becomes "1 óra 60 perc" — wrong. Rounding first gives "2 óra 0 perc".
 */
export function duration(min: number): string {
  const total = Math.round(min);
  const h = Math.floor(total / 60);
  const m = total - h * 60;
  return h === 0 ? `${m} perc` : `${h} óra ${m} perc`;
}
