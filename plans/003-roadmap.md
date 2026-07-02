# Plan 3 — Roadmap

Milestones from zero to a deployed MVP and just beyond. Each milestone ends with something demo-able — no milestone is "done" on internals alone.

## M0 — Plans approved *(this milestone)*

Plans 0–3 written, reviewed, committed. The vision, architecture, and MVP are agreed.

**Exit:** these docs are on `main`.

## M1 — Core loop, runnable locally

The inner loop works end to end: config loader (YAML → validated agent definition), provider adapter (Anthropic + OpenAI-compatible), agent loop with tool-call handling, one trivial built-in tool to prove the cycle.

**Exit demo:** `deno run` an `agent.yaml` from the terminal, type a prompt, watch the agent call a tool and answer.

## M2 — Triggers, native tools, permissions v0

The outer loop exists: trigger interface with **webhook** and **cron** implementations (Discord comes with MCP in M3 to keep this milestone small). Native tools `run_bash` and `http_request`. Permission config (net/command/filesystem/tool allowlists) enforced at the framework layer and compiled to Deno flags.

**Exit demo:** an agent triggered by `curl` runs a permitted shell command, and a config-denied host/command fails cleanly with the denial surfaced to the model.

## M3 — MCP + Discord trigger

MCP client: declare servers in config, their tools appear in the agent's toolset. Discord gateway trigger with channel filtering and in-thread replies. Thread-scoped memory in SQLite.

**Exit demo:** a locally-run agent reads a Discord message and answers using a tool from an MCP server.

## M4 — MVP agent, deployed

The `looped/agent` Docker image, secrets from env, memory volume. The issue-bot from Plan 2 running 24/7 on the Mac mini serving the real team.

**Exit demo:** teammate posts in `#issues`, gets an issue link back. The whole agent is one YAML file and one `docker run`. **This is the v1 success criterion from Plan 0.**

## M5 — Generalize and polish

Prove the framework isn't a one-bot wonder: build a **second, different agent** (e.g. cron-triggered report generator, or webhook-driven deploy notifier) with no framework changes — only config. CLI (`looped init/dev/run`), structured run logs, README/docs good enough for an outsider.

**Exit demo:** second agent live; a newcomer follows the docs to a running agent in under ~30 minutes.

## Later (unscheduled, needs its own plan when ready)

- Multi-agent composition (`agent_call`) — Plan 4 candidate
- Observability/audit for client deployments (traces, run history UI)
- Programmatic `defineAgent()` config
- Fleet management (compose templates, hosted platform?)
- More triggers: Slack, email, queues
- Context compaction for long-lived threads

## Open questions

- Sequence M2 vs M3: if the MVP itch gets strong, Discord+MCP could jump ahead of webhook/cron. Default is as written (permissions early, per Plan 0 principle 6).
- Does the second M5 agent target a real internal need (preferred) or a demo?
