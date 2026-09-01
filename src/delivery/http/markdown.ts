/**
 * A markdown subset, rendered without a dependency.
 *
 * Justified only because the markdown shown on this page is our own prompts'
 * output, with a known shape: headings, bullets, `- [ ]` tasks, bold, inline
 * code, blank-line paragraphs. Anything outside that set is printed as escaped
 * text rather than guessed at — a misread format is worse than an ugly line.
 *
 * Escaping happens before any markup is added, and on every path. The text
 * being rendered includes a language model's answer, which is the one way a
 * local page like this could be made to hurt anything.
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Inline marks, applied to already-escaped text. */
function inline(escaped: string): string {
  return escaped
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`(.+?)`/g, "<code>$1</code>");
}

const HEADING = /^(#{1,3})\s+(.*)$/;
const TASK = /^-\s+\[( |x|X)\]\s+(.*)$/;
const BULLET = /^-\s+(.*)$/;

export function renderMarkdown(md: string): string {
  const out: string[] = [];
  let list: string[] = [];
  let paragraph: string[] = [];

  const flushList = () => {
    if (list.length === 0) return;
    out.push(`<ul>${list.join("")}</ul>`);
    list = [];
  };
  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    out.push(`<p>${paragraph.join(" ")}</p>`);
    paragraph = [];
  };
  const flush = () => { flushList(); flushParagraph(); };

  for (const raw of md.split("\n")) {
    const line = raw.trim();

    if (line === "") { flush(); continue; }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      const level = heading[1]!.length;
      out.push(`<h${level}>${inline(escapeHtml(heading[2]!))}</h${level}>`);
      continue;
    }

    const task = TASK.exec(line);
    if (task) {
      flushParagraph();
      const checked = task[1]!.toLowerCase() === "x" ? " checked" : "";
      list.push(
        `<li class="task"><input type="checkbox"${checked} disabled> ${inline(escapeHtml(task[2]!))}</li>`,
      );
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      flushParagraph();
      list.push(`<li>${inline(escapeHtml(bullet[1]!))}</li>`);
      continue;
    }

    flushList();
    paragraph.push(inline(escapeHtml(line)));
  }

  flush();
  return out.join("");
}
