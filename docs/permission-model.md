---
title: "The permission model"
description: "Why an agent never asks for permission at runtime: boundaries declared once in config, enforced by the Deno runtime and layered so each boundary assumes the one inside it can fail."
---

Interactive coding agents answer the safety question with a human in the loop: *may I run
this command?* That works when someone is sitting at the terminal. A service agent has no
one to ask; it runs at 3am, triggered by a webhook, on a machine nobody is watching. And
even with a human present, prompts have a known failure mode: enough of them and people
stop reading and approve everything.

So we took the opposite position: **an agent never asks for permission at runtime.** The
question was already answered before it started.

## Declared once, in config

Everything the agent is allowed to touch is written in the `permissions:` block of the
agent file: which network hosts, which executables, which paths. The default is deny. An
agent with no `permissions:` block can touch nothing, and there is no way to grant more
while the agent is running. Widening the boundary means editing the file and redeploying,
which is exactly the friction you want: a capability change is a config change, and it
gets reviewed and versioned like one.

This means that the agent file completely defines what an agent is allowed to do. You
don't need to read a transcript to find out what an agent can reach; a few lines of YAML
tell you before it ever runs.

## Built on Deno

We run agents on Deno because Deno treats permissions as a runtime primitive. Most
runtimes give a process everything the OS user can do: anything the user can read, write
or execute, the process can too, and any sandboxing has to be bolted on around it. A Deno
process starts with nothing and only holds what you granted it at launch, which is
exactly the shape an agent's boundaries need.

At startup, the framework compiles the `permissions:` block into Deno permission flags;
`af flags agent.yaml` prints the exact set. In the base image, that means file reads are
scoped to the agent's own directories, writes to its data volume and subprocess spawning
to bash alone. What matters here is where the enforcement happens: in the runtime,
underneath the framework's own code. A bug in the framework can't grant an access the
runtime was never given.

On top of the Deno sandbox sits the framework's own permission engine, which handles the
things runtime flags can't express. Network egress is checked per host. Shell commands
are statically analysed, and every executable in a pipe or chain is checked against the
allowlist. Subprocesses only get the env vars the config grants them, and secrets are
injected server side, so they never enter the model's context.

## A denial is an answer

When the agent tries something outside its grants, nothing pauses and nothing crashes.
The denial goes back to the agent as an ordinary tool result, something like `permission
denied: run access to "curl" is not in the agent's permissions.run allowlist`, and the
agent carries on with that as context for its next turn: it works within its grants or
reports what it couldn't do. Your role moves from approving actions in real time to
reviewing the audit trail afterwards, where every decision, allowed and denied, is
recorded.

## Layers that assume failure

We don't trust any single boundary to hold. Enforcement nests: the permission engine
sits inside the Deno sandbox, which sits inside the container, and each layer assumes the
layer inside it can fail. Bash subprocesses escape the Deno sandbox by design, and the
container is what contains them. That's also why there is no "run on the host" mode: the
framework refuses to run where its outermost layer is missing.

The result is that running an agent unattended becomes a calculated risk: the worst case
is bounded by a config file you wrote, enforced at three layers you didn't have to build.

The full reference, with syntax, matching rules, secrets and the honest notes on where
each layer's limits sit, is in [Permissions](permissions.md).
