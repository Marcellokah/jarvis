import { escapeHtml } from "../../markdown.ts";

const W = 720, H = 180, L = 52, R = 8, T = 10, B = 26;
const IW = W - L - R;
const IH = H - T - B;

/**
 * How many axis labels this width can carry without them running together.
 *
 * A label per column is the obvious thing and the wrong one: 56 months under
 * a 720-unit box is 12 units each, which is narrower than the text. The ends
 * are always drawn because they are what say WHICH span this is; in between
 * the labels thin out evenly. Nothing is lost by it — every column keeps its
 * own reader, and the reader carries the full label.
 */
const MAX_LABELS = 12;

/**
 * The shortest bar that is still visible, in this viewBox's own units.
 *
 * A measured zero must draw something. A zero-height rect is legal SVG that
 * paints exactly nothing, and the month would then be indistinguishable from
 * one nobody recorded — the very confusion this primitive exists to prevent.
 */
const STUB = 1.5;

export interface BarsSpec {
  label: string;
  format: (v: number) => string;
}

export interface BarRow {
  label: string;
  /** null means nobody recorded this month; 0 means it was recorded as zero. */
  value: number | null;
}

/**
 * Months as columns — the chart for volume, not for a daily measurement.
 *
 * The large `plot` is built for a daily series with gap bands, and training
 * volume is not that shape. A day without training is a REAL zero, not a
 * missing measurement, so a daily line would lie on the axis through most of
 * the record and its bucketed median would be zero: an accurate picture that
 * says nothing. Monthly totals are the thing worth looking at.
 *
 * The one rule that matters here is that **two different kinds of empty
 * exist**, and they must not render alike:
 *
 *   - `null` — nobody recorded this month. It gets the same vocabulary the
 *     large chart uses for a hole: a `hezag` band, which is ground rather
 *     than data. Every month before 2026-08 in the subscription record is
 *     this: the table was created in S2 and earlier months are deliberately
 *     not reconstructed.
 *   - `0` — recorded, and it was zero. A visible stub on the axis. A month
 *     without training inside the workout record's own span is this.
 *
 * Collapsing the two would tell the reader that an unrecorded month was zero,
 * which is exactly the class of confidently-wrong number this whole system is
 * built against.
 */
export function bars(rows: readonly BarRow[], spec: BarsSpec): string {
  const measured = rows.filter(
    (r): r is { label: string; value: number } => r.value !== null,
  );
  const summary = escapeHtml(
    measured.length === 0
      ? `${spec.label} — nincs adat`
      : `${spec.label} — ${measured.length} mért hónap ${rows.length} hónapból`,
  );
  const open = `<svg class="oszlopok" viewBox="0 0 ${W} ${H}" role="group" aria-label="${summary}">`
    + `<title>${summary}</title>`;

  // Nothing measured is not an empty picture. An empty frame reads as "the
  // chart broke"; a sentence reads as "there is nothing here yet".
  if (measured.length === 0) {
    return `${open}<text class="tengely" x="${L}" y="${T + IH / 2}">nincs adat</text></svg>`;
  }

  const n = (v: number) => Math.round(v * 100) / 100;
  const max = Math.max(...measured.map((r) => r.value));
  const cw = IW / rows.length;
  const bw = Math.max(1, cw * 0.7);
  // An all-zero series has no scale to place anything on; every bar is a stub.
  const yOf = (v: number) =>
    max === 0 ? T + IH - STUB : T + IH - Math.max(STUB, (v / max) * IH);

  // Holes first: they are the ground the rest is drawn on, exactly as the
  // large chart draws its gap bands before anything else.
  const holes = rows.map((r, i) => {
    if (r.value !== null) return "";
    const x = L + i * cw + (cw - bw) / 2;
    return `<rect class="hezag" x="${n(x)}" y="${T}" width="${n(bw)}" height="${IH}"/>`;
  }).join("");

  const grid = [0, 1].map((f) => {
    const y = T + IH * (1 - f);
    return `<line class="racs" x1="${L}" y1="${n(y)}" x2="${W - R}" y2="${n(y)}"/>`
      + `<text class="tengely" x="4" y="${n(y + 3)}">${escapeHtml(spec.format(max * f))}</text>`;
  }).join("");

  const columns = rows.map((r, i) => {
    if (r.value === null) return "";
    const x = L + i * cw + (cw - bw) / 2;
    const y = yOf(r.value);
    // The class carries the distinction into the markup, so a reader — and a
    // test — can tell a recorded zero from an unrecorded month.
    const cls = r.value === 0 ? "oszlop nulla" : "oszlop";
    return `<rect class="${cls}" x="${n(x)}" y="${n(y)}" width="${n(bw)}" height="${n(T + IH - y)}"/>`;
  }).join("");

  const every = Math.max(1, Math.ceil(rows.length / MAX_LABELS));
  const axis = rows.map((r, i) => {
    const last = i === rows.length - 1;
    if (i !== 0 && !last && i % every !== 0) return "";
    const anchor = i === 0 ? "start" : last ? "end" : "middle";
    const x = i === 0 ? L : last ? W - R : L + (i + 0.5) * cw;
    return `<text class="tengely" x="${n(x)}" y="${H - 8}" text-anchor="${anchor}">`
      + `${escapeHtml(r.label)}</text>`;
  }).join("");

  // Same readout box the large chart uses: clamped inside the plot so it
  // never spills past an edge, sized to its own label.
  const reader = (x: number, text: string) => {
    const esc = escapeHtml(text);
    const boxW = Math.max(96, esc.length * 6);
    const bx = Math.min(W - R - boxW, Math.max(L, x - boxW / 2));
    return `<g class="olvaso"><rect x="${n(bx)}" y="${T}" width="${boxW}" height="18" rx="2"/>`
      + `<text x="${n(bx + 6)}" y="${T + 13}">${esc}</text></g>`;
  };

  // One target per column, thinned labels included: what the axis cannot
  // print, the reader still says.
  const targets = rows.map((r, i) => {
    const x = L + i * cw;
    const text = `${r.label} · ${r.value === null ? "nincs adat" : spec.format(r.value)}`;
    return `<rect class="celpont" tabindex="0" x="${n(x)}" y="${T}" width="${n(cw)}" height="${IH}">`
      + `<title>${escapeHtml(text)}</title></rect>${reader(x + cw / 2, text)}`;
  }).join("");

  return `${open}${holes}${grid}${columns}${axis}${targets}</svg>`;
}
