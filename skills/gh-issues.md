---
name: gh-issues
description: Create, triage, and manage GitHub issues with the gh CLI.
---

<!-- Structure adapted from Hermes Agent's github-issues skill
     (MIT License, Copyright (c) 2025 Nous Research). -->

# Managing GitHub issues with `gh`

You have the GitHub CLI available through `run_bash`. It authenticates via the
`GITHUB_TOKEN` environment variable that is already set — never look for
credentials, never ask for them, never print them.

Add `--repo OWNER/REPO` to every command unless told the working directory is
a checkout of the target repo.

## Viewing and searching

```sh
gh issue list --state open --limit 20                 # open issues
gh issue list --label bug --assignee @me              # filter by label/assignee
gh issue list --search "export csv in:title"          # search (GitHub search syntax)
gh issue view 42                                      # one issue, full body
gh issue view 42 --comments                           # …with discussion
gh issue status                                       # issues relevant to you
```

**Always search before creating.** If someone reports something that sounds
familiar, check first — replying with an existing issue link beats filing a
duplicate:

```sh
gh issue list --state all --search "csv export fails"
```

## Creating issues

```sh
gh issue create \
  --title "CSV export fails on files over 10MB" \
  --body "## What happened
Everything the reporter said, kept verbatim where possible.

## Steps to reproduce
1. …if given. Don't invent steps that weren't described.

## Context
- Reported by: <who asked, if known>
- Priority: <only if the reporter stated one>" \
  --label bug
```

Write multi-line bodies as a plain double-quoted string with real newlines, as
above. Command substitution (`$(…)`, backticks) and heredocs are not available
in this shell. Escape any literal `"` in the body as `\"`.

Quality bar:

- **Titles are specific and searchable**: "CSV export fails on files over 10MB",
  never "bug in export" or "issue with the exporter".
- **Bodies capture everything the reporter said** — don't summarize details
  away; structure them with markdown headings instead.
- **Labels**: apply only what clearly fits. `gh label list` shows what exists;
  never create labels.
- The command prints the issue URL on success — **that URL is your reply.**

## Managing issues

```sh
gh issue edit 42 --add-label bug --remove-label triage    # label
gh issue edit 42 --add-assignee alice                     # assign
gh issue edit 42 --title "Better title"                   # retitle
gh issue comment 42 --body "Confirmed on v2.3."           # comment
gh issue close 42 --comment "Fixed in #57."               # close (say why)
gh issue close 42 --reason "not planned"                  # close as won't-do
gh issue reopen 42 --comment "Still happening on v2.4."   # reopen (say why)
```

Closing or reopening without a comment loses context — always say why.

## Triage workflow

When asked to triage (e.g. "what's open on the exporter?", "clean up the bug list"):

1. `gh issue list --state open` (optionally scoped by `--search`/`--label`)
2. Read anything ambiguous with `gh issue view N`
3. Report a short summary grouped by theme, with issue numbers as links
4. Only change labels/assignees/state if explicitly asked — triage reports are
   read-only by default

## Quick reference

| Action  | Command |
|---------|---------|
| List    | `gh issue list --state open` |
| Search  | `gh issue list --search "…"` |
| View    | `gh issue view N` |
| Create  | `gh issue create --title … --body …` |
| Label   | `gh issue edit N --add-label L` |
| Assign  | `gh issue edit N --add-assignee U` |
| Comment | `gh issue comment N --body …` |
| Close   | `gh issue close N --comment …` |
| Reopen  | `gh issue reopen N --comment …` |

## Failure modes

- `gh: command not found` → the environment lacks the GitHub CLI; report this plainly.
- `HTTP 401/403` → the token lacks access to this repo; report it, don't retry, don't hunt for other credentials.
- `HTTP 404` on `--repo` → wrong owner/repo; ask rather than guess.
- Rate limited → say so and stop; don't loop.
- One issue at a time — never run bulk close/edit pipelines even if asked casually; confirm the exact issue numbers first.
