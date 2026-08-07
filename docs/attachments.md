---
title: "Images and attachments"
description: "What an agent can see when someone sends it a file: images across every channel, and how everything else is handled."
---

People send agents screenshots. Someone pastes a stack trace as a PNG, forwards a photo of a receipt, drops a design mock into a channel and asks what's wrong with it. An agent that can only read text is going to look ridiculous in that conversation.

So an image that arrives on a channel reaches the model. The agent looks at it and answers about it, and it doesn't matter which channel it came from: the trigger fetches the bytes, and the model gets the picture alongside the text.

```yaml
model:
  provider: anthropic
  id: claude-sonnet-5   # any model with vision; see the note on models below
purpose: |
  You review UI screenshots. When someone posts an image, describe what's
  wrong with the layout and suggest a fix.
triggers:
  - type: discord
```

That's the whole configuration. There's no flag to turn images on, because there's nothing to turn on: if a channel delivers an image and your model can see, the agent sees it.

## What each channel can do

| Channel | Images in | Files that aren't images | Agent sends media back |
| --- | --- | --- | --- |
| Discord | Yes, from the attachment CDN | Named in the prompt | No |
| Slack | Yes (needs the `files:read` scope) | Named in the prompt | No |
| Telegram | Yes, photos and images sent as files | Named in the prompt | No |
| Email (Resend, IMAP, Gmail, Outlook) | Yes, from the message's attachments | Named in the prompt | No |
| Webhook | Not yet | Not yet | No |
| GitHub | No, images in an issue stay markdown links | n/a | No |
| Cron | n/a, nothing arrives | n/a | No |

## Anything the agent can't look at, it can still tell you about

When someone attaches a PDF, the agent doesn't get the PDF. What it gets is a line in the prompt saying the PDF arrived:

```
Can you check these numbers?
[attachment: quarterly.pdf (application/pdf, 2.1 MB) — not an image; this agent reads text and images]
```

This matters more than it sounds. Before, that file was dropped in silence and the agent replied as though nothing had been attached, which reads to the person on the other end as though the agent is ignoring them. Now the agent can say "you sent me quarterly.pdf and I can't read PDFs," which is a useful answer even though it's a no.

The same line shows up when an image is too big, when a message carries more images than the agent's limit allows, and when a download fails. An agent never quietly sees less than what you sent it.

## Limits, because an image is expensive

A single full-resolution image can cost thousands of input tokens, and a phone will happily upload 12 megabytes without telling anyone. Two caps live in `limits:`, next to the other budgets:

```yaml
limits:
  max_image_bytes: 5000000        # 5 MB; a bigger image is named, not read
  max_images_per_message: 4       # beyond this, the rest are named, not read
```

Both have sensible defaults, so you only touch them if your agent has a reason to. Set `max_images_per_message: 0` for an agent that should never spend tokens on pictures at all; the images still get named, so it can say why it isn't looking.

## Models that can actually see

An image only helps if the model has eyes. Every current Claude and GPT model does. If you point an agent at a small local model through an `openai-compatible` `base_url`, check that the model is a vision model before you rely on this — a text-only model will reject the request rather than ignore the image.

## Permissions

Fetching an image means an outbound request, so hermetic agents need the host that serves it. The framework works that out from your triggers, the same way it already derives `discord.com`: a Discord agent gets `cdn.discordapp.com`, a Slack agent gets `files.slack.com`. Telegram and email need nothing new, because their attachments come from a host the agent already talks to. WhatsApp is the exception that proves the rule: Graph hands back a signed URL on a different host, so a WhatsApp agent also gets `lookaside.fbsbx.com` and `mmg.whatsapp.net`.

You don't add these to `permissions.net` yourself. `af flags` will show you the full list an agent runs under; see [the permission model](permission-model.md#hermetic-mode).

Slack is the one channel that needs something on its end: add the `files:read` scope to the bot, or the download comes back 403 and the agent tells you it couldn't fetch the file.

## What we don't do yet

**The agent replies in text.** It can look at your screenshot and describe the fix; it can't draw you a diagram and post it back. Sending media outward means multipart uploads on Discord, a three-step upload flow on Slack, and a MIME builder for SMTP, and none of that shares any code with reading images. It's a separate piece of work.

**A tool can't hand the model an image.** `read_file` reads text, `http_request` returns text, and an MCP server that replies with an image block has that block dropped. So an agent can look at an image someone sent it, but it can't go and fetch one for itself. This is the next thing worth building; it's a smaller change than it sounds.

**Webhook and GitHub attachments.** Both would mean downloading a URL from a host the caller chooses, and a [hermetic agent](permission-model.md#hermetic-mode) can't be given permission for "whatever host turns up at runtime" — Deno's `--allow-net` has no way to say that, and we'd rather refuse than pretend. If you control the webhook caller, base64 the image into the request body instead.

**Voice.** An agent can't listen to a voice note or hold a phone call. A voice note currently arrives as a named attachment, so the agent can at least say it can't play it. Real-time voice is a different shape of program from the one this framework is: our loop is an event arriving, a run happening, and a reply going back, while a live voice session is a permanent open socket streaming audio in both directions with the model deciding when you've stopped talking. That's not a feature we can bolt onto the run loop; it's a second runtime. The cheaper and more likely path is transcription, where a voice note becomes text and text is something the agent already knows what to do with. Slack even transcribes voice clips for us already.
