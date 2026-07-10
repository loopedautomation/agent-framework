import { assertEquals } from "@std/assert";
import { decodeKeys, type Key, LineEditor } from "./editor.ts";

// ── decodeKeys ─────────────────────────────────────────────────────────────

Deno.test("decodeKeys: plain text becomes char keys, multibyte intact", () => {
  assertEquals(decodeKeys("hi"), [
    { kind: "char", ch: "h" },
    { kind: "char", ch: "i" },
  ]);
  assertEquals(decodeKeys("é🙂"), [
    { kind: "char", ch: "é" },
    { kind: "char", ch: "🙂" },
  ]);
});

Deno.test("decodeKeys: arrows, home/end and delete in CSI and legacy forms", () => {
  assertEquals(decodeKeys("\x1b[A\x1b[B\x1b[C\x1b[D").map((k) => k.kind), [
    "up",
    "down",
    "right",
    "left",
  ]);
  assertEquals(decodeKeys("\x1b[H\x1b[F\x1b[1~\x1b[4~\x1b[3~").map((k) => k.kind), [
    "home",
    "end",
    "home",
    "end",
    "delete",
  ]);
  // SS3 (application keypad) arrows decode too:
  assertEquals(decodeKeys("\x1bOA").map((k) => k.kind), ["up"]);
});

Deno.test("decodeKeys: control characters map to ctrl keys and specials", () => {
  assertEquals(decodeKeys("\x01\x05\x17"), [
    { kind: "ctrl", ch: "a" },
    { kind: "ctrl", ch: "e" },
    { kind: "ctrl", ch: "w" },
  ]);
  assertEquals(decodeKeys("\x7f\t").map((k) => k.kind), ["backspace", "tab"]);
});

Deno.test("decodeKeys: enter forms — \\r, \\n, and \\r\\n collapse to one", () => {
  assertEquals(decodeKeys("\r").map((k) => k.kind), ["enter"]);
  assertEquals(decodeKeys("\n").map((k) => k.kind), ["enter"]);
  assertEquals(decodeKeys("a\r\nb").map((k) => k.kind), ["char", "enter", "char"]);
});

Deno.test("decodeKeys: a lone ESC is the esc key; unknown CSI is dropped", () => {
  assertEquals(decodeKeys("\x1b"), [{ kind: "esc" }]);
  assertEquals(decodeKeys("\x1b[5~x"), [{ kind: "char", ch: "x" }]); // page-up: ignored
});

// ── LineEditor ─────────────────────────────────────────────────────────────

function type(ed: LineEditor, text: string) {
  for (const key of decodeKeys(text)) ed.apply(key);
}

const key = (kind: Key["kind"]): Key => ({ kind }) as Key;
const ctrl = (ch: string): Key => ({ kind: "ctrl", ch });

Deno.test("editor: insert, cursor movement and deletes", () => {
  const ed = new LineEditor();
  type(ed, "helo");
  ed.apply(key("left"));
  type(ed, "l");
  assertEquals(ed.text, "hello");
  ed.apply(key("home"));
  ed.apply(key("delete"));
  assertEquals(ed.text, "ello");
  ed.apply(key("end"));
  ed.apply(key("backspace"));
  assertEquals(ed.text, "ell");
  assertEquals(ed.cursor, 3);
});

Deno.test("editor: emacs keys — ctrl-a/e/k/u and ctrl-w word delete", () => {
  const ed = new LineEditor();
  type(ed, "one two three");
  ed.apply(ctrl("w"));
  assertEquals(ed.text, "one two ");
  ed.apply(ctrl("w"));
  assertEquals(ed.text, "one ");
  ed.apply(ctrl("a"));
  assertEquals(ed.cursor, 0);
  ed.apply(ctrl("e"));
  assertEquals(ed.cursor, 4);
  ed.apply(ctrl("u"));
  assertEquals(ed.text, "");
  type(ed, "abc");
  ed.apply(key("left"));
  ed.apply(ctrl("k"));
  assertEquals(ed.text, "ab");
});

Deno.test("editor: history recall preserves the draft and dedupes", () => {
  const ed = new LineEditor(["first", "second"]);
  type(ed, "draft");
  ed.apply(key("up"));
  assertEquals(ed.text, "second");
  ed.apply(key("up"));
  assertEquals(ed.text, "first");
  ed.apply(key("up")); // already at the oldest
  assertEquals(ed.text, "first");
  ed.apply(key("down"));
  ed.apply(key("down"));
  assertEquals(ed.text, "draft"); // back to the draft

  ed.setText("second");
  assertEquals(ed.apply(key("enter")), "submit");
  ed.submit();
  assertEquals(ed.history, ["first", "second"]); // consecutive dupe not re-added
  assertEquals(ed.text, "");

  type(ed, "third");
  ed.submit();
  assertEquals(ed.history, ["first", "second", "third"]);
});

Deno.test("editor: blank submissions stay out of history", () => {
  const ed = new LineEditor();
  type(ed, "   ");
  ed.submit();
  assertEquals(ed.history, []);
});
