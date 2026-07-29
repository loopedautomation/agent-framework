---
name: github-profile
description: Work across a whole GitHub account — notifications, cross-repo search, PR review queue, issues, releases, Actions — with the REST API over http_request.
---

# Working across a GitHub profile with `http_request`

You operate over one person's entire GitHub account, not a single repository.
Everything goes through `https://api.github.com`. Authentication is attached
server side — never ask for a token, never set an `Authorization` header, never
print one.

Send `Accept: application/vnd.github+json` on every call. Add
`X-GitHub-Api-Version: 2022-11-28` when you want to pin behaviour.

## The response-size rule (read this first)

`http_request` truncates response bodies at ~8k characters, and GitHub's
resource objects are enormous — a single repository is ~2k characters, a single
issue with its user objects is ~1.5k. A `per_page=100` list is *always*
truncated, and truncated JSON is worse than no JSON because it looks parseable.

So:

- **Default to `per_page=10`.** Go to 20 only for endpoints returning small
  objects (notifications, tags, labels, workflow runs). Never exceed 30.
- **Prefer search over list-then-filter.** `GET /search/issues?q=…` with a tight
  query beats pulling 100 issues and reading them.
- **Prefer GraphQL when you need many small fields across many objects.** One
  GraphQL call that selects five fields per node returns a fraction of what the
  equivalent REST list returns. See [GraphQL](#graphql-when-rest-is-too-fat).
- Paginate with `page=2,3,…` when the first page genuinely wasn't enough. Say so
  rather than silently reporting a partial answer.

## Who am I

```
GET /user                          → the authenticated account (login, name, plan)
GET /user/repos?per_page=10&sort=pushed&affiliation=owner
GET /user/orgs
GET /user/emails
```

`affiliation` is the profile-wide lever: `owner` (yours), `collaborator`,
`organization_member`, or a comma-separated combination. `sort=pushed` is
almost always what someone means by "my recent repos". `visibility=private`
narrows to private work.

Resolve `@me`-style references with `GET /user` once per conversation and reuse
the login; several endpoints below need it as a literal string.

## The inbox: notifications

This is the highest-value profile-wide surface — it is the single place where
"what needs me across everything" is answerable in one call.

```
GET /notifications?per_page=20                    # unread, subscribed threads
GET /notifications?all=true                       # include already-read
GET /notifications?participating=true             # only threads you're @-ed in or authored
GET /notifications?since=2026-07-01T00:00:00Z     # ISO 8601; also `before`
GET /repos/{owner}/{repo}/notifications           # scoped to one repo
```

Each thread has `id`, `reason` (`mention`, `review_requested`, `assign`,
`author`, `comment`, `ci_activity`, …), `unread`, `updated_at`, and a `subject`
with `title`, `type` (`Issue`, `PullRequest`, `Release`, …) and `url`.

`subject.url` is an **API** URL, not a web URL. To give the user a clickable
link, convert it: `https://api.github.com/repos/o/r/issues/42` →
`https://github.com/o/r/issues/42`. For a `PullRequest` subject the API url is
`/pulls/42` and the web url is `/pull/42` (singular). Get this right — a wrong
link is worse than no link.

Managing the inbox:

```
PATCH  /notifications/threads/{id}                # mark one thread read
DELETE /notifications/threads/{id}                # mark one thread done
PUT    /notifications  {"last_read_at": "…"}      # mark everything read
PUT    /notifications/threads/{id}/subscription {"ignored": true}
DELETE /notifications/threads/{id}/subscription   # unsubscribe
```

**Marking notifications read is destructive to the user's inbox and cannot be
undone.** Never do it as a side effect of reading. Only when explicitly asked,
and for a bulk `PUT /notifications`, confirm the exact scope first.

## Cross-repo search

Search is how you answer "anywhere in my account" questions. All searches use
[GitHub search syntax](https://docs.github.com/en/search-github) in `q`, and all
return `{total_count, incomplete_results, items}`.

```
GET /search/issues?q=is:open+is:pr+review-requested:LOGIN&per_page=10
GET /search/issues?q=is:open+assignee:LOGIN+archived:false&sort=updated&order=desc
GET /search/issues?q=is:open+author:LOGIN+is:pr+draft:false
GET /search/issues?q=is:issue+mentions:LOGIN+updated:>2026-07-01
GET /search/repositories?q=user:LOGIN+language:go&sort=updated
GET /search/code?q=TODO+user:LOGIN+language:ts        # requires a token with repo scope
GET /search/commits?q=author:LOGIN+committer-date:>2026-07-01
```

Qualifiers worth knowing: `user:`, `org:`, `repo:`, `is:open`/`is:closed`,
`is:pr`/`is:issue`, `author:`, `assignee:`, `mentions:`, `review-requested:`,
`reviewed-by:`, `label:`, `archived:false`, `draft:false`, `updated:>DATE`,
`created:YYYY-MM-DD..YYYY-MM-DD`, `sort:updated-desc`.

Two current behaviours to hold on to:

- **Issue search uses "advanced search" semantics by default** (since September
  2025). A space between multiple `repo:`/`org:`/`user:` qualifiers is **AND**,
  not OR. To OR them, use `repo:a/b OR repo:c/d` explicitly.
- URL-encode the query. `+` for spaces is fine; `>` `:` `/` inside qualifiers
  are fine unencoded in practice, but encode anything with `#` or `&`.
- Search is rate limited separately and much more tightly (30 req/min
  authenticated). Don't loop searches — compose one good query.

`GET /issues` and `GET /user/issues` are the non-search shortcuts for
"everything assigned to me across all repos"; they take
`filter=assigned|created|mentioned|subscribed`, `state`, `labels`, `sort`,
`since`. They're cheaper than search but can't express the interesting queries.

## Pull requests

```
GET  /repos/{o}/{r}/pulls?state=open&per_page=10&sort=updated&direction=desc
GET  /repos/{o}/{r}/pulls/{n}                     # includes mergeable, additions, deletions
GET  /repos/{o}/{r}/pulls/{n}/files?per_page=30   # patch per file — large, page carefully
GET  /repos/{o}/{r}/pulls/{n}/reviews
GET  /repos/{o}/{r}/pulls/{n}/comments            # inline review comments
GET  /repos/{o}/{r}/issues/{n}/comments           # top-level discussion (PRs are issues)
POST /repos/{o}/{r}/pulls  {"title","head","base","body","draft"}
POST /repos/{o}/{r}/pulls/{n}/reviews {"event":"COMMENT|APPROVE|REQUEST_CHANGES","body":"…"}
PATCH /repos/{o}/{r}/pulls/{n} {"title","body","state":"closed","base"}
PUT  /repos/{o}/{r}/pulls/{n}/merge {"merge_method":"squash|merge|rebase"}
```

`/pulls/{n}/files` returns a `patch` string per file and blows the 8k cap on
anything but a tiny diff. For reviewing real changes, ask for the file list
first (`per_page=30` gives you `filename`, `status`, `additions`, `deletions`
per file, and you can ignore `patch` truncation), then fetch individual files'
contents if you need them.

**Merging and closing are irreversible from the agent's side.** Confirm the repo
and number before either. Never merge on a casual instruction ("ship it") without
restating what you're about to merge.

## Issues

```
GET   /repos/{o}/{r}/issues?state=open&per_page=10&labels=bug&assignee=LOGIN
GET   /repos/{o}/{r}/issues/{n}
POST  /repos/{o}/{r}/issues {"title","body","labels":[],"assignees":[]}
PATCH /repos/{o}/{r}/issues/{n} {"state":"closed","state_reason":"completed|not_planned"}
POST  /repos/{o}/{r}/issues/{n}/comments {"body":"…"}
GET   /repos/{o}/{r}/labels?per_page=30
```

`GET /repos/{o}/{r}/issues` **includes pull requests** — every PR is an issue.
Filter them out by checking for the `pull_request` key on each item, or use
`/search/issues?q=…+is:issue`.

Always search before creating: `GET /search/issues?q=repo:o/r+is:issue+<terms>`.
Replying with an existing issue link beats filing a duplicate.

## Actions

```
GET  /repos/{o}/{r}/actions/runs?per_page=10&status=failure&branch=main
GET  /repos/{o}/{r}/actions/runs/{run_id}
GET  /repos/{o}/{r}/actions/runs/{run_id}/jobs
POST /repos/{o}/{r}/actions/runs/{run_id}/rerun
POST /repos/{o}/{r}/actions/runs/{run_id}/rerun-failed-jobs
GET  /repos/{o}/{r}/actions/workflows
POST /repos/{o}/{r}/actions/workflows/{id}/dispatches {"ref":"main","inputs":{}}
```

`status` accepts `queued`, `in_progress`, `completed`, plus the conclusions
`success`, `failure`, `cancelled`, `timed_out`, `action_required`. A run's
`conclusion` is `null` while `status` is not `completed` — report "still
running", never "passed".

Job logs are served as a redirect to a signed URL and `http_request` does not
follow redirects, so you cannot read raw logs this way. Use the jobs endpoint's
`steps[]` (each has `name`, `status`, `conclusion`) to say *which step* failed,
and hand the user the run's `html_url` for the log itself. If the CLI variant of
this agent is running, `gh run view --log-failed` gets you the actual text.

For "is CI green across my repos", combine
`/search/repositories?q=user:LOGIN+sort:updated` with a runs call per repo — and
cap it. Five repos, not fifty.

## Releases, tags, commits, content

```
GET  /repos/{o}/{r}/releases?per_page=10
GET  /repos/{o}/{r}/releases/latest
POST /repos/{o}/{r}/releases {"tag_name","name","body","draft","prerelease","generate_release_notes":true}
POST /repos/{o}/{r}/releases/generate-notes {"tag_name","previous_tag_name"}
GET  /repos/{o}/{r}/commits?per_page=10&since=…&author=LOGIN&sha=main
GET  /repos/{o}/{r}/compare/{base}...{head}      # commits + files between two refs
GET  /repos/{o}/{r}/contents/{path}?ref=main     # base64 `content`, or a dir listing
```

`generate_release_notes: true` on release creation writes the changelog for you
from merged PRs — prefer it over composing notes by hand.

`/contents/{path}` returns base64 in `content` for files under 1MB; for anything
larger it returns metadata with a `download_url` instead. A directory path
returns an array of entries, which is the cheapest way to explore a repo layout.

## Gists, stars, and the rest of the profile

```
GET  /gists?per_page=10           POST /gists {"files":{"a.md":{"content":"…"}},"public":false}
GET  /user/starred?per_page=10    PUT/DELETE /user/starred/{o}/{r}
GET  /users/{login}/events/public?per_page=20      # public activity timeline
GET  /repos/{o}/{r}/subscription  PUT /repos/{o}/{r}/subscription {"subscribed":true}
```

## GraphQL when REST is too fat

For "across everything" questions, one GraphQL call is often the only thing that
fits in 8k. `POST https://api.github.com/graphql` with
`{"query": "...", "variables": {...}}`:

```graphql
query {
  viewer {
    login
    pullRequests(states: OPEN, first: 20, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { title url isDraft repository { nameWithOwner } reviewDecision }
    }
  }
}
```

Select only the fields you'll report. GraphQL shares the same token and the same
attached credential; errors come back as HTTP 200 with an `errors` array, so
check for it rather than trusting the status code.

## Rate limits

```
GET /rate_limit        # free; does not consume quota
```

5,000 requests/hour authenticated for core, 30/minute for search. Responses
carry `x-ratelimit-remaining` and `x-ratelimit-reset` (Unix seconds).

A `403` with `x-ratelimit-remaining: 0`, or a `429`, means rate limited: say so
and stop. Do not retry in a loop. A `403` with quota remaining is a permissions
problem — the token lacks the scope — and retrying will not fix that either.

## Failure modes

- **401** — the token is invalid or expired. Report it plainly; don't hunt for
  other credentials.
- **403** with quota left — missing scope. Name the scope you think is needed
  (`repo` for private repos and code search, `workflow` for Actions dispatch,
  `notifications` for the inbox, `gist` for gists) and stop.
- **404** on a repo you believe exists — usually a private repo the token can't
  see, or a typo in `owner/repo`. Ask rather than guessing at the owner.
- **422** — validation failed. The body's `errors[]` says which field; read it
  and fix the request rather than retrying the same payload.
- **Truncated body** — you asked for too much. Re-request with a smaller
  `per_page` or fewer fields via GraphQL. Never parse or report from a body you
  can see was cut off.

## Working style

- **One repo at a time unless told otherwise.** "Check my repos" means the
  handful that are actually active (`sort=pushed`), not every repo on the
  account. Say which ones you looked at.
- **Read before you write.** Search for the existing issue, read the PR before
  reviewing it, check the run before rerunning it.
- **Never bulk-mutate.** No loops that close issues, merge PRs, mark
  notifications read, or unsubscribe from threads. If a bulk action is genuinely
  wanted, list exactly what would be affected and get confirmation first.
- **Links are the deliverable.** Every issue, PR and run object carries
  `html_url` — use it verbatim rather than composing URLs by hand.
- Report what you did, not how you did it. The user wants "3 PRs need your
  review: …", not a description of the endpoints you called.
