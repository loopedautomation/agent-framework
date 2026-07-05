# The Looped Agent Framework Manifesto

I built the same agent twice. A Discord bot that reads what my team posts in a channel, creates a well-formed GitHub issue and replies with the link. The whole idea fits in a paragraph, but both times, with two different frameworks, it took many hours of wrangling: gateway daemons, config files in four formats, pairing rituals and a general-purpose assistant that I had to prompt-steer into behaving like a single-purpose bot.

The models were never the problem. My personal favourite, gpt-5.4-mini, is exceptional at this task. The problem is that every agent framework is either a library you embed in an app you now have to write, or a personal assistant you have to talk out of doing everything else. What I kept needing was a **runtime for deploying agents as services**, and nobody ships that.

So this is Looped AF, the Looped Agent Framework, and these are its convictions.

## An agent should have one job

An agent should be hired the way you'd staff a business process: one specialist at a time. An agent with one job is easier to prompt, easier to permission, easier to test and possible to trust. Everything else in this manifesto follows from this. If you need a second job done, run a second agent. Containers are relatively cheap. Note that one job doesn't mean an agent can only do a single thing. It can have multiple tools and be able to do many tasks, but these tasks should all be related to its primary purpose.

## An agent should be a file

One job fits in one file: the purpose, the model, the tools, the triggers and the permissions. It's a file you can read in a minute, diff in a review and check into git next to the process it automates. `docker compose up` and it's ready to work. There's no SDK to learn and no app to scaffold, and if you ever do need code, it's there as an escape hatch.

## Agents should be services

The loop is the whole point. The agent waits for an event (a Discord message, a webhook, a cron tick), does its job, delivers the result and then goes idle again. From your side it's fire and forget: you message it the way you'd message a colleague. When you're free again you come back to check in. It's asynchronous.

## Minimalism is a feature

My GitHub agent doesn't need a browser, so it doesn't have one. The base image contains a runtime, a handful of native tools and nothing else. Capability is added deliberately, through a Dockerfile layer, a skill or an MCP server. Every tool an agent carries is attack surface, context cost and one more way for a small model to get confused.

## Cheap models are the default

A narrow agent on a mini model can do the job of a general agent on a frontier model, at a fraction of the cost. Small toolsets, schema-constrained outputs and lean context are what make cheap models reliable, so the framework is built around them. The whole economic story is automation that's too cheap to meter.

## Never ask permission at runtime

If your agent is left unattended, you're not going to be able to grant it permission anyway. So permissions are declared once in config (which commands, which hosts, which paths), the default is deny, and enforcement happens in layers: the runtime sandbox, then the container. A denied action goes back to the agent as context for its next turn.

## The container is the computer

Docker-native means the container is the unit of deployment, isolation and scaling. The Dockerfile is the environment and the YAML is the agent. It runs the same on a Mac mini as it does in a fleet. If it doesn't run cleanly in a container, it doesn't ship.

## No provider is load-bearing

Models improve monthly and vendors change their terms overnight. Swapping providers is one config line. Any OpenAI-compatible endpoint or any local model will work, and there's no lock-in.

## Agents name themselves

You give an agent a job and a handle. On first boot it chooses its own name and keeps it for life. This costs nothing, and it changes how the whole thing feels: you hire someone and they get to work. There's no persona to design and no identity questionnaire to fill in before the agent does anything useful; it names itself and gets on with the job.

---

Looped AF is being built in the open, plans-first, starting with the agent I've now built twice the hard way. The third time it's a config file.

If you think agents should be simpler, smaller, cheaper and boringly deployable, this is for you. Please give us a star on GitHub and follow along.

<sub>Written by Claude in the voice of Ratul Maharaj - the [looped-docs skill](skills/writing/looped-docs.md) is what makes that possible.</sub>
