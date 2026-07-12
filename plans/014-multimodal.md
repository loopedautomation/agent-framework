# Plan 14 — Multimodality: images in, text out

An agent that watches a Discord channel cannot see the screenshot someone posted in it. It never even wakes up: the trigger drops a message with no text, so the one thing the user actually sent goes nowhere. Every channel we support carries images, and every one of them throws the bytes away before the agent gets a turn.

This plan closes the inbound half: an image that arrives on a channel reaches the model. It does not open the outbound half (the agent still replies in text) and it does not attempt voice.

Status: inbound images implemented. Attachments the model cannot read, non-image files, and outbound media are described honestly and dropped.

## Where it stands today

The pipeline is text-only end to end, and one type makes it so:

```ts
export type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };
```

`AgentEvent.input` is a string above it. `NativeTool.execute()` returns a string below it. Everything in between inherits the constraint.

Three channels drop media in silence, which is the part that reads as a bug rather than a missing feature:

- **Discord** bails on `!msg.content.trim()`, so a screenshot posted with no caption never wakes the agent at all.
- **Slack** rejects any message carrying a `subtype`, and a file upload *is* the `file_share` subtype. Every upload is filtered out before the agent sees it.
- **Telegram** reads `text`, but a captioned photo carries `caption`. Both the photo and the caption go.

The email family is the honest one: it parses attachments and renders them into the prompt as `[attachment: report.pdf (application/pdf, 12345 bytes) — not delivered]`. `tools/mcp.ts` does the same thing to MCP image blocks, which servers are already handing us.

## The design: images ride on the user message

The tempting move is to turn `Message.content` into a content-block union, the way the provider wire formats do. We don't, because `content` being a string is load-bearing in more places than the model layer: compaction compares it (`head[0].content === COMPACTION_MARKER`), the redactor walks it, the REPL and TUI render it, and the runs table stores it. A union would touch all of that to buy a generality we don't need for images arriving from a chat channel.

Instead, images ride alongside the text on the user turn:

```ts
export type Message =
  | { role: "user"; content: string; images?: ImageContent[] }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface ImageContent {
  media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  data: string; // base64, no data: prefix
}
```

`content` stays a string on every role, so nothing downstream of the model changes. The assistant still answers in text. A tool still returns a string. The session store needs no migration at all — it persists whole messages as opaque JSON, so the new field survives a round trip on its own.

Three provider dialects, three mappings, all of them small:

- **Anthropic** already has a private content-block union (`text | tool_use | tool_result`) and already sends `content` as an array. Adding an `image` block is an extension of a union that exists.
- **OpenAI-compatible** needs `content` widened from `string` to the array form (`{type: "text"} | {type: "image_url"}`) on user turns that carry images. Turns without images keep sending a bare string, so nothing changes for the agents that have no images and no proxy that only speaks the old shape breaks.
- **Codex** already uses an array of `input_text` items; `input_image` joins it.

## What each channel does with an attachment

Every trigger resolves attachments to bytes before it emits, so the loop and the providers never learn where an image came from. Anything that is not an image the model can read is described in the prompt instead of dropped in silence:

```
[attachment: quarterly.pdf (application/pdf, 2.1 MB) — not readable by this agent]
```

That line is the whole contract for non-images. The agent can say what arrived and that it can't read it, which is what the user needed to know.

Fetching bytes costs a network hop, and the hermetic sandbox has to allow it:

| Channel | Where the bytes are | New host |
|---|---|---|
| Telegram | `getFile` then `/file/bot<token>/<path>` | none — same `api.telegram.org` |
| Email (all four transports) | already in the payload, or one fetch on a host we already reach | none |
| Discord | the CDN url on the attachment | `cdn.discordapp.com`, `media.discordapp.net` |
| Slack | `url_private`, needs the bot token as a bearer | `files.slack.com`, plus the `files:read` scope |
| GitHub, webhook | a url on an arbitrary host | not attempted (see below) |

Telegram and email cost nothing at the sandbox boundary. Discord and Slack widen `permissions.net` by two hosts and one host respectively, derived automatically in `hermetic.ts` from the trigger, the same way `discord.com` already is.

## Limits, because an image is not a tweet

An image at full resolution costs thousands of input tokens, and a channel will hand you a 25 MB upload without blinking. Two caps, both in `limits:` where the other dead-man's switches live:

- `max_image_bytes` (default 5 MB) — anything larger is described rather than fetched.
- `max_images_per_message` (default 4) — beyond the cap, the rest are described.

A dropped image is always named in the prompt. The agent never silently sees less than what arrived.

## What this deliberately does not do

- **The agent cannot send an image back.** `Trigger.deliver(key, text: string)` is text-only and stays that way. Outbound media is a second plan: it needs multipart on Discord, a three-step upload on Slack, and a MIME builder on SMTP, and none of it shares code with the inbound path.
- **A tool cannot return an image.** `NativeTool.execute()` returns a string. This is the change that would unlock MCP image blocks (`tools/mcp.ts` drops them today) and a `read_file` that can open a PNG. It is a smaller change than this plan and a good next one — but it is a different one, and it lands in the tool-result path rather than the trigger path.
- **Webhook and GitHub attachments.** Both would mean fetching a url from a host chosen by the caller, which `--allow-net` cannot express (see Plan 6 — a wildcard host has no compiled equivalent, and a hermetic agent refuses to pretend otherwise). A webhook caller who wants the agent to see an image can base64 it into the request body; that stays open as a follow-up.
- **Voice.** See below.

## Voice, and why it is not in this plan

Realtime voice is not a feature that sits on top of the run loop; it replaces it. Our model is discrete: an event arrives, a run happens, a reply goes back. A realtime voice session is a persistent bidirectional socket streaming audio frames, with server-side turn detection and barge-in — the model *is* the transport, and there is no request to respond to. Wiring one into `AgentService.handle` means reconciling a streaming session with a run-shaped store, and it would be a single-provider path (Anthropic has no realtime or audio API; the Messages API has no audio content block at all), which contradicts the provider-dialect abstraction the framework is built on.

The cheap 80% is transcription, and it fits the existing shape exactly: a voice note is an attachment, transcription turns it into text, and the text is the input to an ordinary run. Slack already transcribes voice clips for us and hands the result back in `files[].transcription` — we simply don't read it. That is where voice should start, and it belongs in a plan of its own.
