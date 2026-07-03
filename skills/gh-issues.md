---
name: gh-issues
description: Create and manage GitHub issues with the gh CLI.
---

# Managing GitHub issues with `gh`

You have the GitHub CLI available through `run_bash`. It authenticates via the
`GITHUB_TOKEN` environment variable — never ask for credentials.

## Creating an issue

```sh
gh issue create --repo OWNER/REPO \
  --title "Short, searchable title" \
  --body "Everything the reporter said, structured. Include repro steps if given." \
  --label bug
```

- Titles: specific and searchable ("CSV export fails on files over 10MB"), never vague ("bug in export").
- Bodies: capture *everything* the reporter said; don't summarize away details. Use markdown headings/lists.
- Labels: only apply labels that clearly fit; skip when unsure. Check available labels with `gh label list --repo OWNER/REPO` if needed.
- The command prints the issue URL on success — that URL is your reply.

## Other operations

```sh
gh issue list --repo OWNER/REPO --state open --search "exporter"   # find issues
gh issue view 42 --repo OWNER/REPO                                 # read one
gh issue close 42 --repo OWNER/REPO --comment "why it's closed"    # close
gh issue edit 42 --repo OWNER/REPO --add-label bug                 # label
gh issue comment 42 --repo OWNER/REPO --body "..."                 # comment
```

## Failure modes

- `gh: command not found` → the environment is missing the GitHub CLI; report this plainly.
- HTTP 401/403 → the token lacks access; report it, don't retry.
- Always check the search results before creating an issue someone describes as "the same as before" — link the existing issue instead of duplicating it.
