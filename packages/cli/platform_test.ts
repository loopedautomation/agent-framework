import { assertEquals } from "@std/assert";
import { matchAgent, parseGithubRemote } from "./platform.ts";

Deno.test("parseGithubRemote handles https and ssh remotes", () => {
  assertEquals(
    parseGithubRemote("https://github.com/looped/agent-framework.git"),
    "looped/agent-framework",
  );
  assertEquals(
    parseGithubRemote("git@github.com:looped/agent-framework.git"),
    "looped/agent-framework",
  );
  assertEquals(
    parseGithubRemote("https://github.com/looped/agent-framework"),
    "looped/agent-framework",
  );
  assertEquals(parseGithubRemote("https://gitlab.com/x/y.git"), undefined);
});

const agents = [
  {
    id: "a1",
    handle: "release-bot",
    sourceType: "github" as const,
    repoFullName: "looped/tools",
    repoBranch: "main",
  },
  {
    id: "a2",
    handle: "docs-bot",
    sourceType: "github" as const,
    repoFullName: "looped/tools",
    repoBranch: "docs",
  },
  {
    id: "a3",
    handle: "manual-bot",
    sourceType: "manual" as const,
    repoFullName: null,
    repoBranch: null,
  },
];

const repo = (branch: string | undefined, fullName = "looped/tools") => ({
  fullName,
  branch,
  dirty: false,
  unpushed: false,
});

Deno.test("matchAgent: repo+branch is the strongest signal", () => {
  assertEquals(matchAgent(agents, repo("docs"), undefined).agent?.id, "a2");
  assertEquals(matchAgent(agents, repo("main"), undefined).agent?.id, "a1");
});

Deno.test("matchAgent: handle breaks ties when branch doesn't", () => {
  const twoOnMain = [agents[0], { ...agents[1], id: "a4", repoBranch: "main" }];
  assertEquals(
    matchAgent(twoOnMain, repo("main"), "docs-bot").agent?.id,
    "a4",
  );
  const ambiguous = matchAgent(twoOnMain, repo("main"), undefined);
  assertEquals(ambiguous.agent, undefined);
  assertEquals(ambiguous.reason?.includes("--agent"), true);
});

Deno.test("matchAgent: single repo match wins regardless of branch", () => {
  assertEquals(
    matchAgent([agents[0], agents[2]], repo("feature/x"), undefined).agent?.id,
    "a1",
  );
});

Deno.test("matchAgent: falls back to handle outside a matching repo", () => {
  // An explicit handle wins even when the checkout's repo doesn't match —
  // that's the --agent escape hatch.
  assertEquals(
    matchAgent(agents, repo("main", "other/repo"), "docs-bot").agent?.id,
    "a2",
  );
  assertEquals(
    matchAgent(agents, undefined, "docs-bot").agent?.id,
    "a2",
  );
});

Deno.test("matchAgent: manual agents are never matched", () => {
  const result = matchAgent([agents[2]], undefined, "manual-bot");
  assertEquals(result.agent, undefined);
});
