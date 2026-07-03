# Plan 4 — Landscape & Positioning

Research date: July 2026. Four research sweeps: the frameworks I used and disliked (OpenClaw, Hermes), the best-engineered agent runtimes in existence (Claude Code, OpenCode, Codex CLI), the current framework landscape (eve, Flue, Mastra, Docker Agent, n8n, durable-execution platforms), and the Open Agent Spec.

## Positioning

**The position is a philosophy, not a feature set: fit-for-purpose agents for business process automation.** Everyone else in the market sells *generality* — a toolkit, canvas, or platform for building *anything*. Looped sells *narrowness*: one business process, one agent, automated end to end. That's the claim competitors can't fast-follow, because their positioning, economics, and existing users all demand breadth. Docker Agent can add a `triggers:` key next week; it cannot become "the framework for hiring a digital specialist" without abandoning what it is. A feature gap closes in a release; a contrary philosophy requires a different product.

Everything distinctive about Looped **derives from** the fit-for-purpose stance rather than sitting beside it:

- **Minimalism** — a one-job agent needs three tools, not sixty; general frameworks *structurally can't* ship lean because every user needs a different sixty.
- **Cheap-model economics** — narrow scope is what makes mini models reliable; frameworks built for open-ended agents are priced (in tokens and trust) for frontier models.
- **Permissions without prompts** — you can write a tight, auditable allowlist for one process; nobody can for "anything the user might ask."
- **Config over code** — one job fits in one file; general-purpose behavior doesn’t.
- **The domain: business processes** — not coding (Claude Code/Flue's turf), not personal assistance (OpenClaw/Hermes's turf), not chat products. The repetitive, well-scoped work teams do by hand — the n8n job market, served with an agent instead of a canvas.

The market map, read this way:

- **General-purpose assistants** (OpenClaw, Hermes): the opposite philosophy — one agent, every job. Their bloat and security record are the cautionary tale, and the source of our origin story.
- **Build-anything toolkits** (Mastra, LangGraph, CrewAI, OpenAI/Claude SDKs, Flue): libraries for developers writing agent *applications*. Fine products; different job. You bring the service, trigger, deployment, and opinion.
- **Vercel eve**: closest in spirit (single-purpose backend agents, channels, cron) — but positioned as infrastructure gravity for Vercel's cloud, and still developer-app-shaped (TS + markdown directories). Their thesis is "agents belong on our platform"; ours is "agents are containers you own."
- **Docker Agent**: closest in format (pure YAML) — but a *runtime/packaging* play with no automation thesis, no triggers, no permission story.
- **n8n / Dify / Zapier Agents / Lindy**: the same *buyer problem* (automate the process), a different *product theory* — visual workflows with AI nodes bolted in, vs. an agent given a job, tools, and boundaries. When the process is fuzzy ("read this message, create a sensible issue"), a canvas of boxes is the wrong abstraction and a scoped agent is the right one.

Supporting evidence, not the moat: the feature intersection (config-driven + Docker-native + trigger-in-config) also happens to be unoccupied today. Useful for launch messaging; never the load-bearing argument.

**Positioning statement:** *Looped AF is the framework for fit-for-purpose agents — hire an agent for one job. Describe the job in a single file, give it exactly the tools and permissions the job needs, and run it as a container on your own infrastructure. It automates business processes the way you'd staff them: one specialist at a time.*

> **One job. One file. `docker compose up` and it's hired.**

## Comparison

| | Definition | Execution model | Triggers in config | Provider-agnostic | Permissions | Deployment | Target |
|---|---|---|---|---|---|---|---|
| **Looped AF** | One file (YAML today) | Long-running container service | **Yes — discord/webhook/cron** | Yes (thin adapter) | Declarative deny-by-default, 3-layer enforcement | `docker run`, anywhere | Developers → businesses |
| Vercel eve | TS + markdown directory | Durable workflows on Vercel | Yes (channels + schedules) | Yes (AI Gateway) | HITL approvals | Vercel primitives | Devs on Vercel |
| Docker Agent | YAML, OCI artifacts | Request/response CLI/API | **No** | Yes | Toolset scoping | Docker Desktop | Developers |
| Flue | TS code + md skills | Harness library, self-host | Partial (channels, webhooks) | Yes | Sandbox-first | Node/CF/Docker/etc. | TS devs |
| Mastra | TS code | Library or Hono server + platform | Cron native, webhooks DIY | Yes (3,000+ models) | HITL suspend/resume | Deployers + Mastra Platform ($250/mo) | TS startups → enterprise |
| Claude Agent SDK | Code + fs config | In-process library | No | No (Claude only) | **Deepest in market** (rules/modes/hooks) | BYO | Agent developers |
| OpenCode | JSON config + md agents | Client/server, local | No | Yes (75+ via models.dev + AI SDK) | Category rules, last-match | BYO | Developers |
| n8n | Visual canvas (JSON) | Long-running server | **Best-in-class** | Yes | Platform RBAC only | Docker / cloud | Ops teams |
| Inngest/Trigger.dev | TS/Py code | Durable functions | **Yes** | BYO SDK | None agent-specific | Open-core cloud | Backend devs |

## Target market

1. **Developers first.** The OSS framework. People like me: comfortable with Docker and YAML, allergic to canvases and proprietary clouds, wanting the third build of a simple bot to take 30 minutes. Truly open license (Apache-2.0/MIT) — this matters strategically: n8n's fair-code and Mastra's `ee/` split are known irritants, and a permissive license is what lets *other* agencies build on Looped, which feeds the ecosystem and the eventual platform.
2. **Businesses after.** Via the hosted platform and the service business (Plan 5). The business buyer never sees YAML — they see an automated process and a monthly invoice. The developer-first phase builds the credibility, the tooling, and the agent portfolio that the business phase sells.

## What the research settled (lessons adopted into Plans 0–2)

**From OpenClaw/Hermes (what we're escaping):** both are general-purpose personal assistants you prompt-steer into single-purpose jobs — a monolithic gateway daemon, config across 3–4 formats, unsandboxed-by-default host execution (OpenClaw's 2026 security crisis: 512 audit findings, Microsoft advising against running it on corporate machines), skills marketplaces shipping malicious code, single-user identity assumptions. What they got right and we copy: one-command onboarding, markdown memory files, provider switching with zero code changes, cron + bearer-auth webhook triggers, scale-to-zero framing.

**From Claude Code/OpenCode/Codex (settled engineering to adopt):**
- **One flat loop per agent** — single message history, `while(tool_calls)`, deterministic harness around a thin model core. No graphs inside an agent; compose at the process level.
- **Permission grammar**: `Tool(specifier)` rules (`bash(gh *)`, `net(api.github.com)`), evaluated **deny → ask → allow, first match wins, no specificity magic**. Publish a JSON Schema for the config.
- **`ask` is impossible at runtime.** Claude Code's headless mode auto-denies; OpenCode's `ask` literally hangs the server. For unattended agents every undecided action resolves to **deny, a declared fallback, or a delegated decision event** (escalation-as-event: webhook a human/policy service, deny on timeout). This is a Looped config-validation rule, not a runtime state.
- **Enforce with sandboxes, not prompts** — Anthropic's own telemetry: 93% of permission prompts rubber-stamped; sandboxing cut prompts 84%. Codex's defaults are the benchmark: workspace-scoped writes, network off by default, explicit egress allowlist.
- **Server-first architecture** (OpenCode): the agent runtime exposes an HTTP surface (health, sessions, events via SSE) with an OpenAPI spec; CLI and any UI are thin clients. Bind loopback by default, auth token even locally (OpenCode shipped an unauthenticated-local-RCE; we won't).
- **Provider abstraction, three layers** (OpenCode's proven blueprint): model-metadata registry (consume **models.dev**, don't rebuild it) → thin per-provider adapters behind one streaming interface → config-level overrides (baseURL/apiKey/custom models) so any OpenAI-compatible endpoint is just config. Add **model roles** (big/small routing — >50% of Claude Code's calls go to a cheap model) and per-agent fallback chains.
- **Compaction from day one** for long-lived agents: prune old tool outputs first, then summarize; token headroom reserve; anti-thrash cutoff.
- **Typed error taxonomy + budgets**: `max_steps`, `max_cost` per run as first-class config — the dead-man's switch for unattended operation.
- **MCP hygiene**: config-declared, namespaced (`mcp__server__tool`) so permission rules cover them uniformly, deferred schema loading, output token caps, tool filtering (`include:`) so a fat server can't blow a small model's context.
- The provider-politics saga (Anthropic legally forcing OpenCode to strip its integration; Google sunsetting Gemini CLI under users' feet) is the standing argument for our provider-agnosticism.

## Open Agent Spec — position

Philosophically aligned (declarative YAML, native/mcp/custom tools, sandbox allowlists nearly isomorphic to our permissions), but tiny adoption and a stateless task-executor model that doesn't cover triggers, memory, or deployment. **Decision: no compliance commitment.** We keep config sovereignty, steal the good ideas (typed task I/O for testability, typed sandbox-violation errors), and revisit if the spec gains real traction.

## Threat watch

- **Docker** could add `triggers:` to Docker Agent any release (they ship weekly); **eve** has Vercel's distribution. Feature gaps close — that's exactly why the positioning is the philosophy, not the checklist.
- What features can't buy them: the fit-for-purpose opinion baked into every default (minimal base image, cheap-model design targets, per-process permission ceilings, one-file agents), a portfolio of proven process agents, and the platform/agency layer that sells outcomes rather than tooling.
- The real risk is not a competitor adding a feature but a competitor adopting the *category*. Move fast on owning the language ("fit-for-purpose agents", process agents as hires) and on shipping reference agents that make the philosophy tangible.

## Open questions

- ~~Exact license choice~~ — settled: Apache-2.0 (ecosystem norm, patent grant; copyright Looped Automation).
- Do we consume models.dev directly or vendor a snapshot?
- Category language: "fit-for-purpose agents"? "process agents"? Worth settling before the manifesto gets wide distribution — owning a term is part of the positioning.
