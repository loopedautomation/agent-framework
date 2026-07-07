# Plan 7 — Email triggers

An email address is the one inbox every business already has. Invoices land there, support requests land there, statements and notices from providers land there. If incoming mail can wake an agent, a whole class of back-office jobs collapses into one agent file: watch the mailbox, act on what arrives and maybe reply. This plan covers how mail becomes a trigger.

Status: design; implementation has not started. The roadmap (Plan 3) has carried "email" on its later list since the beginning; this plan makes it concrete.

## The trigger wakes the agent; tools do the rest

We keep the trigger's job narrow. An email trigger watches for new messages, turns each qualifying one into an `AgentEvent` and carries the agent's reply back as an email. Everything else the agent might do with a mailbox, searching old threads, adding labels, moving messages into folders, comes in through tools: a mail CLI in the image plus a skill, or an MCP server. This split keeps the trigger about the size of `discord.ts` and means the same trigger serves both shapes of agent, the one that files invoices silently and the one that answers support mail.

## Mail arrives in one of two ways

**Pushed.** An inbound-mail provider (Resend, Postmark, Mailgun, SES) receives mail for a domain whose MX records point at it, parses the MIME and POSTs the message as JSON to an HTTP endpoint, signing each request. The framework already knows this shape: the webhook trigger serves HTTP with `Deno.serve`, checks a secret with a timing-safe compare and emits an event. An inbound-email transport is that plus a provider-specific signature check and payload parser.

**Pulled.** The trigger signs into a mailbox that already exists and polls it: IMAP for anything self-hosted or app-password friendly, the Gmail API and Microsoft Graph for the two big hosted providers. The Telegram trigger is the template here, a long-poll loop with a cursor, exponential backoff on errors and an `AbortController` for shutdown.

We ship pushed first. It needs no OAuth, no polling cursor and no MIME parsing (the provider did that work), so it is a short step from the existing webhook trigger, and it covers the "give the agent its own address" case: point `invoices@yourco.com` at Resend, route it to the agent, done. Pulled comes second, because watching a mailbox that already exists (your actual Gmail) is the ask that makes this feature matter to people who won't set up MX records.

## The shape in config

One `type: email` with a `transport` discriminator inside it. The options an operator actually reasons about (who may write to the agent, whether it replies) are shared across transports, and "email" is the concept being configured; the transport is plumbing. In `schema.ts` this is a nested discriminated union on `transport`, same drift-guard treatment as the existing triggers.

```yaml
triggers:
  - type: email
    transport: resend
    path: /email                        # served by the trigger's HTTP listener
    signing_secret_env: RESEND_WEBHOOK_SECRET
    api_key_env: RESEND_API_KEY         # used to send replies
    from_addresses: ["ratul@looped.sh", "amin@looped.sh"]
    allow_silence: true
```

And the pulled flavor, later:

```yaml
triggers:
  - type: email
    transport: imap
    host: imap.fastmail.com
    username: agent@looped.sh
    password_env: IMAP_PASSWORD
    smtp_host: smtp.fastmail.com        # replies go out over SMTP
    folder: INBOX
    poll_seconds: 60
    from_addresses: ["happy@looped.sh", "gwinyai@looped.sh"]
```

Credentials follow the house rule: config names an environment variable, `triggersFromConfig` resolves it at startup and a missing variable fails the boot, ahead of the first message.

## Normalizing a message

Triggers emit plain text, so the email renders into the `input` string: from, to, subject, date and the body. Plain-text bodies pass through; HTML-only mail gets a naive tag-strip in v1, which will mangle the occasional newsletter and is fine for the correspondence this feature targets. Attachments are listed by filename and size in the rendered text and are otherwise dropped in v1; delivering their contents needs a story about writable paths and size caps first (open question below).

The `conversationKey` is `email:<root Message-ID>`, walked back through `References`/`In-Reply-To`, with a fallback of normalized subject plus counterpart address for mail that lacks threading headers. With `memory.scope: thread` an ongoing correspondence gets its history loaded the same way a Discord thread does.

## Replies are ordinary email sends

The `emit` callback returns the run result and the trigger delivers it: through the provider's send API on the pushed transport, over SMTP on IMAP. Replies set `In-Reply-To` and `References` so they land in the same thread, and the subject gets the conventional `Re:`. The `NO_REPLY` sentinel and `allow_silence` work exactly as they do on the chat triggers, which matters more here than anywhere: an agent that files invoices into accounting software should answer nothing at all.

## An email address is an open channel

The chat triggers inherit a boundary from their platform: only people in the server or the workspace can speak to the agent. An email address has no such fence; anyone on the internet can write to it. That makes inbound mail the framework's widest prompt-injection surface, and every unfiltered message costs tokens besides.

So the filtering rules are stricter than the chat triggers' optional `from_users`:

- **`from_addresses` is required.** Exact addresses or domain patterns (`*@looped.sh`). An operator who genuinely wants an open mailbox writes `from_addresses: ["*"]` and has thereby said so in the file that defines the agent's blast radius. The check is a pure `shouldHandle` function with its own test file, applied before the model is ever called, like the Discord one.
- **Signatures are verified on the pushed transport.** The provider signs each webhook; the trigger verifies before parsing, with the same timing-safe comparison the webhook trigger uses. An unsigned POST to the endpoint is a 401 and no event.
- **Auto-generated mail is dropped.** Messages carrying `Auto-Submitted` or bulk/list `Precedence` headers, and anything from the agent's own sending address, are skipped. An agent that replies to an out-of-office reply to its own reply is a mail loop, and this is the standard defense.

One honest caveat: a `From` header is an assertion. The pushed providers check SPF and DKIM and we can surface their verdict, and a pulled mailbox sits behind its provider's own filtering, but `from_addresses` should be understood as access control for honest senders plus a cost gate. The defense against a crafted message that gets through remains the same as everywhere else in the framework: the permission block bounds what a fooled agent can actually do.

## Gmail and Outlook are credential problems first

Both providers have spent years closing password access to mailboxes. Where an app password can still be issued, the IMAP transport covers the account with no new code, and that is the documented first answer for Gmail. Outlook requires OAuth even for IMAP, so it waits for the OAuth story.

That story is a `gmail` and an `outlook` transport polling the respective APIs, authenticated by a refresh token: `client_id`, `client_secret_env` and `refresh_token_env` in config, access tokens minted at startup and renewed in the loop. The container has no browser, so acquiring that refresh token happens outside the agent, either a documented one-time flow or an `af` helper command (open question). The push channels both providers offer (Gmail's Pub/Sub notifications, Graph change subscriptions) need public endpoints and subscription upkeep; polling is cheap at the scale of a mailbox, so push is deferred until someone actually needs the latency.

## The polled cursor can live in the mailbox

The IMAP transport's simplest correctness story: fetch messages the mailbox marks unseen, run the agent, mark them seen. The mailbox itself is the cursor, so a restarted container picks up where it left off with no local state. Two costs come with that. A crash between the run and the flag write means one duplicate run after restart. And the agent now shares read-state with any human using the same mailbox; whoever opens the message first wins. The documented recommendation is a dedicated address or a dedicated folder the agent owns, with mail routed in by the operator's own filters. The alternative, persisting a UID cursor in SQLite, would be the first time a trigger touches the store, and whether to open that door is an open question rather than a quiet side effect.

## Phasing

1. **Pushed transport.** `packages/triggers/email.ts` with `transport: resend`, signature verification, the `shouldHandle` filter and replies through the provider's send API. Schema, factory, generated `agent.json`, `docs/email.mdx`, an example agent under `examples/` (an invoice inbox is the natural one).
2. **IMAP.** The polling loop, SMTP replies, the seen-flag cursor. This is the transport that covers self-hosted mail and app-password Gmail.
3. **Gmail and Outlook transports.** OAuth refresh-token flow, API polling.

Hermetic mode (Plan 6) needs two additions when these land: the pushed transport claims a listen right like the webhook trigger, and the pulled transports contribute their mail hosts to the derived net allowlist.

## Open questions

- Should phase 1 include a `generic` pushed transport (documented JSON shape, shared-secret auth) alongside Resend, so any provider with inbound webhooks can be wired up without a framework release?
- Attachments: when they do get delivered, where do they land (a path under `/data`?), and what size caps apply?
- IMAP cursor: is the seen-flag answer enough, or do triggers get SQLite access for a proper UID cursor?
- Refresh-token acquisition for Gmail/Outlook: documented manual flow, or an `af email auth` helper that runs the browser dance on the operator's machine?
- Should wildcard `from_addresses` require a per-sender rate cap, or is `limits.max_cost` enough of a backstop?
- Multiple email triggers on one agent (two mailboxes, different filters): allowed from day one or explicitly deferred?
