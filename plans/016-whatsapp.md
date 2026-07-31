# Plan 16 — WhatsApp: the channel with a rulebook

Every channel this framework speaks so far was designed for bots. Discord hands you a gateway, Telegram hands you a token from a chat with @BotFather, Slack hands you an app manifest. WhatsApp hands you a business verification, a phone number you must register with a PIN, a 24-hour window outside which you may only send pre-approved templates, a per-message bill, and — since January 2026 — a clause in the Business Solution Terms that decides whether your agent is allowed on the platform at all.

That last item is the reason this plan opens with terms rather than transport. WhatsApp is the largest messaging surface on earth and the one users ask for most, and the integration itself is smaller than Discord's. What makes it a plan rather than a pull request is everything around the wire.

Status: design; implementation has not started.

## The constraint that shapes the product

Meta's [Business Solution Terms](https://www.whatsapp.com/legal/business-solution-terms) prohibit using the WhatsApp Business Platform to provide "AI or machine-learning technologies, including LLMs, generative AI platforms, or general-purpose AI assistants" **when that AI is the primary functionality being provided**. Enforcement began for new users on 2025-10-15 and reached everyone on 2026-01-15; ChatGPT, Copilot and Perplexity were removed from the platform under it.

What survives the clause is a business running an LLM-powered assistant for its *own* customers — support, commerce, operations, notifications. What does not survive is a product whose pitch is "deploy your general assistant to WhatsApp." Looped AF sits on the right side of this line by construction: we ship the framework, the operator brings their own WhatsApp Business Account, their own number, their own display name and their own use case. The agent is the business's, running under the business's WABA, and the framework is a dependency the way Deno is.

That is not a loophole to be quiet about, it's a design rule with teeth:

- **Docs lead with it.** The WhatsApp page opens with the eligibility question — "is this agent your business's own assistant?" — before it mentions a single env var. Nobody should discover this after paying for business verification.
- **We never broker WABAs.** The framework does not offer a shared number, a pooled sender, or a hosted "just point it at us" mode. Every deployment authenticates as its operator's own WABA. This is also what keeps quality ratings, messaging tiers and bans scoped to the operator who earned them.
- **The hosted platform (Plan 5) inherits the rule.** A managed WhatsApp channel on the hub would have to be per-tenant BYO-WABA via Embedded Signup, never a Looped-owned number fronting many agents. If that can't be done cleanly it doesn't ship.
- **Positioning language is fixed.** "Connect your business's assistant to WhatsApp," never "put your agent on WhatsApp."

An operator who wants a personal general assistant on WhatsApp is asking for something the platform forbids, and the honest answer is Telegram, which costs nothing and asks no permission.

## Cloud API, and nothing else

The On-Premises API was fully sunset on 2025-10-23 and can no longer send messages, so there is exactly one supported architecture: the **WhatsApp Cloud API** over the Graph API, pinned to an explicit version (`v26.0` at time of writing; `v25.0` is supported to 2028-07-29). Version lives in config with a default we bump deliberately, the way we do with provider model ids — a channel that silently follows `latest` breaks at Meta's convenience, not ours.

Two things follow from Cloud API being the only option.

**Inbound is webhook-only.** There is no long-poll, no gateway socket, no Socket Mode equivalent. Telegram's `polling` transport and Slack's `socket` exist precisely so an agent can run behind a laptop NAT with no public endpoint; WhatsApp has no such affordance. The `whatsapp` channel therefore has one transport and needs a public HTTPS URL, which makes the docs' "you need somewhere to host this" section mandatory rather than an aside. On the upside, webhook-only is exactly the shape that scales to zero: Meta retries undelivered webhooks for up to seven days, and on a host that autostarts on inbound HTTP the retry is what wakes the machine — the same argument the Telegram webhook transport already makes.

**Aggregators are a config detail, not an architecture.** Direct Cloud API (the operator's own Meta app, Meta bills them) is the default and the documented path. 360dialog passes the Cloud API through unchanged for a flat monthly fee and works with the same code given a different `api_base` — which the Telegram channel already proves is a one-option affordance worth having, since it's also how the tests stand up a fake Graph server. Twilio, Vonage, Bird and Infobip each impose their own payload shape and normalize away fields we care about (`interactive` replies, `pricing` metadata); they are not in scope. If someone wants Twilio's WhatsApp, that is a separate `twilio` channel someday, not a mode of this one.

## The shape of the implementation

`packages/triggers/whatsapp.ts`, implementing `Trigger` (`Channel` after Plan 12), modelled closely on `telegram.ts` — a thin typed `fetch` wrapper over the endpoints we actually use, no SDK. Meta's own Node SDK has been archived and read-only since 2023; the community options are maintained but pin themselves to Graph versions on their schedule, and the surface we need is roughly six calls. Principle 8 (no library where a fetch will do) applies cleanly.

### Ingest

`Deno.serve` on the configured `port`/`path`, same as the Telegram webhook transport and subject to the same rule that HTTP-serving channels on one agent need distinct port/path pairs.

`GET` is the verification handshake: Meta sends `hub.mode=subscribe`, `hub.verify_token`, `hub.challenge`, and we echo `hub.challenge` as a raw body with 200 when the token matches the configured one, timing-safely. The verify token is ours to mint and lives in config as `verify_token_env` — unlike Telegram's per-boot secret it must survive restarts, because Meta re-verifies on subscription changes.

`POST` is the delivery. Order of operations is fixed and is where most WhatsApp integrations get it wrong:

1. **Read the body as raw bytes and verify `X-Hub-Signature-256` before parsing.** HMAC-SHA256 over the *unparsed* body with the Meta app secret (`app_secret_env`), compared timing-safely against the value after `sha256=`. Parsing and re-serializing breaks the digest; our verifier takes bytes, never an object. `verifySlackSignature` and `verifyGithubSignature` are the existing shape to follow, and the three copies of `timingSafeEqual` scattered across `webhook.ts`, `slack.ts` and `tty.ts` should become one export in core while we're here.
2. **Dedup on the wamid.** Delivery is at-least-once, unordered, retried for days, and fanned out to every subscribed app. `messages[].id` is globally unique, so a seen-message table in the SQLite store — wamid plus a timestamp, pruned past the retry window — is what stands between a retried webhook and a second billed LLM run with a second reply. This gate sits *before* `emit`, next to the author filter, for exactly the reason the author filter sits there.
3. **Ack immediately, run after.** Return 200 the moment the event is accepted. A run outlasts any webhook timeout, and a non-2xx puts the delivery back in Meta's retry queue where it will arrive again and again.

The payload is `entry[].changes[]` where `field === "messages"`, and each `value` carries either `messages[]` (inbound) or `statuses[]` (delivery receipts). We subscribe to both: `statuses` is not agent input, but `failed` with its error object is the only place a rejected send explains itself, and it belongs in the run log rather than nowhere. Errors surface at three levels — `value.errors`, `messages[].errors`, `statuses[].errors` — and all three get logged.

`conversationKey` is `whatsapp:<wa_id>`, the sender's phone number. WhatsApp has no threads: one number is one conversation, forever. That makes `memory.scope: thread` behave like a per-contact memory, which is the intuitive reading, and makes `deliver()` for agent-created schedules trivial to route — with a caveat the next section is entirely about.

### The 24-hour window is session state

Any inbound user message opens a 24-hour service window in which free-form messages are free and unrestricted. Outside it, only pre-approved templates may be sent, and anything else is a 400 from Graph. A free-entry-point conversation (Click-to-WhatsApp ad, Page CTA) opens a 72-hour window that covers templates too.

For a request/reply agent this is invisible: the inbound message that woke the agent opened the window, and the reply lands inside it. It becomes load-bearing the moment an agent sends unprompted — `deliver()` for scheduled sends (the memory/schedules feature), `reply_to` routing from Plan 12, cron output aimed at a WhatsApp channel. Every one of those can fire hours after the last inbound message, into a closed window.

So the channel tracks it: the timestamp of the last inbound message per `wa_id`, persisted alongside the session, and `deliver()` checks it before sending. When the window is open, the send is a normal text. When it is closed, the choice is a configured template or a loud failure — and the default is the loud failure, logged and reflected in run status, because silently dropping a scheduled message is worse than a red line in the log. An optional `out_of_window_template` in config names a template (with the run's text as a body parameter) for operators who have one approved; without it, out-of-window sends are refused with an error that names the reason and points at the docs.

This is also the honest answer to Plan 12's open question about failed routed deliveries: WhatsApp is the channel that makes "the run succeeded but delivery was refused" a routine outcome rather than an outage, and it should be a first-class run status, not a log line.

### Rendering: WhatsApp is not markdown

`text.body` caps at **4096 characters**, so `splitMessage(text, 4096)` from `text.ts` applies unchanged. Formatting is WhatsApp's own markup — `*bold*`, `_italic_`, `~strike~`, triple-backtick monospace — with no headings, no links-as-markdown, no nested lists. A model that has been talking to Discord all day will emit `**bold**` and `## headings` and they will render as literal asterisks and hashes.

Two mitigations, and we should do both. The channel appends a short rendering note to the agent's context the way other surfaces already shape output expectations, and a `toWhatsAppMarkup()` pass converts the common markdown constructs on the way out: `**x**`/`__x__` → `*x*`, `# Heading` → `*Heading*`, `[text](url)` → `text (url)` since WhatsApp autolinks bare URLs anyway. Pure function, unit-tested, same neighbourhood as `splitMessage`.

### Media

Inbound media arrives as an id, and resolving it is two hops: `GET /<MEDIA_ID>` returns a signed `url` that **expires in about five minutes** and still requires the bearer header to download. That is the Telegram `getFile` pattern with a shorter fuse, and it maps onto `resolveAttachments` and the `limits:` block with no new concepts — images fetched within `max_image_bytes`, audio/video/documents handed over as typed notes so the agent can say plainly what it can't read. Platform caps: images 5 MB, audio and video 16 MB, documents 100 MB.

Voice notes are the interesting case, because WhatsApp is a voice-first channel in much of the world and Plan 14's engines already exist: with `voice:` configured, an inbound voice note transcribes into the prompt and the reply can go back as an audio message, exactly as Telegram does it. That should land with the media work rather than after it — a WhatsApp agent that ignores voice notes is a WhatsApp agent people stop using.

Outbound media is `POST /<PHONE_NUMBER_ID>/media` for an id, then a send referencing it. Phase 2.

### Presence

`POST /<PHONE_NUMBER_ID>/messages` with `status: "read"`, the inbound `message_id`, and `typing_indicator: {type: "text"}` marks the message read and shows the typing bubble in one call. The bubble auto-clears on reply or after 25 seconds — which is shorter than many runs, so long runs need a re-send on a timer or an accepted gap. Cheap, enormously improves how a slow agent feels, and off by default only if read receipts turn out to be something operators want to withhold.

## Config

```yaml
channels:
  - name: support
    type: whatsapp
    # phone_number_id: from the WhatsApp Manager (required)
    phone_number_id: "123456789012345"
    # token_env: WHATSAPP_TOKEN (default) — system user access token
    # app_secret_env: WHATSAPP_APP_SECRET (default) — signs X-Hub-Signature-256
    # verify_token_env: WHATSAPP_VERIFY_TOKEN (default) — your handshake token
    public_url: https://my-agent.fly.dev
    # path: /whatsapp   (default)
    # port: 8080        (default)
    # from_numbers: ["+263771234567"]   # allow-list, checked before the model
    # allow_silence: true               # __NO_REPLY__ posts nothing
    # graph_version: v26.0              # pinned deliberately
    # api_base: https://graph.facebook.com   # 360dialog, or a fake in tests
    # out_of_window_template: service_update  # else out-of-window sends fail loudly
    # mark_read: true                   # read receipt + typing indicator
```

Three secrets rather than Telegram's one, all `*_env` names resolved at startup through `lookupSecret` so a missing token fails at boot and not at 3am. `from_numbers` is the `from_users` analogue and matters more here: an unlisted number reaching the model is not just tokens, it is a stranger with your business's phone number in their contacts.

Notably absent: `require_mention` and `chats`. WhatsApp Cloud API has no group messaging for businesses — every conversation is one person and one business number — so both filters would be furniture.

## Testing

Everything that can be a pure function should be, following `telegram_test.ts`: signature verification over fixed byte fixtures with a known-good digest, the dedup gate, `from_numbers` filtering, `toWhatsAppMarkup`, `splitMessage` at the 4096 boundary, window open/closed arithmetic, and payload normalization from real captured `entry/changes/value` fixtures for each inbound type. The transport gets a fake Graph server via `api_base` on an ephemeral port, the way the Telegram tests already do it, covering the GET handshake, a signed POST, a POST with a bad signature, and a duplicate wamid.

A live test against a real WABA (`whatsapp_live_test.ts`, skipped without credentials) mirrors `discord_live_test.ts` — the handshake and the first send are exactly the steps a doc can describe wrongly for a year without anyone noticing.

## Phasing

1. **Text, both ways.** The webhook server, signature verification, wamid dedup, inbound text → `emit`, reply with `splitMessage` + markup conversion, `from_numbers`, `allow_silence`, `deliver()` with the window check. Config schema, JSON Schema regen, `docs/whatsapp.mdx` opening on eligibility, and an example agent (a business support bot — the framing matters).
2. **Media and voice.** Inbound images through `resolveAttachments`, honest notes for the rest, voice notes transcribed and voiced back through the Plan 14 engines, outbound media upload. Read receipts and the typing indicator.
3. **Interactive and templates.** Reply buttons (3 max, 20-char titles), lists (10 rows, 24-char titles), and a template send path — the last of which is what makes out-of-window delivery work properly and is the doorway to Flows, which are their own plan if anyone wants them.

Plan 12's rename lands underneath all of this; if 12 ships first, this is a `channels:` entry from day one, and if it doesn't, this is a `triggers:` entry that gets swept with the rest.

## Open questions

- **Does the framework need a template registry at all?** Phase 3 sends templates by name with positional parameters, which is the thin version. A `templates:` config block that validates parameter counts at `af validate` time would catch the errors that otherwise show up as a `failed` status webhook — but templates are approved in Meta's UI, and mirroring that state in a YAML file is a synchronization problem we'd own forever.
- **Should `mark_read` default on?** A read receipt is a commitment on the business's behalf, and some operators will have opinions about telling a customer their message was read by a machine.
- **Where does the wamid dedup table live?** A store table is the durable answer and survives restarts, which matters because Meta's retry window is days. An in-memory LRU is one line and loses everything on deploy. The retry window says store; the "no schema churn for one channel" instinct says otherwise.
- **Statuses as agent input?** A `failed` delivery is operator information today. Whether an agent should ever be *woken* by a delivery receipt (a dunning agent noticing its message bounced) is a real use case and a large surface — the `field` filter makes it opt-in cheaply, but nothing else in the framework wakes on non-messages.
- **Does the 25-second typing indicator get refreshed?** Re-sending on a timer keeps the bubble alive through a long run and costs an API call every 20 seconds per active conversation; letting it lapse makes a slow agent look dead.
- **Embedded Signup for the hosted platform.** Per-tenant BYO-WABA onboarding is the only compliant multi-tenant shape, and it is a real OAuth-shaped feature. Plan 5's problem or this one's?
- **Do we say anything about Baileys?** Operators will ask why they can't just use an unofficial library on a spare number. The docs should probably answer it once, plainly — ToS violation, unannounced bans, and a live supply-chain incident in the ecosystem — rather than leaving people to find out.
