/**
 * Every email template key must have a production call site that sends it
 * (`template: '<key>'`). Catches dead templates. No mocks: reads source files only.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EmailTemplateNameSchema } from '../types.js';

// Z-37: decide send or delete; owner review
const KNOWN_UNSENT = [
  'attempt_submitted_candidate',
  'attempt_graded_candidate',
  'attempt_ready_for_review_admin',
  'weekly_digest_admin',
];

const ROOT = resolve(__dirname, '../../../..'); 

function sources(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (['node_modules', 'dist', '__tests__', '.git'].includes(n)) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.ts$/.test(n) && !/\.test\.ts$/.test(n)) out.push(p);
  }
  return out;
}

describe('email template send coverage', () => {
  const text = [join(ROOT, 'modules'), join(ROOT, 'apps')]
    .flatMap((d) => sources(d))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
  const sent = (k: string): boolean => new RegExp(String.raw`template:\s*["']${k}["']`).test(text);

  it('every template is sent somewhere, except the known-unsent list', () => {
    const unsent = EmailTemplateNameSchema.options.filter((k) => !sent(k));
    expect(unsent.sort()).toEqual([...KNOWN_UNSENT].sort());
  });
});
