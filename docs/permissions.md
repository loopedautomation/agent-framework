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
A `net` entry may be an env reference — `net: ["${COOLIFY_HOST}"]`, and likewise `http.auth`'s `url`. An instance hostname is deployment configuration, not a secret, and this keeps it out of a committed agent file. The reference resolves at startup, before the [sandbox flags](#the-layers) are compiled from it, so what the runtime enforces is the real host. A missing one fails at startup like any other reference; `af validate` and `af flags` describe rather than run, so they leave it visible and warn instead.

- **`read` / `write`** - path prefixes: granting `/workspace` grants everything beneath it. A path is normalized and its symlinks are expanded before the check, so neither `..` traversal nor a link pointing out of the root steps outside the allowlist. The tools then act on the resolved path, so what was authorized is what gets opened. A symlink that stays inside the root is fine, which means an allowed root can itself be a link, the way `/tmp` is on macOS.

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

The same blindness applies to network-capable binaries (`curl`, `ssh`, even `gh`): a subprocess opens its own sockets, so its traffic never touches `permissions.net` — until per-agent egress enforcement lands, such a grant is an implicit `net: ["*"]` with the container as the only boundary.

`af validate` and startup both warn about these grants — shells, interpreters, wrappers, and known network-capable binaries — naming what each one gives up. The grants stay legal (a `gh` agent is a perfectly good agent); the warning exists so the cost is a choice, not a surprise.

Grant the specific CLIs the agent's job needs (`gh`, `grep`) and let the [container](#the-layers) be the backstop. The MCP examples that launch a server via `bash -c` are unaffected: that spawn comes from your config at startup and never passes through `run_bash`.

## Scoped environments

Subprocesses receive only the env vars the config's `env:` block grants, plus `PATH`/`HOME`; the agent process keeps its own ambient environment to itself. The same goes for MCP servers: each one sees only its own `env:` block.

## Secrets

The config names an environment variable; the value stays out of the file:

```yaml
env:
  GITHUB_TOKEN: ${GITHUB_TOKEN}
```

The value resolves from the process environment first, then from `/run/secrets/<NAME>` (Docker Compose file secrets). A missing reference fails at startup, before any event is handled. The value is scoped to the tools that need it, so the model can use `GITHUB_TOKEN` without ever seeing it.

That covers the way in. A permitted CLI or MCP server can also echo a secret back at you in its output, so tool results, transcripts, records, logs and traces are scrubbed of known secret values on the way out. For an authenticated API, `http.auth` lets the runtime attach the credential to the request itself. Both are covered in [Secrets](secrets.md).

## The layers

Enforcement is layered: the app-level engine described above runs inside a runtime sandbox, which runs inside a container.

1. **The Deno sandbox.** The config compiles to Deno permission flags; `af flags agent.yaml` prints them. In the [base image](docker-run.md#what-the-base-image-gives-you), reads are scoped to `/agent`, `/skills`, `/data` and `/run/secrets`; writes to `/data`; subprocess spawning to `bash`, which the permission engine then gates per executable.
2. **The container.** This is the unit of isolation; the compose examples add `read_only: true` and a tmpfs.

Two honest notes on where the layers actually sit:

- If your agent spawns something, whether that's a `permissions.run` grant or a stdio MCP server, the Deno layer allows all *network* egress in the container (`--allow-net`). Per-host enforcement happens in the app-level permission engine, and the container's egress policy is layer 2; restrict it with your network setup where it matters. An agent that spawns nothing gets its `net:` list compiled straight into `--allow-net`, so the runtime enforces it for the whole process ([hermetic mode](permission-model.md#hermetic-mode)).
- `bash` subprocesses escape the Deno sandbox by design; the container boundary is what contains them. That is why there is no "run on the host" mode.

## An operator's floor

Everything above assumes the person who wrote the agent file and the person running it are the same. That holds while you're writing your own agents. It stops holding the moment files get shared, which is something we want: one file, plain words, a template someone can copy is most of the point. When you copy an `agent.yaml` from a repo or a gallery and run `docker compose up`, its `permissions:` block is a request you grant in full, and nothing on your side gets a say.

A floor is the operator's side of that conversation. Put a file at `/etc/af/floor.yaml`, or point `AF_PERMISSION_FLOOR` at one:

```yaml
run: [gh, git, jq]
net: ["api.github.com", "*.internal.example.com"]
write: [/data]
deny:
  net: [metadata.google.internal]
  read: [/run/secrets]
```

An agent file that asks for anything outside this doesn't start. The error names every grant that was refused and the floor entry that refused it, so you fix it in one pass:

```
agent.yaml asks for more than this host allows:
  - permissions.run asks for "curl", which is not covered by /etc/af/floor.yaml's run list
  - permissions.net asks for "*.google.internal", which /etc/af/floor.yaml denies (deny.net: "metadata.google.internal")
```

### The floor only refuses

Nothing in a floor grants an agent anything. It has no way to add a host or an executable that the agent file didn't already ask for, so reading the agent file still tells you the agent's maximum blast radius. That property is what the rest of this page is built on, and a floor that could widen would break it.

It also means a refused file fails to start rather than running with less than it declares. Quietly trimming grants would leave you with a file that no longer describes the agent, which is worse than an error at boot.

### How entries match

Each axis matches the same way the permission engine does, one level up: the floor's entry has to be at least as wide as what the file asks for.

- **`run`** is exact basenames. A floor of `[gh]` covers a file asking for `gh` and refuses `curl`. Only a floor of `*` covers a file asking for `*`.
- **`net`** follows the wildcard rule from [Deny by default](#deny-by-default). A floor of `*.example.com` covers `api.example.com` and `*.eu.example.com`, and refuses `example.com` (the apex isn't a subdomain) and `*.github.com`.
- **`read` and `write`** are path prefixes. A floor of `/data` covers `/data/runs` and refuses `/` and `/database`.

An axis you leave out of the floor is unconstrained, so a floor naming only `run` says nothing about network access.

`deny` works the other way round: it refuses a grant that *overlaps* the denied entry in either direction. Denying `metadata.google.internal` refuses a file asking for that host, and also refuses one asking for `*.google.internal`, because that grant could reach it. Use `deny` when you want to forbid a few specific things without enumerating everything you'd permit.

### When there's no floor

Neither file present means no floor and no change: a developer on their own machine sees the same behaviour as before.

The two failure cases are treated differently, because they mean different things. If `AF_PERMISSION_FLOOR` names a file that can't be read, startup fails - an operator who pointed at a policy shouldn't end up with an unpoliced agent because of a typo. If the *default* path can't be read for some reason other than being absent, the agent starts without a floor and prints a warning naming the path. Stopping an agent because of a file it was never told about would be wrong, and staying quiet about a policy that might exist and isn't applying would be worse.

In the [base image](docker-run.md#what-the-base-image-gives-you), `/etc/af` is in the runtime's read paths, so a floor mounted there is readable under the sandbox flags the agent runs with.
