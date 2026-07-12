# Deploying standup-bot

Goal: an agent that sits in your standup voice channel and that you can simply talk to. Say what's blocking you and it keeps it; ask it what Amin said last Tuesday and it tells you; tell it you'll have something in by Thursday and it comes back to you on Thursday. Budget ~20 minutes.

The [`voice:`](../../docs/voice.md) block is what makes it audible, and it does two separate things here. `live` puts the agent in the voice channel for a real spoken conversation. `stt` and `tts` handle voice notes in the text channel, for the person who missed standup and sends one at lunchtime. Everything it actually remembers or schedules runs through [`memory.persistent`](../../docs/memory.md) and [`schedules:`](../../docs/scheduling.md), which are ordinary tools on the ordinary loop.

## What you need before starting

- A Discord server you can add a bot to
- An OpenAI API key, with the Realtime API available on it
- Somewhere to run a container: any Docker host

## 1. Create the Discord bot (~10 min)

1. In the [Discord Developer Portal](https://discord.com/developers/applications), create a New Application with a Bot.
2. Enable the **Message Content Intent** under Privileged Gateway Intents. Without it the bot receives empty messages, and this is the most common setup failure.
3. Copy the bot token; this is `DISCORD_BOT_TOKEN`.
4. Run `af discord-invite agent.yaml`, open the URL it prints, and add the bot to your server. The invite asks for the permissions it needs to read the channel, post in it, send voice messages, connect to a voice channel and speak there.
5. Make sure you have a text channel and a voice channel both named `standup`, or change the two names in `agent.yaml`. They can be named differently from each other; `channels:` is the text one and `voice_channels:` is the voice one.

## 2. Deploy with Docker Compose (~5 min)

In this directory:

```sh
cp .env.example .env     # OPENAI_API_KEY and DISCORD_BOT_TOKEN; never commit .env
docker compose up -d
```

One key covers everything: the model that runs the agent, the transcription of voice notes, the speech that answers them, and the realtime session in the voice channel. There is no Dockerfile and nothing to build - the stock image runs with `agent.yaml` mounted onto it.

## 3. Verify

```sh
docker compose ps                # "healthy" after ~15s
curl -s localhost:9097/healthz   # identity JSON - note the name the agent chose
```

The bot appears in the `standup` voice channel on its own, a few seconds after it starts. Join it and talk:

> **Ratul:** *(in the voice channel)* Morning. I'm still on the export bug, and I'm blocked because I can't get staging credentials.
> **bot:** Got it, I'll keep that. Anything you need from anyone to unblock it?
>
> **Ratul:** Ask Amin. Actually, remind me Thursday to chase him if it's still open.
> **bot:** Sure. One second.
> *(files the schedule)*
> **bot:** Done, I'll ask you Thursday.
>
> *(Thursday)*
> **bot:** *(in the standup channel)* Ratul, are you still blocked on the staging credentials?

Then, in the `standup` text channel, hold the microphone button and send a voice note - it comes back as one.

## How the live conversation actually works

This is the part worth understanding, because it explains what the agent can and can't do while you're talking to it.

The voice you hear is a realtime speech-to-speech model. It handles the conversation: hearing you, working out when you've finished a thought, speaking, and shutting up when you cut it off. It is fast, and it knows nothing about your standup. So it has exactly one tool - `ask_agent` - and when you ask for something real it passes the request to this agent, which does the work with its own memory, its own schedules and its own permissions, and speaks the answer when the run comes back.

That's why the `purpose` above tells it to say something before it goes quiet. A delegated run takes a second or two, and a voice that vanishes mid-conversation reads as broken. It's also why `limits.max_steps` is 8 rather than the default 20: a spoken answer that takes twenty tool calls is an answer nobody waits for.

The split is the safety story too. Nothing the voice model says can touch anything. Every action goes through a normal run, so the permission engine sees it and the audit trail records it, exactly as for a typed message.

## The costs, named

- **A live session bills by the audio minute**, including the minutes where nobody is talking. `idle_seconds: 120` closes the realtime session after two minutes of silence and reopens it the moment someone speaks, so the bot sitting in an empty channel all afternoon costs nothing. Two minutes is generous for a standup, where pauses are normal; drop it if your bill says so.
- **There is no `require_mention`**, and that's deliberate. A voice note carries no text to @-mention with, so a mention gate would drop the voice notes this agent exists to hear. The price is a model call on every message in the `standup` channel. `allow_silence` plus the `__NO_REPLY__` instruction in the purpose is what keeps the agent from talking over the team; `gpt-5.4-mini` is what keeps that cheap.
- **This agent cannot run in hermetic mode.** Live voice media rides UDP to a media server Discord picks per session, and the sandbox can't allowlist an address nobody knows in advance. `af validate` says so plainly, and the container is the egress boundary instead. If hermetic mode matters to you more than voice does, run the two jobs as two agents.

## What it looks like when it breaks

- **The bot joins the voice channel but never speaks.** Its `OPENAI_API_KEY` has no Realtime API access. The logs say so on the first thing anyone says.
- **It hears you but answers nothing useful.** That's the delegation failing rather than the voice - check the logs for the run, the same way you would for a text message.
- **It never joins at all.** Either the voice channel name doesn't match `voice_channels`, or the bot was invited before you turned voice on. Run `af discord-invite` again and open the URL; the invite now carries `CONNECT` and `SPEAK`.

## What it can't do yet

It hears the room as one voice. It doesn't know who's speaking, so it can't tell you what *you* said last week without you saying your name, and `from_users` has no effect on the voice channel. Speaker identification is on the roadmap ([plan 15](../../plans/015-live-voice.md)).
