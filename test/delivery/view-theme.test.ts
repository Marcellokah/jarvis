import { describe, it, expect } from "vitest";
import { STYLE, TOKEN_NAMES } from "../../src/delivery/http/view/theme.ts";

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

  it("a csökkentett mozgás mindent leállít, az oldalváltást is", () => {
    // A @view-transition alapból animál; a reduced-motion blokknak a
    // ::view-transition-* pszeudóelemeket is le kell állítania, különben az
    // egyetlen mozgás marad, amit a beállítás nem tud kikapcsolni.
    expect(STYLE).toContain("@view-transition");
    const reduced = /prefers-reduced-motion[^{]*\{([\s\S]*)\}\s*`?\s*$/.exec(STYLE)?.[1] ?? "";
    expect(reduced).toContain("view-transition");
  });
});
