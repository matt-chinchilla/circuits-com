// A lead's profile picture — the rules the three pages share (list avatar,
// profile, Add lead). The picture itself travels the admin's ONE image
// pipeline (ImageUploadField → LogoCropperModal → canvasToDataUrl) and the
// server re-checks it with utils/image_url.validate_optional_image_url.

import { safeImageUrl } from '@shared/utils/url';

/** The server's MAX_IMAGE_URL_LEN (api/app/utils/image_url.py). A cropped
 *  upload is ~10-25 KB of base64, so only a pasted blob gets near it. */
export const PHOTO_MAX_CHARS = 200_000;

const WORD_START = /[\p{L}\p{N}]/u;

/**
 * Up to two letters for the avatar when there is no picture: the first and
 * last word of the PERSON's name. A company-only row gets none — the avatar
 * shows a company mark instead, so a row with nobody on file never reads as
 * a person called "Bisco Industries" (owner, 2026-09-25). A nickname in
 * parentheses is not part of the name: "Robert (Bob) Smith" → "RS". null
 * when the name has no letter or digit to show.
 */
export function leadInitials(contactName: string | null): string | null {
  for (const name of [contactName]) {
    const words = (name ?? '')
      .replace(/\([^)]*\)/g, ' ')
      .split(/\s+/)
      .map((w) => [...w].find((ch) => WORD_START.test(ch)))
      .filter((ch): ch is string => ch !== undefined);
    if (words.length === 0) continue;
    const letters = words.length === 1 ? words[0] : words[0] + words[words.length - 1];
    return letters.toUpperCase();
  }
  return null;
}

/** What a PATCH/POST sends for the field: the trimmed value, or null (clear). */
export function photoForSave(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed ? trimmed : null;
}

/**
 * Why this value cannot be saved as a photo, in the console's voice — or
 * undefined when it can (an empty field included: that clears the picture).
 * The same allowlist as the server: a raster data:image URL or http(s).
 */
export function photoError(value: string | null | undefined): string | undefined {
  const trimmed = photoForSave(value);
  if (trimmed === null) return undefined;
  if ([...trimmed].length > PHOTO_MAX_CHARS) {
    return 'That image is too large to store. Upload the file instead and it will be cropped to size.';
  }
  if (safeImageUrl(trimmed) === null) {
    return 'Paste an image link that starts with https://, or upload a picture.';
  }
  return undefined;
}
