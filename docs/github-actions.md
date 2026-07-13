---
title: "GitHub Actions"
description: "Run an agent one-shot in CI: the action pipes a prompt into af run and hands the reply back as a step output."
---

Some jobs don't want a long-lived agent — they want one run: a workflow asks the agent a question, the agent does its job, the reply feeds the next step and everything is gone when the job ends. The `loopedautomation/agent-framework` action does exactly that, and nothing else.

```yaml
jobs:
  triage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: loopedautomation/agent-framework@v0.8.0
        id: agent
        with:
          agent: ./triage/agent.yaml
          prompt: "Triage issue #${{ github.event.issue.number }}: ${{ github.event.issue.title }}"
          secrets: |
            OPENAI_API_KEY=${{ secrets.OPENAI_API_KEY }}
      - run: echo "${{ steps.agent.outputs.reply }}"
```

The agent runs in Docker on the runner, exactly as it runs everywhere else: the action installs the [`af` CLI](cli.md), and `af run` starts the published container with the config mounted and the sandbox intact. What makes the run one-shot is piped stdin — the prompt goes in as a single line, the agent handles it, and the process exits on end-of-input. No trigger, no service, no state left behind beyond the job's own filesystem.

## Inputs

| Input | Default | |
| --- | --- | --- |
| `agent` | `agent.yaml` | Path to the agent file, relative to the workspace. It must have no `triggers:` — a trigger makes the agent a service, and a CI step has to end. |
| `prompt` | — | What to ask the agent. One run, one reply; newlines collapse to spaces. |
| `secrets` | — | `KEY=VALUE` lines for the container's env file. |
| `env-file` | — | An existing env file to use; `secrets` lines are appended to it. |
| `af-version` | `latest` | The [`@looped/af`](https://jsr.io/@looped/af) version to install. |
| `image` | the CLI's pinned image | Container image override, passed through as `af run --image`. |

## Outputs

| Output | |
| --- | --- |
| `reply` | The agent's reply. |
| `status` | How the run ended: `ok`, `error_max_steps` or `error_provider`. The step fails on anything but `ok`, so you only read this when you've set `continue-on-error`. |

The reply also lands in the job's step summary, so a human reading the workflow run sees what the agent said without digging through the transcript.

## Secrets

The container never sees the runner's environment — it gets [an env file and nothing else](secrets.md), same as every other deployment. The `secrets` input is that file: put the provider API key and every other env ref the agent file declares in it, one `KEY=VALUE` line each, with the values coming from the workflow's `secrets` context so GitHub masks them in logs.

```yaml
secrets: |
  ANTHROPIC_API_KEY=${{ secrets.ANTHROPIC_API_KEY }}
  GITHUB_TOKEN=${{ secrets.GITHUB_TOKEN }}
```

Setting `env:` on the step does nothing for the agent — that's deliberate. An env file you wrote is a list you can read; the runner's environment is not.

## Stateless by design

Every run on a fresh runner is a fresh agent: first boot, new name, empty [memory](memory.md). That's the point — a CI agent's context should come from its prompt and its skills, not from what a previous job happened to leave in a volume. If your agent needs durable memory across runs, it wants to be a service (`af up` on a machine you keep), not a workflow step.

## Requirements and notes

- **A Linux runner with Docker** — `ubuntu-latest` has it. macOS runners don't ship Docker.
- **Pin the action to a release tag** — the current release, `@v0.8.0` for example — the same way you'd pin any action. The framework's releases and the action share one repo, so one tag names both.
- **Budgets still apply**: the run is bounded by the agent's step cap, so a confused agent costs a known amount, not a job timeout.
- **[Test cases](testing.md) belong in CI too.** `af test` isn't part of this action — it runs on the host, not in Docker — but it's one install away in a sibling step, and its exit code already speaks CI.
