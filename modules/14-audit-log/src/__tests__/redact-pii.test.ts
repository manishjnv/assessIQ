// modules/14-audit-log/src/__tests__/redact-pii.test.ts
// Pure-function unit tests for the PII patterns added 2026-05-29 per
// modules/20-data-rights/SKILL.md D7. Runs without Postgres containers.
//
// PURPOSE: pin the forward-protection so a future redact.ts edit that
// removes any of these patterns is loud — the next time PII drifts into
// audit_log JSONB, that gap is what would catch it.

import { describe, it, expect } from 'vitest';
import { redactPayload } from '../redact.js';

const obj = (input: Record<string, unknown>) =>
  redactPayload(input) as Record<string, unknown>;

describe('redactPayload — PII patterns (D7 forward protection)', () => {
  it('redacts email at top level', () => {
    const out = obj({ email: 'candidate@example.com' });
    expect(out['email']).toBe('[REDACTED]');
  });

  it('redacts _email suffix variants', () => {
    const out = obj({
      recipient_email: 'r@e.com',
      customer_email: 'c@e.com',
      from_email: 'f@e.com',
    });
    expect(out['recipient_email']).toBe('[REDACTED]');
    expect(out['customer_email']).toBe('[REDACTED]');
    expect(out['from_email']).toBe('[REDACTED]');
  });

  it('redacts name + _name suffix variants', () => {
    const out = obj({
      name: 'Manish',
      first_name: 'M',
      last_name: 'K',
      display_name: 'Manish K',
      full_name: 'Manish Kumar',
      candidate_name: 'C',
    });
    expect(out['name']).toBe('[REDACTED]');
    expect(out['first_name']).toBe('[REDACTED]');
    expect(out['last_name']).toBe('[REDACTED]');
    expect(out['display_name']).toBe('[REDACTED]');
    expect(out['full_name']).toBe('[REDACTED]');
    expect(out['candidate_name']).toBe('[REDACTED]');
  });

  it('redacts phone + phone_number variants', () => {
    const out = obj({
      phone: '+91xxx',
      phone_number: '+91xxx',
      mobile_phone: '+91xxx',
    });
    expect(out['phone']).toBe('[REDACTED]');
    expect(out['phone_number']).toBe('[REDACTED]');
    expect(out['mobile_phone']).toBe('[REDACTED]');
  });

  it('redacts answer_text + candidate_answer (but NOT correct_answer rubric ground-truth)', () => {
    const out = obj({
      answer_text: 'candidate response',
      candidate_answer_text: 'candidate response',
      candidate_answer: 'candidate response',
      correct_answer: 'rubric ground-truth',
    });
    expect(out['answer_text']).toBe('[REDACTED]');
    expect(out['candidate_answer_text']).toBe('[REDACTED]');
    expect(out['candidate_answer']).toBe('[REDACTED]');
    // correct_answer is rubric ground-truth, NOT candidate PII. Must NOT be redacted.
    expect(out['correct_answer']).toBe('rubric ground-truth');
  });

  it('redacts ip + _ip suffix + ip_address variants', () => {
    const out = obj({
      ip: '1.2.3.4',
      client_ip: '1.2.3.4',
      request_ip: '1.2.3.4',
      source_ip: '1.2.3.4',
      ip_address: '1.2.3.4',
    });
    expect(out['ip']).toBe('[REDACTED]');
    expect(out['client_ip']).toBe('[REDACTED]');
    expect(out['request_ip']).toBe('[REDACTED]');
    expect(out['source_ip']).toBe('[REDACTED]');
    expect(out['ip_address']).toBe('[REDACTED]');
  });

  it('redacts user_agent variants', () => {
    const out = obj({
      user_agent: 'Mozilla/5.0',
      userAgent: 'Mozilla/5.0',
      client_user_agent: 'Mozilla/5.0',
    });
    expect(out['user_agent']).toBe('[REDACTED]');
    expect(out['userAgent']).toBe('[REDACTED]');
    expect(out['client_user_agent']).toBe('[REDACTED]');
  });

  it('redacts PII inside nested objects (covers candidate-login.ts:246 shape)', () => {
    const out = obj({
      userId: 'uuid',
      after: {
        email: 'leaked@example.com',
        expiresAt: '2026-05-29T11:00:00Z',
      },
    });
    const after = out['after'] as Record<string, unknown>;
    expect(after['email']).toBe('[REDACTED]');
    // Non-PII sibling fields stay intact.
    expect(after['expiresAt']).toBe('2026-05-29T11:00:00Z');
    expect(out['userId']).toBe('uuid');
  });

  it('redacts codex:rescue V6 additional PII keys (mobile/whatsapp/urls/free-text)', () => {
    const out = obj({
      phone_number_e164: '+919999999999',
      mobile: '9999999999',
      whatsapp: '+919999999999',
      whats_app: '+919999999999',
      linkedin_url: 'https://linkedin.com/in/x',
      resume_url: 'https://s3/x.pdf',
      feedback_text: 'free text',
      comment_text: 'free text',
      notes_text: 'free text',
    });
    expect(out['phone_number_e164']).toBe('[REDACTED]');
    expect(out['mobile']).toBe('[REDACTED]');
    expect(out['whatsapp']).toBe('[REDACTED]');
    expect(out['whats_app']).toBe('[REDACTED]');
    expect(out['linkedin_url']).toBe('[REDACTED]');
    expect(out['resume_url']).toBe('[REDACTED]');
    expect(out['feedback_text']).toBe('[REDACTED]');
    expect(out['comment_text']).toBe('[REDACTED]');
    expect(out['notes_text']).toBe('[REDACTED]');
  });

  it('leaves non-PII fields untouched (regression pin)', () => {
    const out = obj({
      id: 'uuid',
      role: 'candidate',
      created_at: '2026-05-29T10:00:00Z',
      score: 87,
      band: 'distinction',
    });
    expect(out['id']).toBe('uuid');
    expect(out['role']).toBe('candidate');
    expect(out['created_at']).toBe('2026-05-29T10:00:00Z');
    expect(out['score']).toBe(87);
    expect(out['band']).toBe('distinction');
  });
});
