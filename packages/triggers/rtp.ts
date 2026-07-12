// RTP packets for Discord voice: build and parse the 12-byte header, seal and
// open payloads with aead_aes256_gcm_rtpsize, and speak the UDP IP-discovery
// dialect. Pure functions plus WebCrypto — no sockets in this file, so all of
// it unit-tests without a network.

/** The RTP header this bridge sends: no CSRCs, no extension. */
export const RTP_HEADER_BYTES = 12;

/** The Opus silence frame; five of these precede going quiet, per Discord. */
export const SILENCE_FRAME: Uint8Array = new Uint8Array([0xf8, 0xff, 0xfe]);

/** The encryption mode this bridge selects; every current voice server offers it. */
export const ENCRYPTION_MODE = "aead_aes256_gcm_rtpsize";

/** Build the 12-byte RTP header: version 2, payload type 0x78, BE fields. */
export function rtpHeader(seq: number, timestamp: number, ssrc: number): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(RTP_HEADER_BYTES);
  const view = new DataView(header.buffer);
  header[0] = 0x80;
  header[1] = 0x78;
  view.setUint16(2, seq & 0xffff);
  view.setUint32(4, timestamp >>> 0);
  view.setUint32(8, ssrc >>> 0);
  return header;
}

/** What the receive path needs to know about an inbound packet before decrypting. */
export interface RtpPacketInfo {
  seq: number;
  timestamp: number;
  ssrc: number;
  /** Header, CSRCs and (when present) the 4-byte extension preamble — the AAD in rtpsize modes. */
  unencryptedBytes: number;
  /** 32-bit words of extension data sitting at the start of the plaintext. */
  extensionWords: number;
}

/**
 * Parse an inbound packet's clear portion. Returns undefined for anything
 * that isn't RTP carrying audio — RTCP reports share the socket and land
 * here too, distinguishable by payload type.
 */
export function parseRtp(packet: Uint8Array): RtpPacketInfo | undefined {
  if (packet.length < RTP_HEADER_BYTES + 4) return undefined;
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  if (packet[0] >> 6 !== 2) return undefined; // RTP version 2
  const payloadType = packet[1] & 0x7f;
  if (payloadType < 96 || payloadType > 127) return undefined; // RTCP, not audio
  const csrcCount = packet[0] & 0x0f;
  const hasExtension = (packet[0] & 0x10) !== 0;
  const unencryptedBytes = RTP_HEADER_BYTES + csrcCount * 4 + (hasExtension ? 4 : 0);
  if (packet.length < unencryptedBytes + 4) return undefined;
  const extensionWords = hasExtension ? view.getUint16(RTP_HEADER_BYTES + csrcCount * 4 + 2) : 0;
  return {
    seq: view.getUint16(2),
    timestamp: view.getUint32(4),
    ssrc: view.getUint32(8),
    unencryptedBytes,
    extensionWords,
  };
}

/** Import the session key the voice gateway hands over in Session Description. */
export async function importVoiceKey(secretKey: number[]): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    new Uint8Array(secretKey),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

/** The 12-byte AES-GCM nonce: a 32-bit counter up front, zeros behind. */
function nonceBytes(counter: number): Uint8Array<ArrayBuffer> {
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setUint32(0, counter >>> 0);
  return nonce;
}

/**
 * Seal one outbound packet: header ‖ ciphertext(opus)+tag ‖ nonce counter.
 * The header is authenticated but not encrypted (that's the "rtpsize" part),
 * and the receiver reads the nonce back from the trailing four bytes.
 */
export async function sealRtp(
  key: CryptoKey,
  header: Uint8Array<ArrayBuffer>,
  opus: Uint8Array<ArrayBuffer>,
  nonceCounter: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const nonce = nonceBytes(nonceCounter);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: header },
      key,
      opus,
    ),
  );
  const packet = new Uint8Array(header.length + sealed.length + 4);
  packet.set(header);
  packet.set(sealed, header.length);
  packet.set(nonce.subarray(0, 4), header.length + sealed.length);
  return packet;
}

/**
 * Open one inbound packet and return its Opus payload, with any header
 * extension data stripped. Returns undefined when the seal doesn't verify —
 * a stray or tampered packet is dropped, never thrown.
 */
export async function openRtp(
  key: CryptoKey,
  packet: Uint8Array<ArrayBuffer>,
  info: RtpPacketInfo,
): Promise<Uint8Array | undefined> {
  const nonce = new Uint8Array(12);
  nonce.set(packet.subarray(packet.length - 4));
  try {
    const plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce, additionalData: packet.subarray(0, info.unencryptedBytes) },
        key,
        packet.subarray(info.unencryptedBytes, packet.length - 4),
      ),
    );
    return plain.subarray(info.extensionWords * 4);
  } catch {
    return undefined;
  }
}

/** The 74-byte IP discovery request: type 1, length 70, our SSRC. */
export function ipDiscoveryRequest(ssrc: number): Uint8Array<ArrayBuffer> {
  const packet = new Uint8Array(74);
  const view = new DataView(packet.buffer);
  view.setUint16(0, 1);
  view.setUint16(2, 70);
  view.setUint32(4, ssrc >>> 0);
  return packet;
}

/** Parse the discovery response into the address and port the world sees us at. */
export function parseIpDiscovery(
  packet: Uint8Array,
): { address: string; port: number } | undefined {
  if (packet.length !== 74) return undefined;
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  if (view.getUint16(0) !== 2) return undefined; // type 2 = response
  const raw = packet.subarray(8, 72);
  const end = raw.indexOf(0);
  const address = new TextDecoder().decode(raw.subarray(0, end === -1 ? raw.length : end));
  return { address, port: view.getUint16(72) };
}
