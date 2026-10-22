// GATE-8 A1-2: every mutating cross-tenant super-admin route must use superAdminFreshMfa.
// The route tests mock the auth seam, so this guards the wiring at source level.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dirname, '..', 'routes', 'admin-super');

describe('admin-super mutating routes use fresh MFA', () => {
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== '_shared.ts')) {
    it(file, () => {
      const parts = readFileSync(join(dir, file), 'utf8').split(/\bapp\.(get|post|put|patch|delete)\(/).slice(1);
      for (let i = 0; i < parts.length; i += 2) {
        const verb = parts[i]!;
        const body = parts[i + 1]!.slice(0, 600);
        if (verb === 'get') continue;
        expect(body, `${file} ${verb} ${body.slice(0, 60)}`).toContain('superAdminFreshMfa');
        expect(body).not.toContain('superAdminOnly');
      }
    });
  }
});
