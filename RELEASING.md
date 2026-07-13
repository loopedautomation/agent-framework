# Releasing

How to cut a release, written so an agent (or a human) can follow it start to finish. Releases happen from `main` with a `vX.Y.Z` tag; publishing the GitHub release triggers everything else.

## Pick the version

This is 0.x software: a breaking change bumps the minor version, new features bump the minor version, fixes alone bump the patch version. Check the commits since the last tag (`git log $(git describe --tags --abbrev=0)..main --oneline`) — a `!` after the type (`feat(config)!:`) or a `BREAKING` note in the body marks a breaking change.

## Bump every version reference

The version lives in four files that must always agree:

- `packages/core/deno.json` — the `"version"` field
- `packages/triggers/deno.json` — the `"version"` field
- `packages/cli/deno.json` — the `"version"` field
- `packages/core/mod.ts` — `export const VERSION = "X.Y.Z";`

The `release-binaries` and `publish-image` workflows verify the tag against that `VERSION` constant and refuse a mismatch, so a partial bump fails the release halfway — v0.7.0 shipped with only three of the four bumped and had to be superseded the same day.

Docs and examples pin the release too. In `README.md`, `action.yml`, `docs/` and `examples/`, rewrite **every** match of these patterns to the new version, whatever version they currently name (a stale one should self-heal, not survive):

- `loopedautomation/agent-framework@vX.Y.Z` — GitHub Action usage examples
- `ghcr.io/loopedautomation/agent:X.Y.Z` — image tags in doc examples
- `` `@vX.Y.Z` `` — the bare release tag in inline code (docs/github-actions.md)

Then verify no reference to the previous version survives anywhere that matters:

```sh
git grep -n "<previous version>" -- README.md action.yml docs examples packages
```

That must come back empty before you commit.

## Ship it

1. Commit everything as `release: vX.Y.Z`, with a short body naming the highlights since the last release. Push to `main`.
2. Publish the release: `gh release create vX.Y.Z --target main --title vX.Y.Z --generate-notes`, prepending a hand-written **Highlights** section (and a **Breaking change** section when there is one) to the generated notes.
3. Publishing triggers three workflows, and all three must go green: `publish-jsr` (the `@looped/*` packages), `release-binaries` (four `af` tarballs plus checksums attached to the release), and `publish-image` (`ghcr.io/loopedautomation/agent`, tagged `X.Y.Z`, `X.Y`, `X` and `latest`). Watch them finish; a release isn't done until the assets and image exist.

## If a release goes wrong

Fix forward. JSR versions are immutable, so a bad release means a new patch version with the fix — never move or reuse a tag, and never delete a published JSR version (yanking on jsr.io is the most you can do). Mark the bad GitHub release as a prerelease with a note pointing at its successor.
