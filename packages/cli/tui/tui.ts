// The interactive REPL for `af run` — a raw-mode line editor with a slash
// command dropdown and a live view of the run (tool calls as they happen,
// via the core's RunEvent seam). Hand-rolled on ANSI like style.ts: no
// curses, no dependencies. Off-TTY, local.ts keeps the plain prompt() loop;
// this file assumes a terminal on both ends.
//
// Layout: an info box on load, then a bottom region that is repainted in
// place — the input line between two horizontal rules, the dropdown below
// it, and during a run the status spinner above the box:
//
//   ⠼ thinking · step 2 · 3s
//   ────────────────────────
//   ❯ what time is it
//   ────────────────────────
//     ❯ /help   List commands and keys

import type { AgentConfig, AgentService, RunEvent, RunResult } from "@looped/core";
import { ACCENT, accent, bold, dim, err, paint, table, visibleLength, warn } from "../style.ts";
import { decodeKeys, type Key, LineEditor } from "./editor.ts";
import {
  completions,
  LOCAL_COMMANDS,
  parseSlash,
  replCommands,
  type SlashCommand,
} from "./commands.ts";
import { renderMarkdown } from "./markdown.ts";

const enc = new TextEncoder();
const write = (s: string) => Deno.stdout.writeSync(enc.encode(s));

const PROMPT_W = 2;
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const HISTORY_MAX = 500;

function termWidth(): number {
  try {
    return Deno.consoleSize().columns;
  } catch {
    return 80;
  }
}

/** Collapse to one line and cap the visible width (event lines, previews). */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, Math.max(0, max - 1)) + "…" : flat;
}

/**
 * The repaintable block at the bottom of the screen: the input box, its
 * dropdown, and the run status. Knows how many rows it drew and where it
 * parked the cursor, so it can erase itself and draw the next frame.
 */
class Region {
  #rows = 0;
  #park = 0;

  /** Redraw as `lines`, parking the cursor at (row, col) within them. */
  draw(lines: string[], row: number, col: number) {
    let out = this.#erase() + lines.join("\n");
    const up = lines.length - 1 - row;
    if (up > 0) out += `\x1b[${up}A`;
    out += "\r" + (col > 0 ? `\x1b[${col}C` : "");
    this.#rows = lines.length;
    this.#park = row;
    write(out);
  }

  /** Print a finished line into scrollback above the region; caller redraws. */
  printAbove(line: string) {
    write(this.#erase() + line + "\n");
    this.#rows = 0;
    this.#park = 0;
  }

  /** Erase the region and forget it. */
  clear() {
    write(this.#erase());
    this.#rows = 0;
    this.#park = 0;
  }

  /** The screen was cleared out from under us (ctrl-l, /clear). */
  reset() {
    this.#rows = 0;
    this.#park = 0;
  }

  #erase(): string {
    if (this.#rows === 0) return "\r\x1b[0J";
    return "\r" + (this.#park > 0 ? `\x1b[${this.#park}A` : "") + "\x1b[0J";
  }
}

function loadHistory(path: string): string[] {
  try {
    return Deno.readTextFileSync(path).split("\n").filter((l) => l.length > 0).slice(-HISTORY_MAX);
  } catch {
    return [];
  }
}

function saveHistory(path: string, history: readonly string[]) {
  try {
    Deno.writeTextFileSync(path, history.slice(-HISTORY_MAX).join("\n") + "\n");
  } catch {
    // Best effort — a read-only data dir shouldn't take the REPL down.
  }
}

/** Inputs to {@linkcode tui}. */
export interface TuiOptions {
  /** The agent's config (model line, memory scope, handle). */
  config: AgentConfig;
  /** The initialized service the REPL runs turns against. */
  service: AgentService;
}

/** Run the interactive REPL until /exit, ctrl-c on an empty line, or ctrl-d. */
export async function tui(options: TuiOptions): Promise<void> {
  const session = new Tui(options);
  const onSigint = () => {
    // Only reachable while a run is in flight (raw mode eats ctrl-c otherwise);
    // erase the run view and put the cursor back before dying.
    session.cleanup();
    Deno.exit(130);
  };
  Deno.addSignalListener("SIGINT", onSigint);
  try {
    await session.run();
  } finally {
    Deno.removeSignalListener("SIGINT", onSigint);
    Deno.stdin.setRaw(false);
    write(SHOW_CURSOR);
  }
}

class Tui {
  #config: AgentConfig;
  #service: AgentService;
  #conversationKey?: string;
  #ed: LineEditor;
  #historyPath: string;
  #region = new Region();
  #sel = 0;
  #dismissed = false;
  #frame = 0;
  #pending: Key[] = [];
  #decoder = new TextDecoder();
  #buf = new Uint8Array(4096);
  #commands: SlashCommand[];

  constructor({ config, service }: TuiOptions) {
    this.#config = config;
    this.#service = service;
    this.#commands = replCommands(config.commands);
    this.#conversationKey = config.memory?.scope === "thread" ? "cli" : undefined;
    const dataDir = Deno.env.get("AF_DATA_DIR") ?? ".looped";
    this.#historyPath = `${dataDir}/cli_history`;
    this.#ed = new LineEditor(loadHistory(this.#historyPath));
  }

  async run() {
    this.#header();
    while (true) {
      const line = await this.#readLine();
      if (line === null) break;
      if (!line.trim()) continue;
      saveHistory(this.#historyPath, this.#ed.history);
      if (await this.#dispatch(line.trim())) break;
    }
    write(dim("bye\n"));
  }

  /** Erase whatever the region has on screen (the SIGINT path). */
  cleanup() {
    this.#region.clear();
    write(SHOW_CURSOR + "\n");
  }

  /** Route one submitted line: screen-local command or a turn with the agent. */
  async #dispatch(line: string): Promise<boolean> {
    if (line.toLowerCase() === "exit") return true;
    const slash = parseSlash(line);
    // Only the screen-local commands live here. Everything else — built-ins,
    // config-defined commands, plain prose — goes to the agent, where
    // handle() intercepts known commands and unknown /names fall through to
    // the model untouched (plan 010).
    switch (slash && LOCAL_COMMANDS.some((c) => c.name === slash.name) ? slash.name : null) {
      case "exit":
        return true;
      case "clear":
        this.#clearScreen();
        return false;
      default:
        await this.#turn(line);
        if (slash?.name === "help") this.#localHelp();
        return false;
    }
  }

  // ── input ──────────────────────────────────────────────────────────────

  /** Read one line in raw mode; null means the user asked to leave. */
  async #readLine(): Promise<string | null> {
    Deno.stdin.setRaw(true);
    try {
      this.#sel = 0;
      this.#dismissed = false;
      this.#paint();
      while (true) {
        const key = this.#pending.shift() ?? null;
        if (key === null) {
          const n = await Deno.stdin.read(this.#buf);
          if (n === null) return this.#exitLine(); // EOF
          this.#pending = decodeKeys(this.#decoder.decode(this.#buf.subarray(0, n), {
            stream: true,
          }));
          continue;
        }
        const action = this.#handleKey(key);
        if (action === "submit") {
          this.#finishLine();
          return this.#ed.submit();
        }
        if (action === "exit") return this.#exitLine();
        this.#paint();
      }
    } finally {
      Deno.stdin.setRaw(false);
    }
  }

  #handleKey(key: Key): "cont" | "submit" | "exit" {
    const menu = this.#menu();
    if (menu.length) {
      switch (key.kind) {
        case "up":
          this.#sel = (this.#sel + menu.length - 1) % menu.length;
          return "cont";
        case "down":
          this.#sel = (this.#sel + 1) % menu.length;
          return "cont";
        case "tab":
          this.#ed.setText(`/${menu[this.#sel].name} `);
          return "cont";
        case "enter":
          this.#ed.setText(`/${menu[this.#sel].name}`);
          return "submit";
        case "esc":
          this.#dismissed = true;
          return "cont";
      }
    }
    if (key.kind === "ctrl") {
      switch (key.ch) {
        case "c":
          if (!this.#ed.text) return "exit";
          this.#ed.setText("");
          return "cont";
        case "d":
          if (!this.#ed.text) return "exit";
          this.#ed.apply({ kind: "delete" });
          return "cont";
        case "l":
          this.#clearScreen();
          return "cont";
      }
    }
    const before = this.#ed.text;
    const action = this.#ed.apply(key);
    if (action === "submit") return "submit";
    if (this.#ed.text !== before) {
      this.#dismissed = false;
      this.#sel = 0;
    }
    return "cont";
  }

  #menu(): SlashCommand[] {
    return this.#dismissed ? [] : completions(this.#ed.text, this.#commands);
  }

  // ── painting ───────────────────────────────────────────────────────────

  /** The input box (rule / input / rule) with the dropdown below it. */
  #paint() {
    const cols = termWidth();
    const menu = this.#menu();
    this.#sel = Math.min(this.#sel, Math.max(0, menu.length - 1));

    // Horizontal scroll: keep the cursor inside the window on long lines.
    const chars = [...this.#ed.text];
    const avail = Math.max(8, cols - PROMPT_W - 1);
    const start = this.#ed.cursor >= avail ? this.#ed.cursor - avail + 1 : 0;
    const visible = chars.slice(start, start + avail).join("");

    const rule = dim("─".repeat(cols));
    const lines = [rule, accent("❯") + " " + visible, rule];
    const nameW = Math.max(...menu.map((c) => c.name.length), 0);
    for (let i = 0; i < menu.length; i++) {
      const { name, description } = menu[i];
      const entry = `/${name.padEnd(nameW)}  ${description}`;
      lines.push("  " + (i === this.#sel ? accent("❯ " + entry) : dim("  " + entry)));
    }
    this.#region.draw(lines, 1, PROMPT_W + (this.#ed.cursor - start));
  }

  /** The run view: status spinner above an empty, disabled input box. */
  #paintRun(status: string) {
    const rule = dim("─".repeat(termWidth()));
    this.#region.draw(["", status, "", rule, dim("❯"), rule], 0, 0);
  }

  /** Leave the submitted line in scrollback, box and dropdown erased. */
  #finishLine() {
    this.#region.printAbove(accent("❯") + " " + this.#ed.text);
  }

  #exitLine(): null {
    this.#region.clear();
    return null;
  }

  /** The on-load info box: who is listening, on what model, with what memory. */
  #header() {
    const inner = [
      `${bold(this.#config.handle)} ${dim("is listening")}`,
      dim(`model   ${this.#config.model.provider} / ${this.#config.model.id}`),
      dim(`memory  ${this.#memoryDesc()} · /help for commands`),
    ];
    const w = Math.min(Math.max(...inner.map(visibleLength)) + 2, termWidth() - 2);
    write(dim(`╭${"─".repeat(w)}╮`) + "\n");
    for (const line of inner) {
      const pad = " ".repeat(Math.max(0, w - 1 - visibleLength(line)));
      write(dim("│") + " " + line + pad + dim("│") + "\n");
    }
    write(dim(`╰${"─".repeat(w)}╯`) + "\n");
  }

  #clearScreen() {
    write("\x1b[2J\x1b[H");
    this.#region.reset();
    this.#header();
  }

  #memoryDesc(): string {
    return [
      this.#config.memory?.scope === "thread" ? "thread" : undefined,
      this.#config.memory?.persistent ? "persistent" : undefined,
    ].filter(Boolean).join(" + ") || "none";
  }

  // ── the run view ───────────────────────────────────────────────────────

  /** One turn with the agent: live status + tool lines, then the reply. */
  async #turn(input: string) {
    const startedAt = performance.now();
    let step = 0;
    let tool: string | undefined;
    const status = () => {
      const elapsed = ((performance.now() - startedAt) / 1000).toFixed(0);
      const doing = tool ? `⚙ ${tool}` : "thinking";
      return `${paint(FRAMES[this.#frame++ % FRAMES.length], ACCENT)} ${
        dim(`${doing} · step ${step} · ${elapsed}s`)
      }`;
    };
    write(HIDE_CURSOR);
    this.#paintRun(status());
    const timer = setInterval(() => this.#paintRun(status()), 80);
    const onEvent = (e: RunEvent) => {
      const width = termWidth() - 12;
      switch (e.type) {
        case "step":
          step = e.n;
          break;
        case "assistant":
          this.#region.printAbove(dim(`  · ${oneLine(e.content, width)}`));
          this.#paintRun(status());
          break;
        case "tool_call":
          tool = e.name;
          break;
        case "tool_result":
          this.#region.printAbove(
            dim(
              `  ✓ ${e.name} ${e.content.trim() ? "" : "(no output) "}(${
                (e.durationMs / 1000).toFixed(1)
              }s)`,
            ),
          );
          tool = undefined;
          this.#paintRun(status());
          break;
      }
    };
    try {
      const result = await this.#service.handle(
        { id: crypto.randomUUID(), trigger: "cli", input, conversationKey: this.#conversationKey },
        { onEvent },
      );
      clearInterval(timer);
      this.#region.clear();
      this.#reply(result);
    } catch (e) {
      clearInterval(timer);
      this.#region.clear();
      write(`  ${err("✗")} ${e instanceof Error ? e.message : String(e)}\n\n`);
    } finally {
      write(SHOW_CURSOR);
    }
  }

  #reply(result: RunResult) {
    write("\n" + accent(`● ${this.#config.handle}`) + "\n");
    for (const line of renderMarkdown(result.reply).split("\n")) write(`  ${line}\n`);
    const status = `[${result.status} · ${result.steps} step${result.steps === 1 ? "" : "s"} · ` +
      `${result.usage.inputTokens}in/${result.usage.outputTokens}out tokens]`;
    write("  " + (result.status === "ok" ? dim(status) : warn(status)) + "\n\n");
  }

  // ── the screen-local commands ──────────────────────────────────────────

  /** Printed after the agent's /help reply: this surface's own extras. */
  #localHelp() {
    const rows = LOCAL_COMMANDS.map((c) => [`  ${accent("/" + c.name)}`, dim(c.description)]);
    write(table(rows).join("\n") + "\n");
    write(
      dim("  keys: ↑↓ history · tab complete · ctrl-c clear line / exit · ctrl-l clear screen") +
        "\n\n",
    );
  }
}
