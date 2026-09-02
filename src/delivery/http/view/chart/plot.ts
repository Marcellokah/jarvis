import { escapeHtml } from "../../markdown.ts";
import { bucketise } from "./buckets.ts";
import { dayNumber, type Series, type Point } from "./series.ts";
import type { SeriesSpec } from "./registry.ts";

const W = 720, H = 260, L = 52, R = 8, T = 10, B = 22;
const IW = W - L - R;
const IH = H - T - B;

/** The inverse of `dayNumber`: the ISO date a day-since-epoch number names. */
const dateOfDay = (day: number): string => new Date(day * 86_400_000).toISOString().slice(0, 10);

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
 * draws a bucketed min-max band, not raw points — see buckets.ts. The reader
 * follows the same rule: one focusable target per drawn column, describing
 * its range and median, not one per raw measurement. Doing it the other way
 * would put thousands of overlapping, individually-tabbable targets on a
 * 7-year chart, and their text would describe measurements the picture
 * itself already collapsed into a band.
 */
export function plot(series: Series, spec: SeriesSpec): string {
  const summary = escapeHtml(
    `${spec.label}, ${series.totalDays} nap: ${series.points.length} mérés, `
    + `${Math.floor(series.coverage * 100)}% lefedettség`
    + (series.points.length === 0 ? "" : `, ${spec.format(series.min)}–${spec.format(series.max)}`),
  );
  const open = `<svg class="plot" viewBox="0 0 ${W} ${H}" role="group" aria-label="${summary}">`
    + `<title>${summary}</title>`;

  if (series.points.length === 0) {
    return `${open}<text class="tengely" x="${L}" y="${T + IH / 2}">nincs mérés ebben az ablakban</text></svg>`;
  }

  const span = series.toDay - series.fromDay;
  const lo = spec.zeroBased ? Math.min(0, series.min) : series.min;
  const hi = series.max;
  const range = hi - lo === 0 ? 1 : hi - lo;
  const n = (v: number) => Math.round(v * 100) / 100;

  const xOfDay = (day: number) => span === 0 ? L + IW / 2 : L + ((day - series.fromDay) / span) * IW;
  const yOfVal = (v: number) => T + IH - ((v - lo) / range) * IH;

  // Gap bands first: they are the ground the rest is drawn on.
  const gaps = series.gaps.map((g) => {
    const x1 = xOfDay(dayNumber(g.fromDate));
    const x2 = xOfDay(dayNumber(g.toDate));
    // At least one pixel wide: a hole the axis cannot resolve is still a hole,
    // and a zero-width band would hide exactly the gaps a long window packs
    // most tightly.
    return `<rect class="hezag" x="${n(x1)}" y="${T}" width="${n(Math.max(1, x2 - x1))}" height="${IH}"/>`;
  }).join("");

  const grid = [0, 0.5, 1].map((f) => {
    const y = T + IH * f;
    const v = hi - (hi - lo) * f;
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

  let data: string;
  let targets: string;
  if (dense) {
    const buckets = bucketise(series, columns);
    const colW = IW / columns;
    const band: string[] = [];
    const line: string[] = [];
    const readers: string[] = [];
    let connected = false;
    for (const [i, b] of buckets.entries()) {
      if (b === null) { connected = false; continue; }
      const x = L + (i / columns) * IW;
      band.push(`<rect class="sav" x="${n(x)}" y="${n(yOfVal(b.max))}" width="1.2" `
        + `height="${n(Math.max(0.6, yOfVal(b.min) - yOfVal(b.max)))}"/>`);
      line.push(`${connected ? "L" : "M"}${n(x)} ${n(yOfVal(b.median))}`);
      connected = true;

      // The column's own day range, read back out of the same fraction
      // bucketise() used to place points in it.
      const dayLo = span === 0 ? series.fromDay : Math.round(series.fromDay + (i / columns) * span);
      const dayHi = span === 0 ? series.fromDay : Math.round(series.fromDay + ((i + 1) / columns) * span);
      const dateLabel = dayLo === dayHi ? dateOfDay(dayLo) : `${dateOfDay(dayLo)}–${dateOfDay(dayHi)}`;
      const label = `${dateLabel} · ${b.n} mérés, ${spec.format(b.min)}–${spec.format(b.max)} `
        + `(medián ${spec.format(b.median)})`;
      const cw = n(Math.max(1, colW));
      readers.push(`<rect class="celpont" tabindex="0" x="${n(x)}" y="${T}" width="${cw}" height="${IH}">`
        + `<title>${escapeHtml(label)}</title></rect>${reader(x + colW / 2, label)}`);
    }
    data = band.join("") + `<path class="vonal" pathLength="1" d="${line.join(" ")}"/>`;
    targets = readers.join("");
  } else {
    data = series.segments.map((seg) => {
      if (seg.length === 1) {
        return `<circle class="pont" cx="${n(xOfDay(seg[0]!.day))}" cy="${n(yOfVal(seg[0]!.value))}" r="2"/>`;
      }
      const d = seg.map((p: Point, i) => `${i === 0 ? "M" : "L"}${n(xOfDay(p.day))} ${n(yOfVal(p.value))}`).join(" ");
      return `<path class="vonal" pathLength="1" d="${d}"/>`;
    }).join("");

    // One reader per measured day: sparse enough that every measurement
    // earns its own focusable target.
    targets = series.points.map((p) => {
      const x = xOfDay(p.day);
      const label = `${p.date} · ${spec.format(p.value)}`;
      return `<rect class="celpont" tabindex="0" x="${n(x - 2)}" y="${T}" width="4" height="${IH}">`
        + `<title>${escapeHtml(label)}</title></rect>${reader(x, label)}`;
    }).join("");
  }

  return `${open}${gaps}${grid}${data}${targets}${axis}</svg>`;
}
