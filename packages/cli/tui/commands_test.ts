import { assertEquals } from "@std/assert";
import { COMMANDS, completions, parseSlash } from "./commands.ts";

Deno.test("completions: prefix-filtered, exact match included, args close it", () => {
  assertEquals(completions("/").length, COMMANDS.length);
  assertEquals(completions("/re").map((c) => c.name), ["reset"]);
  assertEquals(completions("/help").map((c) => c.name), ["help"]);
  assertEquals(completions("/HE").map((c) => c.name), ["help"]); // case-insensitive
  assertEquals(completions("/help "), []); // arguments began
  assertEquals(completions("/nope"), []);
});

Deno.test("completions: non-slash lines never open the dropdown", () => {
  assertEquals(completions(""), []);
  assertEquals(completions("hello"), []);
  assertEquals(completions("a /path/like this"), []);
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
