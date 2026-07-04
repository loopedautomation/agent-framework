# The Looped Manifesto

I built the same agent twice. A Discord bot: read what my team posts in a channel, create a well-formed GitHub issue, reply with the link. The whole idea fits in a paragraph. Both times, with two different frameworks, it took many hours of wrangling — gateway daemons, config files in four formats, pairing rituals, a general-purpose assistant prompt-steered into pretending to be a single-purpose bot.

The models were never the problem. The models are astonishing. The problem is that every agent framework is either a library you embed in an app you now have to write, or a personal assistant you have to talk out of doing everything else. Nobody ships the thing I keep needing: a **runtime for deploying agents as services**.

So this is Looped AF — the Looped Agent Framework — and these are its convictions.

## One agent, one job

Not a personal assistant. Not a do-anything companion. A fit-for-purpose agent, hired for one business process — the way you'd staff it: one specialist at a time. An agent with one job is easier to prompt, easier to permission, easier to test, and possible to trust. Everything else in this manifesto follows from this. If you need a second job done, run a second agent. Containers are cheap.

## An agent is a file

One job fits in one file: the purpose, the model, the tools, the triggers, the permissions. A file you can read in a minute, diff in a review, and check into git next to the process it automates. `docker compose up`, and it's hired. No SDK to learn, no app to scaffold, no canvas to drag boxes across. Code is the escape hatch, never the entry point.

## Agents are services, not scripts

The loop is the whole point: wait for an event — a Discord message, a webhook, a cron tick — act, deliver the result, go idle. Fire-and-forget from the user's side. A colleague you message, not a program you operate.

## Minimalism is a feature

My GitHub agent doesn't need a browser, so it doesn't have one. The base image is a runtime, a handful of native tools, and nothing else. Capability is added deliberately — a Dockerfile layer, a skill, an MCP server — never shipped by default. Every tool an agent carries is attack surface, context cost, and one more way for a small model to get confused. Bloat isn't generosity; it's negligence.

## Cheap models are the default

A narrow agent on a mini model beats a general agent on a frontier model, at a fraction of the cost. Small toolsets, schema-constrained outputs, and lean context are what make cheap models reliable — so the framework is built around them. Automation that's too cheap to meter is the entire economic story.

## Never ask permission at runtime

Permission prompts don't scale, and unattended agents can't answer them anyway. Permissions are declared once in config — which commands, which hosts, which paths — deny by default, enforced in layers: the runtime sandbox, then the container. A denied action is information the agent adapts to, not a dialog waiting for a human who isn't there.

## The container is the computer

Docker-native means the container is the unit of deployment, isolation, and scaling. The Dockerfile is the environment; the YAML is the agent. It runs the same on a Mac mini as it does in a fleet. If it doesn't run cleanly in a container, it doesn't ship.

## No provider is load-bearing

Models improve monthly and vendors change their terms overnight. Swapping providers is one config line. Any OpenAI-compatible endpoint, any local model, no lock-in — ever.

## Agents name themselves

You give an agent a job and a handle. On first boot, it chooses its own name, and keeps it for life. This costs nothing and changes how it feels: you didn't configure a process, you hired someone.

---

Looped AF is being built in the open, plans-first, starting with the agent I've now built twice the hard way. Third time it's a config file.

If you think agents should be simpler, smaller, cheaper, and boringly deployable — this is for you. If you think an agent framework needs a graph orchestrator, a canvas, and a browser in every container, we happily disagree.

*The plans live in [`plans/`](plans/). The loop starts here.*

<sub>Written by Claude Fable 5 (`claude-fable-5`) in collaboration with Ratul Maharaj.</sub>
