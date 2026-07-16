---
title: "GitHub Actions"
description: "Run an agent one-shot in CI: the action pipes a prompt into af run and hands the reply back as a step output."
---

Sometimes a workflow needs an agent for a single question. Triage this issue, summarize this diff, decide whether this release needs a warning in the notes. Keeping a service running for that would be backwards: the job starts, the question gets asked once and everything should be gone when the job ends. The `loopedautomation/agent-framework` action gives you exactly that single run.

```yaml
jobs:
  triage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: loopedautomation/agent-framework@v0.9.0
        id: agent
        with:
          agent: ./triage/agent.yaml
          prompt: "Triage issue #${{ github.event.issue.number }}: ${{ github.event.issue.title }}"
          secrets: |
            OPENAI_API_KEY=${{ secrets.OPENAI_API_KEY }}
      - run: echo "${{ steps.agent.outputs.reply }}"
```

The agent runs in Docker on the runner, the same way it runs everywhere else. The action installs the [`af` CLI](cli.md), and `af run` starts the published container with the config mounted and the sandbox intact. What makes the run one-shot is piped stdin: the prompt goes in as one line, the agent handles it and the process exits when the input ends. Once the job finishes, the runner is discarded and the agent with it.

## Inputs

| Input | Default | |
| --- | --- | --- |
| `agent` | `agent.yaml` | Path to the agent file, relative to the workspace. The file can't declare `triggers:`; a trigger makes the agent a long-lived service, and a CI step has to end. |
| `prompt` | required | What to ask the agent. The run handles one line, so newlines in the prompt collapse to spaces. |
| `secrets` | none | `KEY=VALUE` lines for the container's env file. |
| `env-file` | none | An existing env file to use; lines from `secrets` are appended to it. |
| `af-version` | `latest` | The [`@looped/af`](https://jsr.io/@looped/af) version to install. |
| `image` | the CLI's pinned image | Container image override, passed through as `af run --image`. |

## Outputs

| Output | |
| --- | --- |
| `reply` | The agent's reply. |
| `status` | How the run ended: `ok`, `error_max_steps` or `error_provider`. The step fails on anything but `ok`, so you'll only read this output when you've set `continue-on-error`. |

The reply also lands in the job's step summary, so anyone reading the workflow run can see what the agent said without digging through the transcript.

## Secrets

The container gets its environment from [an env file](secrets.md), the same way every other deployment does, and the runner's own environment stays outside. The `secrets` input is that file: put the provider API key and every other env ref the agent file declares in it, one `KEY=VALUE` line each, and take the values from the workflow's `secrets` context so GitHub masks them in logs.

```yaml
secrets: |
  ANTHROPIC_API_KEY=${{ secrets.ANTHROPIC_API_KEY }}
  GITHUB_TOKEN=${{ secrets.GITHUB_TOKEN }}
```

Setting `env:` on the step does nothing for the agent, and that's deliberate. An env file you wrote yourself is a list you can read and audit, while the runner's environment carries whatever the job happened to accumulate.

## Every run is a fresh agent

On a fresh runner the agent boots for the first time, picks a new name and starts with empty [memory](memory.md). We think that's the right default for CI: a workflow step should get its context from the prompt and the skills you gave it, and whatever a previous job left in a volume shouldn't change what this run does. It does mean the action is the wrong shape for an agent that needs durable memory across runs; that agent wants to be a service, deployed with `af up` on a machine you keep.

## Requirements and notes

- **A Linux runner with Docker.** `ubuntu-latest` has it; macOS runners don't ship Docker.
- **Pin the action to a release tag**, the same way you'd pin any action; `@v0.9.0` is the current release at the time of writing. The framework's releases and the action share one repo, so one tag names both.
- **Budgets still apply.** The run is bounded by the agent's step cap, so you know roughly what a confused agent can cost before the job starts.
- **[Test cases](testing.md) belong in CI too.** `af test` runs on the host, so this action doesn't wrap it, but it's one install away in a sibling step and its exit code already works as a CI check.
