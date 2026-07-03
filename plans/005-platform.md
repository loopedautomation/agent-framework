# Plan 5 — Platform & Business

Context: Looped AF is built by **Looped** ([looped.sh](https://looped.sh)), an existing back-office automation SaaS (Track, Invoices, Chat, Routines). The framework's **first commercial consumer is Looped itself**:

- **Looped Chat → a Looped AF agent.** The product's chat interface becomes an agent behind a `chat` trigger (the app frontend consuming the agent's HTTP/SSE surface), with custom tools/skills against Looped's internal API. This pulls per-app-user sessions and surface auth forward from "platform tier" to a real near-term requirement — it needs its own plan when scheduled.
- **Routines → cron-triggered agents.** The product's scheduled automations are already the framework's shape; migrating them is dogfooding, not rework.

Production dogfooding in a paying-user SaaS is stronger validation than any demo agent, and it precedes agency work in the arc below.

The framework (Plans 0–3) is step one of the larger arc:

**OSS framework → dogfood in Looped's product → hosted platform → service business.**

Each step funds and feeds the next: the framework builds credibility and an agent portfolio; the platform turns deployment into recurring revenue; the service business sells *outcomes* to companies that will never touch YAML. This plan sketches steps two and three plus the "agent hub" question. Nothing here blocks framework v1 — but framework decisions made now (permissions, audit, server surface, licensing) are what make these steps possible later.

## The hosted platform ("Looped Cloud", working name)

**What it is:** push an `agent.yaml` (or connect a repo), we run the container, the triggers, the secrets, and the observability. The self-hosted and hosted experience use the *same* artifact — an agent developed on a laptop deploys to the platform unchanged.

**Market-validated shape** (see Plan 4 research): Mastra is the cleanest template — Apache-2.0 framework → hosted platform GA 18 months later at $250/mo/team; Vercel's model is "framework free, meter the primitives"; n8n proves per-execution pricing feels fair to automation buyers, per-task credits (Zapier/Lindy) feel punishing.

### Offering, in tiers

1. **Free / self-host** — the framework, forever. Also the funnel.
2. **Hosted agents** — per-agent-per-month base (the "headcount" metaphor: an agent is cheap staff) + metered executions/tokens at cost or thin margin. Includes: managed triggers (we hold the Discord gateway connection, the webhook endpoints, the cron scheduler), secrets vault, memory persistence, log/run retention, uptime.
3. **Team/business tier** — RBAC, SSO, audit export, VPC/on-prem deploy of the platform, policy layer (org-wide permission ceilings that agent configs cannot exceed — the managed-settings pattern from Claude Code).

### What the framework must have for the platform to be buildable (design-now items)

- **Server-first agent runtime** (already in Plan 1): every agent container exposes health, sessions, runs, and an SSE event stream. The platform is *a consumer of the same API* any self-hoster gets.
- **Audit trail in SQLite** per agent (already in Plan 1): runs, tool calls, permission denials, token cost. The platform aggregates these; the client-facing dashboard is a view over them.
- **Sandboxing tiers**: Docker isolation is sufficient single-tenant; the platform running strangers' agents needs gVisor/Firecracker-class isolation. Design the runtime so the container boundary is assumed, never the host.
- **Permissive license** (Apache-2.0): required for the ecosystem, and it means competitors *can* host Looped agents — our platform wins on being first-party, not on legal lockout. (n8n chose the opposite; it caps their ecosystem.)

## The service business ("Looped Agency", working name)

**The offer:** we build, deploy, and operate fit-for-purpose agents for your business processes. Fixed build fee per agent + monthly operation fee (hosting, monitoring, model costs, iteration). CrewAI's enterprise motion (platform + bundled dev-hours in one SKU) validates merging platform and services into one contract.

**Why the framework makes the agency viable:** margin. If an agent takes days instead of weeks to build (config over code), and runs on cheap models (Plan 0 principle), and operates itself (permissions + budgets + observability instead of babysitting), then each client agent is high-margin recurring revenue. The framework is the agency's cost structure.

**Sequencing:** the agency can start before the platform exists — early client agents run on plain Docker hosts using the OSS framework, exactly like the Mac mini MVP. The platform emerges from automating what the agency does by hand (deploy, monitor, rotate secrets, report). This is the natural order: **framework → agency (revenue now, learnings) → platform (productize the agency's ops)**.

**Client-trust requirements** (why Plan 0 principle 6 exists): a client conversation survives exactly these questions — What can the agent touch? (permission config, human-readable) Where do our credentials live? (secret references, external vault later, never in context) What did it do last month? (audit trail) What does it cost? (per-run token/cost metering).

## The agent hub — open question, current thinking

The hub is **a control plane, never a runtime dependency.** Agents must be fully functional without it — otherwise we've rebuilt the OpenClaw monolithic gateway we're explicitly reacting against.

If built, the hub is a UI over APIs the agents already expose (Plan 1's server surface): see the fleet, start/stop agents, tail runs and sessions, edit configs, view costs, manage secrets. Same artifact three ways:

- **Local dev**: `af dev` already gives a single-agent view; the hub is the multi-agent version.
- **Desktop app**: plausibly a Deno-native webview app later — nice for the Mac-mini operator persona, but a browser pointed at a local port delivers 90% of it sooner.
- **Hosted**: the platform dashboard *is* the hub, hosted.

**Decision for now:** build the agent HTTP/SSE surface into the framework (needed regardless), defer the hub UI until there's a fleet worth managing (post-M5), and let the first hub be a web UI — desktop packaging is a later decision. Orchestration between agents (hub as scheduler/router) stays out of scope until multi-agent (Plan 1) is designed.

## Open questions

- Platform build trigger: after the agency has N manually-operated client agents? After M5?
- Pricing anchor for hosted agents: per-agent/month "headcount" vs per-execution — pilot both with agency clients.
- Multi-tenancy isolation choice when the time comes: Firecracker (microVM, Vercel/AWS-style) vs gVisor (syscall filter) vs dedicated hosts per client.
- Does the agency operate under the Looped brand or separately?
- Hub: web-first confirmed, but is the desktop app ever worth it beyond the founder's own workflow?
