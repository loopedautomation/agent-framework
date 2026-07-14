# Plan 6 — Security: closing the egress gaps

The permission model promises that the agent file completely defines what an agent is allowed to do. For the native tools that promise holds today. For anything that runs outside the agent process, a bash subprocess or an MCP server, the network half of the promise does not hold yet. This plan records where enforcement actually stands, where the gaps are and the design for closing them.

Status: hermetic mode has shipped (step 1 of the sequencing below); the rest is design accepted. `docs/permission-model.md` ("Where the boundaries stop today", "Hermetic mode") is the user-facing statement of the same gaps and must stay consistent with this plan.

## Where enforcement stands today

Enforcement nests in three layers, and each layer assumes the one inside it can fail.

1. **The permission engine** (`packages/core/permissions/engine.ts`). App-level checks on every native tool call: `net` per host for `http_request`, `run` per executable (static analysis of pipes and chains, command substitution rejected), `read`/`write` per normalized path prefix. Every decision lands in the audit trail. Deny by default; a denial returns to the model as a tool result.
2. **The Deno sandbox.** The published image (`images/agent/Dockerfile`) launches the runtime with one fixed flag set: reads scoped to `/agent`, `/skills`, `/data`, `/looped`, `/deno-dir` and `/run/secrets`, writes to `/data`, subprocess spawning to `bash` alone, and `--allow-net` open. Those flags are baked at image build time, before any agent.yaml is known, so they are the widest an agent runs under. An agent that spawns nothing re-execs into narrower ones, its whole net allowlist compiled into `--allow-net` (hermetic mode, below); an agent that spawns something keeps them, and gap 1 is its reality.
3. **The container.** The outer wall. `bash` subprocesses escape the Deno sandbox by design and the container is what contains them; that is why there is no run-on-the-host mode.

## The gaps

The gaps as they stood when this plan was written. Hermetic mode closes 1 and 3 for agents that spawn nothing; for agents that spawn something they stand as written.

**1. Network enforcement stops at the agent process.** `permissions.net` gates only the native `http_request` tool. A bash subprocess or an MCP server makes whatever outbound calls it wants, because the Deno layer allows all net in the container and the engine never sees traffic it didn't originate. In practice, an entry in `permissions.run` for a network-capable binary is an implicit `net: ["*"]` for that agent: `run: [gh]` lets `gh` reach any host.

The threat this enables is prompt injection plus exfiltration. A hostile Discord message or webhook payload steers the agent into running an allowed CLI against an attacker's endpoint, carrying whatever the agent holds in context or on its readable paths. The engine allows it because the executable is on the list and the destination host is never checked.

**2. MCP servers sit outside the permission engine.** MCP tool calls go straight to `client.callTool` (`packages/core/tools/mcp.ts`) with no engine check and no per-call audit entry. Declaring a server under `tools.mcp` trusts it entirely; the controls are the `include:` filter and the scoped `env:` block.

**3. The image's sandbox flags are shared.** Layer 2's scoping is identical for a locked-down agent and a permissive one; only layer 1 varies per agent inside the shipped container.

**4. `run` matches by basename.** `run: [gh]` allows any executable named `gh` anywhere on disk. Fine inside the hardened base image; a derived image that widens writable paths should know the container is the backstop.

**5. Static analysis stops at the head of each segment.** `extractExecutables` (`packages/core/tools/bash.ts`) checks the first word of each pipe/chain segment and can't see into arguments. Granting a program that runs other programs (`bash`, `sh`, `python`, `node`, `env`, `xargs`, `find` with `-exec`) collapses the allowlist: `bash -c '<anything>'` passes with the inner command carried as an opaque string. `docs/permissions.md` documents it, and `af validate` / startup now warn per entry (`runGrantAdvisories`, `packages/core/permissions/advisories.ts`) — the structural gap itself remains.

## Shipped: hermetic mode

`packages/core/permissions/hermetic.ts` decides eligibility and compiles the flags; `packages/cli/local.ts` re-execs into them before the service is constructed. Two notes on what the design met on contact with the runtime:

- **Auto-detected, no config key.** A qualifying agent gets hermetic mode and says so at startup; `af flags` and `af validate` print the flags and the hosts. Adding `run:` later moves the agent back behind the container boundary, and both commands name the grant that did it. The open question below is settled that way: an opt-in nobody sets protects nobody.
- **Wildcard hosts disqualify an agent.** `--allow-net` matches exact hosts and has no wildcard form, so `*.example.com` has no compiled equivalent. `permissionsToDenoFlags()` used to strip the `*.` and emit the apex, which denies the subdomains the config allows and allows the apex it doesn't; that was harmless while the flags were informational and would have become a live bug the moment they were real. The flags now omit what they cannot express, and hermetic mode refuses to be the enforcement boundary for a config it can only partly express.

## Design: hermetic mode

The subprocess escape hatch only exists when the config asks for it. When an agent has no `permissions.run` grants and no stdio MCP servers, nothing runs outside the Deno sandbox, and the runtime's own `--allow-net` can hold the entire net allowlist for the whole process, HTTP MCP clients included.

The design: at startup, before connecting anything, the in-container entrypoint inspects the resolved config. If the agent qualifies, it re-execs `deno run` with the per-agent compiled flags from `permissionsToDenoFlags()` in place of the image's broad set. The framework derives and appends the hosts it needs for itself, all of which are already in the config:

- the model provider endpoint (`model.base_url`, or the provider's default host),
- trigger hosts (e.g. `discord.com` and `gateway.discord.gg`, Slack's Socket Mode hosts, `api.telegram.org`),
- HTTP MCP server URLs' hosts,
- listen rights for the status server and any webhook trigger ports.

This closes gap 1 for the qualifying agent class with no new infrastructure, and it makes `af flags` output real inside the shipped container rather than informational (gap 3, for this class). Agents that qualify are probably the common shape: `net`-only agents and HTTP-MCP agents.

What it deliberately does not do: ban subprocesses. The CLI-plus-skill pattern (`gh-issues-cli`) is half the framework's philosophy and the current stand-in for `tools.custom` (#12). Hermetic mode rewards the absence of subprocesses; it does not forbid their presence.

## Deferred to the platform: per-agent egress enforcement

For agents that do spawn subprocesses, per-host enforcement has to live at a layer subprocesses cannot bypass: the network. Raw network rules are not enough, because `permissions.net` is a list of hostnames and iptables sees only IPs; `api.github.com` moves between addresses and shares CDN IPs with half the internet. The chokepoint has to understand hostnames, which means a filtering proxy. (Deno Sandbox uses the same architecture at its VM boundary, which is decent external validation of the shape.)

Decision: the framework does not ship this. A per-agent proxy sidecar and internal Docker network orchestrated by `af up` would work, and the design notes are preserved in git history for when they're needed, but it is infrastructure, and infrastructure is where it should be solved. Looped Agents, the hosted platform (Plan 5), owns the network fabric its agents run on and will enforce `permissions.net` there for all traffic regardless of origin, the same compile-the-allowlist move this plan uses everywhere else.

For self-hosted agents the position is documented honestly instead: a subprocess-running agent's egress is bounded by the container, and operators who need per-host egress control apply it with their own network setup. The mitigations that do ship are hermetic mode (which removes the subprocess class from most agents) and the `af validate` warnings (#48) for `run:` entries that carry unrestricted egress.

One config surface still holds: the same `permissions.net` list is enforced by the Deno runtime when the agent is hermetic, and by the platform's network when it runs on Looped Agents.

## Rejected: @deno/sandbox as the runtime

Deno Sandbox provisions Firecracker microVMs via the Deno Deploy API, with `allowNet` enforced by an egress proxy outside the guest. The enforcement shape is exactly right, and it is the same shape as the design above. It is rejected as the runtime because it is cloud-only: an agent would require a Deno Deploy account and run on their infrastructure, which breaks the Docker-native, self-hosted deployment model that Plan 0 commits to. It may return later as an optional backend ("run this agent in a throwaway cloud VM").

## MCP: audit-trail entries and a readonly gate

Gap 2 has two halves. Where a server can *talk to* is a network question, deferred with egress enforcement above. What remains is app-level and stays in the framework:

- **`include:` is the MCP permission surface.** It already behaves as a deny-by-default tool allowlist: a tool you didn't include does not exist for the agent. A separate `permissions.mcp` axis would duplicate it, so we recognize `include:` as the grant rather than invent a parallel one.
- **MCP calls join the audit trail.** Every `mcp__<server>__<tool>` call is recorded through the same audit sink the permission engine uses, so a transcript is no longer the only record of what an agent did over MCP.
- **A `readonly:` server flag.** MCP tools carry a `readOnlyHint` annotation. `readonly: true` on a server exposes only tools whose annotation says read-only, for wiring up a fat server safely when the job only reads. The annotation is self-reported by the server, so this is a guard against misconfiguration; the trust boundary for a hostile server remains declaring it at all.

## Sequencing

1. ~~**Hermetic mode.**~~ Shipped. Entrypoint re-exec plus host derivation from config.
2. ~~**`af validate` warnings (#48).**~~ Shipped. `af validate` and startup flag `run:` entries that defeat the model: shells and interpreters, wrappers, network-capable binaries.
3. **MCP permission axis.** Design first; likely its own plan or an amendment here.

Per-agent egress enforcement lands with Looped Agents (Plan 5), on the platform's network layer.

## Open questions

- ~~Is hermetic mode auto-detected, opt-in, or auto-detected with an opt-out?~~ Auto-detected. A change of enforcement layer is never silent: startup, `af flags` and `af validate` each name the grant that caused it.
- ~~Should `af validate` refuse, or only warn loudly, on shells and interpreters (bash, sh, python, node) in `permissions.run`, which collapse the allowlist entirely (gap 5)?~~ Warn, don't refuse: the container is still the backstop, some jobs legitimately need an interpreter, and a refusal would push people to rename binaries rather than to think. The warning names the cost per entry.
- When the platform enforces `permissions.net` at its network layer, where do denied egress attempts land? They should reach the same audit trail as engine denials.
