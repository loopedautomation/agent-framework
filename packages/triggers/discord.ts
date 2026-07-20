import { logError, logInfo, resolveAttachments, withNotes } from "@looped/core";
import type {
  AgentEvent,
  Attachment,
  CommandSpec,
  MediaLimits,
  RunResult,
  Trigger,
} from "@looped/core";
import type { ImageContent } from "@looped/core";
import { isSilence, NO_REPLY, replyModality, splitMessage } from "./text.ts";
import { placeholderWaveform, SPEAK_MAX_CHARS, type VoiceEngines } from "./voice.ts";
import type { DiscordVoiceSession } from "./discord_voice.ts";

// A deliberately minimal Discord gateway client: identify, heartbeat,
// MESSAGE_CREATE, reconnect-with-backoff. No library — the framework's
// only job here is "message in, reply in thread", and a dependency-free
// ~200 lines keeps the container minimal (Plan 0, principle 8).

const API = "https://discord.com/api/v10";
// GUILDS | GUILD_VOICE_STATES | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT.
// The voice-state intent is what lets the gateway answer a channel join with
// the voice server to connect to (plan 15); it is not privileged.
const INTENTS = (1 << 0) | (1 << 7) | (1 << 9) | (1 << 12) | (1 << 15);

export { NO_REPLY, splitMessage };

/**
 * Permission bitfield the invite URL requests: VIEW_CHANNEL | SEND_MESSAGES |
 * READ_MESSAGE_HISTORY | CONNECT | SPEAK | SEND_VOICE_MESSAGES. The voice bits
 * ride along whether or not the agent uses live voice — an invite is a one-time
 * ceremony, and asking twice is worse than asking for two bits nobody exercises.
 * SEND_VOICE_MESSAGES sits at bit 46, past 32-bit bitwise range, hence the
 * addition.
 */
export const INVITE_PERMISSIONS: number =
  ((1 << 10) | (1 << 11) | (1 << 16) | (1 << 20) | (1 << 21)) + 2 ** 46;

/** Message flag marking a voice message (IS_VOICE_MESSAGE). */
export const VOICE_MESSAGE_FLAG = 8192;

/** The OAuth invite URL for a bot application — so nobody computes permission bitfields by hand. */
export function inviteUrl(applicationId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${applicationId}&scope=bot&permissions=${INVITE_PERMISSIONS}`;
}

/** Fetch the bot's application id (the client_id the invite URL needs). */
export async function fetchApplicationId(
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchFn(`${API}/applications/@me`, {
    headers: { authorization: `Bot ${token}` },
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(
      `discord: cannot fetch application info (${res.status}) — check the bot token`,
    );
  }
  return (await res.json()).id;
}

export interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  content: string;
  author: { id: string; bot?: boolean; username?: string };
  mentions?: { id: string }[];
  flags?: number;
  attachments?: DiscordAttachment[];
}

/** A file Discord hung off a message (the fields this trigger reads). */
export interface DiscordAttachment {
  id: string;
  filename: string;
  url: string;
  proxy_url?: string;
  content_type?: string;
  size?: number;
  /** Playback seconds; present on voice-message attachments. */
  duration_secs?: number;
}

/** True when a message is a voice message: the flag plus an audio attachment. (pure, unit-tested) */
export function isVoiceMessage(msg: DiscordMessage): boolean {
  return ((msg.flags ?? 0) & VOICE_MESSAGE_FLAG) !== 0 &&
    (msg.attachments?.[0]?.content_type?.startsWith("audio/") ?? false);
}

/** The caps a hand-built trigger uses when the config's `limits:` block isn't threaded in. */
const DEFAULT_MEDIA: MediaLimits = { maxImageBytes: 5_000_000, maxImagesPerMessage: 4 };

/** What the agent reads when a post is nothing but an attachment. */
const NO_CAPTION = "(the user sent this with no message text.)";

/** The message's files, as the media layer sees them. */
export function discordAttachments(
  msg: DiscordMessage,
  fetchFn: typeof fetch = fetch,
): Attachment[] {
  return (msg.attachments ?? []).map((a) => ({
    filename: a.filename,
    // Discord reports "image/png; charset=..." on some uploads; the media layer
    // matches the bare type.
    mediaType: a.content_type?.split(";")[0].trim(),
    size: a.size,
    fetch: async () => {
      // The CDN url is signed and carries its own expiry — a bot token on it
      // buys nothing.
      const res = await fetchFn(a.url);
      if (!res.ok) {
        await res.body?.cancel();
        throw new Error(`discord CDN returned ${res.status}`);
      }
      return new Uint8Array(await res.arrayBuffer());
    },
  }));
}

/**
 * What the filter knows about a channel (from `/channels/<id>`). A thread's
 * `channel_id` is the thread's own id and its `name` is the thread's title, so
 * the parent channel's id and name ride along — a filter naming `#general`
 * matches the threads under it too.
 */
export interface DiscordChannelInfo {
  name?: string;
  parentId?: string;
  parentName?: string;
}

/** Message filters shared by {@linkcode shouldHandle} and {@linkcode DiscordTriggerOptions}. */
export interface DiscordFilterOptions {
  /** Channel names or ids to listen in; empty/undefined = all channels. DMs always pass. */
  channels?: string[];
  /** Only handle messages that @-mention the bot (DMs always pass). */
  requireMention?: boolean;
  /** Only handle messages from these authors (user ids or usernames); empty/undefined = anyone. */
  fromUsers?: string[];
}

/** Pure filter: should this message wake the agent? (unit-tested) */
export function shouldHandle(
  msg: DiscordMessage,
  botUserId: string,
  channel: DiscordChannelInfo | undefined,
  opts: DiscordFilterOptions,
): boolean {
  if (msg.author.bot || msg.author.id === botUserId) return false;
  // The author gate runs before the model is ever called — messages from
  // unlisted authors are dropped here and never reach the provider.
  if (
    opts.fromUsers?.length &&
    !opts.fromUsers.some((u) => u === msg.author.id || u === msg.author.username)
  ) return false;
  // A screenshot posted with no caption is still someone talking to the agent;
  // only a message carrying neither text nor a file is nothing to wake for.
  if (!msg.content.trim() && !msg.attachments?.length) return false;
  // A DM addresses the bot by definition: the channel filter and the mention
  // gate only apply to guild messages (DMs carry no guild_id).
  const isDM = !msg.guild_id;
  if (!isDM && opts.channels?.length) {
    const ids = [msg.channel_id, channel?.name, channel?.parentId, channel?.parentName];
    if (!opts.channels.some((c) => ids.includes(c))) return false;
  }
  if (!isDM && opts.requireMention && !msg.mentions?.some((m) => m.id === botUserId)) return false;
  return true;
}

/** Options for {@linkcode DiscordTrigger}. */
export interface DiscordTriggerOptions extends DiscordFilterOptions {
  /** Discord bot token. */
  token: string;
  /** Post replies into this channel id instead of the source channel. */
  replyChannel?: string;
  /** Suppress the reply when the agent answers with the NO_REPLY sentinel (or nothing). */
  allowSilence?: boolean;
  /** Show the typing indicator in the source channel while the agent works. */
  showTyping?: boolean;
  /** Slash commands to register as Discord application commands, so clients offer a native picker with descriptions. */
  commands?: CommandSpec[];
  /** What an image posted in a channel may cost (from the agent's `limits:` block). */
  media?: MediaLimits;
  /** Voice engines: transcribe incoming voice messages, and (with speak) voice the replies back. */
  voice?: VoiceEngines;
  /** Voice channel names or ids to join for live spoken conversations. */
  voiceChannels?: string[];
  /**
   * Builds the live session for a joined channel; absent means no live voice.
   * The trigger supplies `delegate` — it is the agent loop, closed over the
   * conversation this voice channel speaks into.
   */
  liveVoice?: (delegate: (prompt: string) => Promise<string>) => DiscordVoiceSession;
}

/** A guild as GUILD_CREATE describes it — enough to find the voice channels we were told to join. */
interface DiscordGuild {
  id: string;
  channels?: { id: string; name?: string; type: number }[];
}

/** Discord's channel type for a guild voice channel. */
const GUILD_VOICE_CHANNEL = 2;

/** The voice channels in a guild that the filter names, by id. (pure, unit-tested) */
export function matchVoiceChannels(
  guild: DiscordGuild,
  wanted: string[] | undefined,
): string[] {
  if (!wanted?.length) return [];
  return (guild.channels ?? [])
    .filter((c) => c.type === GUILD_VOICE_CHANNEL)
    .filter((c) => wanted.some((w) => w === c.id || w === c.name))
    .map((c) => c.id);
}

/** A Discord slash-command interaction (the fields this trigger reads). */
export interface DiscordInteraction {
  id: string;
  token: string;
  type: number;
  channel_id?: string;
  guild_id?: string;
  data?: { name?: string; options?: { name: string; value?: string }[] };
  member?: { user?: { id: string; username?: string } };
  user?: { id: string; username?: string };
}

/**
 * Fire `send` now and again every `intervalMs` until the returned stop
 * function is called. Discord's typing indicator expires after ~10 s, so the
 * default interval keeps it alive for the whole run.
 */
export function typingLoop(send: () => void, intervalMs = 8_000): () => void {
  send();
  const timer = setInterval(send, intervalMs);
  return () => clearInterval(timer);
}

/**
 * Listens to the Discord gateway and wakes the agent on matching messages,
 * replying in the source channel (or a configured reply channel).
 */
export class DiscordTrigger implements Trigger {
  /** Trigger name, used as the event's `trigger` field. */
  readonly name = "discord";
  #opts: DiscordTriggerOptions;
  #ws?: WebSocket;
  #heartbeat?: ReturnType<typeof setInterval>;
  #stopped = false;
  #botUserId = "";
  #applicationId = "";
  #channelInfos = new Map<string, DiscordChannelInfo | undefined>();
  #reconnectDelayMs = 1_000;
  /** Live voice sessions, by guild — one conversation per guild at a time. */
  #voiceSessions = new Map<string, DiscordVoiceSession>();
  /** Our own voice session id per guild, half of what the voice server needs. */
  #voiceStates = new Map<string, string>();
  /** Counts spoken turns, so each delegated run carries a distinct event id. */
  #voiceTurn = 0;

  /** Create the trigger; nothing connects until {@linkcode start}. */
  constructor(opts: DiscordTriggerOptions) {
    this.#opts = opts;
  }

  async #api(path: string, init?: RequestInit): Promise<Response> {
    return await fetch(`${API}${path}`, {
      ...init,
      headers: {
        authorization: `Bot ${this.#opts.token}`,
        // FormData rides as multipart with its own boundary (voice uploads).
        ...(init?.body instanceof FormData ? {} : { "content-type": "application/json" }),
        ...init?.headers,
      },
    });
  }

  /** Fetch a voice message's audio from the CDN and hand it to the transcriber. */
  async #transcribe(attachment: DiscordAttachment): Promise<string> {
    const res = await fetch(attachment.url);
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`voice download failed (${res.status})`);
    }
    return await this.#opts.voice!.transcribe({
      audio: new Uint8Array(await res.arrayBuffer()),
      mimeType: attachment.content_type?.split(";")[0].trim() ?? "audio/ogg",
      durationSecs: attachment.duration_secs,
    });
  }

  /** Speak the reply and post it as a voice message; false hands the reply back to the text path. */
  async #sendVoiceReply(msg: DiscordMessage, text: string): Promise<boolean> {
    try {
      const clip = await this.#opts.voice!.speak!(text);
      // Discord accepts only Ogg Opus as a voice message.
      if (clip.mimeType !== "audio/ogg") return false;
      const duration = clip.durationSecs ?? 1;
      const form = new FormData();
      form.append(
        "payload_json",
        JSON.stringify({
          flags: VOICE_MESSAGE_FLAG,
          attachments: [{
            id: "0",
            filename: "voice-message.ogg",
            duration_secs: duration,
            waveform: placeholderWaveform(duration),
          }],
          message_reference: { message_id: msg.id, fail_if_not_exists: false },
        }),
      );
      form.append("files[0]", new Blob([clip.audio], { type: "audio/ogg" }), "voice-message.ogg");
      const res = await this.#api(`/channels/${msg.channel_id}/messages`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        logError(`discord: voice reply failed (${res.status}): ${await res.text()}`);
        return false;
      }
      await res.body?.cancel();
      return true;
    } catch (err) {
      logError(`discord: voice reply failed: ${(err as Error).message}`);
      return false;
    }
  }

  async #channelInfo(channelId: string): Promise<DiscordChannelInfo | undefined> {
    if (!this.#channelInfos.has(channelId)) {
      const res = await this.#api(`/channels/${channelId}`);
      if (!res.ok) {
        await res.body?.cancel();
        this.#channelInfos.set(channelId, undefined);
      } else {
        const { name, parent_id, type } = await res.json();
        // A thread (types 10–12) reports its title as `name` and its channel
        // as `parent_id`; resolving the parent lets the channels filter match
        // either. For non-threads, parent_id is the category — not a channel
        // anyone lists in the filter, so it stays out of the info.
        const isThread = type === 10 || type === 11 || type === 12;
        const parentName = isThread && parent_id
          ? (await this.#channelInfo(parent_id))?.name
          : undefined;
        this.#channelInfos.set(channelId, {
          name,
          parentId: isThread ? parent_id : undefined,
          parentName,
        });
      }
    }
    return this.#channelInfos.get(channelId);
  }

  /** Proactive send (agent-created schedules): "discord:<channelId>" keys are ours. */
  async deliver(conversationKey: string, text: string): Promise<boolean> {
    const match = conversationKey.match(/^discord:(.+)$/);
    if (!match) return false;
    for (const part of splitMessage(text)) {
      const res = await this.#api(`/channels/${match[1]}/messages`, {
        method: "POST",
        body: JSON.stringify({ content: part }),
      });
      if (!res.ok) {
        logError(`discord: deliver failed (${res.status}): ${await res.text()}`);
      } else {
        await res.body?.cancel();
      }
    }
    return true;
  }

  async #reply(msg: DiscordMessage, result: RunResult, asVoice = false) {
    // A leading __VOICE__/__TEXT__ marker overrides the default modality and is
    // stripped from the reply the recipient sees.
    const { mode, text: reply } = replyModality((result.reply ?? "").trim());

    // The agent had nothing to say — with allow_silence, say nothing.
    if (this.#opts.allowSilence && isSilence(reply)) return;

    // Where to post: a dedicated reply channel, else the source channel.
    const target = this.#opts.replyChannel ?? msg.channel_id;
    const inSourceChannel = target === msg.channel_id;

    // A voice message gets a voice message back by default; __VOICE__ forces one
    // and __TEXT__ opts out. Failures and replies too long to speak fall through
    // to the text path; replies routed to another channel stay text, since they
    // quote context.
    const wantsVoice = mode === "voice" || (mode === undefined && asVoice);
    if (
      wantsVoice && this.#opts.voice?.speak && inSourceChannel &&
      reply !== "" && reply.length <= SPEAK_MAX_CHARS &&
      await this.#sendVoiceReply(msg, reply)
    ) return;

    let body = reply || `(${result.status})`;
    if (!inSourceChannel) {
      // Out-of-channel replies carry their own context: quote the triggering
      // message and link back (message_reference only works in-channel).
      const link = msg.guild_id
        ? ` ([jump](https://discord.com/channels/${msg.guild_id}/${msg.channel_id}/${msg.id}))`
        : "";
      const quoted = msg.content.replace(/\n/g, "\n> ");
      body = `On this message${link}:\n> ${quoted}\n\n${body}`;
    }

    for (const part of splitMessage(body)) {
      const res = await this.#api(`/channels/${target}/messages`, {
        method: "POST",
        body: JSON.stringify(
          inSourceChannel
            ? {
              content: part,
              message_reference: { message_id: msg.id, fail_if_not_exists: false },
            }
            : { content: part },
        ),
      });
      if (!res.ok) {
        logError(`discord: reply failed (${res.status}): ${await res.text()}`);
      } else {
        await res.body?.cancel();
      }
    }
  }

  /**
   * Register the command list as global application commands (bulk overwrite,
   * so removed commands disappear too). Native registration is cosmetic —
   * autocomplete and descriptions in the client; failure only logs.
   */
  async #registerCommands() {
    const commands = this.#opts.commands;
    if (!commands?.length) return;
    this.#applicationId = await fetchApplicationId(this.#opts.token);
    const res = await this.#api(`/applications/${this.#applicationId}/commands`, {
      method: "PUT",
      body: JSON.stringify(commands.map((c) => ({
        name: c.name,
        description: c.description,
        type: 1, // CHAT_INPUT
        options: [{
          type: 3, // STRING
          name: "args",
          description: "Text passed to the command",
          required: false,
        }],
      }))),
    });
    if (!res.ok) {
      logError(`discord: command registration failed (${res.status}): ${await res.text()}`);
    } else {
      await res.body?.cancel();
    }
  }

  /**
   * A native slash-command invocation arrives as an interaction, not a
   * message: acknowledge with a deferred reply ("thinking…"), run the agent
   * on the equivalent "/name args" text, then fill the deferred message in.
   */
  async #handleInteraction(
    interaction: DiscordInteraction,
    emit: (event: AgentEvent) => Promise<RunResult>,
  ) {
    if (interaction.type !== 2 || !interaction.data?.name) return; // APPLICATION_COMMAND only
    const user = interaction.member?.user ?? interaction.user;
    // The same author gate as messages, before the model is called.
    if (
      this.#opts.fromUsers?.length && user &&
      !this.#opts.fromUsers.some((u) => u === user.id || u === user.username)
    ) return;

    const ack = await this.#api(`/interactions/${interaction.id}/${interaction.token}/callback`, {
      method: "POST",
      body: JSON.stringify({ type: 5 }), // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
    });
    if (!ack.ok) {
      logError(`discord: interaction ack failed (${ack.status}): ${await ack.text()}`);
      return;
    }
    await ack.body?.cancel();

    const args = interaction.data.options?.find((o) => o.name === "args")?.value ?? "";
    const result = await emit({
      id: interaction.id,
      trigger: this.name,
      input: `/${interaction.data.name}${args ? ` ${args}` : ""}`,
      conversationKey: interaction.channel_id ? `discord:${interaction.channel_id}` : undefined,
    });

    const webhook = `/webhooks/${this.#applicationId}/${interaction.token}`;
    const parts = splitMessage((result.reply ?? "").trim() || `(${result.status})`);
    for (const [i, part] of parts.entries()) {
      const res = i === 0
        ? await this.#api(`${webhook}/messages/@original`, {
          method: "PATCH",
          body: JSON.stringify({ content: part }),
        })
        : await this.#api(webhook, { method: "POST", body: JSON.stringify({ content: part }) });
      if (!res.ok) {
        logError(`discord: interaction reply failed (${res.status}): ${await res.text()}`);
      } else {
        await res.body?.cancel();
      }
    }
  }

  /**
   * Ask the gateway to put us in the guild's voice channel. The answer comes
   * back as two separate events, which is why the join is spread across three
   * handlers: we hold the session id from one and the voice server from the
   * other, and connect once we have both.
   */
  #joinVoice(guild: DiscordGuild, ws: WebSocket) {
    if (!this.#opts.liveVoice) return;
    const [channelId] = matchVoiceChannels(guild, this.#opts.voiceChannels);
    if (!channelId) return;
    logInfo(`discord: joining voice channel ${channelId}`);
    ws.send(JSON.stringify({
      op: 4, // VOICE STATE UPDATE
      d: {
        guild_id: guild.id,
        channel_id: channelId,
        self_mute: false,
        // A deafened bot is sent no audio, and this one is here to listen.
        self_deaf: false,
      },
    }));
  }

  /** The voice server named itself: open the live session behind it. */
  #startVoiceSession(
    server: { guild_id: string; token: string; endpoint?: string },
    emit: (event: AgentEvent) => Promise<RunResult>,
  ) {
    const sessionId = this.#voiceStates.get(server.guild_id);
    // A null endpoint means the voice server is being reassigned; the gateway
    // sends another VOICE_SERVER_UPDATE when the new one is ready.
    if (!this.#opts.liveVoice || !sessionId || !server.endpoint) return;

    this.#voiceSessions.get(server.guild_id)?.stop();
    // What the voice model asks for runs as an ordinary event, in a
    // conversation of its own: spoken history stays out of the text channels'
    // threads, and every tool call still passes the permission engine.
    const session = this.#opts.liveVoice(async (prompt) => {
      const result = await emit({
        id: `voice-${server.guild_id}-${this.#voiceTurn++}`,
        trigger: this.name,
        input: prompt,
        conversationKey: `discord-voice:${server.guild_id}`,
      });
      return (result.reply ?? "").trim() || `(the run ended: ${result.status})`;
    });
    this.#voiceSessions.set(server.guild_id, session);
    session.start({
      endpoint: server.endpoint,
      token: server.token,
      sessionId,
      guildId: server.guild_id,
      userId: this.#botUserId,
    });
  }

  /** Connect to the gateway; matching messages emit events and get replies. */
  async start(emit: (event: AgentEvent) => Promise<RunResult>): Promise<void> {
    const res = await this.#api("/gateway/bot");
    if (!res.ok) {
      throw new Error(`discord: cannot reach gateway (${res.status}) — check the bot token`);
    }
    const { url } = await res.json();
    await this.#registerCommands();
    this.#connect(`${url}?v=10&encoding=json`, emit);
  }

  #connect(gatewayUrl: string, emit: (event: AgentEvent) => Promise<RunResult>) {
    if (this.#stopped) return;
    const ws = new WebSocket(gatewayUrl);
    this.#ws = ws;

    ws.onmessage = async (raw) => {
      const payload = JSON.parse(raw.data);
      switch (payload.op) {
        case 10: { // HELLO → heartbeat + identify
          clearInterval(this.#heartbeat);
          this.#heartbeat = setInterval(
            () => ws.send(JSON.stringify({ op: 1, d: null })),
            payload.d.heartbeat_interval,
          );
          ws.send(JSON.stringify({
            op: 2,
            d: {
              token: this.#opts.token,
              intents: INTENTS,
              properties: { os: "linux", browser: "looped-af", device: "looped-af" },
              // Explicit presence so the bot reads as online for as long as
              // the gateway connection is up.
              presence: { since: null, activities: [], status: "online", afk: false },
            },
          }));
          break;
        }
        case 0: { // dispatch
          if (payload.t === "READY") {
            this.#botUserId = payload.d.user.id;
            this.#reconnectDelayMs = 1_000;
            logInfo(`discord trigger connected as ${payload.d.user.username}`);
          }
          if (payload.t === "INTERACTION_CREATE") {
            this.#handleInteraction(payload.d as DiscordInteraction, emit).catch((err) =>
              logError(`discord: interaction handling failed: ${err}`)
            );
          }
          // The three events a live voice channel join is made of: the guild
          // arrives with its channel list, we ask to join one, and the gateway
          // answers with our session id and the voice server to dial.
          if (payload.t === "GUILD_CREATE") {
            this.#joinVoice(payload.d as DiscordGuild, ws);
          }
          if (payload.t === "VOICE_STATE_UPDATE" && payload.d.user_id === this.#botUserId) {
            this.#voiceStates.set(payload.d.guild_id, payload.d.session_id);
          }
          if (payload.t === "VOICE_SERVER_UPDATE") {
            this.#startVoiceSession(payload.d, emit);
          }
          if (payload.t === "MESSAGE_CREATE") {
            const msg = payload.d as DiscordMessage;
            const channel = this.#opts.channels?.length
              ? await this.#channelInfo(msg.channel_id)
              : undefined;
            if (!shouldHandle(msg, this.#botUserId, channel, this.#opts)) break;
            const stopTyping = this.#opts.showTyping
              ? typingLoop(() => {
                this.#api(`/channels/${msg.channel_id}/typing`, { method: "POST" })
                  .then((res) => res.body?.cancel())
                  .catch(() => {}); // typing is cosmetic — never let it break the run
              })
              : undefined;
            try {
              // With voice engines, a voice message becomes the prompt itself
              // — it carries exactly one attachment and no text, so there is
              // nothing else to resolve. Without them it flows through the
              // media path and resolves to an honest "can't listen" note.
              const voiceNote = this.#opts.voice && isVoiceMessage(msg)
                ? msg.attachments![0]
                : undefined;
              let input: string;
              let images: ImageContent[] = [];
              let asVoice = false;
              if (voiceNote) {
                try {
                  input = await this.#transcribe(voiceNote);
                  asVoice = true;
                } catch (err) {
                  input = `[voice message — transcription failed (${(err as Error).message})]`;
                }
              } else {
                const media = await resolveAttachments(
                  discordAttachments(msg),
                  this.#opts.media ?? DEFAULT_MEDIA,
                );
                // An image with no caption still needs a prompt: the model is
                // told what it is looking at rather than handed an empty turn.
                input = withNotes(msg.content.trim() || NO_CAPTION, media.notes);
                images = media.images;
              }
              const result = await emit({
                id: msg.id,
                trigger: this.name,
                input,
                images,
                conversationKey: `discord:${msg.channel_id}`,
              });
              await this.#reply(msg, result, asVoice);
            } finally {
              stopTyping?.();
            }
          }
          break;
        }
        case 7: // RECONNECT
        case 9: // INVALID SESSION
          ws.close();
          break;
      }
    };

    ws.onclose = () => {
      clearInterval(this.#heartbeat);
      if (this.#stopped) return;
      const delay = this.#reconnectDelayMs;
      this.#reconnectDelayMs = Math.min(delay * 2, 60_000);
      logInfo(`discord: gateway closed, reconnecting in ${delay}ms`);
      setTimeout(() => this.#connect(gatewayUrl, emit), delay);
    };
    ws.onerror = () => ws.close();
  }

  /** Close the gateway connection, leave every voice channel, and stop reconnecting. */
  stop(): Promise<void> {
    this.#stopped = true;
    clearInterval(this.#heartbeat);
    for (const session of this.#voiceSessions.values()) session.stop();
    this.#voiceSessions.clear();
    this.#ws?.close();
    return Promise.resolve();
  }
}
