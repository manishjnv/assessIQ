// modules/01-auth/src/signup-blocklist.ts
//
// Z-71: small editable data file for the self-serve sign-up. Staff edit the two lists below
// and deploy; no other code changes. A blocked request gets the same neutral answer as any
// other request (no mail is sent), so the list is not an oracle.

/** Throw-away mail hosts. Compared with the part of the address after the last "@". */
export const BLOCKED_EMAIL_DOMAINS: readonly string[] = [
  "mailinator.com",
  "guerrillamail.com",
  "guerrillamail.net",
  "sharklasers.com",
  "10minutemail.com",
  "tempmail.com",
  "temp-mail.org",
  "trashmail.com",
  "yopmail.com",
  "getnada.com",
  "dispostable.com",
  "throwawaymail.com",
];

/**
 * Well-known brand and authority names an organisation may not claim (a visitor could
 * otherwise send invitations and certificates under that name). Matched as whole words
 * anywhere in the normalised organisation name.
 */
export const BLOCKED_ORG_NAMES: readonly string[] = [
  "assessiq",
  "google",
  "microsoft",
  "amazon",
  "apple",
  "facebook",
  "meta",
  "ibm",
  "oracle",
  "tcs",
  "tata consultancy services",
  "infosys",
  "wipro",
  "hcl",
  "accenture",
  "cognizant",
  "deloitte",
  "kpmg",
  "pwc",
  "upsc",
  "ssc",
  "nta",
  "cbse",
  "ugc",
  "aicte",
  "reserve bank of india",
  "rbi",
  "sebi",
  "government of india",
  "ministry of",
  "indian army",
  "ibps",
];

// Look-alike letters (Cyrillic, Greek) folded to ASCII before matching.
const CONFUSABLES: Readonly<Record<string, string>> = {
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i", "ј": "j",
  "ѕ": "s", "һ": "h", "ԁ": "d", "ɡ": "g", "ο": "o", "ν": "v", "ρ": "p", "τ": "t", "α": "a",
  "ε": "e", "ι": "i", "κ": "k",
};

/** NFKC, lower-case, collapse spaces, strip diacritics, fold look-alikes. Same NFKC as self-serve.ts. */
export function foldForBlocklist(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\u0000-\u007f]/g, (c) => CONFUSABLES[c] ?? c);
}

function words(s: string): string {
  return ` ${foldForBlocklist(s).replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
}

/** True when the address host or the organisation name is on the block list. */
export function isBlockedSignup(email: string, orgName: string): boolean {
  const at = email.lastIndexOf("@");
  const domain = at >= 0 ? email.slice(at + 1).trim().toLowerCase() : "";
  if (domain !== "" && BLOCKED_EMAIL_DOMAINS.includes(domain)) return true;
  const name = words(orgName);
  return BLOCKED_ORG_NAMES.some((b) => name.includes(words(b)));
}
