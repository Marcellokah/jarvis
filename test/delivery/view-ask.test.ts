import { describe, it, expect } from "vitest";
import { chatBlock, askBody, SCRIPT, type AskData } from "../../src/delivery/http/view/ask.ts";
import type { Turn } from "../../src/infra/db/repositories/conversations.ts";

const base: AskData = { history: [], chatAvailable: true };

function turn(over: Partial<Turn> & Pick<Turn, "role" | "content">): Turn {
  return { id: 1, chatId: "web", createdAt: "2026-09-01T08:00:00.000Z", ...over };
}

// A conversation turn is the one place in the whole app where a language
// model's own output, and the owner's own typing, become HTML — `chatBlock`
// is the composed rendering that actually reaches the browser, not just the
// `renderMarkdown` primitive underneath it. The old `page.test.ts`
// `describe("renderPage")` test this replaces asserted exactly this
// composition; testing only `renderMarkdown` in isolation (as
// `markdown.test.ts` already does) would still pass if `chatBlock` stopped
// calling it — this test exists so that mistake fails here.
describe("chatBlock", () => {
  it("escapes everything a model or a person typed", () => {
    const html = chatBlock({
      ...base,
      history: [turn({ role: "assistant", content: "<script>x()</script>" })],
    });
    expect(html).not.toContain("<script>x()</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("keeps the page usable when the model is unreachable", () => {
    // Named controls, not a bare `toContain("disabled")` — the deleted
    // renderPage test's own rationale: a rendered task checkbox also carries
    // the word "disabled", so a blanket check cannot fail.
    const html = chatBlock({ ...base, chatAvailable: false });
    expect(html).toContain(`<input type="text" placeholder="Kérdezz valamit…" disabled>`);
    expect(html).toContain(`<button type="submit" disabled>`);
    expect(html).toContain("nem érhető el");
  });

  it("leaves the question box usable when the model is reachable", () => {
    const html = chatBlock({ ...base, chatAvailable: true });
    expect(html).toContain(`<input type="text" placeholder="Kérdezz valamit…">`);
    expect(html).toContain(`<button type="submit">`);
    expect(html).not.toContain("nem érhető el");
  });
});

describe("a kérdés-script", () => {
  it("nem tart a böngészőben másolatot a tokenből", () => {
    // A süti `HttpOnly`, és a `chatAuth` elfogadja — a sessionStorage-másolat
    // ezzel feleslegessé vált, közben viszont olvasható maradt bármelyik
    // scriptnek, és a böngésző-munkamenettel együtt meg is halt.
    expect(SCRIPT).not.toContain("sessionStorage");
    expect(SCRIPT).not.toContain("Bearer");
    // A süti nem véletlenül megy: a kérés kimondva kéri.
    expect(SCRIPT).toContain(`credentials: "same-origin"`);
  });

  it("nem viszi magával a címsor-takarítást", () => {
    // Az a keretbe került (`view/shell.ts`), mert minden oldalra érvényes.
    expect(SCRIPT).not.toContain("replaceState");
  });
});

describe("askBody", () => {
  it("also escapes what it renders, through the same composed path the route sends", () => {
    // `askBody` — not `chatBlock` — is what `routes/page.ts` actually sends
    // to the browser for `/kerdes`; pinned separately so a future `askBody`
    // change that bypasses `chatBlock` cannot slip through unnoticed either.
    const html = askBody({
      ...base,
      history: [turn({ role: "user", content: "<img src=x onerror=alert(1)>" })],
    });
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});
