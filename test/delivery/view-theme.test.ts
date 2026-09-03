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
});
