import { describe, it, expect } from "vitest";
import { STYLE, TOKEN_NAMES } from "../../src/delivery/http/view/theme.ts";

/**
 * The FIRST `@media (prefers-reduced-motion: reduce) { … }` block's own
 * body, brace-balanced — not regex-greedy to the stylesheet's last `}`.
 *
 * D4: `/prefers-reduced-motion[^{]*\{([\s\S]*)\}\s*\`?\s*$/` captured from
 * the first block's `{` to the LAST `}` in the whole stylesheet, so it kept
 * passing even once a second (and now third, fourth) reduced-motion block
 * was appended further down — anything between the first block and the end
 * of the file counted as "inside" it. Counting braces instead stops at the
 * first block's own matching `}`, so a rule that moved OUT of that block
 * (into an unconditional one later in the file) is no longer seen as still
 * inside it.
 */
function firstReducedMotionBlock(css: string): string {
  const start = css.indexOf("prefers-reduced-motion");
  if (start === -1) return "";
  const open = css.indexOf("{", start);
  let depth = 0;
  let i = open;
  for (; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return css.slice(open + 1, i);
}

/**
 * Every selector token that refers to the bare `nav` element, unscoped by a
 * class — e.g. `nav {` or `nav a.menu` — as opposed to `nav.fomenu` or
 * `.tartomanyok`.
 *
 * F3 shipped two `<nav>`s that are not the site menu (`.tartomanyok` on the
 * measurement detail page, `.lapozo` on the workout log) into a stylesheet
 * whose navigation rules were written element-first: `nav { position: fixed;
 * … }` and friends. Both inherited the site menu's fixed 8.5rem left column
 * with no rule of their own to override it — one now with browser-default
 * blue links, since `.tartomanyok` had never been styled at all. Scoping the
 * existing rules to `nav.fomenu` (theme.ts) fixes today's two victims, but
 * only a scan that rejects ANY bare `nav` selector stops the next `<nav>`
 * from falling into the same trap — a hand-picked list of today's classes
 * would not.
 *
 * Comments are stripped first so Hungarian prose like "navigáció" or the
 * `@view-transition { navigation: auto; }` declaration cannot be mistaken
 * for a selector. `\bnav\b` alone would also match the "nav" inside
 * `nav.fomenu` (a dot is a non-word character, so the boundary still fires),
 * so a match is only a violation when the character right after "nav" is
 * NOT "." (i.e. not immediately scoped by a class) — and a match preceded by
 * "." is skipped too, so a future `.nav`-named class is not mistaken for the
 * bare element.
 */
function bareNavSelectors(css: string): string[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const hits: string[] = [];
  const re = /\bnav\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const before = stripped[m.index - 1];
    const after = stripped[m.index + 3];
    if (before === ".") continue; // a class like `.nav`, not the element
    if (after === ".") continue; // scoped, e.g. `nav.fomenu`
    hits.push(stripped.slice(Math.max(0, m.index - 15), m.index + 25));
  }
  return hits;
}

describe("téma", () => {
  it("mindkét séma minden tokent megad", () => {
    const root = /:root\s*\{([^}]*)\}/.exec(STYLE)?.[1] ?? "";
    const light = /prefers-color-scheme:\s*light\s*\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(STYLE)?.[1] ?? "";
    for (const name of TOKEN_NAMES) {
      expect(root, `sötét: ${name}`).toContain(`${name}:`);
      expect(light, `világos: ${name}`).toContain(`${name}:`);
    }
  });

  it("nincs olyan szín, amit csak média-blokk ad meg", () => {
    // A klasszikus olvashatatlan-oldal hiba: egy szín, aminek az egyetlen
    // definíciója média-blokkban van, a másik sémában egyszerűen nincs.
    const light = /prefers-color-scheme:\s*light\s*\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(STYLE)?.[1] ?? "";
    const root = /:root\s*\{([^}]*)\}/.exec(STYLE)?.[1] ?? "";
    const declared = [...light.matchAll(/(--[a-z-]+)\s*:/g)].map((m) => m[1]!);
    for (const name of declared) expect(root).toContain(`${name}:`);
  });

  it("a lépcsőzetes beúszásnak van honnan indexet vennie", () => {
    // A `--i` alapértéke 0, tehát ha semmi nem állítja be, a 60ms-os lépcső
    // soha nem szólal meg — a szabály viszont úgy néz ki, mintha működne. Ez
    // pontosan az a "magabiztosan hazudó" felület, amit ez az oldal kerül.
    expect(STYLE).toContain("animation-delay: calc(var(--i, 0) * 60ms)");
    expect(/\.lap\s*>\s*\*:nth-child\(2\)\s*\{\s*--i:\s*1/.test(STYLE)).toBe(true);
    expect(/\.lap\s*>\s*\*:nth-child\(3\)\s*\{\s*--i:\s*2/.test(STYLE)).toBe(true);
  });

  it("a body kifest egy hátteret", () => {
    // Átlátszó törzs a gazda hátterét kölcsönzi, és a másik séma szövegét
    // teszi a saját alapjára.
    expect(/body\s*\{[^}]*background:\s*var\(--hatter\)/.test(STYLE)).toBe(true);
  });

  it("a nagy diagram olvasója bármilyen fókuszra megjelenik, nem csak :focus-visible-re", () => {
    // :focus-visible szándékosan kizárja az egér- és érintés-eredetű fókuszt.
    // Ha a `.olvaso` felfedése csak erre menne, egy koppintás vagy egy
    // egérkattintás fókuszálná a célpontot, de az olvasó rejtve maradna — a
    // "koppintással is működik" ígéret hazugság lenne. A tartalom-feltárás
    // ezért sima :focus-ra fut, a :focus-visible csak a billentyűzetes
    // fókuszgyűrűnek marad, ami helyesen csak billentyűzetre jelenik meg.
    expect(/\.plot \.celpont:hover \+ \.olvaso,\s*\n\s*\.plot \.celpont:focus \+ \.olvaso \{ opacity: 1; \}/.test(STYLE)).toBe(true);
    expect(STYLE).not.toMatch(/\.plot \.celpont:focus-visible \+ \.olvaso/);
    expect(/\.plot \.celpont:focus-visible \{ stroke: var\(--jel\); stroke-width: 1; \}/.test(STYLE)).toBe(true);
  });

  it("a csökkentett mozgás mindent leállít, az oldalváltást is", () => {
    // A @view-transition alapból animál; a reduced-motion blokknak a
    // ::view-transition-* pszeudóelemeket is le kell állítania, különben az
    // egyetlen mozgás marad, amit a beállítás nem tud kikapcsolni.
    expect(STYLE).toContain("@view-transition");
    const reduced = firstReducedMotionBlock(STYLE);
    expect(reduced).toContain("view-transition");
  });

  it("egyetlen navigációs szabály sem szól a puszta `nav` elemről", () => {
    // A site-menü fix, 8.5rem széles bal sávja csak a .fomenu-t illeti — más
    // <nav> (pl. .tartomanyok, .lapozo) a saját elrendezését akarja, nem ezt.
    // Ez egy szkennelés, nem egy fix lista: BÁRMELY jövőbeli `nav { … }` vagy
    // `nav …` szabály itt bukik, nem csak a mai kettő.
    const hits = bareNavSelectors(STYLE);
    expect(hits, `puszta nav szelektor(ok): ${JSON.stringify(hits)}`).toEqual([]);
  });

  it("a h2 a --cimszin tokent használja, és az WCAG AA fölött van mindkét sémában", () => {
    // M9: a h2 korábban `--vaz`-t, majd (F6 alatt) `--halvany`-t használt.
    // `--halvany` 4.49:1-re javította a sötét sémát, de 4.41:1-re rontotta a
    // világosat (6.66:1-ről) — WCAG AA ehhez a betűmérethez 4.5:1-et kíván,
    // tehát egyik séma sem felelt meg utána. A visszaállítás `--vaz`-ra zöld
    // maradt volna a teszttel, mert semmi nem pinnelte le sem a tényleges
    // színt, sem a kontrasztot — ez a teszt mindkettőt teszi.
    expect(/h2\s*\{[^}]*color:\s*var\(--cimszin\)/.test(STYLE)).toBe(true);

    const root = /:root\s*\{([^}]*)\}/.exec(STYLE)?.[1] ?? "";
    const light = /prefers-color-scheme:\s*light\s*\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(STYLE)?.[1] ?? "";

    const hex = (css: string, token: string): string => {
      const m = new RegExp(`${token}:\\s*(#[0-9A-Fa-f]{6})`).exec(css);
      if (m === null) throw new Error(`token not found: ${token}`);
      return m[1]!;
    };
    const luminance = (h: string): number => {
      const lin = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      const r = parseInt(h.slice(1, 3), 16), g = parseInt(h.slice(3, 5), 16), b = parseInt(h.slice(5, 7), 16);
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    };
    const contrast = (a: string, b: string): number => {
      const pair = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
      return (pair[0] + 0.05) / (pair[1] + 0.05);
    };

    expect(contrast(hex(root, "--cimszin"), hex(root, "--hatter"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(hex(light, "--cimszin"), hex(light, "--hatter"))).toBeGreaterThanOrEqual(4.5);
  });

  it("a .tartomanyok és a .lapozo navnak van saját szabálya", () => {
    // A mérésrészlet oldal tartomány-választója soha nem kapott saját
    // stílust — a böngésző alapértelmezett kék, aláhúzott linkjeivel jelent
    // meg, miközben a site-menü fix sávjában lebegett. Ez a teszt azt zárja
    // ki, hogy ez a hiány visszatérjen.
    //
    // Comments are stripped first, and the selector-to-`{` gap is capped at
    // 40 chars: an earlier version of this test read `[^{]*` with no cap and
    // no comment stripping, so it was satisfied by the class name merely
    // being MENTIONED in a comment much earlier in the file, with the `{` of
    // some unrelated, later rule closing the match — it stayed green even
    // after the actual `.tartomanyok` rule block was deleted entirely.
    const stripped = STYLE.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(/\.tartomanyok[.\s\w-]{0,40}\{[^}]+\}/.test(stripped)).toBe(true);
    expect(/\.lapozo[.\s\w-]{0,40}\{[^}]+\}/.test(stripped)).toBe(true);
  });
});
