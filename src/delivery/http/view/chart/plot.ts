import { escapeHtml } from "../../markdown.ts";
import { bucketise, columnOf, type Bucket } from "./buckets.ts";
import { chartSummary } from "./summary.ts";
import { dayNumber, type Series, type Point } from "./series.ts";
import type { SeriesSpec } from "./registry.ts";

const W = 720, H = 260, L = 52, R = 8, T = 10, B = 22;
const IW = W - L - R;
const IH = H - T - B;

/**
 * The narrowest reader target worth drawing, in this viewBox's own units.
 *
 * It is what caps the number of targets, and the cap is not cosmetic. One
 * target per measurement puts 648 of them on `vo2max?tart=mind` and 365 on
 * the default steps chart — each a strip barely a pixel wide, so no pointer
 * can pick one out and no one can Tab through them, and each carrying its
 * label twice (once as a `<title>`, once as the visible readout) for ~190 KB
 * of markup around a 30 KB picture. Targets therefore sit on a fixed grid
 * whether the series is dense or sparse, and a cell that caught several
 * measurements says how many.
 */
const READER_W = 4;
const READER_COLS = Math.max(1, Math.round(IW / READER_W));

/**
 * The large view: axes, gap bands, a min-max band and a median line.
 *
 * Drawing order carries meaning. Gap bands go furthest back because they are
 * ground, not data; the reader targets go in front of everything because they
 * are what the pointer and the keyboard must reach.
 *
 * The `<svg>` is a labelled GROUP (`role="group"`), not a labelled IMAGE
 * (`role="img"`). Those are different promises: `role="img"` tells assistive
 * tech the element is one atomic picture, and it flattens every descendant
 * into that single node — a screen-reader user tabbing onto one of the
 * focusable `<rect>` targets below would land on nothing, because the
 * targets no longer exist as objects in the accessibility tree. This chart
 * puts focusable content inside the graphic on purpose, so it cannot claim
 * `role="img"` and still keep that content reachable — a group leaves each
 * target exposed as its own object, with its own name from its own
 * `<title>`. The whole-chart summary is not lost by dropping `role="img"`:
 * it is carried by the group's own `aria-label`/`<title>`, and it is the
 * only form of this information a non-visual reader — a screen reader, or
 * this same string reused verbatim in a Telegram reply — has any use for,
 * since the drawn bands and axes carry nothing for them at all.
 *
 * The readout's real reach, honestly: mouse hover always works, on every
 * browser, because `:hover` on an SVG shape is unconditional. Keyboard and
 * tap both route through the same mechanism — CSS reveals the `.olvaso`
 * group next to a target on `:hover` or `:focus` — and that mechanism only
 * fires if the browser actually lets a plain `<rect tabindex="0">` receive
 * focus in the first place. Chromium and Firefox do this without asking.
 * WebKit (Safari, and anything embedding it — so iOS in general) does not:
 * a non-form SVG element with `tabindex` is not in Safari's default Tab
 * order at all unless the user has turned on Full Keyboard Access, a system
 * setting this page cannot see or set. A tap can still focus the element
 * directly (bypassing Tab order), so touch mostly works in practice even in
 * Safari — but sequential keyboard reach does not, and no amount of CSS
 * fixes that without JavaScript, which this chart does not ship.
 *
 * When the series is dense (more measurements than pixel columns), the chart
 * draws a bucketed min-max band, not raw points — see buckets.ts. Either way
 * the line obeys the one rule this whole branch exists for: it never spans a
 * hole the series itself calls unusual. The sparse branch gets that from
 * `series.segments`; the dense branch has to be told, because a hole one
 * pixel column wide leaves no empty column behind to break on and the median
 * line would otherwise run straight through its own `hezag` band — which is
 * exactly what it did on the two metrics the spec was written from (37 of 37
 * HRV holes, 65 of 66 resting-pulse ones).
 */
export function plot(series: Series, spec: SeriesSpec): string {
  const summary = escapeHtml(`${spec.label}, ${chartSummary(series, spec)}`);
  const open = `<svg class="plot" viewBox="0 0 ${W} ${H}" role="group" aria-label="${summary}">`
    + `<title>${summary}</title>`;

  if (series.points.length === 0) {
    return `${open}<text class="tengely" x="${L}" y="${T + IH / 2}">nincs mérés ebben az ablakban</text></svg>`;
  }

  const span = series.toDay - series.fromDay;
  const lo = spec.zeroBased ? Math.min(0, series.min) : series.min;
  const hi = series.max;
  // A series with no spread at all — 49 six-minute-walk tests, every one of
  // them 500 m — has no axis to place a value on. It is centred, exactly as
  // the sparkline centres it: pinning it to the bottom of the frame would
  // read as the lowest value the metric ever took, and the two renderers
  // would tell the same row two different stories.
  const flat = hi - lo === 0;
  const n = (v: number) => Math.round(v * 100) / 100;

  const xOfDay = (day: number) => span === 0 ? L + IW / 2 : L + ((day - series.fromDay) / span) * IW;
  const yOfVal = (v: number) => flat ? T + IH / 2 : T + IH - ((v - lo) / (hi - lo)) * IH;

  // Gap bands first: they are the ground the rest is drawn on.
  const gaps = series.gaps.map((g) => {
    const x1 = xOfDay(dayNumber(g.fromDate));
    const x2 = xOfDay(dayNumber(g.toDate));
    // At least one pixel wide: a hole the axis cannot resolve is still a hole,
    // and a zero-width band would hide exactly the gaps a long window packs
    // most tightly.
    return `<rect class="hezag" x="${n(x1)}" y="${T}" width="${n(Math.max(1, x2 - x1))}" height="${IH}"/>`;
  }).join("");

  // A flat series gets one grid line carrying its one value. Three lines with
  // three identical labels would look like an axis and say nothing.
  const grid = (flat ? [0.5] : [0, 0.5, 1]).map((f) => {
    const y = T + IH * f;
    const v = flat ? hi : hi - (hi - lo) * f;
    return `<line class="racs" x1="${L}" y1="${n(y)}" x2="${W - R}" y2="${n(y)}"/>`
      + `<text class="tengely" x="4" y="${n(y + 3)}">${escapeHtml(spec.format(v))}</text>`;
  }).join("");

  const axis = `<text class="tengely" x="${L}" y="${H - 6}">${escapeHtml(series.from)}</text>`
    + `<text class="tengely" x="${W - R}" y="${H - 6}" text-anchor="end">${escapeHtml(series.to)}</text>`;

  const columns = Math.max(1, Math.round(IW));
  const dense = series.points.length > columns;

  // A readout box for one x position: clamped inside the plot so it never
  // spills past the right edge, sized to its own label so short and long
  // readings don't share one fixed width.
  const reader = (x: number, label: string) => {
    const esc = escapeHtml(label);
    const boxW = Math.max(96, esc.length * 6);
    const bx = Math.min(W - R - boxW, Math.max(L, x - boxW / 2));
    return `<g class="olvaso"><rect x="${n(bx)}" y="${T}" width="${boxW}" height="18" rx="2"/>`
      + `<text x="${n(bx + 6)}" y="${T + 13}">${esc}</text></g>`;
  };

  // One reader per occupied grid cell, dense and sparse alike — see READER_W.
  // A cell holding a single measurement still reads as that one day and that
  // one value; only a cell that really caught several says so.
  const cellLabel = (b: Bucket) => {
    const value = `${spec.format(b.min)}–${spec.format(b.max)} (medián ${spec.format(b.median)})`;
    if (b.n === 1) return `${b.from} · ${spec.format(b.median)}`;
    return `${b.from === b.to ? b.from : `${b.from}–${b.to}`} · ${b.n} mérés, ${value}`;
  };
  const cellW = IW / READER_COLS;
  const targets = bucketise(series, READER_COLS).map((b, i) => {
    if (b === null) return "";
    const x = L + (i / READER_COLS) * IW;
    const label = cellLabel(b);
    return `<rect class="celpont" tabindex="0" x="${n(x)}" y="${T}" width="${n(cellW)}" height="${IH}">`
      + `<title>${escapeHtml(label)}</title></rect>${reader(x + cellW / 2, label)}`;
  }).join("");

  let data: string;
  if (dense) {
    const buckets = bucketise(series, columns);
    // The column each unusual hole lands its far end in. The line has to start
    // a fresh subpath there: an even-every-other-day series packs its holes
    // into a single column, so "the next column is empty" — the only break the
    // dense branch used to know — never fires, and the median line bridges the
    // very band drawn to say nothing was measured.
    const breakAt = new Set(series.gaps.map((g) => columnOf(series, dayNumber(g.toDate), columns)));
    const band: string[] = [];
    const runs: { x: number; y: number }[][] = [];
    for (const [i, b] of buckets.entries()) {
      if (b === null) continue;
      const x = L + (i / columns) * IW;
      band.push(`<rect class="sav" x="${n(x)}" y="${n(yOfVal(b.max))}" width="1.2" `
        + `height="${n(Math.max(0.6, yOfVal(b.min) - yOfVal(b.max)))}"/>`);
      const previous = i > 0 && buckets[i - 1] !== null;
      if (!previous || breakAt.has(i) || runs.length === 0) runs.push([]);
      runs.at(-1)!.push({ x, y: yOfVal(b.median) });
    }
    // A run of one column is a point, not a line: an "M"-only path is legal
    // SVG that draws absolutely nothing, so the one column between two holes
    // would simply vanish. The sparse branch has always drawn a circle there.
    data = band.join("") + runs.map((run) => {
      if (run.length === 1) {
        return `<circle class="pont" cx="${n(run[0]!.x)}" cy="${n(run[0]!.y)}" r="2"/>`;
      }
      const d = run.map((p, i) => `${i === 0 ? "M" : "L"}${n(p.x)} ${n(p.y)}`).join(" ");
      return `<path class="vonal" pathLength="1" d="${d}"/>`;
    }).join("");
  } else {
    data = series.segments.map((seg) => {
      if (seg.length === 1) {
        return `<circle class="pont" cx="${n(xOfDay(seg[0]!.day))}" cy="${n(yOfVal(seg[0]!.value))}" r="2"/>`;
      }
      const d = seg.map((p: Point, i) => `${i === 0 ? "M" : "L"}${n(xOfDay(p.day))} ${n(yOfVal(p.value))}`).join(" ");
      return `<path class="vonal" pathLength="1" d="${d}"/>`;
    }).join("");
  }

  return `${open}${gaps}${grid}${data}${targets}${axis}</svg>`;
}
