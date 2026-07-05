// Terminal styling for af — the Looped palette, dependency-free.
// Pure string formatting: color detection is a module flag so tests
// (and NO_COLOR / piped output) get plain text.

/** The Looped loop: cyan → violet. The banner paints with it; log prefixes cycle it. */
export const LOOP_GRADIENT = ["#22d3ee", "#38bdf8", "#60a5fa", "#818cf8", "#a78bfa", "#c084fc"];

export const ACCENT = "#685EF6"; // Looped primary purple
const OK = "#37946A";
const WARN = "#ED9B00";
const ERR = "#D02E1F";

function detectColor(): boolean {
  try {
    return Deno.stdout.isTerminal() && Deno.env.get("NO_COLOR") === undefined;
  } catch {
    return false;
  }
}

let colorEnabled = detectColor();

/** Override color detection (tests, --no-color futures). */
export function setColorEnabled(on: boolean) {
  colorEnabled = on;
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** Truecolor-paint text; identity when color is off. */
export function paint(text: string, hex: string): string {
  if (!colorEnabled) return text;
  const [r, g, b] = rgb(hex);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

export const accent = (text: string): string => paint(text, ACCENT);
export const ok = (text: string): string => paint(text, OK);
export const warn = (text: string): string => paint(text, WARN);
export const err = (text: string): string => paint(text, ERR);

export function dim(text: string): string {
  return colorEnabled ? `\x1b[2m${text}\x1b[22m` : text;
}

export function bold(text: string): string {
  return colorEnabled ? `\x1b[1m${text}\x1b[22m` : text;
}

/** A stable gradient color for the i-th agent (foreground log prefixes). */
export function gradientAt(i: number): string {
  return LOOP_GRADIENT[i % LOOP_GRADIENT.length];
}

// deno-lint-ignore no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

/** Printable width — pad by what the user sees, not by escape bytes. */
export function visibleLength(text: string): number {
  return text.replace(ANSI, "").length;
}

/** Align rows into columns (two spaces apart), padding by visible width. */
export function table(rows: string[][]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, visibleLength(cell))));
  }
  return rows.map((row) =>
    row
      .map((cell, i) => cell + " ".repeat(widths[i] - visibleLength(cell)))
      .join("  ")
      .trimEnd()
  );
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * A one-line spinner for the slow moments (image pull, healthz wait).
 * Off-TTY it degrades to a single plain line so piped output stays clean.
 */
export class Spinner {
  #timer?: ReturnType<typeof setInterval>;
  #text = "";
  #frame = 0;
  #live = colorEnabled;

  start(text: string) {
    this.#text = text;
    if (!this.#live) {
      console.log(text);
      return;
    }
    this.#timer = setInterval(() => {
      this.#write(`\r\x1b[2K${paint(FRAMES[this.#frame++ % FRAMES.length], ACCENT)} ${this.#text}`);
    }, 80);
  }

  update(text: string) {
    this.#text = text;
    if (!this.#live) console.log(text);
  }

  /** Stop and replace the spinner line (off-TTY: just print it). */
  stop(finalLine?: string) {
    clearInterval(this.#timer);
    if (this.#live) this.#write("\r\x1b[2K");
    if (finalLine !== undefined) console.log(finalLine);
  }

  #write(s: string) {
    Deno.stdout.writeSync(new TextEncoder().encode(s));
  }
}
