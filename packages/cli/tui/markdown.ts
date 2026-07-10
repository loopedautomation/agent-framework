// Markdown → ANSI for agent replies — the subset models actually write:
// emphasis, inline code, links, headings, bullets, fences, quotes. Marker
// stripping always happens; the styling itself follows style.ts's color
// detection, so piped output stays plain text.

import { accent, bold, dim, italic, LOOP_GRADIENT, paint, strike, underline } from "../style.ts";

const CODE = LOOP_GRADIENT[0]; // cyan — inline code and nothing else

/** Inline spans: code first (protected), then emphasis, strikes and links. */
function inline(text: string): string {
  return text.split(/(`[^`]+`)/g).map((part) => {
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      return paint(part.slice(1, -1), CODE);
    }
    return part
      .replace(/\*\*\*([^*]+)\*\*\*/g, (_, t) => bold(italic(t)))
      .replace(/\*\*([^*]+)\*\*/g, (_, t) => bold(t))
      .replace(/__([^_]+)__/g, (_, t) => bold(t))
      .replace(/\*([^*\s][^*]*)\*/g, (_, t) => italic(t))
      .replace(/(?<!\w)_([^_]+)_(?!\w)/g, (_, t) => italic(t))
      .replace(/~~([^~]+)~~/g, (_, t) => strike(t))
      .replace(
        /\[([^\]]+)\]\(([^)\s]+)\)/g,
        (_, label, url) => underline(label) + dim(` (${url})`),
      );
  }).join("");
}

/**
 * Render a markdown reply for the terminal. Line-based: fenced code passes
 * through untouched (indented), everything else gets block + inline styling.
 */
export function renderMarkdown(md: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const line of md.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue; // the fence markers themselves add nothing
    }
    if (inFence) {
      out.push("  " + line);
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      out.push(bold(accent(inline(heading[1]))));
      continue;
    }
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      out.push(dim("─".repeat(24)));
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      out.push(dim("│ ") + dim(inline(quote[1])));
      continue;
    }
    out.push(inline(line.replace(/^(\s*)[-*+]\s+/, "$1• ")));
  }
  return out.join("\n");
}
