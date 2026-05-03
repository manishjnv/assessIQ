/**
 * modules/13-notifications/src/email/transport.ts
 *
 * nodemailer transport factory — P3.D9: Resend as default via nodemailer
 * generic SMTP transport (NOT the Resend native SDK).
 *
 * SMTP_URL format: smtps://resend:re_<api_key>@smtp.resend.com:465
 * Any compliant SMTP URL works — Hostinger, SendGrid, local MailHog, etc.
 *
 * Stub-fallback: if SMTP_URL is empty/unset AND no per-tenant smtp_url is
 * provided, the transport returns null and the caller falls back to the
 * dev-emails.log JSONL path.
 *
 * NEVER import claude / @anthropic-ai from this file (Rule #1).
 */

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { SmtpConfig } from '../types.js';
import { config } from '@assessiq/core';

/**
 * Build a nodemailer Transporter from a SMTP URL string.
 * Returns null if the URL is empty/unset (stub-fallback path).
 */
export function buildTransportFromUrl(smtpUrl: string): Transporter | null {
  if (!smtpUrl || smtpUrl.trim().length === 0) return null;
  return nodemailer.createTransport(smtpUrl);
}

/**
 * Resolve the effective nodemailer Transporter for a send operation.
 * Priority:
 *   1. Per-tenant smtp_config.smtp_url (when tenant has custom SMTP configured)
 *   2. Platform-level SMTP_URL env var (the Resend default)
 *   3. null → dev-emails.log fallback
 *
 * Phase 3 ships only the generic SMTP driver (nodemailer over SMTP_URL).
 * Per-tenant native-SDK drivers (SES, SendGrid) are Phase 4.
 */
export function resolveTransport(tenantSmtpConfig?: SmtpConfig | null): Transporter | null {
  // 1. Per-tenant override
  if (tenantSmtpConfig?.smtp_url && tenantSmtpConfig.smtp_url.trim().length > 0) {
    return buildTransportFromUrl(tenantSmtpConfig.smtp_url);
  }

  // 2. Platform default
  const platformUrl = config.SMTP_URL;
  if (platformUrl && platformUrl.trim().length > 0) {
    return buildTransportFromUrl(platformUrl);
  }

  // 3. No SMTP configured — caller falls back to dev stub
  return null;
}

/**
 * Resolve the effective FROM address for a send.
 * Priority: per-tenant from_address → EMAIL_FROM env var.
 */
export function resolveFromAddress(tenantSmtpConfig?: SmtpConfig | null): string {
  if (tenantSmtpConfig?.from_address && tenantSmtpConfig.from_address.trim().length > 0) {
    const name = tenantSmtpConfig.from_name ?? 'AssessIQ';
    return `${name} <${tenantSmtpConfig.from_address}>`;
  }
  return config.EMAIL_FROM;
}
