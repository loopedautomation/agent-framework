// af test — run an agent's test cases (Plan 9). Executes in-process on the
// host the way `af validate` does: real model, mocked tools, in-memory store.

import {
  type CaseResult,
  type EvalCase,
  parseEvalFile,
  resolveAgentConfig,
  runEvalCases,
} from "@looped/core";
import { fail } from "./docker_commands.ts";
import { dim, err, ok } from "./style.ts";

/** Test files beside the agent: `<stem>.test.yaml`, plus anything in `tests/`. */
async function discoverTestFiles(agentPath: string): Promise<string[]> {
  const found: string[] = [];
  const stem = agentPath.replace(/\.ya?ml$/, "");
  for (const candidate of [`${stem}.test.yaml`, `${stem}.test.yml`]) {
    try {
      if ((await Deno.stat(candidate)).isFile) found.push(candidate);
    } catch {
      // not there
    }
  }
  const dir = agentPath.includes("/") ? agentPath.slice(0, agentPath.lastIndexOf("/")) : ".";
  try {
    for await (const entry of Deno.readDir(`${dir}/tests`)) {
      if (entry.isFile && /\.ya?ml$/.test(entry.name)) found.push(`${dir}/tests/${entry.name}`);
    }
  } catch {
    // no tests/ directory
  }
  return found.sort();
}

function caseLine(result: CaseResult): string {
  const mark = result.passed ? ok("✓") : err("✗");
  const stats = dim(
    `${result.steps} step${result.steps === 1 ? "" : "s"} · ` +
      `${result.usage.inputTokens}in/${result.usage.outputTokens}out tokens`,
  );
  const lines = [`${mark} ${result.name}  ${stats}`];
  for (const failure of result.failures) lines.push(`  ${err("↳")} ${failure}`);
  return lines.join("\n");
}

/** Run every discovered test case for the agent; exits non-zero on any failure. */
export async function test(path: string) {
  const config = await resolveAgentConfig(path);
  const files = await discoverTestFiles(path);
  if (!files.length) {
    fail(
      `no test files found for ${path} — expected ${
        path.replace(/\.ya?ml$/, ".test.yaml")
      } or tests/*.yaml beside it`,
    );
  }

  const cases: EvalCase[] = [];
  for (const file of files) {
    cases.push(...parseEvalFile(await Deno.readTextFile(file), file).cases);
  }
  const baseDir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
  console.log(
    dim(`${cases.length} case${cases.length === 1 ? "" : "s"} · model ${config.model.id}`),
  );

  const results = await runEvalCases(cases, { config, baseDir });
  for (const result of results) console.log(caseLine(result));

  const failed = results.filter((r) => !r.passed).length;
  const tokens = results.reduce(
    (t, r) => ({ in: t.in + r.usage.inputTokens, out: t.out + r.usage.outputTokens }),
    { in: 0, out: 0 },
  );
  const summary = `${results.length - failed} passed, ${failed} failed ` +
    `(${tokens.in}in/${tokens.out}out tokens)`;
  console.log(failed ? err(summary) : ok(summary));
  if (failed) Deno.exit(1);
}
