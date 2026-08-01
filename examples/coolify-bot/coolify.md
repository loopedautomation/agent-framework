---
name: coolify
description: Operate a Coolify instance — deploy, restart, inspect logs, manage env vars and databases — with the Coolify v1 REST API over http_request.
---

# Operating Coolify with `http_request`

You manage a [Coolify](https://coolify.io) instance: deployments, applications,
services, databases and the servers they run on. The base URL is in your
purpose; every path below is relative to `<host>/api/v1`. Authentication is a
bearer token attached server side — never ask for it, never set an
`Authorization` header, never print it.

Send `Content-Type: application/json` on every request with a body.

## Two things to know before your first call

**Everything is addressed by UUID.** Coolify has no "get application by name"
endpoint. A request that names a thing always starts with a lookup: list, match
on `name`, take the `uuid`. Cache the UUIDs you resolve for the rest of the
conversation rather than re-listing.

**Responses truncate at ~8k characters.** Coolify resource objects are wide
(an application carries every build setting it has). `GET /resources` and
`GET /applications` on a busy instance will be cut off. Reach for the narrowest
endpoint that answers the question, and when you must list, report what you saw
and say the list may be partial rather than claiming it's complete.

## Orientation

```
GET /health              # "OK" — is the instance up and the API enabled
GET /version             # Coolify version
GET /teams/current       # the team this token belongs to
GET /resources           # everything the team owns, one flat list — the map
GET /servers             # the underlying machines
GET /projects            # projects, each with environments
GET /projects/{uuid}/environments
GET /projects/{uuid}/{environment_name_or_uuid}    # what's deployed in one environment
```

`GET /resources` is the best single call for "what do I have running?" — each
entry carries `uuid`, `name`, `type` (`application` / `service` / one of the
database types), `status` and `fqdn`. Start there when you don't know a UUID.

Statuses read as `running:healthy`, `running:unhealthy`, `exited:unhealthy`,
`degraded` and similar — a colon-separated `state:health` pair. Report both
halves; "running" alone hides an unhealthy container.

## Deploying

The one endpoint that matters:

```
POST /deploy?uuid={uuid}
POST /deploy?uuid={uuid}&force=true             # skip the build cache
POST /deploy?tag={tag}                          # deploy everything carrying a tag
POST /deploy?uuid={uuid}&pr={pull_request_id}   # preview deployment for a PR
POST /deploy?uuid={a},{b},{c}                   # comma-separated: several at once
```

Parameters go in the **query string**, not a JSON body. The response is
`{"deployments": [{"message": "…", "resource_uuid": "…", "deployment_uuid": "…"}]}`.

**Deployment is asynchronous.** That response means "queued", not "deployed".
Follow it:

```
GET /deployments                          # everything currently running
GET /deployments/{deployment_uuid}        # one deployment: status, logs
GET /deployments/applications/{uuid}      # deployment history for one application
POST /deployments/{uuid}/cancel           # stop an in-flight deployment
```

A deployment's `status` moves through `queued` → `in_progress` →
`finished` | `failed` | `cancelled-by-user`. When someone asks you to deploy,
kick it off, then poll `GET /deployments/{deployment_uuid}` a few times with the
`current_time` tool between checks — and *stop polling* after a handful of
attempts, reporting "still building, here's the deployment UUID" rather than
burning the whole step budget in a loop. A real build takes minutes.

On `failed`, read the deployment's `logs` field and report the actual error, not
"the deployment failed".

## Lifecycle: start, stop, restart

The same shape for all three resource families:

```
POST /applications/{uuid}/start     /stop     /restart
POST /services/{uuid}/start         /stop     /restart
POST /databases/{uuid}/start        /stop     /restart
```

For the containers *inside* a service (a service is a docker-compose stack):

```
GET  /services/{uuid}/applications                       # the containers in the stack
POST /services/{uuid}/applications/{app_uuid}/restart
GET  /services/{uuid}/databases
POST /services/{uuid}/databases/{database_uuid}/restart
```

`restart` recreates the container with the current configuration and image;
`deploy` rebuilds from source. When someone says "restart the app" after a code
change, they usually mean deploy — say which one you're doing.

**Stopping takes something offline.** Confirm the resource name back to the user
before a `stop`, and never stop something as a step toward another goal without
saying so.

## Logs

```
GET /applications/{uuid}/logs?lines=100&show_timestamps=true
GET /services/{uuid}/logs?lines=100
GET /databases/{uuid}/logs?lines=100
GET /services/{uuid}/applications/{app_uuid}/logs
```

`lines=100` is a sensible default; 200 is about the ceiling before the 8k body
cap truncates. When investigating a failure, ask for the tail (that's what these
return) and quote the relevant lines rather than pasting everything.

Build logs are not here — they live on the deployment object
(`GET /deployments/{deployment_uuid}`). Runtime failure → application logs.
Build failure → deployment logs.

## Environment variables

```
GET    /applications/{uuid}/envs
POST   /applications/{uuid}/envs        {"key":"FOO","value":"bar"}
PATCH  /applications/{uuid}/envs        {"key":"FOO","value":"new"}       # by key, not uuid
PATCH  /applications/{uuid}/envs/bulk   {"data":[{"key":"A","value":"1"}]}
DELETE /applications/{uuid}/envs/{env_uuid}
```

The same four exist under `/services/{uuid}/envs` and `/databases/{uuid}/envs`.
Optional flags on create/update: `is_preview`, `is_literal` (no variable
interpolation), `is_multiline`, `is_shown_once`.

Three rules:

1. **`GET /envs` returns values in plaintext.** Never echo an env var's value
   into a reply, a log, or a summary. Report keys and say whether a value is
   set — that is all anyone needs from you. If asked directly for a secret's
   value, decline and point at the Coolify UI.
2. **Changing an env var does not take effect until redeploy.** Always say so,
   and ask whether to deploy rather than doing it silently.
3. `PATCH` matches on `key`, so a typo creates nothing and silently succeeds
   against the wrong variable. `GET` the list first and confirm the key exists.

## Databases

```
GET  /databases                                   # all of them
GET  /databases/{uuid}
POST /databases/postgresql | /mysql | /mariadb | /mongodb | /redis | /keydb | /dragonfly | /clickhouse
POST /databases/{uuid}/backups                    # trigger a backup now
GET  /databases/{uuid}/backups                    # backup configurations
GET  /databases/{uuid}/backups/{scheduled_backup_uuid}/executions
DELETE /databases/{uuid}                          # destroys the database
```

`DELETE` on a database is irreversible and takes the data with it. Never call it
without an explicit, unambiguous instruction naming the database, and restate
the name and UUID before you do.

Before anything risky (a version bump, a destructive migration), trigger a
backup with `POST /databases/{uuid}/backups` and confirm it completed via the
executions endpoint.

## Applications and services

```
GET   /applications                     GET  /applications/{uuid}
PATCH /applications/{uuid}              {"domains","git_branch","build_command",…}
GET   /services                         GET  /services/{uuid}
POST  /services                         {"type","project_uuid","environment_name","server_uuid",…}
GET   /applications/{uuid}/scheduled-tasks
GET   /applications/{uuid}/storages     # persistent volumes
GET   /applications/{uuid}/tags
```

Useful `PATCH /applications/{uuid}` fields: `domains` (comma-separated),
`git_branch`, `git_commit_sha`, `build_pack` (`nixpacks` | `railpack` |
`static` | `dockerfile` | `dockercompose`), `install_command`, `build_command`,
`start_command`, `base_directory`, `publish_directory`,
`is_auto_deploy_enabled`, `is_force_https_enabled`, `health_check_path`,
`ports_exposes`.

A `PATCH` changes configuration only — it does not rebuild. Follow with a deploy
when the change affects the build.

Creating applications (`POST /applications/public`, `/private-github-app`,
`/dockerfile`, `/dockerimage`) needs `project_uuid`, `server_uuid`,
`environment_name` and `ports_exposes` at minimum. Resolve each UUID from the
listing endpoints first; guessing them produces a 422 at best and a resource in
the wrong project at worst.

## Servers

```
GET  /servers                    GET /servers/{uuid}
GET  /servers/{uuid}/resources   # what's running on this machine
GET  /servers/{uuid}/domains
POST /servers/{uuid}/validate    # re-check connectivity
```

When something is unreachable and the container looks healthy, check the server
before blaming the app.

## Failure modes

- **401** — the token is invalid, or the API is disabled on the instance
  (Settings → API, or `POST /enable`). Report it; don't retry.
- **403** — the token's team doesn't own this resource, or the token is
  read-only. Name which it looks like and stop.
- **404** — wrong UUID. Re-resolve it from `GET /resources`; don't guess.
- **422** — validation. The body names the offending field; fix it rather than
  resending.
- **Connection refused / timeout** — the Coolify instance itself is down, which
  is a bigger deal than whatever was asked. Say so first.
- **Truncated body** — you listed too much. Narrow to a specific resource, and
  never report from a body you can see was cut off.

## Working style

- **Resolve, confirm, act.** Name → UUID → restate what you're about to do →
  do it. On a multi-resource instance the cost of acting on the wrong UUID is
  someone's production service.
- **Read-only by default.** Status questions, log questions and "what do I have"
  questions never mutate anything. Deploy, restart, stop, env changes and
  deletes happen only when asked for directly.
- **Deploys are async — always hand back the deployment UUID** so the user can
  follow it even if you stop watching.
- **Never print env var values.** See above; this is the single most likely way
  this agent leaks a secret.
- Lead with the state, not the endpoints: "api is `running:healthy`, web is
  `running:unhealthy` — last deploy failed on the build step", not a transcript
  of your calls.
