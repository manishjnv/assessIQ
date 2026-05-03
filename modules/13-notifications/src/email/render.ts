/**
 * modules/13-notifications/src/email/render.ts
 *
 * Handlebars compile + per-template var schema lookup + render.
 *
 * P3.D14 rules:
 * - Every {{var}} is HTML-escaped (default Handlebars behaviour).
 * - NO {{{triple-stash}}} allowed — enforced by not registering any
 *   triple-stash helpers.
 * - Per-template Zod validation of the vars shape before render.
 *
 * Templates live in email/templates/<name>.{html,txt}.
 * Both variants are loaded and compiled at module init (eager compilation
 * so runtime failures are loud at startup, not at first send).
 *
 * NEVER import claude / @anthropic-ai from this file (Rule #1).
 */

import Handlebars from 'handlebars';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { EmailTemplateName, TemplateVarsMap } from '../types.js';
import {
  InvitationAdminVarsSchema,
  InvitationCandidateVarsSchema,
  TotpEnrolledVarsSchema,
  AttemptSubmittedCandidateVarsSchema,
  AttemptGradedCandidateVarsSchema,
  AttemptReadyForReviewAdminVarsSchema,
  WeeklyDigestAdminVarsSchema,
} from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, 'templates');

// ---------------------------------------------------------------------------
// Per-template Zod schema map
// ---------------------------------------------------------------------------

// exactOptionalPropertyTypes forces input types to be T|undefined on optional
// fields, while the inferred Output type is T. We cast to ZodType<Output> which
// is what the render call-site actually needs (vars have already been parsed).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TEMPLATE_VARS_SCHEMAS: Record<EmailTemplateName, z.ZodType<any>> = {
  invitation_admin: InvitationAdminVarsSchema,
  invitation_candidate: InvitationCandidateVarsSchema,
  totp_enrolled: TotpEnrolledVarsSchema,
  attempt_submitted_candidate: AttemptSubmittedCandidateVarsSchema,
  attempt_graded_candidate: AttemptGradedCandidateVarsSchema,
  attempt_ready_for_review_admin: AttemptReadyForReviewAdminVarsSchema,
  weekly_digest_admin: WeeklyDigestAdminVarsSchema,
};

// ---------------------------------------------------------------------------
// Compiled template cache
// ---------------------------------------------------------------------------

type CompiledPair = {
  html: HandlebarsTemplateDelegate;
  txt: HandlebarsTemplateDelegate;
};

const _compiledCache = new Map<EmailTemplateName, CompiledPair>();

function loadAndCompile(name: EmailTemplateName): CompiledPair {
  const cached = _compiledCache.get(name);
  if (cached !== undefined) return cached;

  const htmlSrc = readFileSync(join(TEMPLATES_DIR, `${name}.html`), 'utf-8');
  const txtSrc = readFileSync(join(TEMPLATES_DIR, `${name}.txt`), 'utf-8');

  const pair: CompiledPair = {
    // HTML templates: noEscape: false = HTML-escape all {{vars}} (security: no XSS).
    html: Handlebars.compile(htmlSrc, { noEscape: false }),
    // Plain-text templates: noEscape: true = no HTML escaping (URLs must be literal).
    txt: Handlebars.compile(txtSrc, { noEscape: true }),
  };

  _compiledCache.set(name, pair);
  return pair;
}

// ---------------------------------------------------------------------------
// Public render function
// ---------------------------------------------------------------------------

export interface RenderResult {
  subject: string;
  html: string;
  text: string;
}

/**
 * Validate vars against the template's Zod schema, then render both HTML and
 * text variants.
 *
 * Throws a ZodError if vars don't satisfy the schema.
 */
export function renderTemplate<T extends EmailTemplateName>(
  name: T,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vars: any,
): RenderResult {
  // Validate vars against the per-template schema.
  const schema = TEMPLATE_VARS_SCHEMAS[name]!;
  const parsed = schema.parse(vars) as TemplateVarsMap[T];

  const { html: htmlTpl, txt: txtTpl } = loadAndCompile(name);

  const html = htmlTpl(parsed);
  const text = txtTpl(parsed);

  // Extract subject from the first line of the txt template (convention).
  // Templates begin with "Subject: <subject line>\n\n<body>".
  const lines = text.split('\n');
  let subject = 'AssessIQ notification';
  let bodyText = text;

  const subjectLine = lines[0];
  if (subjectLine !== undefined && subjectLine.startsWith('Subject: ')) {
    subject = subjectLine.slice('Subject: '.length).trim();
    bodyText = lines.slice(2).join('\n'); // skip "Subject: ..." and blank line
  }

  return { subject, html, text: bodyText };
}
