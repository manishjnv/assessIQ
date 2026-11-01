// Single source of the sub-processor list. Read by /privacy and /trust so the two pages cannot drift.
// Wording matches the /privacy text of 2026-10 (no legal text change). Name no region beyond what is listed here.
export interface SubProcessor {
  name: string;
  /** Short purpose, used in the /privacy sentence and the /trust table. */
  purpose: string;
  /** Where the processing happens, as /privacy states it. */
  location: string;
}

export const subProcessors: SubProcessor[] = [
  { name: 'Hostinger', purpose: 'server hosting', location: 'Hosting provider of the virtual private server' },
  { name: 'Cloudflare', purpose: 'network proxy and security', location: 'In front of the server' },
  { name: 'Brevo', purpose: 'transactional email', location: 'Email delivery' },
  { name: 'Google', purpose: 'optional sign-in with a Google account', location: 'Only if the user chooses Google sign-in' },
  { name: 'Anthropic', purpose: 'AI-assisted evaluation of written answers, processed in the United States', location: 'United States' },
];

/** "A (a), B (b), and C (c)" - the exact list sentence used on /privacy. */
export function subProcessorSentence(list: SubProcessor[] = subProcessors): string {
  const parts = list.map((s) => `${s.name} (${s.purpose})`);
  return parts.slice(0, -1).join(', ') + ', and ' + parts.at(-1);
}
