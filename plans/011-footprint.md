# Plan 11 — Footprint: a smaller image and a smaller resident set

Minimalism is principle 8, and so far it has meant shipping no browser and no extras. This plan applies the same principle to the two numbers an operator actually pays for: the size of `looped/agent` on disk and the memory an agent holds while it sits in its loop waiting for work. A fleet is many containers on one box; every megabyte in the image is pulled per host and every resident megabyte is spent per agent, all day, mostly while idle.

Status: design; implementation has not started. Numbers below are measured from the current published image; the estimates are marked as estimates and phase 1 replaces them with measurements.

## Where the bytes actually are

- `ghcr.io/loopedautomation/agent:latest`: **201MB**
- `denoland/deno:alpine-2.9.1`, the base: **161MB**
- our layers: **~40MB** (bash, the user setup, the cached dependencies in `/deno-dir`)
- the framework source itself: **412KB**

So the honest reading is that the image is a runtime with a rounding error of product on top. Excluding test files with `.dockerignore` or pruning `packages/` saves kilobytes and is worth doing only for hygiene. Shrinking this image means shrinking what carries the code, and the full `deno` CLI is a development toolchain (formatter, linter, LSP, REPL, test runner) that no production agent ever invokes.

## The compile move

`deno compile` produces a single binary: the slimmed runtime (`denort`) plus a snapshot of the code, with type-stripping and module resolution done at build time. That replaces the three heaviest things we ship, the full CLI, the source and the `/deno-dir` cache, with one artifact. The build becomes multi-stage: a builder image runs `deno compile packages/cli/main.ts`, and the runtime stage is alpine plus bash plus the binary. We estimate the result lands around half the current size, and phase 1's first task is to build it and publish the real number. A compiled binary also starts faster, since boot no longer pays for module graph resolution, which the operator sees as a quicker `docker run` and a shorter healthcheck start period.

One real cost, and it collides with Plan 6. A compiled binary bakes its permission flags at build time, so the slim image carries the broad flag set the Dockerfile uses today, and hermetic mode's re-exec-with-narrower-flags trick has no `deno` CLI to re-exec into. The two features pull in opposite directions on the same layer of the sandbox. The resolution we propose: ship the compiled image as `looped/agent:slim` alongside the current image, keep the `deno run` image hermetic-capable, and decide which one deserves the default tag after hermetic mode has landed and both can be compared honestly. Layer 2, the container, bounds both variants either way.

## The floor: a distroless variant for hermetic agents

bash exists in the image for one reason, the `run_bash` contract. An agent with no `permissions.run` grants never spawns it, and Plan 6 already defines that agent class as hermetic. For them the floor is distroless: the compiled binary, CA certificates and nothing else, no shell, no package manager, no busybox. The healthcheck can no longer shell out to `wget`, so the binary grows an `af healthcheck` subcommand that curls its own status port and exits accordingly, which the HEALTHCHECK instruction calls in exec form. This variant is the smallest expressible statement of principle 8: the agent that needs nothing ships nothing.

## Memory: measure, cap, then trim

Idle memory is currently unmeasured, which is the first thing to fix. `/healthz` grows an `rss` field from `Deno.memoryUsage()`, and phase 1 records the idle baseline for each example agent. What we know without measuring:

- **The framework's own idle set is V8 plus trigger connections.** V8 grows its heap toward whatever the machine offers and returns memory reluctantly. A `--v8-flags=--max-old-space-size` ceiling in the entrypoint turns "grows until something pushes back" into a bounded number, and the docs' compose examples gain a matching `mem_limit` so the container is the hard stop. A bounded agent fits the limits philosophy that already governs steps.
- **Per-run memory is already event-scoped.** History loads from SQLite when an event arrives and is garbage after the run; an idle agent holds no transcript. Long threads still inflate each run, and the compaction work Plan 1 scopes for v1 bounds that in tokens and bytes at once. Tool-output caps do the same for the outlier tool call.
- **MCP servers are the elephant.** A stdio MCP server is a resident child process, commonly a Node runtime holding more memory than the agent itself, multiplied by every server in the config. The cheapest fix is the advice the framework already gives, a CLI plus a skill instead of a server where that covers the job. Beyond advice, an idle-disconnect option (validate and fetch schemas at startup, then drop the child until a tool call needs it) would reclaim the memory without giving up fail-at-boot, at the price of reconnect latency on first use. Whether that complexity earns its place is an open question.

## Guardrails so it stays small

Sizes regress one convenient dependency at a time, so CI gets two checks alongside the image build: the image size, failing the job when it grows past a set threshold without the threshold being deliberately raised in the same PR, and an idle-RSS smoke that boots the triggerless example, waits, and samples `/healthz`. The thresholds live in the repo where a PR that fattens the image has to say so in its diff.

## Phasing

1. **Measure and cap.** `rss` in `/healthz`, recorded baselines for the examples, the V8 heap ceiling, `mem_limit` in the documented compose files, the CI size and RSS checks. No image surgery yet; this phase makes every later claim checkable.
2. **`looped/agent:slim`.** The multi-stage compile build, published beside the current image with its measured size, plus `af healthcheck` so the same binary serves the distroless variant.
3. **The distroless hermetic image.** For the no-`run:` agent class, once slim has soaked.
4. **The default-tag decision.** After Plan 6's hermetic mode lands, pick the default image with both candidates on the table, and record the choice here.

## Open questions

- `deno compile` against a Deno workspace with npm dependencies has sharp edges version to version; the phase 2 spike either clears it or this plan gets amended with what broke.
- Does the compiled binary's startup win change the healthcheck `start-period`, and should the healthcheck defaults tighten with it?
- MCP idle-disconnect: worth the supervision complexity, or is "prefer a CLI and a skill" the whole answer at this scale?
- Is there appetite for size budgets per layer (base, bash, binary) in CI, or is the single whole-image threshold enough bookkeeping?
- The V8 ceiling number itself: one default for all agents, or derived from `limits` in config? A flat default is likely right until an agent proves otherwise.
