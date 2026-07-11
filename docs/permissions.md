---
title: "Permissions"
description: "Deny-by-default allowlists, denials as tool results, secrets and the sandbox layers."
---

A service agent runs at 3am, triggered by a webhook, on a machine nobody is watching. There is no one to ask "may I run this?", so the question has to be answered before the agent starts. That is what the `permissions:` block is for: you declare once, in config, which hosts, which executables and which paths the agent is allowed to touch, and everything else is denied. A denied action goes back to the agent as context for its next turn. This page is the reference; the reasoning behind the design is in [The permission model](permission-model.md).

## Deny by default

An agent with no `permissions:` block can touch nothing.

```yaml
permissions:
  net: [api.github.com, "*.internal.example.com"]  # hosts http_request may reach
  run: [gh, echo]                                  # executables run_bash may spawn
  read: [/workspace]                               # readable path prefixes
  write: [/workspace/out]                          # writable path prefixes
```

- **`net`** - hosts, matched exactly; `*.example.com` matches subdomains, and the apex needs its own entry.
- **`run`** - executables, matched by basename.
- **`read` / `write`** - path prefixes: granting `/workspace` grants everything beneath it. Paths are normalized before the check, so `..` traversal cannot step outside the allowlist.

Tools follow permissions: `run_bash` only exists for the agent if `run:` grants something, `http_request` only if `net:` does and `read_file`/`write_file` only if `read:`/`write:` do. This means that no unused tool schema takes up context. The full toolset is in [Tools](tools.md).

## The escape hatches

Some jobs are open-ended on purpose. A research agent's capability really is "the web", and a scripting agent on a throwaway box may genuinely need any executable. For those, `net` and `run` accept a bare `*`:

```yaml
permissions:
  net: ["*"]   # every host
  run: ["*"]   # every executable
```

We made the spelling loud on purpose. A `*` in a reviewed config is a choice someone can be asked about, and the audit trail still records every call the agent makes; what you give up is the allowlist as a statement of where the agent *could* reach, which is most of what this page sells. Reach for it when the job is genuinely the open web, and keep listing hosts everywhere else. Paths need no such spelling: prefixes already cover everything beneath them, and `read: ["/"]` says "the whole filesystem" in exactly as many characters as it should take.

## Denials are tool results

A denied action is an ordinary tool result. The model sees `permission denied: run access to "curl" is not in the agent's permissions.run allowlist` and works with that on its next turn: it asks differently, stays within its grants or reports what it couldn't do. Every decision, allowed and denied, lands in the [audit trail](docker-run.md#persistence-the-data-volume).

## Static analysis of shell commands

`run_bash` does not trust the shell: it extracts every executable from pipes and chains and checks each one against `run:`. Command substitution (`$(...)`, backticks, `<(...)`) is rejected outright, because there is no way to check it statically before it runs.

The check reads the executable at the head of each segment; it can't see into the arguments. That is fine for ordinary tools, and it means you should keep programs that run *other* programs off the allowlist. Granting any of these hands over everything:

- shells: `run: [bash]` lets `bash -c '<anything>'` through, since the inner command travels as an opaque string
- interpreters: `python -c`, `node -e`, `deno run`
- wrappers and exec flags: `env`, `xargs`, `timeout`, `find -exec`

Grant the specific CLIs the agent's job needs (`gh`, `grep`) and let the [container](#the-layers) be the backstop. The MCP examples that launch a server via `bash -c` are unaffected: that spawn comes from your config at startup and never passes through `run_bash`.

## Scoped environments

Subprocesses receive only the env vars the config's `env:` block grants, plus `PATH`/`HOME`; the agent process keeps its own ambient environment to itself. The same goes for MCP servers: each one sees only its own `env:` block.

## Secrets

The config names an environment variable; the value stays out of the file:

```yaml
env:
  GITHUB_TOKEN: ${GITHUB_TOKEN}
```

The value resolves from the process environment first, then from `/run/secrets/<NAME>` (Docker Compose file secrets). A missing reference fails at startup, before any event is handled. Secrets are injected into tools server side and never enter the model's context; the model can use `GITHUB_TOKEN` without ever seeing it.

## The layers

Enforcement is layered: the app-level engine described above runs inside a runtime sandbox, which runs inside a container.

1. **The Deno sandbox.** The config compiles to Deno permission flags; `af flags agent.yaml` prints them, e.g. `--allow-net=api.github.com --allow-run=gh`. In the [base image](docker-run.md#what-the-base-image-gives-you), reads are scoped to `/agent`, `/skills`, `/data` and `/run/secrets`; writes to `/data`; subprocess spawning to `bash`, which the permission engine then gates per executable.
2. **The container.** This is the unit of isolation; the compose examples add `read_only: true` and a tmpfs.

Two honest notes on where the layers actually sit:

- The Deno layer allows all *network* egress in the container (`--allow-net`). Per-host enforcement happens in the app-level permission engine, and the container's egress policy is layer 2; restrict it with your network setup where it matters.
- `bash` subprocesses escape the Deno sandbox by design; the container boundary is what contains them. That is why there is no "run on the host" mode.
