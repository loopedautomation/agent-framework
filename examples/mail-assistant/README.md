# Deploying mail-assistant

A personal email + calendar assistant: mail you forward to it wakes it, cron ticks make it check your calendar, and it reaches you by sending email of its own. It keeps a spam list in persistent memory and reminds you before meetings. The design reasoning lives in the [email assistant guide](../../docs/email-assistant.mdx); this README is the setup.

## Prerequisites

- A domain (or subdomain, e.g. `agents.example.com`) you can point at [Resend](https://resend.com), and a Resend account.
- A public HTTPS endpoint for the agent's webhook - a reverse proxy or tunnel in front of port 8080.
- A calendar that publishes a secret ICS address (Google Calendar: Settings → your calendar → "Secret address in iCal format").
- An OpenAI-compatible API key for the model.

## Setup

1. **Resend receiving.** Add your domain in Resend and follow their [receiving setup](https://resend.com/docs/dashboard/receiving/introduction) - the MX records route the domain's inbound mail to them. Pick the agent's address, e.g. `assistant@agents.example.com`.
2. **Webhook.** In Resend, create a webhook for the `email.received` event pointing at your public URL for the agent, e.g. `https://agents.example.com/email`. Copy the signing secret into `RESEND_WEBHOOK_SECRET`.
3. **API key.** Create a Resend API key with sending access; it goes in `RESEND_API_KEY`. The trigger uses it to fetch message bodies and send replies, and the agent uses it (through the skill's `curl` call) to send you reminders.
4. **Calendar.** Copy the secret ICS address into `CALENDAR_ICS_URL`. Treat it like a password - anyone holding it can read that calendar - and rotate it from calendar settings if it ever leaks.
5. **Addresses.** Edit `agent.yaml`: replace `ratul@example.com` (the operator) and `assistant@agents.example.com` (the agent's sending address) with yours, in both the `purpose` and the skill file.
6. **Forwarding filters.** In your mail provider, create filters that forward the mail you want the agent to see to its address. In Gmail: Settings → Forwarding and POP/IMAP → add the agent's address as a forwarding address (Gmail sends it a confirmation mail - check the agent's [run history](http://localhost:9092/runs) or the Resend dashboard for the confirmation link), then build filters with "Forward to". Start narrow: one sender, one subject keyword.

Then, in this directory:

```sh
cp .env.example .env     # fill in the four values; never commit .env
docker compose up -d --build
```

## Verify

```sh
docker compose ps                   # should say "healthy" after ~15s
curl -s localhost:9092/healthz      # identity JSON - note the agent's chosen name
docker compose logs -f              # "email trigger listening on :8080/email"
```

Email something matching one of your filters, or mail the agent's address directly:

> spam: newsletter@some-vendor.com

You should get a one-line confirmation back, and `curl -s localhost:9092/runs` shows the run. The next reminder tick (every 15 minutes on weekday working hours) checks your calendar; the morning tick (07:30) sends the briefing.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Webhook deliveries fail in the Resend dashboard | The endpoint isn't reachable over HTTPS, or the path isn't `/email` |
| Deliveries show 401 | `RESEND_WEBHOOK_SECRET` doesn't match the webhook's signing secret |
| Runs happen but no reply arrives | Sending address not on a verified Resend domain, or `RESEND_API_KEY` lacks sending access |
| Reminders never fire | `CALENDAR_ICS_URL` wrong or stale, or the events are outside the cron window (weekdays 7-18) |
| Reminder times look shifted | The feed's times are UTC; tell the agent your timezone in `purpose` |
| Container exits at startup naming an env var | That variable is missing from `.env` - the boot fails ahead of the first message on purpose |

Every message it acts on, every send and every memory update lands in the run history and audit trail (`curl -s localhost:9092/runs`, `/audit`). The spam list survives restarts in the `mail-assistant-data` volume; deleting that volume clears memory, history and the agent's chosen name.
