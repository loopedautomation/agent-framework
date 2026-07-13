# Contributing

Looped AF is a Deno workspace: three packages (`packages/core`, `packages/triggers`, `packages/cli`), published to JSR and glued together by a handful of `deno.json` tasks. This file covers the mechanics of getting a change from your machine into the repo.

## Setup

You need [Deno 2.x](https://deno.com) and nothing else. There's no `npm install` step; Deno resolves everything straight from `deno.json` and `deno.lock`.

```sh
git clone https://github.com/loopedautomation/agent-framework
cd agent-framework
deno task test
```

Docker is only needed if you're exercising `af` end to end against the published base image (`af run`, `af up`). Most package-level work doesn't touch it.

## Local development

Four tasks matter day to day:

- `deno task test` - runs every `*_test.ts` file across the workspace. Tests live next to the code they cover (`docker_test.ts` sits beside `docker.ts`, and so on), so add yours there rather than in a separate test tree.
- `deno task check` - type-checks the packages.
- `deno fmt` / `deno lint` - formatting and lint. `deno fmt` skips Markdown (`fmt.exclude` in `deno.json`), so docs formatting is on you.
- `deno task ok` - fmt check, lint, type check and tests, in that order. This is exactly what CI runs, so run it before you push and you'll already know whether CI will pass.

## Working on the CLI

`deno task af` runs `af` straight from source instead of the version installed from JSR. Reach for it whenever you're iterating on `packages/cli` and want to try a command without publishing anything.

## Schema changes

If your change touches the agent config shape (mostly `packages/core/config`), regenerate the JSON Schema and commit it:

```sh
deno task gen-schema
```

CI runs this same command and fails the build if `schema/agent.json` doesn't match what's committed, so this step isn't optional.

## Docs changes

Docs live in `docs/` and are published at [docs.looped.sh/agent-framework](https://docs.looped.sh/agent-framework). Voice and formatting rules are in [`skills/writing/looped-docs.md`](skills/writing/looped-docs.md); read that before writing or editing a page rather than guessing at the style from what's already there.

## Submitting a change

Work on a branch and keep commits focused. Your PR description should explain why the change is needed, not just what moved. CI runs `deno task ok` plus the schema check above, and both need to pass before a merge.

This is alpha software, and the README says so up front: interfaces, config fields and defaults are all still moving. If your change breaks something on purpose, say so in the PR description rather than working around it.

## Releasing

The process lives in [RELEASING.md](RELEASING.md): version numbers exist in four source files that must agree (the release workflows refuse a tag that contradicts them), plus the action and image tags pinned throughout the docs and examples. It is written to be followed end to end, by an agent or a human.

## Reporting bugs and proposing features

Open a GitHub issue. There's no template yet, so a clear repro (for a bug) or a description of the problem you're trying to solve (for a feature) is enough to get started.
