# Plan 4 — Landscape & Positioning

Research date: July 2026. Four research sweeps: the frameworks I used and disliked (OpenClaw, Hermes), the best-engineered agent runtimes in existence (Claude Code, OpenCode, Codex CLI), the current framework landscape (eve, Flue, Mastra, Docker Agent, n8n, durable-execution platforms), and the Open Agent Spec.

## The gap

**"Config-driven + Docker-native + event-triggered" is an unoccupied intersection.** Every pair exists; the triple does not:

- **Docker Agent** (Docker's own `cagent`): pure-YAML agents, distributed as OCI artifacts — but **zero triggers**. Strictly request/response. Closest structural competitor, made by Docker themselves.
- **Vercel eve** (launched June 2026, "Next.js for agents"): channels for Discord/Slack/GitHub, cron schedules, `instructions.md` agents — closest competitor **in spirit**, but the substrate is Vercel's cloud (Workflows, Sandbox, Cron Jobs), and the definition is a TypeScript-plus-markdown directory, not a portable config file.
- **Inngest / Trigger.dev / Temporal / Hatchet**: triggers-first, durable — but code-first. No declarative agent definition.
- **n8n / Dify**: triggers + self-hosting for the business-automation market — but visual-canvas-first, and n8n's fair-code license forbids building a platform business on it.
- **Flue** (Fred Schott / Astro team, now Cloudflare): "Claude Code but 100% headless" — code-first TS harness, no config-driven story, no hosted offering.
- **Mastra / LangGraph / CrewAI / OpenAI & Claude Agent SDKs**: libraries you embed in your own app. You bring the service, the trigger, and the deployment.

**Stated precisely: nobody ships "the trigger lives in the agent's config file, and `docker compose up` is the whole deployment story."** That's Looped AF.

> **An agent is a YAML file. `docker compose up` and it's listening.**

Longer form, against the named competitors: *Looped AF is for the agents n8n is too clumsy for and eve is too Vercel for — single-purpose, event-triggered agents (Discord message in, GitHub issue out) defined in one config file, running as a container on your infrastructure. No canvas, no proprietary cloud, no orchestration framework to learn.*

## Comparison

| | Definition | Execution model | Triggers in config | Provider-agnostic | Permissions | Deployment | Target |
|---|---|---|---|---|---|---|---|
| **Looped AF** | One YAML file | Long-running container service | **Yes — discord/webhook/cron** | Yes (thin adapter) | Declarative deny-by-default, 3-layer enforcement | `docker run`, anywhere | Developers → businesses |
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

- **Docker** could add `triggers:` to Docker Agent any release (they ship weekly). 
- **eve** has Vercel's distribution and is two weeks old.
- Consequence: the durable moat is not the YAML format — it's the **opinionated trigger→agent→action product surface**, the permission story businesses can trust, and the platform/service layer. Ship the trigger-in-config primitive fast; it's the one piece with no incumbent.

## Open questions

- Exact license choice (Apache-2.0 vs MIT) — Apache-2.0 gives patent protection, fits the ecosystem norm (eve, Flue, Mastra, Docker Agent are all Apache-2.0).
- Do we consume models.dev directly or vendor a snapshot?
- When Docker Agent inevitably adds triggers, what's our second differentiator? (Current answer: permissions + platform + minimalism-for-cheap-models.)
