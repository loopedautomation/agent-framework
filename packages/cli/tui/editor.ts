// Raw-mode key decoding and the line editor — the pure half of the TUI.
// No I/O here: bytes-in/state-out, so the interesting behavior (cursor
// movement, history, word ops) is testable without a terminal.

/** One decoded keypress. */
export type Key =
  | { kind: "char"; ch: string }
  | { kind: "enter" }
  | { kind: "backspace" }
  | { kind: "delete" }
  | { kind: "left" }
  | { kind: "right" }
  | { kind: "up" }
  | { kind: "down" }
  | { kind: "home" }
  | { kind: "end" }
  | { kind: "tab" }
  | { kind: "esc" }
  | { kind: "ctrl"; ch: string };

function csiKey(params: string, final: string): Key | null {
  switch (final) {
    case "A":
      return { kind: "up" };
    case "B":
      return { kind: "down" };
    case "C":
      return { kind: "right" };
    case "D":
      return { kind: "left" };
    case "H":
      return { kind: "home" };
    case "F":
      return { kind: "end" };
    case "~":
      if (params === "1" || params === "7") return { kind: "home" };
      if (params === "3") return { kind: "delete" };
      if (params === "4" || params === "8") return { kind: "end" };
      return null;
    default:
      return null;
  }
}

/**
 * Decode one raw-mode stdin chunk (already UTF-8 decoded) into keypresses.
 * Unrecognized escape sequences are dropped; a lone ESC is the esc key.
 */
export function decodeKeys(text: string): Key[] {
  const keys: Key[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\x1b") {
      const rest = text.slice(i);
      // deno-lint-ignore no-control-regex
      const csi = rest.match(/^\x1b\[([0-9;]*)([A-Za-z~])/);
      if (csi) {
        i += csi[0].length;
        const key = csiKey(csi[1], csi[2]);
        if (key) keys.push(key);
        continue;
      }
      // deno-lint-ignore no-control-regex
      const ss3 = rest.match(/^\x1bO([A-Z])/);
      if (ss3) {
        // SS3 arrows/home/end (application keypad mode); F-keys fall out as null.
        const key = csiKey("", ss3[1]);
        if (key) keys.push(key);
        i += ss3[0].length;
        continue;
      }
      keys.push({ kind: "esc" });
      i++;
      continue;
    }
    const code = text.charCodeAt(i);
    if (ch === "\r" || ch === "\n") {
      if (!(ch === "\n" && text[i - 1] === "\r")) keys.push({ kind: "enter" });
    } else if (code === 0x7f || ch === "\b") {
      keys.push({ kind: "backspace" });
    } else if (ch === "\t") {
      keys.push({ kind: "tab" });
    } else if (code < 0x20) {
      keys.push({ kind: "ctrl", ch: String.fromCharCode(code + 96) });
    } else {
      const cp = String.fromCodePoint(text.codePointAt(i)!);
      keys.push({ kind: "char", ch: cp });
      i += cp.length;
      continue;
    }
    i++;
  }
  return keys;
}

/** What applying a key did: nothing it knows, an edit, or a submitted line. */
export type EditAction = "none" | "edited" | "submit";

/**
 * A single-line editor over an array of code points, with emacs-style keys
 * and up/down history. The TUI owns rendering and the keys with UI meaning
 * (tab, esc, ctrl-c/d/l); everything else lands here via {@linkcode apply}.
 */
export class LineEditor {
  #chars: string[] = [];
  #cursor = 0;
  #history: string[];
  #histIdx: number;
  #draft: string[] = [];

  /** Start with prior submissions, oldest first (up recalls the newest). */
  constructor(history: string[] = []) {
    this.#history = [...history];
    this.#histIdx = this.#history.length;
  }

  /** The line as typed so far. */
  get text(): string {
    return this.#chars.join("");
  }

  /** Cursor position in code points, 0..text length. */
  get cursor(): number {
    return this.#cursor;
  }

  /** Submitted lines, oldest first. */
  get history(): readonly string[] {
    return this.#history;
  }

  /** Replace the line (dropdown completion), cursor at the end. */
  setText(text: string) {
    this.#chars = [...text];
    this.#cursor = this.#chars.length;
  }

  /** Apply a decoded key; returns what happened so the TUI knows to repaint. */
  apply(key: Key): EditAction {
    switch (key.kind) {
      case "char":
        this.#chars.splice(this.#cursor++, 0, key.ch);
        return "edited";
      case "backspace":
        if (this.#cursor === 0) return "none";
        this.#chars.splice(--this.#cursor, 1);
        return "edited";
      case "delete":
        if (this.#cursor === this.#chars.length) return "none";
        this.#chars.splice(this.#cursor, 1);
        return "edited";
      case "left":
        if (this.#cursor === 0) return "none";
        this.#cursor--;
        return "edited";
      case "right":
        if (this.#cursor === this.#chars.length) return "none";
        this.#cursor++;
        return "edited";
      case "home":
        this.#cursor = 0;
        return "edited";
      case "end":
        this.#cursor = this.#chars.length;
        return "edited";
      case "up":
        return this.#recall(-1);
      case "down":
        return this.#recall(1);
      case "enter":
        return "submit";
      case "ctrl":
        switch (key.ch) {
          case "a":
            this.#cursor = 0;
            return "edited";
          case "e":
            this.#cursor = this.#chars.length;
            return "edited";
          case "k":
            this.#chars.length = this.#cursor;
            return "edited";
          case "u":
            this.#chars.splice(0, this.#cursor);
            this.#cursor = 0;
            return "edited";
          case "w":
            return this.#deleteWordBack();
          default:
            return "none";
        }
      default:
        return "none";
    }
  }

  /** Record the current line in history and clear for the next one. */
  submit(): string {
    const line = this.text;
    if (line.trim() && line !== this.#history.at(-1)) this.#history.push(line);
    this.#histIdx = this.#history.length;
    this.#chars = [];
    this.#cursor = 0;
    this.#draft = [];
    return line;
  }

  #recall(dir: -1 | 1): EditAction {
    const next = this.#histIdx + dir;
    if (next < 0 || next > this.#history.length) return "none";
    if (this.#histIdx === this.#history.length) this.#draft = this.#chars; // leaving the draft
    this.#histIdx = next;
    this.#chars = next === this.#history.length ? this.#draft : [...this.#history[next]];
    this.#cursor = this.#chars.length;
    return "edited";
  }

  #deleteWordBack(): EditAction {
    if (this.#cursor === 0) return "none";
    let start = this.#cursor;
    while (start > 0 && this.#chars[start - 1] === " ") start--;
    while (start > 0 && this.#chars[start - 1] !== " ") start--;
    this.#chars.splice(start, this.#cursor - start);
    this.#cursor = start;
    return "edited";
  }
}
