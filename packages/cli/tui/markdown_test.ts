import { assert, assertEquals } from "@std/assert";
import { setColorEnabled } from "../style.ts";
import { renderMarkdown } from "./markdown.ts";

/** Run with ANSI on, restoring the piped-test default afterwards. */
function colored(fn: () => void) {
  setColorEnabled(true);
  try {
    fn();
  } finally {
    setColorEnabled(false);
  }
}

Deno.test("markdown: markers are stripped even with color off (piped output)", () => {
  assertEquals(renderMarkdown("**bold** and *italic* and `code`"), "bold and italic and code");
  assertEquals(renderMarkdown("# Heading"), "Heading");
  assertEquals(renderMarkdown("- one\n- two"), "• one\n• two");
  assertEquals(renderMarkdown("~~gone~~ __strong__"), "gone strong");
});

Deno.test("markdown: emphasis becomes ANSI when color is on", () => {
  colored(() => {
    assertEquals(renderMarkdown("**hi**"), "\x1b[1mhi\x1b[22m");
    assertEquals(renderMarkdown("*hi*"), "\x1b[3mhi\x1b[23m");
    assertEquals(renderMarkdown("_hi_"), "\x1b[3mhi\x1b[23m");
    assertEquals(renderMarkdown("~~hi~~"), "\x1b[9mhi\x1b[29m");
    assertEquals(renderMarkdown("***hi***"), "\x1b[1m\x1b[3mhi\x1b[23m\x1b[22m");
  });
});

Deno.test("markdown: inline code is protected from emphasis parsing", () => {
  colored(() => {
    const out = renderMarkdown("`a ** b`");
    assert(out.includes("a ** b")); // the stars survive inside code
    assert(out.includes("\x1b[38;2;")); // and the span is painted
  });
});

Deno.test("markdown: links show the label underlined with a dim url", () => {
  colored(() => {
    const out = renderMarkdown("see [docs](https://looped.sh)");
    assert(out.includes("\x1b[4mdocs\x1b[24m"));
    assert(out.includes("(https://looped.sh)"));
  });
  assertEquals(renderMarkdown("see [docs](https://looped.sh)"), "see docs (https://looped.sh)");
});

Deno.test("markdown: fenced code passes through untouched, fences dropped", () => {
  const out = renderMarkdown("before\n```ts\nconst x = **not bold**;\n```\nafter");
  assertEquals(out, "before\n  const x = **not bold**;\nafter");
});

Deno.test("markdown: quotes, rules and multiplication stay sane", () => {
  assertEquals(renderMarkdown("> wisdom"), "│ wisdom");
  assertEquals(renderMarkdown("---"), "─".repeat(24));
  // No spurious italics from arithmetic:
  assertEquals(renderMarkdown("2 * 3 * 4 = 24"), "2 * 3 * 4 = 24");
  // snake_case survives:
  assertEquals(renderMarkdown("use current_time here"), "use current_time here");
});
