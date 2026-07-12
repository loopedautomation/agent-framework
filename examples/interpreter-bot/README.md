# Deploying interpreter-bot

Goal: hold the microphone button in Telegram, say something in English, and get a voice note back saying it in Spanish. Say "switch to Shona" and it switches. Budget ~10 minutes.

This is the smallest useful voice agent there is, and it is worth looking at the config before you deploy it, because of what isn't in it. There is no `permissions:` block. There are no tools, no skills and no `http_request`. The [`voice:`](../../docs/voice.md) block is the entire capability: `stt` turns the voice note into text, the model interprets it, and `tts` speaks the answer back. Everything else in this repository is about giving an agent the power to act; this one is about what an agent is when you take all of that away.

## What you need before starting

- A Telegram account
- An OpenAI API key (the model, and the transcription)
- An ElevenLabs API key (the speech)
- Somewhere to run a container: any Docker host

## 1. Create the Telegram bot (~2 min)

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → pick a display name and a username. It replies with the token; this is `TELEGRAM_BOT_TOKEN`.
2. In `agent.yaml`, replace `ratulmaharaj` in `from_users` with your own username (bare, no `@`). Anyone who finds the bot can DM it, and each voice note costs a transcription call and a speech call, so this list is who is allowed to spend that. A numeric user id works too and survives a username change ([@userinfobot](https://t.me/userinfobot) tells you yours).

The bot connects outward by long-polling, so Telegram never needs to reach your server.

## 2. Deploy with Docker Compose (~5 min)

In this directory:

```sh
cp .env.example .env     # the three keys; never commit .env
docker compose up -d
```

## 3. Verify

```sh
docker compose ps                 # "healthy" after ~15s
curl -s localhost:9098/healthz    # identity JSON
```

Then DM the bot. Hold the microphone button, say *"the export is broken on big files, I'll look at it after lunch"*, and let go. A few seconds later a voice note comes back, in Spanish, saying the same thing.

> **Ratul:** 🎤 *"the export is broken on big files, I'll look at it after lunch"*
> **bot:** 🎤 *"La exportación falla con los archivos grandes; lo miraré después de comer."*
>
> **Ratul:** 🎤 *"switch to French"*
> **bot:** 🎤 *"D'accord, on passe au français."*
>
> **Ratul:** 🎤 *"tell Amin the staging database is back up"*
> **bot:** 🎤 *"Dis à Amin que la base de données de staging est de nouveau en ligne."*

Typing works too - text in, text out - because a voice note is just another way of putting words in front of the model. That is the whole design: the transcript is the input, and the loop never knows the difference.

## Why two providers

OpenAI hears the languages and ElevenLabs speaks them, and swapping either is one line. The reason for the split is `eleven_multilingual_v2`: one voice id speaks every language this bot interprets into, so it keeps sounding like the same person whether it's answering in French or Shona. Set both to `openai` if you would rather have one key and one bill; the bot still works, and it will sound like a different thing.

## This one runs hermetic, and that's the point

Run `af validate agent.yaml` on it:

```
sandbox:  hermetic — Deno enforces net for the whole process
egress:   0.0.0.0:9090, api.openai.com, api.telegram.org, api.elevenlabs.io
```

The agent spawns nothing, so the Deno sandbox itself holds the entire list of hosts it may reach - and that list was derived from the config, not declared in it. The three hosts are the model, Telegram and the speech API, and there is no fourth. A prompt injection in a voice note has nothing to reach for and no tool to reach with ([Permission model](../../docs/permission-model.md)).

Contrast [`standup-bot`](../standup-bot/), which does live voice in a Discord voice channel: that one sends media over UDP to a server Discord picks per call, which the sandbox cannot allowlist in advance, so it falls back to the container as its boundary. Voice notes are the cheap, safe half of voice, and this is what it costs you: nothing.

## The costs, named

- Every voice note is a transcription call, a model call and a speech call. Short notes are cents; a rambling three-minute one is not. `from_users` is the only thing standing between the bot and anyone who finds it.
- A reply longer than 4000 characters comes back as text instead of speech, which for an interpreter should never happen - if it does, the person spoke for a very long time.
- The bot holds the target language in conversation history (`memory.scope: thread`), so `/reset` puts it back to Spanish. It is not a setting; it is something you said.
