export interface Point { date: string; day: number; value: number }

/** An unusual hole: the two measured days it sits between, and its length. */
export interface Gap { fromDate: string; toDate: string; days: number }

export interface Series {
  column: string;
  /** The requested window, which the x axis spans — not the points' own span. */
  from: string; to: string; fromDay: number; toDay: number;
  points: Point[];
  /** Runs of points close enough to be connected by a line. */
  segments: Point[][];
  gaps: Gap[];
  medianGapDays: number;
  breakThreshold: number;
  min: number; max: number;
  totalDays: number;
  coverage: number;
}

/** Days since the epoch. ISO dates are exact here — no timezone enters. */
export function dayNumber(isoDate: string): number {
  return Math.round(Date.parse(`${isoDate}T00:00:00Z`) / 86_400_000);
}

/**
 * A series knows where its own line may be drawn.
 *
 * No chart may draw through days it has no data for: every library
 * interpolates, and on this owner's history that turns a measured 35-day hole
 * in the step count into a smooth rise that never happened — the confidently
 * wrong number this whole system exists to prevent, in a picture.
 *
 * The break threshold comes from the series' OWN median gap rather than a
 * fixed number of days, because the two shapes in this history need different
 * answers: HRV is measured every other day, so a six-day hole is the news,
 * while steps are daily, so three days already is. A median and not a mean,
 * because one 35-day hole drags a mean far enough to make the hole itself look
 * normal. The LOWER median on an even count, because erring toward a smaller
 * threshold errs toward breaking the line — toward drawing less rather than
 * inventing more.
 */
export function buildSeries(
  column: string, from: string, to: string,
  values: readonly { date: string; value: number | null }[],
): Series {
  const fromDay = dayNumber(from);
  const toDay = dayNumber(to);
  const totalDays = toDay - fromDay + 1;

  const points: Point[] = values
    .filter((v): v is { date: string; value: number } => v.value !== null)
    .map((v) => ({ date: v.date, day: dayNumber(v.date), value: v.value }))
    .sort((a, b) => a.day - b.day);

  const gapsBetween = points.slice(1).map((p, i) => p.day - points[i]!.day);
  const sorted = [...gapsBetween].sort((a, b) => a - b);
  const medianGapDays = sorted.length === 0 ? 0 : sorted[Math.floor((sorted.length - 1) / 2)]!;
  const breakThreshold = medianGapDays * 3;

  const segments: Point[][] = [];
  const gaps: Gap[] = [];
  for (const [i, p] of points.entries()) {
    const prev = points[i - 1];
    if (prev === undefined || p.day - prev.day >= breakThreshold) {
      if (prev !== undefined) {
        gaps.push({ fromDate: prev.date, toDate: p.date, days: p.day - prev.day });
      }
      segments.push([p]);
    } else {
      segments.at(-1)!.push(p);
    }
  }

  const vals = points.map((p) => p.value);
  return {
    column, from, to, fromDay, toDay,
    points, segments, gaps, medianGapDays, breakThreshold,
    min: vals.length === 0 ? 0 : Math.min(...vals),
    max: vals.length === 0 ? 0 : Math.max(...vals),
    totalDays,
    coverage: totalDays === 0 ? 0 : points.length / totalDays,
  };
}
