export type BriefFormat = "md" | "text" | "json";

/**
 * iOS notifications do not render markdown, so the Shortcut gets plain text
 * with the structure preserved through spacing and symbols rather than syntax.
 */
export function toPlainText(markdown: string): string {
  const out: string[] = [];

  for (const raw of markdown.split("\n")) {
    let line = raw;

    if (/^\s*---+\s*$/.test(line)) { out.push("—————"); continue; }

    line = line.replace(/^#{1}\s+/, "");           // title
    line = line.replace(/^#{2,}\s+/, "");          // section headings
    line = line.replace(/^>\s?/, "");              // blockquote marker
    line = line.replace(/^(\s*)-\s+\[\s\]\s+/, "$1☐ ");
    line = line.replace(/^(\s*)-\s+\[x\]\s+/i, "$1☑ ");
    line = line.replace(/^(\s*)[-*]\s+/, "$1• ");
    line = line.replace(/\*\*(.+?)\*\*/g, "$1");   // bold
    line = line.replace(/(^|\s)_(.+?)_(?=\s|$|[.,;:!?)])/g, "$1$2"); // italic
    line = line.replace(/`([^`]+)`/g, "$1");       // inline code
    line = line.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)"); // links

    out.push(line);
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Telegram HTML parse mode. Chosen over MarkdownV2 because MarkdownV2 requires
 * escaping 18 characters anywhere they appear, which Hungarian prose trips over
 * constantly; HTML needs only three.
 */
export function toTelegramHtml(markdown: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const out: string[] = [];

  for (const raw of markdown.split("\n")) {
    if (/^\s*---+\s*$/.test(raw)) { out.push("———"); continue; }

    const h1 = raw.match(/^#\s+(.*)$/);
    if (h1) { out.push(`<b>${esc(h1[1]!)}</b>`); continue; }

    const h2 = raw.match(/^#{2,}\s+(.*)$/);
    if (h2) { out.push(`<b>${esc(h2[1]!)}</b>`); continue; }

    let line = esc(raw.replace(/^>\s?/, ""));
    line = line.replace(/^(\s*)-\s+\[\s\]\s+/, "$1☐ ");
    line = line.replace(/^(\s*)[-*]\s+/, "$1• ");
    line = line.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    line = line.replace(/(^|\s)_(.+?)_(?=\s|$|[.,;:!?)])/g, "$1<i>$2</i>");
    line = line.replace(/`([^`]+)`/g, "<code>$1</code>");
    out.push(line);
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
