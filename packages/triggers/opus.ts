import OpusScript from "opusscript";
import { Buffer } from "node:buffer";

// The framework's one codec dependency, a cost plan 15 names up front:
// Discord speaks Opus and the realtime API PCM, so the live voice bridge
// transcodes. opusscript is libopus compiled to WASM — no native bindings,
// nothing leaves the Deno sandbox — and the dependency stays contained to
// this module.

/** 20 ms of 48 kHz audio per channel — the frame size Discord expects. */
export const FRAME_SAMPLES = 960;

/** Discord voice runs at 48 kHz… */
export const SAMPLE_RATE = 48_000;

/** …in stereo. */
export const CHANNELS = 2;

/** One libopus instance: an encoder and decoder pair over 48 kHz stereo. */
export class OpusCodec {
  #codec: OpusScript;

  constructor() {
    this.#codec = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO);
  }

  /**
   * One 20 ms interleaved-stereo frame → an Opus packet. opusscript speaks
   * Node's Buffer, which is a Uint8Array subclass — the conversions here are
   * type-level, not copies of the audio.
   */
  encode(frame: Int16Array): Uint8Array<ArrayBuffer> {
    const bytes = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
    // Copy out: the codec hands back a view of its own reusable heap.
    return new Uint8Array(this.#codec.encode(bytes, FRAME_SAMPLES));
  }

  /** An Opus packet → interleaved-stereo samples. */
  decode(packet: Uint8Array): Int16Array {
    const decoded = this.#codec.decode(Buffer.from(packet));
    // Copy before the view: the decoder's output buffer is reused next call.
    const bytes = new Uint8Array(decoded);
    return new Int16Array(bytes.buffer, 0, bytes.length >> 1);
  }

  /** Free the WASM-side encoder and decoder state. */
  destroy() {
    this.#codec.delete();
  }
}
