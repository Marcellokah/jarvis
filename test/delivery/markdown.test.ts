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

  it("returns an empty string for empty input", () => {
    expect(renderMarkdown("")).toBe("");
    expect(renderMarkdown("\n\n  \n")).toBe("");
  });
});
