import { assert, assertEquals } from "@std/assert";
import {
  discordToRealtime,
  downmixToMono,
  pcmFromBytes,
  pcmToBytes,
  realtimeToDiscord,
  resample,
  upmixToStereo,
} from "./pcm.ts";

Deno.test("downmix and upmix are shape-true inverses", () => {
  const stereo = new Int16Array([100, 200, -100, -200, 0, 1000]);
  const mono = downmixToMono(stereo);
  assertEquals(mono.length, 3);
  assertEquals(mono[0], 150); // average of the pair
  const back = upmixToStereo(mono);
  assertEquals(back.length, 6);
  assertEquals(back[0], back[1]); // both channels carry the same sample
});

Deno.test("resample: halving and doubling land on the expected lengths", () => {
  const pcm = new Int16Array(960);
  assertEquals(resample(pcm, 48_000, 24_000).length, 480);
  assertEquals(resample(pcm, 24_000, 48_000).length, 1920);
  // Same rate is a pass-through, same instance.
  assertEquals(resample(pcm, 48_000, 48_000), pcm);
});

Deno.test("resample: a constant signal survives untouched", () => {
  const pcm = new Int16Array(480).fill(1234);
  const up = resample(pcm, 24_000, 48_000);
  assert(up.every((s) => s === 1234));
  const down = resample(pcm, 24_000, 12_000);
  assert(down.every((s) => s === 1234));
});

Deno.test("pcm bytes round-trip, little-endian, odd tail dropped", () => {
  const pcm = new Int16Array([1, -1, 32767, -32768]);
  const bytes = pcmToBytes(pcm);
  assertEquals(bytes.length, 8);
  assertEquals(Array.from(pcmFromBytes(bytes)), [1, -1, 32767, -32768]);
  // An unaligned, odd-length view still parses — the dangling byte is dropped.
  const padded = new Uint8Array(11);
  padded.set(bytes, 1);
  assertEquals(pcmFromBytes(padded.subarray(1, 10)).length, 4);
});

Deno.test("the discord/realtime bridge halves and doubles as one call", () => {
  const stereo48k = new Int16Array(1920); // one 20ms frame, interleaved stereo
  const mono24kBytes = discordToRealtime(stereo48k);
  assertEquals(mono24kBytes.length, 480 * 2); // 480 samples of PCM16
  const back = realtimeToDiscord(mono24kBytes);
  assertEquals(back.length, 1920);
});
