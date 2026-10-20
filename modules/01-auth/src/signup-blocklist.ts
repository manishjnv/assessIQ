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

function words(s: string): string {
  return ` ${s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
}

/** True when the address host or the organisation name is on the block list. */
export function isBlockedSignup(email: string, orgName: string): boolean {
  const at = email.lastIndexOf("@");
  const domain = at >= 0 ? email.slice(at + 1).trim().toLowerCase() : "";
  if (domain !== "" && BLOCKED_EMAIL_DOMAINS.includes(domain)) return true;
  const name = words(orgName);
  return BLOCKED_ORG_NAMES.some((b) => name.includes(words(b)));
}
