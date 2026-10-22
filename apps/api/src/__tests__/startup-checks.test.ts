import { describe, it, expect } from 'vitest';
import { shouldWarnAppRoleMembership } from '../startup-checks.js';

describe('shouldWarnAppRoleMembership (GATE-8 A2-3)', () => {
  it('warns only in production when the app login is a member of assessiq_system', () => {
    expect(shouldWarnAppRoleMembership('production', true)).toBe(true);
    expect(shouldWarnAppRoleMembership('production', false)).toBe(false);
    expect(shouldWarnAppRoleMembership('development', true)).toBe(false);
    expect(shouldWarnAppRoleMembership('test', true)).toBe(false);
  });
});
