import { renderMarkdown } from "../markdown.ts";
import type { Turn } from "../../../infra/db/repositories/conversations.ts";

export interface AskData {
  history: readonly Turn[];
  chatAvailable: boolean;
}

// Kept inline: there is no build step and no asset pipeline, and a second
// request for a few lines of script would need its own route and its own
// auth. `.quiet` (the old page's dim-text class) is `.halk` here — the new
// shell's token name for the same role (see `view/today.ts`'s missing-brief
// line for the same swap).
//
// The token is no longer carried here at all. This script used to copy
// `?token=` into `sessionStorage` and send it back as a bearer header, but
// `chatAuth` (see `../auth.ts`) accepts the page's own `HttpOnly` cookie,
// which the browser attaches to this same-origin POST by itself — so the copy
// answered a question nothing asks any more, while keeping a readable copy of
// the token in the browser and dying with the session. Scrubbing the token
// out of the URL was the other half of that line; it moved to the shell
// (`SCRUB_SCRIPT` in `view/shell.ts`), because arriving with a token can
// happen on any of the four pages, not just this one.
//
// On success, the answer is spliced straight into the thread — no reload,
// so the scroll position, the briefing, the measurements and the charts
// above it stay exactly as they were. `location.reload()` survives only as
// the fallback for a response with no `html` field (an older server), where
// the reload is the only way left to show what the server actually has.
export const SCRIPT = `
const form = document.querySelector("form");
if (form) form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = form.querySelector("input[type=text]");
  const question = input.value.trim();
  if (!question) return;
  const button = form.querySelector("button");
  input.disabled = button.disabled = true;
  form.classList.add("busy");
  button.textContent = "Kérdezek";
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      // Spelled out rather than left to the default: the cookie is now the
      // only credential this request carries, so it must not depend on a
      // default staying what it is.
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question }),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    // No \`html\` means an older server than this page: the answer exists, it
    // just has to come back through a reload. The reload shows the server's
    // own truth, so nothing is lost by it.
    if (!data.html) { location.reload(); return; }

    const thread = form.parentNode;
    const add = (who, cls, fill) => {
      const box = document.createElement("div");
      box.className = "turn " + cls;
      const name = document.createElement("div");
      name.className = "who";
      name.textContent = who;
      box.appendChild(name);
      fill(box);
      thread.insertBefore(box, form);
      return box;
    };
    // The question goes in as text, never as markup: what a person types is
    // not HTML. The answer goes in as HTML because the server rendered it —
    // through the same escaping renderer a reload would have used.
    add("Te", "user", (box) => {
      const p = document.createElement("p");
      p.textContent = question;
      box.appendChild(p);
    });
    add("Jarvis", "assistant", (box) => { box.insertAdjacentHTML("beforeend", data.html); });

    input.value = "";
    form.classList.remove("busy");
    button.textContent = "Kérdés";
    input.disabled = button.disabled = false;
    input.focus();
  } catch (err) {
    form.classList.remove("busy");
    button.textContent = "Újra";
    // The failure says what happened next to the box it happened in, rather
    // than overwriting the control's own name with an error.
    let note = form.parentNode.querySelector(".ask-error");
    if (!note) {
      note = document.createElement("p");
      note.className = "halk ask-error";
      form.parentNode.appendChild(note);
    }
    note.textContent = "A kérdés nem ment át (" + err.message + "). A fenti tartalom teljes.";
    input.disabled = button.disabled = false;
  }
});
`;

/**
 * The thread and the question box, unwrapped by any section or heading.
 *
 * Exported separately from `askBody` (not just used internally): its own
 * tests (`test/delivery/view-ask.test.ts`) assert on this function's output
 * directly — the disabled/enabled control strings and the escaping of what a
 * model or a person typed — without needing to also parse the `<section>`
 * wrapper and inline `<script>` that `askBody` adds around it.
 */
export function chatBlock(data: AskData): string {
  const turns = data.history.map((t) => [
    `<div class="turn ${t.role === "user" ? "user" : "assistant"}">`,
    `<div class="who">${t.role === "user" ? "Te" : "Jarvis"}</div>`,
    renderMarkdown(t.content),
    "</div>",
  ].join("")).join("");

  const disabled = data.chatAvailable ? "" : " disabled";
  const notice = data.chatAvailable
    ? ""
    : `<p class="halk">A modell most nem érhető el. A fenti tartalom teljes.</p>`;

  return [
    turns,
    notice,
    `<form><input type="text" placeholder="Kérdezz valamit…"${disabled}>`,
    `<button type="submit"${disabled}>Kérdés</button></form>`,
  ].join("");
}

/**
 * The `/kerdes` route's whole body, `chatBlock` plus the script that drives it.
 *
 * This script ships here and nowhere else, because the form is: no other page
 * has a question box for it to drive. (The URL scrub that used to travel with
 * it is a property of every page and lives in the shell — see `SCRUB_SCRIPT`
 * there.) Placed after the form it drives, so the DOM it queries already
 * exists by the time it runs.
 */
export function askBody(data: AskData): string {
  return `<section><h2>Kérdés</h2>${chatBlock(data)}</section><script>${SCRIPT}</script>`;
}
