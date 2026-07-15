import type { VoiceConfig, VoiceSttConfig, VoiceTtsConfig } from "@looped/core";
import { DEFAULT_VOICE_API_KEY_ENV } from "@looped/core";

// STT/TTS engines behind voice notes, dependency-free like every other client
// in this package. Both providers emit Ogg Opus — the one container Telegram
// and Discord both accept as a voice note — so nothing here transcodes.

/** A voice note: encoded audio plus its container type. */
export interface VoiceClip {
  /** The encoded audio bytes. */
  audio: Uint8Array<ArrayBuffer>;
  /** Container MIME type, e.g. "audio/ogg". */
  mimeType: string;
  /** Playback length in seconds, when known. */
  durationSecs?: number;
}

/** The engines a voice-capable trigger calls: transcribe always, speak when tts is configured. */
export interface VoiceEngines {
  /** Voice note in, transcript out. */
  transcribe(clip: VoiceClip): Promise<string>;
  /** Reply text in, voice note out (Ogg Opus). Absent without a tts block. */
  speak?: (text: string) => Promise<VoiceClip>;
}

/**
 * Longest reply speak() is asked to voice; longer replies fall back to text.
 * OpenAI caps speech input at 4096 chars, and a reply that long is a document,
 * not a voice note.
 */
export const SPEAK_MAX_CHARS = 4_000;

const DEFAULT_STT_MODEL: Record<VoiceSttConfig["provider"], string> = {
  openai: "gpt-4o-mini-transcribe",
  elevenlabs: "scribe_v2",
};
const DEFAULT_TTS_MODEL: Record<VoiceTtsConfig["provider"], string> = {
  openai: "gpt-4o-mini-tts",
  elevenlabs: "eleven_multilingual_v2",
};
// alloy is OpenAI's default voice; the id is ElevenLabs' premade "Rachel".
const DEFAULT_TTS_VOICE: Record<VoiceTtsConfig["provider"], string> = {
  openai: "alloy",
  elevenlabs: "21m00Tcm4TlvDq8ikWAM",
};

/** OpenAI-dialect endpoint root: config base_url (e.g. a metering gateway) or the real API. */
function openaiBase(cfg: VoiceSttConfig | VoiceTtsConfig): string {
  return (cfg.base_url ?? "https://api.openai.com/v1").replace(/\/+$/, "");
}

/** The filename a clip uploads under — some APIs sniff the container from it. */
function fileName(mimeType: string): string {
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "voice.mp3";
  if (mimeType.includes("mp4") || mimeType.includes("m4a")) return "voice.m4a";
  return "voice.ogg";
}

function resolveKey(
  cfg: VoiceSttConfig | VoiceTtsConfig,
  getEnv: (name: string) => string | undefined,
  what: string,
): string {
  const envName = cfg.api_key_env ?? DEFAULT_VOICE_API_KEY_ENV[cfg.provider];
  const key = getEnv(envName);
  if (!key) throw new Error(`voice ${what}: API key env var ${envName} is not set`);
  return key;
}

function openaiTranscribe(cfg: VoiceSttConfig, key: string, fetchFn: typeof fetch) {
  return async (clip: VoiceClip): Promise<string> => {
    const form = new FormData();
    form.append("model", cfg.model ?? DEFAULT_STT_MODEL.openai);
    form.append("file", new Blob([clip.audio], { type: clip.mimeType }), fileName(clip.mimeType));
    const res = await fetchFn(`${openaiBase(cfg)}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body: form,
    });
    if (!res.ok) {
      throw new Error(
        `voice stt: openai transcription failed (${res.status}): ${await res.text()}`,
      );
    }
    return (((await res.json()).text as string) ?? "").trim();
  };
}

function elevenlabsTranscribe(cfg: VoiceSttConfig, key: string, fetchFn: typeof fetch) {
  return async (clip: VoiceClip): Promise<string> => {
    const form = new FormData();
    form.append("model_id", cfg.model ?? DEFAULT_STT_MODEL.elevenlabs);
    form.append("file", new Blob([clip.audio], { type: clip.mimeType }), fileName(clip.mimeType));
    const res = await fetchFn("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": key },
      body: form,
    });
    if (!res.ok) {
      throw new Error(
        `voice stt: elevenlabs transcription failed (${res.status}): ${await res.text()}`,
      );
    }
    return (((await res.json()).text as string) ?? "").trim();
  };
}

function openaiSpeak(cfg: VoiceTtsConfig, key: string, fetchFn: typeof fetch) {
  return async (text: string): Promise<VoiceClip> => {
    const res = await fetchFn(`${openaiBase(cfg)}/audio/speech`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: cfg.model ?? DEFAULT_TTS_MODEL.openai,
        voice: cfg.voice ?? DEFAULT_TTS_VOICE.openai,
        input: text,
        response_format: "opus",
      }),
    });
    if (!res.ok) {
      throw new Error(`voice tts: openai speech failed (${res.status}): ${await res.text()}`);
    }
    const audio = new Uint8Array(await res.arrayBuffer());
    return { audio, mimeType: "audio/ogg", durationSecs: oggOpusDurationSecs(audio) };
  };
}

function elevenlabsSpeak(cfg: VoiceTtsConfig, key: string, fetchFn: typeof fetch) {
  return async (text: string): Promise<VoiceClip> => {
    const voice = cfg.voice ?? DEFAULT_TTS_VOICE.elevenlabs;
    const res = await fetchFn(
      `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=opus_48000_64`,
      {
        method: "POST",
        headers: { "xi-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({ text, model_id: cfg.model ?? DEFAULT_TTS_MODEL.elevenlabs }),
      },
    );
    if (!res.ok) {
      throw new Error(`voice tts: elevenlabs speech failed (${res.status}): ${await res.text()}`);
    }
    const audio = new Uint8Array(await res.arrayBuffer());
    return { audio, mimeType: "audio/ogg", durationSecs: oggOpusDurationSecs(audio) };
  };
}

/**
 * Build the engines a config declares. A voice block holding only `live`
 * configures no note engines, so there is nothing to build here.
 * API keys resolve from *_env here — startup, not first voice note.
 */
export function voiceFromConfig(
  config: VoiceConfig,
  getEnv: (name: string) => string | undefined = Deno.env.get,
  fetchFn: typeof fetch = fetch,
): VoiceEngines | undefined {
  if (!config.stt) return undefined;
  const sttKey = resolveKey(config.stt, getEnv, "stt");
  const transcribe = config.stt.provider === "openai"
    ? openaiTranscribe(config.stt, sttKey, fetchFn)
    : elevenlabsTranscribe(config.stt, sttKey, fetchFn);
  if (!config.tts) return { transcribe };
  const ttsKey = resolveKey(config.tts, getEnv, "tts");
  const speak = config.tts.provider === "openai"
    ? openaiSpeak(config.tts, ttsKey, fetchFn)
    : elevenlabsSpeak(config.tts, ttsKey, fetchFn);
  return { transcribe, speak };
}

/**
 * Playback seconds of an Ogg Opus stream: the last page's granule position
 * counts 48 kHz PCM samples, minus the encoder pre-skip OpusHead declares
 * (RFC 7845). Returns undefined for anything that doesn't parse as Ogg.
 * (pure, unit-tested)
 */
export function oggOpusDurationSecs(bytes: Uint8Array): number | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  let preSkip = 0;
  let lastGranule: bigint | undefined;
  let first = true;
  while (offset + 27 <= bytes.length) {
    // Every page starts with the "OggS" capture pattern.
    if (
      bytes[offset] !== 0x4f || bytes[offset + 1] !== 0x67 ||
      bytes[offset + 2] !== 0x67 || bytes[offset + 3] !== 0x53
    ) return undefined;
    const granule = view.getBigUint64(offset + 6, true);
    const segments = bytes[offset + 26];
    if (offset + 27 + segments > bytes.length) break;
    let payload = 0;
    for (let i = 0; i < segments; i++) payload += bytes[offset + 27 + i];
    const body = offset + 27 + segments;
    if (first) {
      // OpusHead carries the pre-skip as the u16 at payload bytes 10–11.
      const isHead = payload >= 12 &&
        String.fromCharCode(...bytes.subarray(body, body + 8)) === "OpusHead";
      if (isHead) preSkip = view.getUint16(body + 10, true);
      first = false;
    }
    // A granule of all ones marks a page that completes no packet.
    if (granule !== 0xffff_ffff_ffff_ffffn) lastGranule = granule;
    offset = body + payload;
  }
  if (lastGranule === undefined) return undefined;
  const samples = Number(lastGranule) - preSkip;
  return samples > 0 ? samples / 48_000 : 0;
}

/**
 * Discord previews a voice message with a waveform: up to 256 amplitude
 * bytes, base64-encoded. Real amplitudes would take an Opus decode, so this
 * is a gentle placeholder swell — purely cosmetic. (pure, unit-tested)
 */
export function placeholderWaveform(durationSecs = 1): string {
  const points = Math.max(8, Math.min(256, Math.round(durationSecs * 10)));
  const bytes = new Uint8Array(points);
  for (let i = 0; i < points; i++) bytes[i] = 96 + Math.round(64 * Math.abs(Math.sin(i / 3)));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
