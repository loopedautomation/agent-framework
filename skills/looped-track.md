---
name: looped-track
description: Log and manage time, projects, tags and todos through the Looped Track API with http_request.
---

# Looped Track with `http_request`

You keep someone's timesheet in Looped Track through the public Looped API.
Everything below hangs off `https://api.looped.sh/v1/track`. Responses are
JSON.

Authentication is handled outside of you: the runtime attaches the team's
API key to every request to that host. Never ask for a key, never put one in
a URL, and never send a `teamId` — the key already carries the team.

Each route needs a scope on that key: `read:time` / `write:time`,
`read:project` / `write:project`, `read:tag` / `write:tag`, `read:todo` /
`write:todo`. A `403` names what's missing:

```json
{ "error": "Forbidden", "required": ["write:time"], "missing": ["write:time"] }
```

Say which scope the key needs and stop. Retrying will not help.

## The shape of the data

A team owns **projects**; a project owns **sections**; a **time entry**
belongs to a user and optionally points at a project and a section.
**Tags** are team-wide labels you attach to entries. **Todos** are a
separate list that can also point at a project or section.

Clients and invoices are *not* in Track — they live under `/v1/invoices`.

## Logging time

```
POST /v1/track/time
{
  "taskName": "Homepage redesign",
  "durationSeconds": 9000,
  "date": "2025-01-15T00:00:00Z",
  "projectId": "clx…",
  "description": "Hero section and nav",
  "tags": [{ "id": "clt…", "title": "design" }]
}
```

Two things trip everyone up:

- **`durationSeconds` is seconds.** The Track UI shows hours — the API does
  not. "2.5 hours" is `9000`. It must be a positive integer.
- **`date` is stored as a calendar date.** Send ISO 8601, but the time of
  day is dropped on write. Don't promise someone that an entry landed at
  09:30.

`taskName` is required (1–255 chars); `description` caps at 1000.
`projectId`, `sectionId` and `tags` are optional — note that tags are
`{id, title}` objects here, not bare ids.

Add `userId` only to log on someone else's behalf. It requires OWNER or
ADMIN on the key; on a member's key the call fails.

Success is `201`:

```json
{ "success": true, "data": "Time added", "time": { "id": "clm…", … } }
```

## Reading entries

```
GET /v1/track/time?date=2025-01-15&frequency=week
```

`date` is **required** — there is no unfiltered list. `frequency` decides
the window around it:

| `frequency` | Window |
|---|---|
| `day` | that calendar day |
| `week` | the 7 days **ending** on `date` (trailing, not Mon–Sun) |
| `month` | the calendar month containing `date` |
| omitted | same as `week` — a trailing 7 days |

The response is a bare array of entries. Each carries `id`, `taskName`,
`durationSeconds`, `date`, `description`, `projectId`, `sectionId`,
`userId`, `aiGenerated`, plus an expanded `project` (`id`, `title`, `code`,
`status`, `rate`) and `user` when known. Sum `durationSeconds` yourself for
totals; there is no totals endpoint.

`GET /v1/track/time/{id}` returns one entry, or `404` if it isn't yours.

## Fixing entries

```
PATCH  /v1/track/time/{id}     # any subset of the create fields
DELETE /v1/track/time/{id}
```

`PATCH` returns `{ "success": true, "data": "Update Successful", "time": {…} }`,
`DELETE` returns `{ "success": true, "data": "Time deleted" }`. Both `404`
when the entry doesn't exist or belongs to a teammate you can't touch.
Passing `userId` to `PATCH` moves the entry to another person — OWNER/ADMIN
only, same as on create.

## Projects

```
GET    /v1/track/projects
POST   /v1/track/projects        { "title": "Acme redesign", "code": "ACME" }
PUT    /v1/track/projects/{id}   { "id": "clx…", "data": { "status": "COMPLETED" } }
DELETE /v1/track/projects/{id}
```

The list comes back as `{ "data": [...], "pagination": {...} }` — and the
gateway forwards no query parameters, so **you always get the first page of
10**. On a team with more projects than that, a name you're looking for may
simply not be in the response. If the project the person named isn't there,
say you couldn't find it and ask for the project code rather than logging
against the wrong one or against nothing.

`POST` returns `{ "success": true, "data": "Project added" }` — **no id**.
List again to find the project you just made. A duplicate `code` is a `409`.

`PUT` takes the id in *both* the path and the body, with the changes nested
under `data`. Fields: `title`, `code`, `status` (`PENDING`, `ACTIVE`,
`COMPLETED`, `ARCHIVED`).

`DELETE` is refused with `400` while the project has any time entries:
`"Cannot delete project with associated time entries"`. Reassign or delete
those first — and check with the person before you do.

## Sections

```
GET    /v1/track/sections?projectId=clx…    # projectId is required
POST   /v1/track/sections                   { "title": "Phase 2", "projectId": "clx…" }
PUT    /v1/track/sections/{id}              { "title": "Phase 3" }
DELETE /v1/track/sections/{id}
```

`GET` returns a bare array. `POST` returns `201` with
`{ "success": true, "data": { … } }`, or a `409` carrying `success: false`
and `existingSection` when that title is already used in the project —
reuse the id it hands back rather than retrying.

Deleting a section is *not* blocked by time entries the way a project is:
the entries survive with `sectionId` set to null. Say that out loud before
you do it.

## Tags

```
GET    /v1/track/tags
POST   /v1/track/tags        { "title": "design" }
PATCH  /v1/track/tags/{id}   { "title": "design-ops" }
DELETE /v1/track/tags/{id}
```

`POST` is idempotent and case-insensitive: an existing tag comes back as
`200` with `{ "success": true, "tag": {…}, "message": "Tag already exists" }`
instead of an error. A new one is `201`. Either way you get the id you need
for a time entry's `tags` array.

## Todos

```
GET    /v1/track/todos?filter=active
POST   /v1/track/todos
GET    /v1/track/todos/{id}
PATCH  /v1/track/todos/{id}
DELETE /v1/track/todos/{id}
```

`filter` is `all` (default), `active` or `completed`. With
`filter=completed` three extras apply: `count=true` returns `{ "total": n }`,
`unlogged=true` returns only completed todos with no time logged against
them, and `limit`/`offset` switch the response to
`{ items, total, nextOffset }`. Otherwise it's a bare array.

Create and update take `title` (1–255), `description` (≤2000), `projectId`,
`sectionId`, `priority` (`P1` highest to `P4`), `dueDate` (ISO 8601 **with
an offset**), `tagIds` (bare ids here, unlike time entries), and
`recurrence`:

```json
{ "freq": "WEEKLY", "interval": 1, "weekdays": [1, 3] }
```

`weekdays` is 0=Sunday…6=Saturday and only applies to `WEEKLY`; send
`recurrence: null` to make a repeating todo one-off.

`PATCH` with `completed: true` on a recurring todo **spawns the next
occurrence** and returns it as `nextOccurrence`. Mention the new due date;
don't then "complete" the fresh one.

`PATCH` and `DELETE` also work against the collection with `todoId` in the
body, if a path parameter is awkward.

## What isn't there

- **No timers.** There is no start/stop endpoint — Track's public API is
  duration-based entries only. If someone asks you to start a timer, say
  so and offer to log the time when they're done.
- **No reports or rates endpoints.** Project `rate` comes back on entries
  you read, but reporting lives in the Track app. Aggregate the entries
  yourself and say that's what you did.

## Rules

- **Resolve names to ids fresh, every time.** List projects, sections or
  tags, match the name the person used, then act on the id. Never reuse an
  id from earlier in the conversation and never invent one.
- **Do the seconds conversion explicitly and echo it back.** "Logged 2h 30m
  (9000s) on Acme redesign, Wed 15 Jan." A silent factor-of-60 mistake is
  the worst thing you can do here.
- **Confirm before deleting or overwriting.** Say which entry, its date and
  its duration, and wait.
- **Don't send `userId`** unless the person is explicitly logging for
  someone else. It quietly demands OWNER/ADMIN.
- One line per entry when you report. Date, duration, task, project.

## Failure modes

| Response | Means |
|---|---|
| `400` with a field name | Zod rejected the body — usually `durationSeconds` non-positive, missing `date` on the list call, or an over-length `taskName` |
| `401 Invalid API key` / `expired` / `revoked` | The key is bad. Report which; don't retry |
| `403` with `missing` | The key lacks that scope. Name it and stop |
| `404 Time entry not found` | Wrong id, or it belongs to a teammate |
| `409 Project code already exists` | Pick another `code` |
| `400 Cannot delete project with associated time entries` | Reassign the entries first |

## Using this skill

```yaml
skills:
  - ./skills/looped-track.md

permissions:
  net: [api.looped.sh]

http:
  auth:
    - url: https://api.looped.sh
      header: X-API-Key
      value: ${LOOPED_API_KEY}   # looped_… key from Settings → API Keys
```

The key is attached after the tool call, so it never reaches your context.
