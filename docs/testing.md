---
title: "Testing"
description: "Write test cases in YAML beside the agent file and run them with af test. The model call is real; the tools are mocked."
---

An agent's behaviour comes from the combination of its purpose, its model, its skills and its toolset. Change any one of them and the behaviour can shift, and until now the only way to notice was to run the agent and poke at it by hand. `af test` gives you a set of cases that live next to the agent file, say what the agent is supposed to do and run cheaply enough to check on every change.

## Writing cases

`af test` looks for `agent.test.yaml` next to the agent file (or `tests/*.yaml` when you have many). A case gives an input, the canned tool results the run should see and checks against the outcome:

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

  - name: ignores chatter
    input: "lunch anyone?"
    checks:
      - tool_not_called: run_bash
```

Run it with:

```sh
af test agent.yaml
```

The output is one line per case with steps and token counts, then a summary. The exit code is non-zero when any case fails, so the same command works in CI; the provider API key is the only secret a test run needs.

## The model is real and the tools are mocked

Each case goes through the agent's real loop with the real system prompt assembly, and the provider call is a real call to the configured model. That's the point: a case verifies that the purpose, the model, the skills and the toolset produce the right behaviour together.

The tools are where the side effects live, and a test run must never open a GitHub issue. So tool execution is intercepted: a call to a mocked tool returns the canned result from `mocks:`, and a call to a tool with no mock fails the case. That strictness is deliberate, because a surprise tool call is exactly the kind of behaviour a test should catch. It also has an honest cost: when you teach the agent a new step, you update the mocks.

Framework tools with no external side effects (`current_time`, `read_skill` and the [memory](memory.md) tools) run for real, so you don't have to mock the plumbing. Runs write to an in-memory store, which means your agent's `/data` volume stays untouched.

## Checks

The available checks:

| Check | Passes when |
| --- | --- |
| `status: ok` | the run ended with that status (`ok`, `error_max_steps`, `error_provider`) |
| `reply_contains: "text"` | the final reply contains the text |
| `reply_matches: "regex"` | the final reply matches the regular expression (a JavaScript regex, compiled with no flags - write `[Ss]panish` rather than `(?i)spanish`) |
| `tool_called: name` | the run called that tool |
| `tool_not_called: name` | the run never called that tool |
| `max_steps_used: 3` | the run used at most that many steps |

These are deterministic on purpose: they cost nothing beyond the run itself and they never flake on grading. A model-graded check (`judge:`) is planned but hasn't been built yet, so for now write checks against facts in the reply.

## What a failing case is telling you

A test run makes one call per case by default, and the default expectation is that a well-scoped agent on the right model passes consistently. A case that only passes sometimes is usually telling you that the job is under-specified or the model is under-sized, and the fix belongs in the agent file. Tighten the purpose, add a skill or move up a model size; a retry loop would only hide the signal.

Mocks are keyed by tool name, so two different `run_bash` calls in one case get the same canned result. If a case needs the second call to see something different, that's a sign the case is covering two behaviours and wants to be two cases.
