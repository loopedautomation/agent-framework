# Plan 3 — Roadmap

Milestones from zero to a deployed MVP and beyond. Each milestone ends with something demo-able — no milestone is "done" on internals alone. **Every milestone ships its documentation** (Plan 0, principle 10): a feature without docs doesn't exit its milestone.

## M0 — Manifesto *(first milestone)*

Publish the manifesto: the public, opinionated distillation of Plan 0 — why agents should be YAML files in containers, why single-purpose beats general-purpose, why cheap models + minimalism, why permissions without prompts. Lives as `MANIFESTO.md` in the repo root and frames the README; short enough to read in three minutes, sharp enough to be disagreed with.

Also in M0: plans 0–5 committed, monorepo skeleton laid out (Plan 1 repo structure), license finalized (leaning Apache-2.0).

**Exit:** the manifesto is public and the repo structure exists.

## M1 — Core loop, runnable locally

The inner loop works end to end in `packages/core`: config loader (YAML → validated agent definition, published JSON Schema), provider adapter (**OpenAI-compatible first**, Anthropic second; model roles, structured output), the flat tool-use loop with budgets/retries/typed errors, one trivial native tool to prove the cycle. Docs as plain, well-organized markdown in `docs/` (site generator deferred to ~M4 when there's an audience).

**Exit demo:** `deno run` an `agent.yaml` from the terminal, type a prompt, watch a gpt-5.4-mini-class model call a tool and answer. Token cost printed per run.

## M2 — Triggers, native tools, permissions v0

The outer loop exists: trigger interface with **webhook** and **cron** implementations. Natives `run_bash` and `http_request` with scoped environments. Permission engine: rule grammar, deny→ask→allow first-match evaluation, `ask` resolved at config-validation time, Deno flag compilation. SQLite persistence + audit trail v0.

**Exit demo:** an agent triggered by `curl` runs a permitted shell command; a config-denied host/command fails cleanly with the denial surfaced to the model and recorded in the audit log.

## M3 — Skills, MCP, Discord

Skills loader (markdown + progressive disclosure). MCP client (stdio + HTTP, namespacing, `include:` filtering, output caps). Discord gateway trigger with channel filtering and in-thread replies. Thread-scoped session memory.

**Exit demo:** a locally-run agent reads a Discord message and acts using a skill-taught CLI, on a mini model.

## M4 — MVP agent, deployed

The hardened `looped/agent` base image + custom-image story, secrets resolution (env + file), memory volume, agent HTTP/SSE surface. The issue-bot from Plan 2 (skill path) running 24/7 on the Mac mini serving the real team.

**Exit demo:** teammate posts in `#issues`, gets an issue link back seconds later. One YAML file, one custom image layer, one `docker run`. **The v1 success criterion from Plan 0.**

## M5 — The agent that builds agents

The meta-agent: a Looped agent whose job is creating Looped agents. Fed a description ("watch this RSS feed, post summaries to #news"), it writes the `agent.yaml`, the Dockerfile layer if needed, and a skill draft; validates the config against the schema; runs it in dev mode; hands back a ready-to-deploy agent directory (or a PR).

This is simultaneously: the second real agent (proving the framework generalizes beyond the issue-bot with zero framework changes), the ultimate test of the config format's expressiveness and the docs' machine-readability, and the seed of the service business's cost structure (Plan 5 — the agency's build step, automated).

**Exit demo:** describe an agent in one Discord message; receive a working agent directory that deploys with `docker run`.

## M6 — Generalize and polish

CLI polish (`af init/dev/run`), structured run traces, a third agent from the community or a real internal need, docs matured to the "newcomer in 30 minutes" bar, first-party skills library seeded (`skills/`).

**Exit demo:** an outsider follows the docs from zero to a running agent of their own design in under ~30 minutes.

## Later (unscheduled, needs its own plan when ready)

- **Looped Chat on Looped AF** — replace the chat agent in app.looped.sh with a Looped AF agent (`chat` trigger, per-user sessions, internal-API tools). The framework's first production dogfood in a paying-user SaaS; Plan 6 candidate (see Plan 5).
- Multi-agent composition (`agent_call`) and A2A trigger
- Agent hub / control plane UI (Plan 5 — post-fleet)
- Hosted platform (Plan 5 — after the agency validates the ops)
- Programmatic `defineAgent()` config
- External secret providers (Vault/SOPS/1Password)
- More triggers: Slack, email, queues
- Eval harness (`af test`) for cheap-model verification

## Open questions

- Manifesto distribution: repo-only, or also a post (blog/HN/X) at M0 — or hold the public push until M4 when there's something runnable?
- Does M5's meta-agent write skills too, or only configs, in its first iteration?
- Sequence check: if the MVP itch bites, M3's Discord work could pull ahead of M2's cron — default is as written (permissions early).
