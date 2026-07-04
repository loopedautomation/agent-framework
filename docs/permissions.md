---
title: "Permissions"
description: "Deny-by-default allowlists, denials as information, secrets, and the sandbox layers."
---

Permission prompts don't scale, and unattended agents can't answer them anyway. So permissions are declared once in config — which hosts, which executables, which paths — deny by default, and enforced in layers. A denied action is information the agent adapts to, not a dialog waiting for a human who isn't there.

## Deny by default

An agent with no `permissions:` block can touch nothing.

```yaml
permissions:
  net: [api.github.com, "*.internal.example.com"]  # hosts http_request may reach
  run: [gh, echo]                                  # executables run_bash may spawn
  read: [/workspace]                               # readable path prefixes
  write: [/workspace/out]                          # writable path prefixes
```

- **`net`** — hosts, matched exactly; `*.example.com` matches subdomains (not the apex).
- **`run`** — executables, matched by basename.
- **`read` / `write`** — path prefixes. Paths are normalized before the check, so `..` traversal can't escape the allowlist.

**Tools follow permissions**: `run_bash` only exists for the agent if `run:` grants something; `http_request` only if `net:` does; `read_file`/`write_file` only if `read:`/`write:` do. No dead tool schemas burning context — the full toolset is in [Tools](tools.md).

## Denials are tool results

A denied action is not a crash. The model sees `permission denied: run access to "curl" is not in the agent's permissions.run allowlist` as an ordinary tool result and adapts — asks differently, works within its grants, or reports what it couldn't do. Every decision, allowed and denied, lands in the [audit trail](docker-run.md#persistence-the-data-volume).

## Static analysis of shell commands

`run_bash` does not trust the shell: it extracts every executable from pipes and chains and checks each one against `run:`. Command substitution (`$(...)`, backticks, `<(...)`) is rejected outright — it cannot be statically checked, so it does not run.

## Scoped environments

Subprocesses receive only the env vars the config's `env:` block grants (plus `PATH`/`HOME`) — never the agent process's ambient environment. The same goes for MCP servers: each sees only its own `env:` block.

## Secrets

Config holds references, never values:

```yaml
env:
  GITHUB_TOKEN: ${GITHUB_TOKEN}
```

Resolution order: process env var → `/run/secrets/<NAME>` (Docker Compose file secrets). Missing references fail at startup, not on the first request. Secrets are injected into tools server-side and **never enter the model's context** — the model can use `GITHUB_TOKEN` without ever seeing it.

## The layers

Enforcement is layered — the app-level engine described above, inside a runtime sandbox, inside a container:

1. **The Deno sandbox.** The config compiles to Deno permission flags — `af flags agent.yaml` prints them, e.g. `--allow-net=api.github.com --allow-run=gh`. In the [base image](docker-run.md#what-the-base-image-gives-you), reads are scoped to `/agent`, `/skills`, `/data`, `/run/secrets`; writes to `/data`; subprocess spawning to `bash` (which the permission engine then gates per-executable).
2. **The container.** The unit of isolation. The compose examples add `read_only: true` and tmpfs.

Two honest notes on where the layers actually sit:

- The Deno layer allows all *network* egress in the container (`--allow-net`): per-host enforcement happens app-level in the permission engine, and the container's egress policy is layer 2 — restrict it with your network setup where it matters. Automating per-agent egress policy is planned.
- `bash` subprocesses escape the Deno sandbox by design; the container boundary is what contains them. That's why there is no "run on the host" mode.
