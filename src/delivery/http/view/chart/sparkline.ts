import { escapeHtml } from "../../markdown.ts";
import type { Series, Point } from "./series.ts";
import type { SeriesSpec } from "./registry.ts";

const W = 60;
const H = 18;
const PAD = 1.5;

/**
 * The small chart: direction at a glance, no axes, no interaction.
 *
 * One `<path>` per segment, never one for the whole series — a hole this
 * owner's history really contains (35 days without a step count) must read as
 * a hole, not as a smooth rise through days nobody measured. There is no gap
 * band here as there is in the large view: on sixty pixels a band would be
 * noise rather than information, so the line simply stops.
 */
export function sparkline(series: Series, spec: SeriesSpec): string {
  const summary = escapeHtml(
    `${spec.label}: ${series.points.length} mérés, `
    + `${Math.floor(series.coverage * 100)}% lefedettség`
    + (series.points.length === 0 ? "" : `, ${spec.format(series.min)}–${spec.format(series.max)}`),
  );

  const open = (cls: string) =>
    `<svg class="${cls}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" `
    + `role="img" aria-label="${summary}"><title>${summary}</title>`;

  if (series.points.length === 0) return `${open("spark ures")}</svg>`;

  const span = series.toDay - series.fromDay;
  const lo = spec.zeroBased ? Math.min(0, series.min) : series.min;
  const hi = series.max;
  const range = hi - lo;

  const x = (p: Point) => span === 0 ? W / 2 : PAD + ((p.day - series.fromDay) / span) * (W - 2 * PAD);
  // A flat series sits on the midline rather than dividing by zero.
  const y = (p: Point) => range === 0 ? H / 2 : H - PAD - ((p.value - lo) / range) * (H - 2 * PAD);
  const n = (v: number) => Math.round(v * 100) / 100;

  // `pathLength="1"` is an SVG attribute, not a CSS property — it cannot be
  // set from theme.ts. It has to sit on the element itself, because the
  // dash-in animation's `stroke-dasharray: 1` only means "the whole line" if
  // the path's length is normalized to 1 this way; without it the animation
  // still runs but scrubs a fixed 1px dash across paths of very different
  // real lengths instead of drawing each one in from end to end.
  const body = series.segments.map((seg) => {
    if (seg.length === 1) return `<circle cx="${n(x(seg[0]!))}" cy="${n(y(seg[0]!))}" r="1.4"/>`;
    const d = seg.map((p, i) => `${i === 0 ? "M" : "L"}${n(x(p))} ${n(y(p))}`).join(" ");
    return `<path pathLength="1" d="${d}"/>`;
  }).join("");

  return `${open("spark")}${body}</svg>`;
}
