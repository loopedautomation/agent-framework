import { assertEquals } from "@std/assert";
import { completions, LOCAL_COMMANDS, parseSlash, replCommands } from "./commands.ts";

const COMMANDS = replCommands([
  {
    name: "standup",
    description: "Summarize the last day of activity",
    prompt: "Summarize the last 24 hours. Focus: $ARGS",
  },
]);

Deno.test("replCommands: agent commands first, then the REPL's own", () => {
  assertEquals(
    COMMANDS.map((c) => c.name),
    ["help", "status", "reset", "compact", "new", "standup", "clear", "exit"],
  );
  assertEquals(LOCAL_COMMANDS.map((c) => c.name), ["clear", "exit"]);
});

Deno.test("replCommands: built-ins get the dropdown's terse wording", () => {
  assertEquals(
    COMMANDS.map((c) => c.description),
    [
      "List commands and keys",
      "Agent, model and session facts",
      "Clear this conversation's history",
      "Shrink history into a summary",
      "Start a fresh conversation",
      "Summarize the last day of activity",
      "Clear the screen",
      "Leave the REPL",
    ],
  );
});

Deno.test("completions: prefix-filtered, exact match included, args close it", () => {
  assertEquals(completions("/", COMMANDS).length, COMMANDS.length);
  assertEquals(completions("/re", COMMANDS).map((c) => c.name), ["reset"]);
  assertEquals(completions("/st", COMMANDS).map((c) => c.name), ["status", "standup"]);
  assertEquals(completions("/help", COMMANDS).map((c) => c.name), ["help"]);
  assertEquals(completions("/HE", COMMANDS).map((c) => c.name), ["help"]); // case-insensitive
  assertEquals(completions("/help ", COMMANDS), []); // arguments began
  assertEquals(completions("/nope", COMMANDS), []);
});

Deno.test("completions: non-slash lines never open the dropdown", () => {
  assertEquals(completions("", COMMANDS), []);
  assertEquals(completions("hello", COMMANDS), []);
  assertEquals(completions("a /path/like this", COMMANDS), []);
});

Deno.test("parseSlash: strict slash lines only, args captured", () => {
  assertEquals(parseSlash("/help"), { name: "help", args: "" });
  assertEquals(parseSlash("/standup deploys and CI"), {
    name: "standup",
    args: "deploys and CI",
  });
  assertEquals(parseSlash("  /reset  "), { name: "reset", args: "" });
  assertEquals(parseSlash("/HELP"), { name: "help", args: "" });
});

Deno.test("parseSlash: everything else falls through to the model", () => {
  assertEquals(parseSlash("hello"), null);
  assertEquals(parseSlash("look at /etc/hosts"), null);
  assertEquals(parseSlash("/"), null);
});
