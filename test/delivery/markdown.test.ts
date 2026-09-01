import { describe, it, expect } from "vitest";
import { escapeHtml, renderMarkdown } from "../../src/delivery/http/markdown.ts";

describe("escapeHtml", () => {
  it("neutralises every character that could open a tag or attribute", () => {
    expect(escapeHtml(`<script>alert("x") & 'y'</script>`))
      .toBe("&lt;script&gt;alert(&quot;x&quot;) &amp; &#39;y&#39;&lt;/script&gt;");
  });
});

describe("renderMarkdown", () => {
  it("renders the heading levels the briefs and analyses actually use", () => {
    expect(renderMarkdown("# Egy")).toBe("<h1>Egy</h1>");
    expect(renderMarkdown("## Kettő")).toBe("<h2>Kettő</h2>");
    expect(renderMarkdown("### Három")).toBe("<h3>Három</h3>");
  });

  it("renders a bullet list", () => {
    expect(renderMarkdown("- egy\n- kettő"))
      .toBe("<ul><li>egy</li><li>kettő</li></ul>");
  });

  it("renders a checkbox item as a checkbox, checked or not", () => {
    expect(renderMarkdown("- [ ] tennivaló"))
      .toBe(`<ul><li class="task"><input type="checkbox" disabled> tennivaló</li></ul>`);
    expect(renderMarkdown("- [x] kész"))
      .toBe(`<ul><li class="task"><input type="checkbox" checked disabled> kész</li></ul>`);
  });

  it("renders bold and inline code", () => {
    expect(renderMarkdown("sima **vastag** és `kód`"))
      .toBe("<p>sima <strong>vastag</strong> és <code>kód</code></p>");
  });

  it("separates paragraphs on a blank line", () => {
    expect(renderMarkdown("első\n\nmásodik")).toBe("<p>első</p><p>második</p>");
  });

  it("joins the lines of one paragraph with a space, not a break", () => {
    expect(renderMarkdown("első sor\nmásodik sor")).toBe("<p>első sor második sor</p>");
  });

  it("escapes the content of every element it renders", () => {
    expect(renderMarkdown("# <b>cím</b>")).toBe("<h1>&lt;b&gt;cím&lt;/b&gt;</h1>");
    expect(renderMarkdown("- <img src=x onerror=1>"))
      .toBe("<ul><li>&lt;img src=x onerror=1&gt;</li></ul>");
  });

  it("never executes a script the model wrote", () => {
    // The answer comes from a language model; treating it as trusted markup
    // would be the one way this local page could hurt anything.
    const html = renderMarkdown("<script>fetch('/api')</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders syntax it does not know as plain text rather than guessing", () => {
    // A misread format is worse than an ugly line.
    expect(renderMarkdown("| a | b |")).toBe("<p>| a | b |</p>");
    expect(renderMarkdown("> idézet")).toBe("<p>&gt; idézet</p>");
  });

  // -------------------------------------------------------------------------
  // Adversarial input. Every one of these was traced by hand and found safe;
  // none was pinned. A renderer that turns a language model's output into a
  // page is the one place in this project where "safe today" is not enough —
  // the contract is that unknown syntax degrades to escaped plain text, and a
  // contract with no test is a comment.
  // -------------------------------------------------------------------------

  it("prints a heading deeper than h3 as text rather than inventing an h4", () => {
    // HEADING matches #{1,3}; a fourth hash is outside the known subset, so it
    // must not become `<h4>` — and must not become `<h3># Négy>` either.
    expect(renderMarkdown("#### Négy")).toBe("<p>#### Négy</p>");
    expect(renderMarkdown("#####Öt")).toBe("<p>#####Öt</p>");
  });

  it("does not read a task marker that has no space after the dash", () => {
    // `-[ ]` is not a bullet and not a task. Guessing would render a checkbox
    // the model never asked for.
    expect(renderMarkdown("-[ ] nincs szóköz")).toBe("<p>-[ ] nincs szóköz</p>");
  });

  it("leaves an unbalanced bold marker as literal asterisks", () => {
    // The non-greedy `\*\*(.+?)\*\*` needs a closing pair; without one the
    // text passes through, escaped, rather than opening a <strong> that never
    // closes and swallows the rest of the page.
    expect(renderMarkdown("**nem zárt")).toBe("<p>**nem zárt</p>");
    expect(renderMarkdown("**a** és **b")).toBe("<p><strong>a</strong> és **b</p>");
  });

  it("leaves an unclosed backtick as a literal backtick", () => {
    expect(renderMarkdown("`nem zárt kód")).toBe("<p>`nem zárt kód</p>");
  });

  it("treats a line that is only a dash as text, not an empty bullet", () => {
    // BULLET requires `-` plus whitespace plus content; a bare dash has none,
    // so it stays a paragraph rather than becoming <li></li>.
    expect(renderMarkdown("-")).toBe("<p>-</p>");
  });

  it("escapes input that already looks escaped, rather than trusting it", () => {
    // Double-escaping is the correct answer here. Recognising `&amp;` as
    // already-safe would mean trusting the model's text to be pre-escaped,
    // which is exactly the assumption an injection needs.
    expect(renderMarkdown("már &amp; escape-elve")).toBe("<p>már &amp;amp; escape-elve</p>");
    expect(renderMarkdown("&lt;script&gt;")).toBe("<p>&amp;lt;script&amp;gt;</p>");
  });

  it("escapes the content of a task item too", () => {
    // The checkbox branch has its own `inline(escapeHtml(...))` call, which the
    // heading/bullet escape test above never exercises.
    expect(renderMarkdown(`- [ ] <b>tennivaló</b> & "x"`)).toBe(
      `<ul><li class="task"><input type="checkbox" disabled> `
      + `&lt;b&gt;tennivaló&lt;/b&gt; &amp; &quot;x&quot;</li></ul>`,
    );
    expect(renderMarkdown("- [x] <img src=x onerror=alert(1)>")).toBe(
      `<ul><li class="task"><input type="checkbox" checked disabled> `
      + `&lt;img src=x onerror=alert(1)&gt;</li></ul>`,
    );
  });

  it("returns an empty string for empty input", () => {
    expect(renderMarkdown("")).toBe("");
    expect(renderMarkdown("\n\n  \n")).toBe("");
  });
});
