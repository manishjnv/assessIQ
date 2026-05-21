/**
 * modules/13-notifications/src/email/render.ts
 *
 * Handlebars compile + per-template var schema lookup + render.
 *
 * P3.D14 rules:
 * - Every {{var}} is HTML-escaped (default Handlebars behaviour).
 * - NO {{{triple-stash}}} allowed — EXCEPT the email-meta-card `v` cell, which
 *   is template-author-controlled and guarded by assertSafeMetaRows() below.
 *   See docs/13-email-system.md §2 A7.
 * - Per-template Zod validation of the vars shape before render.
 *
 * Email Kit Port (E1/E2): templates compose shared partials from
 * email/partials/*.html via Handlebars block partials. Partials are registered
 * at module init (fail-loud at boot if any is missing). The new visual context
 * (preheader, meta_rows, copyright_year, legal address) is DERIVED here from the
 * already-validated base vars — the per-template Zod schemas are UNCHANGED, so
 * every existing sendEmail() call site keeps working without modification.
 *
 * Templates live in email/templates/<name>.{html,txt}.
 * Both variants are loaded and compiled at module init (eager compilation
 * so runtime failures are loud at startup, not at first send).
 *
 * NEVER import claude / @anthropic-ai from this file (Rule #1).
 */

import Handlebars from 'handlebars';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { EmailTemplateName, TemplateVarsMap } from '../types.js';
import { buildVars } from './i18n.js';
import {
  InvitationAdminVarsSchema,
  InvitationCandidateVarsSchema,
  CandidateLoginLinkVarsSchema,
  TotpEnrolledVarsSchema,
  AttemptSubmittedCandidateVarsSchema,
  AttemptGradedCandidateVarsSchema,
  AttemptReadyForReviewAdminVarsSchema,
  WeeklyDigestAdminVarsSchema,
  AdminEmailOtpVarsSchema,
} from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, 'templates');
const PARTIALS_DIR = join(__dirname, 'partials');

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
  candidate_login_link: CandidateLoginLinkVarsSchema,
  totp_enrolled: TotpEnrolledVarsSchema,
  attempt_submitted_candidate: AttemptSubmittedCandidateVarsSchema,
  attempt_graded_candidate: AttemptGradedCandidateVarsSchema,
  attempt_ready_for_review_admin: AttemptReadyForReviewAdminVarsSchema,
  weekly_digest_admin: WeeklyDigestAdminVarsSchema,
  // P2: Email-OTP sign-in code (admin/reviewer only).
  admin_email_otp: AdminEmailOtpVarsSchema,
};

// ---------------------------------------------------------------------------
// Partial registration + helpers (Email Kit Port E1)
// ---------------------------------------------------------------------------

let _partialsRegistered = false;

/**
 * Register every email/partials/*.html as a Handlebars partial, keyed by file
 * name without extension (e.g. `email-shell`). Idempotent. Fail-loud: if the
 * partials directory is missing or empty, throw at module init rather than on
 * first send.
 */
function registerPartials(): void {
  if (_partialsRegistered) return;
  let files: string[];
  try {
    files = readdirSync(PARTIALS_DIR).filter((f) => f.endsWith('.html'));
  } catch (err) {
    throw new Error(`email render: partials dir not readable at ${PARTIALS_DIR}: ${(err as Error).message}`);
  }
  if (files.length === 0) {
    throw new Error(`email render: no partials found in ${PARTIALS_DIR}`);
  }
  for (const file of files) {
    const name = file.replace(/\.html$/, '');
    const src = readFileSync(join(PARTIALS_DIR, file), 'utf-8');
    Handlebars.registerPartial(name, src);
  }
  _partialsRegistered = true;
}

let _helpersRegistered = false;

function registerHelpers(): void {
  if (_helpersRegistered) return;
  // {{concat "a" b "c"}} → string join. Last arg is the Handlebars options obj.
  Handlebars.registerHelper('concat', (...args: unknown[]): string =>
    args
      .slice(0, -1)
      .map((a) => (a === undefined || a === null ? '' : String(a)))
      .join(''),
  );
  _helpersRegistered = true;
}

// Register eagerly at module load so compile() always sees the partials/helpers.
registerHelpers();
registerPartials();

// ---------------------------------------------------------------------------
// email-meta-card safety (triple-stash {{{v}}} guard) — docs §2 A7
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * A meta-card value is safe to render via {{{v}}} (HTML-unescaped) iff it is
 * either plain text (no angle brackets) OR contains ONLY the allow-listed
 * inline tags: <strong>, <em>, <br>, and <a href="https://…">…</a>.
 */
function isSafeMetaValue(v: string): boolean {
  if (!v.includes('<') && !v.includes('>')) return true;
  const stripped = v
    .replace(/<\/?(?:strong|em)>/g, '')
    .replace(/<br\s*\/?>/g, '')
    .replace(/<a href="https:\/\/[a-z0-9.\-/?=&_%#:]+">/gi, '')
    .replace(/<\/a>/g, '');
  return !stripped.includes('<') && !stripped.includes('>');
}

function assertSafeMetaRows(rows: ReadonlyArray<{ k: string; v: string }>): void {
  for (const row of rows) {
    if (typeof row.v !== 'string' || !isSafeMetaValue(row.v)) {
      throw new Error(`unsafe meta_rows.v (must be plain text or allow-listed inline HTML): ${String(row.v).slice(0, 60)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Per-template derived visual context (Email Kit Port E2)
// ---------------------------------------------------------------------------

type MetaRow = { k: string; v: string };

/**
 * Build the meta-card rows for a template from its validated base vars.
 * Values that interpolate base vars are HTML-escaped here; literal emphasis
 * (<strong>) is template-author-controlled. Returns [] for templates with no
 * meta-card.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildMetaRows(name: EmailTemplateName, p: any): MetaRow[] {
  switch (name) {
    case 'invitation_candidate':
      return [
        { k: 'Assessment', v: `<strong>${escapeHtml(p.assessmentName)}</strong>` },
        { k: 'Company', v: escapeHtml(p.tenantName) },
        { k: 'Expires', v: escapeHtml(p.expiresAt) },
      ];
    case 'invitation_admin': {
      const rows: MetaRow[] = [{ k: 'Role', v: `<strong>${escapeHtml(p.role)}</strong>` }];
      if (typeof p.tenantName === 'string' && p.tenantName.length > 0) {
        rows.push({ k: 'Company', v: escapeHtml(p.tenantName) });
      }
      return rows;
    }
    case 'attempt_graded_candidate':
      return [
        { k: 'Assessment', v: `<strong>${escapeHtml(p.assessmentName)}</strong>` },
        { k: 'Company', v: escapeHtml(p.tenantName) },
      ];
    case 'attempt_ready_for_review_admin':
      return [
        { k: 'Assessment', v: `<strong>${escapeHtml(p.assessmentName)}</strong>` },
        { k: 'Candidate', v: escapeHtml(p.candidateName) },
        { k: 'Reference', v: escapeHtml(p.attemptId) },
      ];
    case 'attempt_submitted_candidate':
      return [
        { k: 'Assessment', v: `<strong>${escapeHtml(p.assessmentName)}</strong>` },
        { k: 'Submitted', v: escapeHtml(p.submittedAt) },
      ];
    case 'weekly_digest_admin':
      return [
        { k: 'Total attempts', v: escapeHtml(String(p.totalAttempts)) },
        { k: 'Completed', v: escapeHtml(String(p.completedAttempts)) },
        { k: 'Graded', v: escapeHtml(String(p.gradedThisWeek)) },
        { k: 'Pending review', v: escapeHtml(String(p.pendingReview)) },
      ];
    case 'candidate_login_link':
    case 'admin_email_otp':
      return [{ k: 'Expires', v: `${escapeHtml(String(p.expires_minutes))} minutes` }];
    case 'totp_enrolled': {
      const rows: MetaRow[] = [{ k: 'Enabled on', v: escapeHtml(String(p.enrolledAt)) }];
      if (typeof p.tenantName === 'string' && p.tenantName.length > 0) {
        rows.unshift({ k: 'Account', v: escapeHtml(p.tenantName) });
      }
      return rows;
    }
    default:
      return [];
  }
}

/**
 * Derive the extra Handlebars context the kit partials need, from the validated
 * base vars. Kept entirely out of the per-template Zod schemas so call sites
 * are unaffected.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function augmentContext(name: EmailTemplateName, p: any): Record<string, unknown> {
  const meta_rows = buildMetaRows(name, p);
  assertSafeMetaRows(meta_rows);
  return {
    meta_rows,
    copyright_year: String(new Date().getFullYear()),
    lang: 'en',
  };
}

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

  // Pre-resolve all i18n strings for this template into _t_<key> vars.
  // Callers never see or set these — they are injected here only.
  const i18nResolved = buildVars(name, parsed as Record<string, string | number>);
  const i18nVars: Record<string, string> = {};
  for (const [k, v] of Object.entries(i18nResolved)) {
    i18nVars[`_t_${k}`] = v;
  }

  // Derive the kit visual context (meta rows, copyright year, lang).
  const derived = augmentContext(name, parsed);

  const ctx = { ...parsed, ...i18nVars, ...derived };
  const html = htmlTpl(ctx);
  const text = txtTpl(ctx);

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
