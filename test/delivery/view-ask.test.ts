import { describe, it, expect } from "vitest";
import { chatBlock, askBody, SCRIPT, type AskData } from "../../src/delivery/http/view/ask.ts";
import { renderMarkdown } from "../../src/delivery/http/markdown.ts";
import type { Turn } from "../../src/infra/db/repositories/conversations.ts";

const base: AskData = { history: [], chatAvailable: true };

function turn(over: Partial<Turn> & Pick<Turn, "role" | "content">): Turn {
  return { id: 1, chatId: "web", createdAt: "2026-09-01T08:00:00.000Z", ...over };
}

// A minimal DOM shim, just enough for `SCRIPT` (executed for real, via
// `new Function`, not re-typed by hand) to run against — no npm dependency
// added for it, per this project's pledge that the client-side surface does
// not grow. It supports exactly what `SCRIPT` touches: element creation,
// `className`/`classList`, `textContent`/`value`/`disabled`, `appendChild`/
// `insertBefore`/`insertAdjacentHTML`/`remove`, and a `querySelector` that
// understands the handful of selectors `SCRIPT` actually uses
// (`"form"`, `"input[type=text]"`, `"button"`, `".ask-error"`).
class El {
  tag: string;
  attrs: Record<string, string> = {};
  children: El[] = [];
  htmlChunks: string[] = [];
  parentNode: El | null = null;
  textContent = "";
  value = "";
  disabled = false;
  className = "";

  constructor(tag: string) { this.tag = tag; }

  get classList() {
    const self = this;
    const list = () => self.className.split(/\s+/).filter(Boolean);
    return {
      contains: (c: string) => list().includes(c),
      add: (c: string) => { if (!list().includes(c)) self.className = [...list(), c].join(" "); },
      remove: (c: string) => { self.className = list().filter((x) => x !== c).join(" "); },
    };
  }

  appendChild(child: El): El { child.parentNode = this; this.children.push(child); return child; }

  insertBefore(child: El, ref: El): El {
    child.parentNode = this;
    const i = this.children.indexOf(ref);
    if (i === -1) this.children.push(child); else this.children.splice(i, 0, child);
    return child;
  }

  insertAdjacentHTML(_pos: string, html: string): void { this.htmlChunks.push(html); }

  remove(): void {
    if (this.parentNode) {
      const i = this.parentNode.children.indexOf(this);
      if (i !== -1) this.parentNode.children.splice(i, 1);
    }
    this.parentNode = null;
  }

  querySelector(sel: string): El | null { return find(this, sel); }
  focus(): void {}
}

function matches(el: El, sel: string): boolean {
  if (sel.startsWith(".")) return el.classList.contains(sel.slice(1));
  const attr = /^([a-z]+)\[([a-z]+)=([a-z]+)\]$/.exec(sel);
  if (attr) {
    const [, tag, name, value] = attr;
    return el.tag === tag && el.attrs[name ?? ""] === value;
  }
  return el.tag === sel;
}

function find(root: El, sel: string): El | null {
  for (const child of root.children) {
    if (matches(child, sel)) return child;
    const nested = find(child, sel);
    if (nested) return nested;
  }
  return null;
}

/** Renders an `El` subtree back to an HTML string, for comparing against `chatBlock`'s own output. */
function serialize(el: El): string {
  const cls = el.className ? ` class="${el.className}"` : "";
  const inner = el.children.map(serialize).join("") + el.htmlChunks.join("");
  return `<${el.tag}${cls}>${el.textContent}${inner}</${el.tag}>`;
}

interface Harness {
  document: { createElement: (tag: string) => El; querySelector: (sel: string) => El | null };
  thread: El;
  form: El;
  input: El;
  listeners: Record<string, (e: { preventDefault(): void }) => unknown>;
}

/** Builds the one-form page `SCRIPT` expects: a thread `<div>` holding the form. */
function buildHarness(): Harness {
  const thread = new El("div");
  const form = new El("form");
  const input = new El("input");
  input.attrs.type = "text";
  const button = new El("button");
  form.appendChild(input);
  form.appendChild(button);
  thread.appendChild(form);
  const listeners: Harness["listeners"] = {};
  (form as unknown as { addEventListener: (t: string, fn: (e: { preventDefault(): void }) => unknown) => void })
    .addEventListener = (type, fn) => { listeners[type] = fn; };
  const document = {
    createElement: (tag: string) => new El(tag),
    querySelector: (sel: string) => find(thread, sel),
  };
  return { document, thread, form, input, listeners };
}

/** Runs `SCRIPT` (the real, unmodified source string) against a fresh harness. */
function runScript(h: Harness, fetchStub: (...args: unknown[]) => Promise<unknown>): void {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- executing the real client script under test
  const attach = new Function("document", "fetch", "location", SCRIPT) as
    (document: unknown, fetch: unknown, location: unknown) => void;
  attach(h.document, fetchStub, { reload: () => { throw new Error("unexpected reload() in this test"); } });
}

const submit = (h: Harness) => {
  const handler = h.listeners.submit;
  if (!handler) throw new Error("submit listener was not attached");
  return handler({ preventDefault() {} });
};

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

describe("a chat scriptje", () => {
  it("a fonál-építő ág nem tölti újra a lapot, ha van html és questionHtml", () => {
    // A görgetési pozíció, a briefing, a mérések és a diagramok mind
    // újraépültek egy kérdés miatt, miközben a szerver már a kezében
    // tartotta a választ.
    //
    // A brief eredeti csonkja `SCRIPT.split("catch")[0]`-t vizsgálta — de a
    // hiányzó-mező ág (lásd lentebb) szándékosan `location.reload()`-t hív, és
    // az a hívás is a `catch` ELŐTT van (a `try` blokkban, a válasz feldolgozó
    // részén belül), tehát a csonk szó szerint véve minden válaszra bukna, nem
    // csak a hibásra. Ezért a fonál-építő ágat a hiányzó-mező elágazás UTÁNI
    // részre szűkítjük: onnantól kezdve, hogy a kód eldöntötte, hogy a fonalat
    // építi (nem a reload-ot választja), nem szabad újra reload-ot hívnia.
    const guard = "if (!data.html || !data.questionHtml) { location.reload(); return; }";
    const afterGuard = SCRIPT.split(guard)[1] ?? "";
    expect(afterGuard.length).toBeGreaterThan(0);
    const buildPath = afterGuard.split("catch")[0] ?? "";
    expect(buildPath).not.toContain("location.reload()");
  });

  it("mindkét fordulót a szerver renderelt HTML-jéből építi, ugyanazzal a renderelővel mint a reload", () => {
    // A reload (`chatBlock`) MINDKÉT szerepet ugyanazon a `renderMarkdown`-on
    // vezeti át — nem csak a válaszét. Ha a kérdés élőben nyers szövegként
    // (`textContent`) kerülne be, egy "**félkövér**" vagy "- lista" kérdés
    // szó szerint jelenne meg beküldéskor, majd formázottan a következő
    // reloadnál — a fonál alakja megváltozna. Ezért a kérdésnek is a szerver
    // által renderelt `data.questionHtml`-ből kell bekerülnie, a válaszéval
    // azonos módon (`insertAdjacentHTML`), nem a nyers `question` változóból.
    //
    // Konkrétan a beillesztő sorra szűkítünk, nem csak arra, hogy a
    // "questionHtml" szó valahol szerepel a scriptben — az triviálisan igaz
    // lenne akkor is, ha a nyers `question` kerülne be és a `data.questionHtml`
    // csak holt kódban szerepelne. Ez a pontos sor bukik el, ha valaki
    // visszacseréli nyers `question`-re (akár `textContent`-tel, akár
    // `insertAdjacentHTML`-lel).
    expect(SCRIPT).toContain(`add("Te", "user", data.questionHtml);`);
    expect(SCRIPT).toContain(`add("Jarvis", "assistant", data.html);`);
    expect(SCRIPT).toContain(`box.insertAdjacentHTML("beforeend", html);`);
    // A kérdés nem kerülhet be nyersen: sem `textContent`-tel a beillesztő
    // sorban, sem a `question` változóból közvetlenül a fonálba.
    expect(SCRIPT).not.toContain("p.textContent = question;");
    expect(SCRIPT).not.toContain(`insertAdjacentHTML("beforeend", question)`);
  });

  it("a html vagy a questionHtml mező hiányában visszaesik az újratöltésre", () => {
    // Régi szerver vagy félbeszakadt telepítés: a válasz megvan, csak a
    // lapon keresztül jön elő. Az újratöltés a szerver igazságát mutatja.
    //
    // A brief eredeti csonkja csak azt nézte, hogy a `location.reload()`
    // SZÖVEG valahol szerepel a scriptben — de az a feltétel eltörlése
    // (pl. `if (!data.html)` → `if (false)`) mellett is igaz marad, hiszen a
    // hívás szövege a holt ágban is ott marad, csak elérhetetlenné válik.
    // Ezért a teljes feltételt magával a hívással együtt rögzítjük, nem csak
    // a hívás szavát — és mindkét mezőt (html, questionHtml) is elvárjuk a
    // feltételben, hogy az egyik hiánya se csússzon át észrevétlenül.
    expect(SCRIPT).toContain(
      "if (!data.html || !data.questionHtml) { location.reload(); return; }",
    );
  });

  it("a hibaág változatlanul kezeli a hibát", () => {
    expect(SCRIPT).toContain("Újra");
    expect(SCRIPT).toContain("A fenti tartalom teljes.");
  });

  it("a sikeres ág eltávolítja a korábbi hibaüzenetet (szöveges rögzítés)", () => {
    // `location.reload()` used to wipe the `.ask-error` note for free — the
    // success path never had to know it existed. Now that nothing reloads,
    // the success path must clear it itself. This assertion only proves the
    // removal CODE is present in the build path (a typo'd class name or a
    // no-op instead of `.remove()` would still pass a bare `toContain`); the
    // execution test below ("a hibaüzenet…" in the next `describe`) is what
    // actually proves the note disappears from a live DOM.
    const guard = "if (!data.html || !data.questionHtml) { location.reload(); return; }";
    const buildPath = (SCRIPT.split(guard)[1] ?? "").split("catch")[0] ?? "";
    expect(buildPath).toContain(`querySelector(".ask-error")`);
    expect(buildPath).toContain(".remove()");
  });
});

describe("a script futtatva — alak-egyezés egy reloaddal (I2)", () => {
  it("az élőben beszúrt fordulók bájtra ugyanazok, mint `chatBlock` reload-kimenete", async () => {
    // The reviewer verified this by hand: run `SCRIPT` for real against a
    // DOM, and compare its output to `chatBlock`'s own reload markup for the
    // same turns. Both `questionHtml` and `html` are produced by the SAME
    // `renderMarkdown` `chatBlock` uses internally — this is what the real
    // `/api/chat` route sends — so the comparison is not circular: it fails
    // the moment either side's element shape, class name, or role label
    // diverges from the other's.
    const questionContent = "Mikor **alszom** eleget?";
    const answerContent = "- Ma korán\n- Holnap később";
    const questionHtml = renderMarkdown(questionContent);
    const html = renderMarkdown(answerContent);

    const h = buildHarness();
    runScript(h, async () => ({
      ok: true,
      status: 200,
      json: async () => ({ html, questionHtml }),
    }));
    h.input.value = questionContent;
    await submit(h);

    const liveTurns = h.thread.children.filter((c) => c !== h.form).map(serialize).join("");

    // Derived from `chatBlock`, not hardcoded: a class rename, a swapped
    // element, or a reordered field on EITHER side breaks this without
    // anyone updating a literal string here.
    const reloadHtml = chatBlock({
      history: [
        turn({ role: "user", content: questionContent }),
        turn({ role: "assistant", content: answerContent }),
      ],
      chatAvailable: true,
    });
    const reloadTurns = reloadHtml.slice(0, reloadHtml.indexOf("<form"));

    expect(liveTurns).toBe(reloadTurns);
  });
});

describe("a script futtatva — hibaüzenet egy sikeres újrapróbálkozás után (I1)", () => {
  it("egy 502 után egy sikeres kérdés eltünteti a korábbi hibaüzenetet", async () => {
    // The exact scenario the reviewer ran by hand: a failed request leaves
    // the `.ask-error` note in the thread (the real `catch` branch, not a
    // manually inserted stand-in), then a second, successful submit must
    // make it disappear — a page that still says "a kérdés nem ment át"
    // after the answer arrived is stating something false.
    const h = buildHarness();
    let call = 0;
    runScript(h, async () => {
      call++;
      if (call === 1) return { ok: false, status: 502 };
      return {
        ok: true, status: 200,
        json: async () => ({ html: renderMarkdown("Jó válasz."), questionHtml: renderMarkdown("Kérdés?") }),
      };
    });

    h.input.value = "Kérdés?";
    await submit(h);
    const failedNote = h.thread.querySelector(".ask-error");
    expect(failedNote).not.toBeNull();
    expect(failedNote?.textContent).toContain("502");

    h.input.value = "Kérdés?";
    await submit(h);
    expect(h.thread.querySelector(".ask-error")).toBeNull();
    const liveTurns = h.thread.children.filter((c) => c !== h.form).map(serialize).join("");
    expect(liveTurns).toContain("Jó válasz.");
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
