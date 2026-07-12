// PCM helpers for the live voice bridge: Discord speaks 48 kHz interleaved
// stereo and the realtime API 24 kHz mono, both PCM16 little-endian. Linear
// interpolation is plenty for speech — anything fancier buys nothing audible
// after the Opus round trip. All pure functions, unit-tested.

/** Interleaved stereo → mono by averaging each left/right pair. */
export function downmixToMono(stereo: Int16Array): Int16Array {
  const mono = new Int16Array(stereo.length >> 1);
  for (let i = 0; i < mono.length; i++) {
    mono[i] = (stereo[2 * i] + stereo[2 * i + 1]) >> 1;
  }
  return mono;
}

/** Mono → interleaved stereo by duplicating each sample into both channels. */
export function upmixToStereo(mono: Int16Array): Int16Array {
  const stereo = new Int16Array(mono.length * 2);
  for (let i = 0; i < mono.length; i++) {
    stereo[2 * i] = mono[i];
    stereo[2 * i + 1] = mono[i];
  }
  return stereo;
}

/** Resample mono PCM between rates by linear interpolation. */
export function resample(pcm: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate) return pcm;
  const outLength = Math.floor(pcm.length * toRate / fromRate);
  const out = new Int16Array(outLength);
  const step = fromRate / toRate;
  for (let i = 0; i < outLength; i++) {
    const pos = i * step;
    const at = Math.floor(pos);
    const frac = pos - at;
    const a = pcm[at];
    const b = pcm[Math.min(at + 1, pcm.length - 1)];
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/**
 * PCM16 bytes → samples. Copies, so the view is aligned whatever the source
 * offset was. Little-endian throughout — every platform this runs on is.
 */
export function pcmFromBytes(bytes: Uint8Array): Int16Array {
  const copy = bytes.slice(0, bytes.length - (bytes.length % 2));
  return new Int16Array(copy.buffer, 0, copy.length >> 1);
}

/** Samples → PCM16 bytes (little-endian). */
export function pcmToBytes(pcm: Int16Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(pcm.length * 2);
  new Int16Array(out.buffer).set(pcm);
  return out;
}

/** Discord's decoded 48 kHz stereo samples → the realtime API's 24 kHz mono bytes. */
export function discordToRealtime(stereo48k: Int16Array): Uint8Array<ArrayBuffer> {
  return pcmToBytes(resample(downmixToMono(stereo48k), 48_000, 24_000));
}

/** The realtime API's 24 kHz mono bytes → Discord's 48 kHz interleaved stereo samples. */
export function realtimeToDiscord(bytes24k: Uint8Array): Int16Array {
  return upmixToStereo(resample(pcmFromBytes(bytes24k), 24_000, 48_000));
}
