# Plan 15 — Live voice: an agent you can talk to

Voice notes made agents hearable: a clip arrives, the transcript runs, a spoken reply posts back. It is still turn-based messaging. The next step is a live conversation — the agent sits in a Discord voice channel, you talk to it, it answers out loud, you interrupt it mid-sentence and it stops. This plan covers how that works, what it costs, and the order to build it in.

Status: implemented, unproven against a live guild. Phases 1–4 are built (config, the realtime session, the Discord voice transport, the wiring). Phase 5 waits on OpenAI. The unit tests cover the protocol state machines and the media plumbing; nobody has yet stood in a voice channel and talked to it, and that is the gap to close before this is called done.

## The moment this is designed for

OpenAI announced GPT-Live in July 2026: a full-duplex voice model family that listens and speaks at the same time, backchannels while you talk, and silently delegates hard questions to GPT-5.5 in the background. There is no GPT-Live API yet — a sign-up form and "soon" is the entire developer story. What exists today is the Realtime API (`gpt-realtime-2.1`): speech-to-speech over WebSocket, sub-second turn latency, function calling, half-duplex with good interruption handling.

Two facts shape the design:

1. **The transport to build against is the Realtime API.** When GPT-Live reaches the API it will almost certainly ride the same event protocol, so the model id is config, and the upgrade is a string.
2. **GPT-Live's own architecture is the delegation pattern.** A fast interaction layer holds the conversation; a reasoning layer does the work in the background. We already have the reasoning layer — it's the agent loop, with its tools, permissions, memory and audit trail. The realtime model becomes the mouth and ears; the Looped agent stays the brain.

## The design

A live voice session is a bridge with three legs:

```
Discord voice channel ⇄ [opus ⇄ pcm bridge] ⇄ Realtime API session
                                                      │
                                          delegate_to_agent(prompt)
                                                      │
                                             the normal agent loop
                                             (tools, permissions,
                                              memory, audit)
```

- **The Discord leg.** Join a voice channel (gateway op 4 → `VOICE_SERVER_UPDATE` → the voice WebSocket → `SELECT_PROTOCOL`), then move audio over UDP as encrypted RTP carrying Opus at 48 kHz. Encryption is `aead_aes256_gcm_rtpsize`, which WebCrypto covers.
- **The realtime leg.** A `wss://` session to the provider. Audio in and out is PCM16 at 24 kHz, so the bridge resamples 48⇄24 (pure TS, linear interpolation is fine for speech) and transcodes Opus⇄PCM.
- **The delegation leg.** The realtime session gets one tool: `delegate_to_agent`. The realtime model handles chit-chat and turn-taking on its own; anything that needs tools, knowledge or judgment goes through the tool as a normal run on the conversation key `discord-voice:<channel>`. The session speaks the result when it returns. Every consequential action therefore still passes the permission engine and lands in the audit trail; the voice model itself can touch nothing.

Config stays inside the existing `voice` block, and the channel to join lives on the trigger:

```yaml
voice:
  stt: { provider: openai }
  tts: { provider: elevenlabs }
  live:
    provider: openai
    model: gpt-realtime-2.1     # gpt-live-1 the day its API opens
    # voice: marin

triggers:
  - type: discord
    voice_channels: ["lounge"]
```

## What it costs, named up front

- **A codec dependency.** Discord speaks Opus and the realtime APIs speak PCM; a bridge needs libopus. There is no pure-TS implementation worth using, so this is the framework's first WASM dependency (`opusscript`). The dependency-free principle takes its first exception here, and it stays contained to `opus.ts`.
- **Hermetic mode, given up.** This is the real cost, and it landed harder than the design expected. Voice media is UDP, and the address comes from the voice server at session time — `Deno.listenDatagram` needs `--unstable-net` (which the workspace `deno.json` now carries) and a net permission for an address nobody can name in advance. So an agent with `voice_channels` is disqualified from hermetic mode and runs under the image's flags, with the container as its egress boundary. `hermeticPlan` says so as a blocker, beside the subprocess ones.
- **Dynamic media hosts.** The voice *websocket* lives at `<node>.discord.media`, different per guild and per reconnect, and wildcard `--allow-net` (phase 1) is what makes it expressible in the derived allowlist at all. The wildcard was worth shipping on its own merits; it does not save hermetic mode here, because the UDP leg is the blocker.
- **The DAVE risk.** Discord is migrating voice to end-to-end encryption (DAVE, MLS-based). We identify with `max_dave_protocol_version: 0` and take the transport-encrypted path, which voice servers still accept. When they stop accepting it, the Discord leg needs an MLS implementation or a maintained library, and that decision gets its own plan amendment.
- **Latency budget.** Discord adds ~30–80 ms each way and the realtime model ~300–800 ms to first audio. The bridge streams frame by frame rather than buffering utterances, so the round trip stays under a second — but a delegated run adds however long the agent's own loop takes, which is why the voice model is told to say something before it calls the tool.

## What stays out

- **Slack and Telegram live voice.** Slack gives bots no huddle audio surface at all. Telegram calls require MTProto user accounts; the Bot API stops at voice notes. Both platforms keep the turn-based voice-note path.
- **Full-duplex mimicry.** Backchannels and listen-while-speaking are model capabilities. The bridge carries whatever the model does; we do not fake "mhmm" client-side.
- **Voice in text channels.** Voice notes already cover that surface.

## Phases

1. **Sandbox groundwork.** Wildcard hosts compile into `--allow-net`; the wildcard hermetic blocker is gone. Verified against Deno 2.9 (the image's pin), including the apex nuance documented in the permission model. *Done.*
2. **The realtime session client.** `realtime.ts`: a dependency-free `wss://` client for the Realtime API event protocol — session setup with nested audio config, server VAD, audio append, streamed output, and the `ask_agent` tool round trip. Tested against a websocket server on loopback, so the socket code under test is the real one. *Done.*
3. **The Discord voice transport.** `rtp.ts` (header, `aead_aes256_gcm_rtpsize` seal/open over WebCrypto, IP discovery), `pcm.ts` (48 kHz stereo ⇄ 24 kHz mono), `opus.ts` (libopus via WASM), `discord_voice.ts` (voice gateway v8, UDP, the 20 ms send clock, barge-in, the lazy session and its idle close). *Done, pending a live guild.*
4. **Wire and ship.** `voice_channels` on the discord trigger, the three-event join (GUILD_CREATE → op 4 → VOICE_STATE_UPDATE + VOICE_SERVER_UPDATE), the voice intent, `CONNECT`/`SPEAK` on the invite, and the config validation that refuses `voice_channels` without `voice.live`. *Done.*
5. **GPT-Live.** When the API opens: change the model id, adopt full-duplex turn events if the protocol grows them, and re-evaluate whether delegation stays ours or moves into the model's own background-reasoning machinery. *Waiting on OpenAI.*

## Decisions taken during implementation

- **Join semantics: always-on.** The bot joins the configured channel at startup and stays. A `/join` command sounded tidier in design and turned out to be a worse experience: someone in the channel has to know the command exists, and the bot is silent until they do. Idle cost is handled where the cost actually is — the realtime session, not the channel membership.
- **The delegate tool is `ask_agent`, and it is the only tool.** The voice model gets no other capability. Everything consequential is an ordinary run on the `discord-voice:<guild>` conversation key, so the permission engine and the audit trail see it exactly as they see a typed message.
- **The realtime session is lazy.** It opens on first speech and closes after `idle_seconds` of silence. A bot sitting in an empty channel holds no session and bills nothing.
- **DAVE is not implemented.** We identify with `max_dave_protocol_version: 0` and take the transport-encrypted path, which voice servers still accept. This is the feature's shelf life, and it is named in the docs rather than buried here.

## Open questions

- **Who is speaking.** The bridge hears the channel as one voice, so `from_users` has no meaning in a voice channel. Discord tells us the SSRC of each speaker and the gateway maps SSRC to user id — wiring that up would let the agent know who asked, and gate on it. Worth doing; not done.
- **Cost control beyond the idle timer.** `idle_seconds` stops an empty channel from billing, but nothing caps a long conversation. `limits` should grow a voice budget (minutes per session, per day) before anyone leaves this running unattended in a busy server.
- **Codec packaging.** `opusscript` is an npm WASM build and it works. A vendored build would be auditable in-repo; whether that is worth the maintenance is unsettled.
- **Reconnects.** The voice websocket has a resume path (op 7, `seq_ack`) that we do not use — a dropped voice connection currently waits for the gateway to send a new voice server. Fine for a channel the bot sits in all day; worth fixing if it proves flaky.
