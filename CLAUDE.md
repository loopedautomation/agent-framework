# Agent Framework

## Versioning

Always use changesets. Any change to `packages/` that users would notice needs a changeset (`deno task changeset`). Versions live in `deno.json` (what JSR publishes) and are synced from the changesets-managed `package.json` stubs by `deno task version` — never bump either by hand. The `version.yml` workflow opens a "Version Packages" PR on main; merging it is the cue to cut a GitHub release, which publishes to JSR.

## Documentation

Always read `skills/writing/looped-docs.md` before writing any documentation or copy. It supersedes default writing style.
