import type { ImageContent } from "@looped/core";

/**
 * The parts a WebSocket-carried conversation needs whatever its semantics
 * are. `tty` and `meet` share a transport and an auth scheme and differ in
 * what a connection means, so this holds the former and neither owns the
 * latter.
 */

/** Image media types a client may attach to a turn. */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** Most images one turn may carry. */
export const MAX_IMAGES = 4;

/** Largest base64 payload per image: roughly 6MB of pixels. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Whether an untrusted `images` field is a well-formed attachment list. */
export function validImages(
  images: unknown,
): images is { mediaType: ImageContent["mediaType"]; data: string }[] {
  if (images === undefined) return true;
  return Array.isArray(images) && images.length <= MAX_IMAGES &&
    images.every((i) =>
      typeof i === "object" && i !== null &&
      IMAGE_TYPES.includes((i as { mediaType?: string }).mediaType ?? "") &&
      typeof (i as { data?: string }).data === "string" &&
      (i as { data: string }).data.length <= MAX_IMAGE_BYTES
    );
}
