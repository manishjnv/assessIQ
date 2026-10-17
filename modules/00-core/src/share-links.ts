// Pure share-link builder for certificate pages (used by the result email).
// Only https verify URLs are accepted; everything is encodeURIComponent'd.

export interface ShareLinks {
  linkedin: string;
  x: string;
  whatsapp: string;
  /** The plain verify URL, for a copy-link line. */
  copy: string;
}

/** Returns null unless `verifyUrl` is a valid https URL. */
export function buildShareLinks(verifyUrl: string, text: string): ShareLinks | null {
  let u: URL;
  try {
    u = new URL(verifyUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const url = encodeURIComponent(u.toString());
  const t = encodeURIComponent(text);
  return {
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${url}`,
    x: `https://twitter.com/intent/tweet?url=${url}&text=${t}`,
    whatsapp: `https://wa.me/?text=${encodeURIComponent(`${text} ${u.toString()}`)}`,
    copy: u.toString(),
  };
}
