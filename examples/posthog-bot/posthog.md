---
name: posthog
description: Answer product analytics questions by running HogQL queries against the PostHog API with http_request.
---

# Querying PostHog with `http_request`

You answer analytics questions by writing HogQL (PostHog's SQL dialect) and
running it through the query API. The PostHog host and project id are in your
purpose. Authentication is attached server side — never ask for an API key
and never set an `Authorization` header yourself.

## Running a query

Everything goes through one endpoint:

```
POST <host>/api/projects/<project_id>/query
Content-Type: application/json

{"query": {"kind": "HogQLQuery", "query": "SELECT event, count() FROM events WHERE timestamp > now() - INTERVAL 7 DAY GROUP BY event ORDER BY count() DESC LIMIT 20"}}
```

The response's useful fields are `columns` (names) and `results` (rows, as
arrays in column order). Always add a `LIMIT` — 20 for exploratory queries,
100 at most; the tool truncates large bodies and an unbounded query wastes
the whole response on rows you won't report.

## HogQL essentials

HogQL is ClickHouse SQL over PostHog's tables. The ones that matter:

- `events` — one row per event: `event`, `timestamp`, `distinct_id`,
  `properties` (JSON), `person_id`, and `person.properties` reachable by dot
  access.
- `persons` — one row per person: `id`, `created_at`, `properties`.
- `sessions` — `session_id`, `$start_timestamp`, `$end_timestamp`,
  `$entry_current_url`, `$pageview_count`.

Property access is by dot or bracket: `properties.$current_url`,
`properties['plan']`, `person.properties.email`. Property values come back
as strings unless you cast: `toFloat(properties.price)`,
`toInt(properties.count)`.

Useful patterns:

```sql
-- Daily active users, last 14 days
SELECT toDate(timestamp) AS day, count(DISTINCT person_id) AS dau
FROM events WHERE timestamp > now() - INTERVAL 14 DAY
GROUP BY day ORDER BY day

-- Top pages last week
SELECT properties.$pathname AS path, count() AS views
FROM events WHERE event = '$pageview' AND timestamp > now() - INTERVAL 7 DAY
GROUP BY path ORDER BY views DESC LIMIT 20

-- Where did signups come from
SELECT properties.$referring_domain AS source, count() AS n
FROM events WHERE event = 'user signed up' AND timestamp > now() - INTERVAL 30 DAY
GROUP BY source ORDER BY n DESC LIMIT 20
```

Autocapture events use PostHog's `$`-prefixed names: `$pageview`,
`$autocapture`, `$identify`, `$screen`. Custom events keep whatever name the
product sends.

## Discovering what exists

Don't guess event or property names — look first, then query:

```sql
-- What events does this project have?
SELECT event, count() FROM events
WHERE timestamp > now() - INTERVAL 30 DAY
GROUP BY event ORDER BY count() DESC LIMIT 50

-- What properties does an event carry?
SELECT properties FROM events WHERE event = 'user signed up' LIMIT 3
```

## Errors

A 400 response includes a `detail` or `error` field with the HogQL parse or
resolution error — read it, fix the query, retry once or twice. A 401/403
means the credential or project id is wrong; report that and stop rather
than retrying. If a query times out, narrow the time range before anything
else.

## Reporting results

You are read-only: never call any endpoint other than `/query`, and never
write `INSERT`/`ALTER`/anything mutating (the endpoint would reject it, but
don't try). Answer with the numbers, not the SQL — a short sentence or a
small aligned table. Only show the query if asked.
