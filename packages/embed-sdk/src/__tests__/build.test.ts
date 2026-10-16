// @vitest-environment node
// Drift gate (RV44): the committed apps/api/public/embed/sdk.js must equal a fresh build.
// If this fails: run `pnpm --filter @assessiq/embed build` and commit the result.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const buildPath = fileURLToPath(new URL('../../build.mjs', import.meta.url));
const norm = (s: string): string => s.split('\r\n').join('\n');

describe('embed sdk bundle', () => {
  it('committed apps/api/public/embed/sdk.js matches a fresh build', async () => {
    const mod = (await import(/* @vite-ignore */ buildPath)) as { render: () => Promise<string>; outfile: string };
    const fresh = await mod.render();
    expect(norm(readFileSync(mod.outfile, 'utf8'))).toBe(norm(fresh));
  }, 30_000);

  it('stays small and exposes window.AssessIQ.mount', async () => {
    const mod = (await import(/* @vite-ignore */ buildPath)) as { render: () => Promise<string> };
    const fresh = await mod.render();
    expect(Buffer.byteLength(fresh)).toBeLessThanOrEqual(6 * 1024);
    expect(fresh).toContain('window.AssessIQ=');
  }, 30_000);
});
