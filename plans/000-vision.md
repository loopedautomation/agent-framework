# Plan 0 — Vision

## Why

Spinning up a fit-for-purpose agent should take minutes, not hours.

I've now built the same simple agent twice — a Discord bot that turns team messages into GitHub issues — once with OpenClaw and once with Hermes. Both times it worked, and both times it took stupidly long and demanded deep technical wrangling for what is conceptually a one-paragraph idea: *listen here, do this one job, reply with a link.*

The gap isn't intelligence — models are plenty capable. The gap is that existing frameworks are **libraries for developers embedding agents inside apps**. What I keep needing is a **runtime for deploying agents as services**: describe the agent, run the container, done.

Looped AF is that runtime.

## What Looped AF is

A Docker-native, config-driven framework for building **single-purpose, event-driven agents that automate business processes**.

The "loop" in Looped: agents are long-running services. They sit in a loop waiting for events — a Discord message, a webhook, a cron tick — act on the event, deliver a result, and go idle. Not request/response scripts, not chatbots: workers.

## What it is not

- **Not a personal assistant.** No general-purpose "do anything" agent. Every agent has one job.
- **Not a chat UI product.** Agents live where the work already happens (Discord, Slack, webhooks), and reply there.
- **Not a prompt-chaining / DAG workflow library.** The model drives the loop; we don't hand-wire graphs of prompts.
- **Not a research playground.** Boring, deployable, operable software.

## Design principles

1. **One agent, one job.** Fit-for-purpose beats general-purpose. A narrow agent is easier to prompt, permission, test, and trust.
2. **Config over code.** An `agent.yaml` plus `docker run` is the whole deployment story. Code is the escape hatch, not the entry point.
3. **Docker-native.** The container is the unit of deployment, isolation, and scaling. If it doesn't run cleanly in a container, it doesn't ship.
4. **Fire-and-forget UX.** Trigger the agent, get a result (usually a link), move on with your day. No babysitting.
5. **Provider-agnostic.** A thin adapter over LLM providers. Swap Anthropic for OpenAI for a local model by changing one config line.
6. **Permissions that don't get in the way.** Declared once in config, enforced at runtime (Deno sandbox where possible, app-level gating elsewhere). Deny by default. Never an interactive prompt in production.
7. **Batteries included, but only the ones you asked for.** Native tools (`run_bash`, HTTP, files) for the common cases; skills and MCP for everything else.
8. **Minimalism.** My GitHub agent doesn't need a browser, so we don't ship one. Base image = runtime + a handful of native tools, nothing else; capability is added per-agent via custom images, skills, and MCP — never by default. Every other framework is bloated; small agents are cheaper, safer, and easier to trust.
9. **Cheap models are the default.** A well-scoped agent on a mini model (gpt-5.4-mini-class) beats a general agent on a frontier model at a fraction of the cost. Narrow jobs, small toolsets, schema-constrained outputs, and lean context are what *make* cheap models reliable — the framework is designed so its agents live inside a small model's competence, with per-run cost visible in the audit trail.
10. **Documentation is part of the product, from day one.** A framework lives or dies by its docs. Every milestone ships its documentation; the "newcomer to running agent in 30 minutes" success criterion is a docs test as much as a framework test.

## Target market

**Developers first, businesses after.** Phase one is an OSS framework for developers who are comfortable with Docker and YAML, allergic to canvases and proprietary clouds, and tired of week-long builds for day-one bots. Phase two reaches businesses through the hosted platform and the service business (Plan 5) — those buyers never see YAML; they see an automated process and an invoice. Positioning against the field is in Plan 4.

## Business context

The framework is step one of a larger arc:

**framework → portfolio of deployed agents → service business building and operating agents for other companies.**

This shapes priorities early: agents will run *on behalf of clients*, so observability, audit trails, and a credible permission story aren't polish — they're what makes the service sellable. Every design decision should survive the question: "would I deploy this into a client's business?"

## Success criteria for v1

The MVP agent (Plan 2) — Discord message in, GitHub issue link out — is:

- defined in **one YAML file**,
- deployed with **one `docker run`**,
- buildable by a newcomer to the framework in **under ~30 minutes**.

Third time building this bot. This time it's a config file.

## Open questions

- Name/branding: "Looped AF" as the public name, or reserve that as the informal one?
- License: leaning Apache-2.0 (ecosystem norm — eve, Flue, Mastra, Docker Agent; patent grant; permissive enough that other agencies can build on Looped, which is strategic — see Plan 4).
- How early does observability (structured logs, run traces) enter the roadmap vs. staying post-MVP? (Platform/agency needs pull it earlier — see Plan 5.)
