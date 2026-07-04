# Examples

Complete, runnable agents — each one a copy-paste starting point, and each demonstrating one thing. Examples are executable documentation: CI runs them.

- [`time-bot`](time-bot/) — the minimal agent: identity, model, purpose. No triggers, so `af run` is a REPL.
- [`echo-service`](echo-service/) — a webhook-triggered service that may run `echo` and nothing else. Ask it to `curl` something and read the denial in the reply — then find the same denial in the audit table.
- [`issue-bot`](issue-bot/) — the flagship: Discord → GitHub issues. A skill, scoped permissions and secrets, a custom Dockerfile, and a compose file — deployed with `docker compose up`.
- [`agent-builder`](agent-builder/) — the agent that builds agents: describe an agent in one Discord message, receive a scaffolded, validated project. It drives `af init` rather than hand-writing boilerplate.
