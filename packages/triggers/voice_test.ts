import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  oggOpusDurationSecs,
  placeholderWaveform,
  type VoiceClip,
  voiceFromConfig,
} from "./voice.ts";

/** A fetch stub that records every request and answers from a queue. */
function recordingFetch(...responses: Response[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = ((url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(responses.shift() ?? new Response("{}"));
  }) as typeof fetch;
  return { calls, fetchFn };
}

const clip: VoiceClip = { audio: new Uint8Array([1, 2, 3]), mimeType: "audio/ogg" };

Deno.test("voiceFromConfig: a missing API key names its env var at startup", () => {
  assertThrows(
    () => voiceFromConfig({ stt: { provider: "openai" } }, () => undefined),
    Error,
    "OPENAI_API_KEY",
  );
  assertThrows(
    () => voiceFromConfig({ stt: { provider: "elevenlabs" } }, () => undefined),
    Error,
    "ELEVENLABS_API_KEY",
  );
  // A custom reference resolves instead of the default — and is named when missing.
  assertThrows(
    () => voiceFromConfig({ stt: { provider: "openai", api_key_env: "MY_KEY" } }, () => undefined),
    Error,
    "MY_KEY",
  );
  // tts resolves its own key, which may differ from stt's.
  assertThrows(
    () =>
      voiceFromConfig(
        { stt: { provider: "openai" }, tts: { provider: "elevenlabs" } },
        (n) => n === "OPENAI_API_KEY" ? "sk-1" : undefined,
      ),
    Error,
    "ELEVENLABS_API_KEY",
  );
});

Deno.test("transcribe: openai gets a multipart upload with the default model", async () => {
  const { calls, fetchFn } = recordingFetch(
    new Response(JSON.stringify({ text: " hello there " })),
  );
  const engines = voiceFromConfig({ stt: { provider: "openai" } }, () => "sk-1", fetchFn);
  assertEquals(await engines.transcribe(clip), "hello there"); // trimmed
  assertEquals(calls[0].url, "https://api.openai.com/v1/audio/transcriptions");
  const headers = calls[0].init?.headers as Record<string, string>;
  assertEquals(headers.authorization, "Bearer sk-1");
  const form = calls[0].init?.body as FormData;
  assertEquals(form.get("model"), "gpt-4o-mini-transcribe");
  const file = form.get("file") as File;
  assertEquals(file.type, "audio/ogg");
  assertEquals(file.name, "voice.ogg");
});

Deno.test("transcribe: elevenlabs authenticates with xi-api-key and model_id", async () => {
  const { calls, fetchFn } = recordingFetch(new Response(JSON.stringify({ text: "hi" })));
  const engines = voiceFromConfig(
    { stt: { provider: "elevenlabs", model: "scribe_v1" } },
    () => "el-1",
    fetchFn,
  );
  assertEquals(await engines.transcribe(clip), "hi");
  assertEquals(calls[0].url, "https://api.elevenlabs.io/v1/speech-to-text");
  const headers = calls[0].init?.headers as Record<string, string>;
  assertEquals(headers["xi-api-key"], "el-1");
  const form = calls[0].init?.body as FormData;
  assertEquals(form.get("model_id"), "scribe_v1"); // the override, not the default
});

Deno.test("speak: openai asks for Ogg Opus with the default voice", async () => {
  const { calls, fetchFn } = recordingFetch(new Response(new Uint8Array([9, 9])));
  const engines = voiceFromConfig(
    { stt: { provider: "openai" }, tts: { provider: "openai" } },
    () => "sk-1",
    fetchFn,
  );
  const out = await engines.speak!("hello");
  assertEquals(out.mimeType, "audio/ogg");
  assertEquals(out.audio.length, 2);
  assertEquals(calls[0].url, "https://api.openai.com/v1/audio/speech");
  const body = JSON.parse(String(calls[0].init?.body));
  assertEquals(body, {
    model: "gpt-4o-mini-tts",
    voice: "alloy",
    input: "hello",
    response_format: "opus",
  });
});

Deno.test("speak: elevenlabs addresses the voice id and asks for opus", async () => {
  const { calls, fetchFn } = recordingFetch(new Response(new Uint8Array([9])));
  const engines = voiceFromConfig(
    { stt: { provider: "openai" }, tts: { provider: "elevenlabs", voice: "v-99" } },
    (n) => n === "ELEVENLABS_API_KEY" ? "el-1" : "sk-1",
    fetchFn,
  );
  const out = await engines.speak!("hello");
  assertEquals(out.mimeType, "audio/ogg");
  assertEquals(
    calls[0].url,
    "https://api.elevenlabs.io/v1/text-to-speech/v-99?output_format=opus_48000_64",
  );
  const body = JSON.parse(String(calls[0].init?.body));
  assertEquals(body, { text: "hello", model_id: "eleven_multilingual_v2" });
});

Deno.test("voiceFromConfig: no tts block means no speak engine", () => {
  const engines = voiceFromConfig({ stt: { provider: "openai" } }, () => "sk-1");
  assertEquals(engines.speak, undefined);
});

// --- Ogg parsing ---

/** One Ogg page: header, lacing values, payload. */
function oggPage(granule: bigint, payload: Uint8Array): Uint8Array {
  const lacing: number[] = [];
  let rest = payload.length;
  while (rest >= 255) {
    lacing.push(255);
    rest -= 255;
  }
  lacing.push(rest);
  const page = new Uint8Array(27 + lacing.length + payload.length);
  page.set([0x4f, 0x67, 0x67, 0x53]); // "OggS"
  new DataView(page.buffer).setBigUint64(6, granule, true);
  page[26] = lacing.length;
  page.set(lacing, 27);
  page.set(payload, 27 + lacing.length);
  return page;
}

/** A minimal OpusHead payload with the given pre-skip. */
function opusHead(preSkip: number): Uint8Array {
  const head = new Uint8Array(19);
  new TextEncoder().encodeInto("OpusHead", head);
  head[8] = 1; // version
  head[9] = 1; // channels
  new DataView(head.buffer).setUint16(10, preSkip, true);
  return head;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

Deno.test("oggOpusDurationSecs: last granule minus pre-skip, over 48kHz", () => {
  const stream = concat(
    oggPage(0n, opusHead(312)),
    oggPage(0n, new TextEncoder().encode("OpusTags")),
    oggPage(48_312n, new Uint8Array(40)), // one second of samples after pre-skip
  );
  assertEquals(oggOpusDurationSecs(stream), 1);
});

Deno.test("oggOpusDurationSecs: skips no-packet pages, refuses non-Ogg bytes", () => {
  // The -1 granule marks a continuation page; the real position is earlier.
  const stream = concat(
    oggPage(0n, opusHead(0)),
    oggPage(96_000n, new Uint8Array(10)),
    oggPage(0xffff_ffff_ffff_ffffn, new Uint8Array(3)),
  );
  assertEquals(oggOpusDurationSecs(stream), 2);
  assertEquals(oggOpusDurationSecs(new TextEncoder().encode("ID3 not an ogg")), undefined);
  assertEquals(oggOpusDurationSecs(new Uint8Array(0)), undefined);
});

Deno.test("placeholderWaveform: base64 of at most 256 amplitude bytes", () => {
  const short = atob(placeholderWaveform(1));
  assert(short.length >= 8 && short.length <= 256);
  const long = atob(placeholderWaveform(600));
  assertEquals(long.length, 256); // capped, never over Discord's limit
});
