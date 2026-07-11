---
name: qbittorrent
description: Queue and manage torrents through the qBittorrent Web API with http_request.
---

# Managing qBittorrent with `http_request`

You manage a qBittorrent server through its Web API. The server address is in
your purpose; every endpoint below goes under `<server>/api/v2/`. Responses
are JSON unless noted.

Authentication is handled outside of you: the server is configured to trust
requests from where you run (localhost bypass or an IP whitelist). Never ask
for a username or password, and never call `/auth/login` — you have no way to
hold its session cookie. If every request returns `Forbidden`, say that the
server's Web UI needs "Bypass authentication for clients on localhost" (or an
IP whitelist covering your address) and stop.

## Reading state

```
GET /api/v2/torrents/info?filter=all&limit=50
```

Filters: `downloading`, `completed`, `paused` (qBittorrent 5: `stopped`),
`errored`, `all`. Each entry's useful fields:

- `name`, `hash` (the id every action needs), `state`
- `progress` — 0 to 1; report it as a percentage
- `dlspeed` / `upspeed` — bytes per second; report as MB/s with one decimal
- `size`, `eta` (seconds; `8640000` means unknown, say "no estimate")
- `category`, `save_path`

```
GET /api/v2/transfer/info      # global dl_info_speed / up_info_speed, bytes/s
GET /api/v2/app/version        # server version, e.g. v5.0.2
```

## Adding a torrent

`POST /api/v2/torrents/add` with header
`Content-Type: application/x-www-form-urlencoded` and a form body:

```
urls=<url-encoded magnet link or .torrent URL>
```

URL-encode the value: magnet links contain `&` and will be cut short
otherwise. Optional fields, joined with `&`: `savepath=`, `category=`,
`paused=true` (queue without starting). The response body is `Ok.` on
success and `Fails.` when the server rejected it (usually a malformed
magnet or a duplicate).

## Acting on torrents

All actions are form-encoded POSTs taking `hashes=<hash>` (join several with
`|`, or the literal `all`):

```
POST /api/v2/torrents/stop        # qBittorrent 5; use /torrents/pause on 4.x
POST /api/v2/torrents/start       # qBittorrent 5; use /torrents/resume on 4.x
POST /api/v2/torrents/recheck
POST /api/v2/torrents/setCategory   # + category=<name>
POST /api/v2/torrents/delete        # + deleteFiles=false
```

qBittorrent 5 renamed pause/resume to stop/start; when one form returns 404,
use the other. A successful action returns an empty 200 — silence is success.

## Rules

- **Resolve names to hashes fresh, every time.** List first, match the name
  the person used, then act on the hash. Never act on a hash from memory.
- **Deleting is two different things.** `deleteFiles=false` removes the entry
  and keeps the data on disk. `deleteFiles=true` destroys the downloaded
  files; only send it when the person explicitly says to delete the files
  too, and repeat back what will be destroyed in your confirmation.
- Report tersely: name, state, percentage, speed. One line per torrent.
