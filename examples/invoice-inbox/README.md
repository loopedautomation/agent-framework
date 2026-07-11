# Deploying invoice-inbox

Goal: an email address that does something. Mail sent or forwarded to `invoices@agents.example.com` wakes the agent, it pulls the vendor, amount, currency and due date out of the message into [persistent memory](../../docs/memory.md), and a one-line confirmation comes back. Ask it "what's due this month?" and it answers from what it has filed. Budget ~15 minutes plus DNS propagation.

This is the smallest useful shape of the [Resend transport](../../docs/email.mdx): Resend receives mail for your domain and delivers each message to the agent as a signed webhook, and the purpose says what happens next. Swap the invoice instructions for your own and the same three files run a different inbox.

## What you need before starting

- A domain (or a subdomain like `agents.example.com`) whose inbound mail you can point at [Resend](https://resend.com), and a Resend account
- A public HTTPS endpoint in front of the container's port 8080; unlike the chat triggers, a webhook has to be reachable from the internet
- An OpenAI API key

## 1. Point the mail at Resend (~5 min plus DNS)

1. Add your domain in Resend and follow their [receiving setup](https://resend.com/docs/dashboard/receiving/introduction); the MX records route the domain's inbound mail to them.
2. Create a webhook for the `email.received` event pointing at your public URL for the agent, e.g. `https://agents.example.com/email`. The signing secret is `RESEND_WEBHOOK_SECRET`.
3. Create an API key with sending access; this is `RESEND_API_KEY`. The trigger uses it to fetch message bodies and to send the confirmation replies.
4. In `agent.yaml`, set `from_addresses` to the senders you expect. The check runs before the model is called, so it is also the cost gate.

## 2. Deploy (~5 min)

In this directory:

```sh
cp .env.example .env     # fill in the three values; never commit .env
docker compose up -d
```

There is no Dockerfile: the agent replies through the trigger and files things into memory, so the stock image runs with `agent.yaml` mounted onto it.

## 3. Verify

```sh
docker compose ps                # should say "healthy" after ~15s
curl -s localhost:9092/healthz   # identity JSON
```

Then email the address something invoice-shaped:

> **Amin:** *(forwards a hosting invoice)*
> **invoice-inbox:** Filed: CloudHost, $42.00, due 2026-08-01.
>
> **Amin:** what's due this month?
> **invoice-inbox:** CloudHost - $42.00 due 2026-08-01.

Mail that isn't an invoice produces no reply at all: the purpose tells the agent to answer `__NO_REPLY__` and `allow_silence: true` makes the trigger send nothing. The run still lands in the run history (`curl -s localhost:9092/runs`), so you can see what it decided and why.

## How it holds up

- The trigger acknowledges each webhook immediately and runs the agent afterwards, because Resend retries slow endpoints and a retried webhook would mean a duplicate run. The reply email is the delivery channel.
- Attachments don't reach the agent yet; it sees filenames and sizes only. An invoice that lives entirely in an attached PDF gets filed with whatever the covering mail says.
- Every filed invoice is a memory write in the [audit trail](../../docs/docker-run.md), and the `invoice-inbox-data` volume is where all of it lives. Deleting the volume deletes the ledger.
- There is no `permissions:` block, so the worst a crafted mail can do is write a junk memory you can ask the agent to forget.
