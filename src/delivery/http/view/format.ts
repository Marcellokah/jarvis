/**
 * Hungarian number formatting, in one place.
 *
 * Three copies of this had grown across the view layer, and they had already
 * drifted: two folded the grouping separator to a plain space and one did
 * not, so `/szamok` rendered "64 860" with U+00A0 while the status strip
 * rendered the same figure with a plain one. Two voices for one number on one
 * page is exactly the kind of small inconsistency that makes a readout look
 * less trustworthy than it is.
 *
 * The fold is deliberate, not a workaround: hu-HU's own grouping separator is
 * a no-break space, and the rest of this UI has rendered a plain one since
 * the first channel readout.
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