/**
 * modules/13-notifications/src/email/i18n.ts
 *
 * Tiny English-string resolver for email templates.
 *
 * Design:
 *   - Strings live in strings/<lang>.json, keyed by template name → string key → value.
 *   - Values may contain {{var}} tokens that are resolved at call time.
 *   - Missing template or key → throws loudly (typos surface early in tests).
 *   - Cache: each lang file is loaded once and kept in memory.
 *
 * TODO: when per-tenant language preference is added, look up
 *   TenantSettings.preferredLanguage (modules/02-tenancy) and pass it as `lang`.
 *   The call site in render.ts is: buildVars(name, parsed, tenantLang ?? 'en').
 *
 * Only English is shipped in this session. A later i18n pass adds e.g. strings/fr.json
 * and the resolver picks it up automatically via the lang parameter.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Cache: lang → parsed strings object
const _cache = new Map<string, Record<string, Record<string, string>>>();

function loadStrings(lang: string): Record<string, Record<string, string>> {
  const cached = _cache.get(lang);
  if (cached !== undefined) return cached;

  const filePath = join(__dirname, 'strings', `${lang}.json`);
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(
      `i18n: could not load strings file for lang "${lang}" at ${filePath}: ${(err as Error).message}`,
    );
  }
  const parsed = JSON.parse(raw) as Record<string, Record<string, string>>;
  _cache.set(lang, parsed);
  return parsed;
}

/**
 * Resolve a single string key for a template, substituting {{var}} tokens.
 *
 * Throws if the template or key is not found in the strings file — this is
 * intentional: loud failures catch typos before they reach production.
 *
 * @param template  Template name, e.g. 'invitation_candidate'
 * @param key       String key, e.g. 'cta'
 * @param vars      Variable bag used to substitute {{var}} tokens in the string value
 * @param lang      Language code (default 'en'). Reserved for future per-tenant lookups.
 */
export function t(
  template: string,
  key: string,
  vars: Record<string, string | number>,
  lang = 'en',
): string {
  const strings = loadStrings(lang);

  const templateStrings = strings[template];
  if (templateStrings === undefined) {
    throw new Error(`i18n: no strings found for template "${template}" in lang "${lang}"`);
  }

  const value = templateStrings[key];
  if (value === undefined) {
    throw new Error(`i18n: no string found for key "${template}.${key}" in lang "${lang}"`);
  }

  // Replace {{var}} tokens with the corresponding value from vars.
  // Unresolved tokens (var not present) are left as-is rather than silently
  // dropping them, which makes debug output more readable.
  return value.replace(/\{\{(\w+)\}\}/g, (match, varName: string) => {
    const replacement = vars[varName];
    return replacement !== undefined ? String(replacement) : match;
  });
}

/**
 * Resolve ALL string keys for a template and return the resulting dictionary.
 * Used by render.ts to pre-populate the Handlebars variable bag.
 *
 * Returns an empty object (silently) if the template has no entry in the
 * strings file — templates that aren't in en.json yet are simply skipped
 * rather than crashing the whole render pipeline.
 *
 * @param template  Template name
 * @param vars      Variable bag for {{token}} substitution
 * @param lang      Language code (default 'en')
 */
export function buildVars(
  template: string,
  vars: Record<string, string | number>,
  lang = 'en',
): Record<string, string> {
  const strings = loadStrings(lang);

  const result: Record<string, string> = {};

  // 1. Merge the cross-template `_shared` namespace first (footer legal entity,
  //    address, etc.). Resolved with inline {{var}} substitution — these keys
  //    do not live under any single template. Per-template keys win on collision.
  const shared = strings['_shared'];
  if (shared !== undefined) {
    for (const [key, value] of Object.entries(shared)) {
      result[key] = value.replace(/\{\{(\w+)\}\}/g, (match, varName: string) => {
        const replacement = vars[varName];
        return replacement !== undefined ? String(replacement) : match;
      });
    }
  }

  // 2. Per-template keys (override any _shared collision).
  const templateStrings = strings[template];
  if (templateStrings !== undefined) {
    for (const key of Object.keys(templateStrings)) {
      result[key] = t(template, key, vars, lang);
    }
  }

  return result;
}
