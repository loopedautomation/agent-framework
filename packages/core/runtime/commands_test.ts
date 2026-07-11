import { assertEquals } from "@std/assert";
import {
  BUILTIN_COMMANDS,
  commandSpecs,
  helpText,
  parseCommand,
  substituteArgs,
} from "./commands.ts";

const KNOWN = ["help", "status", "reset", "standup"];

Deno.test("parseCommand: bare command", () => {
  assertEquals(parseCommand("/status", KNOWN), { name: "status", args: "" });
});

Deno.test("parseCommand: command with arguments", () => {
  assertEquals(parseCommand("/standup deploys and incidents", KNOWN), {
    name: "standup",
    args: "deploys and incidents",
  });
});

Deno.test("parseCommand: surrounding whitespace is tolerated", () => {
  assertEquals(parseCommand("  /help  ", KNOWN), { name: "help", args: "" });
});

Deno.test("parseCommand: multiline arguments survive", () => {
  assertEquals(parseCommand("/standup line one\nline two", KNOWN), {
    name: "standup",
    args: "line one\nline two",
  });
});

Deno.test("parseCommand: unknown command falls through to the model", () => {
  assertEquals(parseCommand("/shrug", KNOWN), undefined);
});

Deno.test("parseCommand: a pasted file path is not a command", () => {
  assertEquals(parseCommand("/usr/bin/env deno", KNOWN), undefined);
});

Deno.test("parseCommand: prefix of a known name does not match", () => {
  assertEquals(parseCommand("/statusreport", KNOWN), undefined);
});

Deno.test("parseCommand: names are case-sensitive", () => {
  assertEquals(parseCommand("/Status", KNOWN), undefined);
});

Deno.test("parseCommand: plain text falls through", () => {
  assertEquals(parseCommand("what is your status?", KNOWN), undefined);
});

Deno.test("parseCommand: a slash mid-message is not a command", () => {
  assertEquals(parseCommand("try /status maybe", KNOWN), undefined);
});

Deno.test("substituteArgs: replaces every $ARGS occurrence", () => {
  assertEquals(
    substituteArgs("Focus: $ARGS. Again: $ARGS", "deploys"),
    "Focus: deploys. Again: deploys",
  );
});

Deno.test("substituteArgs: empty args leave a clean template", () => {
  assertEquals(substituteArgs("Summarize $ARGS", ""), "Summarize ");
});

Deno.test("commandSpecs: built-ins first, then configured commands", () => {
  const specs = commandSpecs([
    { name: "standup", description: "Summarize the day", prompt: "..." },
  ]);
  assertEquals(specs.map((s) => s.name), [
    "help",
    "status",
    "reset",
    "compact",
    "new",
    "stop",
    "standup",
  ]);
});

Deno.test("helpText: one line per command", () => {
  const lines = helpText(BUILTIN_COMMANDS).split("\n");
  assertEquals(lines.length, BUILTIN_COMMANDS.length);
  assertEquals(lines[0].startsWith("/help — "), true);
});
