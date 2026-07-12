# Plan 15 — Live voice: an agent you can talk to

Voice notes made agents hearable: a clip arrives, the transcript runs, a spoken reply posts back. It is still turn-based messaging. The next step is a live conversation — the agent sits in a Discord voice channel, you talk to it, it answers out loud, you interrupt it mid-sentence and it stops. This plan covers how that works, what it costs, and the order to build it in.

Status: design. Phase 1 (the sandbox groundwork) ships with this plan; phases 2–4 have not started.

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

- **A codec dependency.** Discord speaks Opus and the realtime APIs speak PCM; a bridge needs libopus. There is no pure-TS implementation worth using, so this is the framework's first WASM dependency (`opusscript` or a vendored libopus build). The dependency-free principle takes its first exception here, and it should stay contained to the voice bridge module.
- **Unstable UDP.** Voice media is UDP, which in Deno means `Deno.listenDatagram` behind `--unstable-net`. The flag lands in the image entrypoint and in `hermeticPlan`'s output for agents with a live voice config.
- **Dynamic media hosts.** Voice servers hand back endpoints like `<node>.discord.media`, different per guild and per reconnect. This is why wildcard `--allow-net` support ships as phase 1 of this plan: `*.discord.media` joins the derived allowlist the same way fixed hosts do today, and the agent stays hermetic.
- **The DAVE risk.** Discord is migrating voice to end-to-end encryption (DAVE, MLS-based). Bots can still negotiate non-E2EE transport today, and the voice gateway advertises protocol versions, but the downgrade path has a shelf life. When non-DAVE connections are retired, the Discord leg needs an MLS implementation or a maintained library, and that decision gets its own plan amendment.
- **Latency budget.** Discord adds ~30–80 ms each way and the realtime model ~300–800 ms to first audio. Sub-second round trips are achievable; the bridge must stream (decode and forward frame by frame) rather than buffer utterances.

## What stays out

- **Slack and Telegram live voice.** Slack gives bots no huddle audio surface at all. Telegram calls require MTProto user accounts; the Bot API stops at voice notes. Both platforms keep the turn-based voice-note path.
- **Full-duplex mimicry.** Backchannels and listen-while-speaking are model capabilities. The bridge carries whatever the model does; we do not fake "mhmm" client-side.
- **Voice in text channels.** Voice notes already cover that surface.

## Phases

1. **Sandbox groundwork (this PR).** Wildcard hosts compile into `--allow-net`; the wildcard hermetic blocker is gone. Verified against Deno 2.9 (the image's pin), including the apex nuance documented in the permission model.
2. **The realtime session client.** A dependency-free `wss://` client for the Realtime API event protocol: session setup, audio append, response streaming, tool-call round trips, `delegate_to_agent` wired to the agent loop. Testable against a fake WebSocket server the way the Slack and Discord triggers are tested today.
3. **The Discord voice transport.** Voice gateway handshake, UDP socket, RTP encryption, the opus bridge and the resampler. This phase needs a live guild to verify against; unit tests cover the pure parts (RTP framing, resampling, handshake state machine).
4. **Wire and ship.** The `voice_channels` trigger option, join/leave lifecycle, invite permissions (`CONNECT`, `SPEAK`), docs, and an example agent.
5. **GPT-Live.** When the API opens: swap the model id, adopt full-duplex turn events if the protocol grows them, and re-evaluate whether delegation stays ours or moves into the model's own background-reasoning machinery.

## Open questions

- **Join semantics.** Always-on in the configured channel, follow the first human in, or join on a `/join` command? Leaning toward command-driven with an idle timeout, so an agent is in the room because someone asked.
- **Who may talk.** `from_users` has no obvious voice equivalent without speaker identification. The realtime transcript gives us words; mapping them to Discord user ids via RTP SSRC is possible and phase 3 should confirm it.
- **Cost control.** A live session bills by the minute even when idle. `limits` needs a session budget (max minutes per session, per day) before this is safe to leave running unattended.
- **Codec packaging.** npm `opusscript` versus a vendored wasm build; whichever keeps the image small and the supply chain auditable.
