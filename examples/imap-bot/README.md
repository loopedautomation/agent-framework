# Deploying imap-bot

Goal: a mailbox that answers itself. The agent signs into `helpdesk@example.com` over IMAP, and mail from the team wakes it: questions get answered from its [persistent memory](../../docs/memory.md), and mail that teaches it something ("remember: the wifi password is...") updates that memory for the next person who asks. Budget ~15 minutes; the mailbox is the whole integration.

This is the [pulled transport](../../docs/email.mdx#watching-a-mailbox-the-pulled-transports) shape: the agent connects outward, polls for unread mail, marks it read when it's done and replies over SMTP in the same thread. No domain setup, no webhook, no public endpoint. Any provider that issues app passwords works; for a mailbox on Gmail or Outlook, swap the trigger for the `gmail` or `outlook` transport per the [email docs](../../docs/email.mdx) and the rest of the file stays as it is.

## What you need before starting

- A dedicated mailbox for the agent (e.g. `helpdesk@example.com`) with IMAP access and an app password
- An OpenAI API key

## 1. Give the agent the mailbox (~5 min)

1. Create the mailbox with your mail provider and generate an app password; this is `IMAP_PASSWORD`.
2. In `agent.yaml`, set `host`, `smtp_host` and `username` to your provider's values (the example uses Fastmail-shaped names; ports default to 993 and 465 with implicit TLS).
3. Set `from_addresses` to your team's domain or addresses. Replies go back to the sender, so this list decides who the agent corresponds with; leaving it open would have it answering strangers on your behalf.

The mailbox should belong to the agent alone. The unread flag is its cursor, so a human reading mail in the same inbox takes messages away from it.

## 2. Deploy (~5 min)

In this directory:

```sh
cp .env.example .env     # fill in the two values; never commit .env
docker compose up -d
```

There is no Dockerfile and no published trigger port: the agent polls outward, so nothing on the internet needs to reach the container.

## 3. Verify

```sh
docker compose ps                # should say "healthy" after ~15s
curl -s localhost:9095/healthz   # identity JSON
```

Then teach it something and ask for it back, from two different people if you can:

> **Ratul:** remember: the office wifi password is duckling-crumpet-42
> **imap-bot:** Saved under "office wifi password".
>
> **Happy:** what's the wifi password?
> **imap-bot:** duckling-crumpet-42.
>
> **Gwinyai:** how do I claim expenses?
> **imap-bot:** I don't have anything on expenses yet. If you find out, mail it to me and I'll have it for the next person.

Persistent memory is visible from every conversation, so what Ratul teaches it, Amin gets back. Automated notices and misdirected threads produce no reply at all: the purpose tells the agent to answer `__NO_REPLY__` and `allow_silence: true` makes that real.

## How it holds up

- The mailbox is the cursor. A restarted container picks up where it left off with no local state, and a crash between the run and the read-mark costs one duplicate reply.
- Reminder of what the fences are: `from_addresses` runs before the model is called, auto-generated mail (out-of-office replies, list mail) is dropped by the trigger, and the `limits` block caps what any one run can spend.
- The knowledge base, history and audit trail all live in the `imap-bot-data` volume; the mailbox itself holds only the correspondence. Deleting the volume deletes what the team taught it.
- There is no `permissions:` block, and the mailbox credentials belong to the trigger, so the model never sees them. The worst a crafted mail can do is write a junk memory or ask for one back, and the purpose tells the agent to keep memories to the questions they answer.
