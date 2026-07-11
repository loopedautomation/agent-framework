# Examples

Complete, runnable agents. Each one is a copy-paste starting point that demonstrates one thing, and CI runs them, so they double as executable documentation.

- [`time-bot`](time-bot/) - the minimal agent: identity, model, purpose. No triggers, so `af run` is a REPL.
- [`gh-issues-cli`](gh-issues-cli/) - the flagship: Discord to GitHub issues. A skill teaching the `gh` CLI, scoped permissions and secrets, a custom Dockerfile and a compose file, deployed with `docker compose up`.
- [`agent-zero`](agent-zero/) - the agent that builds agents: describe an agent in one Discord message, receive a scaffolded, validated project. It drives `af init` rather than hand-writing boilerplate.
- [`mail-assistant`](mail-assistant/) - a personal email + calendar assistant: forwarded mail wakes it (email trigger via Resend), cron ticks make it check the calendar's ICS feed, it emails you meeting reminders and keeps a spam list in persistent memory.
- [`rememberall-bot`](rememberall-bot/) - a Telegram memory keeper: tell it things, ask for them back later, and have it remind you at a time you name. Persistent memory plus agent-created schedules, with a Coolify deployment path in the README.
- [`qbit-bot`](qbit-bot/) - a torrent butler on Telegram: paste a magnet link, ask what's downloading, get told when it finishes. A skill teaches the qBittorrent Web API; `http_request` against one allowlisted host is the whole capability.
