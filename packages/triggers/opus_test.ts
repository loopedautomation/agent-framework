import { assert, assertEquals } from "@std/assert";
import { FRAME_SAMPLES, OpusCodec } from "./opus.ts";

Deno.test("opus: a 20ms stereo frame round-trips through the codec", () => {
  const codec = new OpusCodec();
  try {
    // A quiet 440 Hz tone, interleaved stereo.
    const frame = new Int16Array(FRAME_SAMPLES * 2);
    for (let i = 0; i < FRAME_SAMPLES; i++) {
      const s = Math.round(4000 * Math.sin((2 * Math.PI * 440 * i) / 48_000));
      frame[2 * i] = s;
      frame[2 * i + 1] = s;
    }
    const packet = codec.encode(frame);
    assert(packet.length > 0 && packet.length < 1000); // compressed, plausibly sized
    const decoded = codec.decode(packet);
    assertEquals(decoded.length, FRAME_SAMPLES * 2); // one full frame back
  } finally {
    codec.destroy();
  }
});
