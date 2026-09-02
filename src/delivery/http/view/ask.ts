import { escapeHtml, renderMarkdown } from "../markdown.ts";
import type { Turn } from "../../../infra/db/repositories/conversations.ts";

export interface AskData {
  history: readonly Turn[];
  chatAvailable: boolean;
}

// Kept inline: there is no build step and no asset pipeline, and a second
// request for a few lines of script would need its own route and its own
// auth. Unchanged from `page.ts`'s original script, except `.quiet` (that
// page's dim-text class) is `.halk` here — the new shell's token name for
// the same role (see `view/today.ts`'s missing-brief line for the same swap).
//
// `POST /api/chat` is untouched by this move: `chatAuth` (see `../auth.ts`)
// accepts either this bearer header or the page's own cookie, so the
// sessionStorage token this script carries keeps working exactly as before.
export const SCRIPT = `
const q = new URLSearchParams(location.search).get("token");
if (q) { sessionStorage.setItem("jarvis-token", q); history.replaceState({}, "", location.pathname); }
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
      headers: { "content-type": "application/json", authorization: "Bearer " + (sessionStorage.getItem("jarvis-token") || "") },
      body: JSON.stringify({ question }),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    location.reload();
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
 * Moved from `page.ts`'s `chatBlock` unchanged (down to the four literal
 * control strings other tests pin — see the task brief): `page.ts` — kept
 * alive only until Task 8 removes it — still assembles its own "Kérdés" band
 * from this content, so it is exported rather than copied a second time.
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
 * The script ships here and nowhere else: the old page carried one script for
 * the whole document, but the new shell (`view/shell.ts`) has no per-page
 * script slot, and every other page has no use for it. Placed after the form
 * it drives, so the DOM it queries already exists by the time it runs.
 */
export function askBody(data: AskData): string {
  return `<section><h2>Kérdés</h2>${chatBlock(data)}</section><script>${SCRIPT}</script>`;
}
