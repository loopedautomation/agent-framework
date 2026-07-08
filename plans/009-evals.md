# Plan 9 — The eval harness

The framework bets on cheap models (Plan 0, principle 9): a well-scoped agent on a mini model, made reliable by a narrow job, a small toolset and lean context. That bet gets placed again every time someone edits a purpose line, swaps the model or rewrites a skill, and today the only way to know it still pays off is to poke the agent by hand. `af test` is the check: a set of cases next to the agent file that say what the agent is supposed to do, runnable in CI, cheap enough to run on every change.

Status: design; implementation has not started. Plan 1 named it ("typed task I/O + `af test`") and the roadmap carries it on the later list.

## A test is cases in YAML, beside the agent

`af test` discovers `agent.test.yaml` next to the agent file (or `tests/*.yaml` when there are many). A case gives an input, the canned tool results the run should see, and checks against the outcome:

```yaml
cases:
  - name: creates an issue from a bug report
    input: "the export button 500s when the report has no rows"
    mocks:
      run_bash: "https://github.com/loopedautomation/looped/issues/42"
    checks:
      - status: ok
      - tool_called: run_bash
      - reply_contains: "issues/42"
      - judge: "the reply is short and hands the reader the issue link"

  - name: ignores chatter
    input: "lunch anyone?"
    checks:
      - tool_not_called: run_bash
```

## The model is real and the tools are mocked

The point of a case is to verify that the model, the purpose, the skills and the toolset produce the right behaviour together, so the provider call is a real call to the configured model. The tools are where the side effects live, and CI must never open a GitHub issue, so tool execution is intercepted: a call to a mocked tool returns the canned result, and a call to a tool with no mock fails the case. That strictness is deliberate, since a surprise tool call is exactly the kind of behaviour a test should surface, and the cost is honest too: when you teach the agent a new step, you update the mocks. A `--live` flag runs the real tools for local smoke testing.

Runs execute in-process on the host, the way `af validate` already does, against an in-memory SQLite store so `/data` stays untouched. Each case goes through the real `runAgent` loop with the real system-prompt assembly; the only substitution is the tool execute functions.

## Checks come in two tiers

**Deterministic checks run first and are preferred.** `status`, `reply_contains`, `reply_matches` (regex), `tool_called` / `tool_not_called`, `max_steps_used`. They are free, they never flake on grading, and for most cases they are enough.

**The judge is for what a regex can't say.** `judge: "<claim>"` makes one call to `model.small` (the role that already exists for cheap internal calls) with the reply and the claim, boxed into a structured yes/no plus a reason. A judge is a model grading a model, so we keep it honest the same way the framework keeps agents honest: a narrow question, a schema-constrained answer and the token cost printed per case. Save judges for tone and substance; use `reply_contains` for facts.

## Nondeterminism is data

The default is one run per case, because the default posture is that a well-scoped agent on the right model passes consistently. `af test --runs 3` repeats every case and reports a pass rate instead of a verdict. A case that passes two times in three is telling you something real about the agent, usually that the job is under-specified or the model is under-sized, and the fix belongs in the agent file rather than in a retry loop.

## Where it fits in the product

- **CLI**: one more `case "test"` in `main.ts`, with the runner living in core (`packages/core/eval/`) so the platform can reuse it later. Exit code is non-zero on any failure; output is one line per case with steps, tokens and the failed checks.
- **CI**: a documented GitHub Actions snippet; the provider key is the only secret a test run needs.
- **The meta-agent (Plan 3, M5)**: an agent that builds agents needs a way to prove its output works. The meta-agent writes `agent.test.yaml` alongside `agent.yaml`, runs `af test`, and hands over an agent that arrives with evidence.

## Phasing

1. **Runner, deterministic checks, mocks.** Discovery, in-process execution, the strict unmocked-call rule, CI exit codes.
2. **The judge.** `model.small` grading with structured output, cost surfaced per case.
3. **Repetition and reporting.** `--runs`, pass rates, and whatever record-keeping the platform wants to aggregate.

## Open questions

- Seeding history: some behaviour only shows up mid-conversation. Does a case get a `history:` block, and in what shape?
- A record mode (`af test --record`?) that runs live once and writes the observed tool results back into `mocks:` would make authoring much faster; is the footgun (blessing whatever happened) acceptable?
- Argument-sensitive mocks: v1 keys mocks by tool name only. Is a per-arguments match (two different `run_bash` calls in one case) needed before anyone hits it?
- MCP tools mock by their full `mcp__server__tool` name, which implies connecting to the server for schemas or stubbing that too. Stub or connect?
- Should `af up` refuse to deploy an agent whose tests fail, or stay out of the way and leave that to CI?
