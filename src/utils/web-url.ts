import { z } from 'zod/v4';

export const webUrlMessage = 'Enter a valid http(s) URL.';

export function isSafeWebUrl(value: string) {
  if (!value) return true;

  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export const optionalWebUrl = z.string().trim().refine(isSafeWebUrl, {
  message: webUrlMessage,
});

export const socialLinksInput = z
  .object({
    twitter: optionalWebUrl.optional(),
    discord: optionalWebUrl.optional(),
    linkedin: optionalWebUrl.optional(),
    website: optionalWebUrl.optional(),
  })
  .optional()
  .nullable();
