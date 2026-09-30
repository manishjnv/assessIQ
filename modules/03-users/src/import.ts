import { ValidationError, uuidv7 } from '@assessiq/core';
import { withTenant } from '@assessiq/tenancy';
import { auditInTx } from '@assessiq/audit-log';
import { normalizeEmail } from './normalize.js';
import * as repo from './repository.js';

/**
 * Bulk candidate CSV import (modules/03-users/SKILL.md § 1).
 *
 * Pure parse/validate (parseCandidateCsv) + one-transaction persist
 * (importCandidates). Inviting to an assessment is NOT done here — the route
 * feeds `candidates[].userId` to 05-assessment-lifecycle's inviteUsers so the
 * invite logic/emails/skip-reasons stay single-sourced.
 */

export const IMPORT_MAX_ROWS = 1000;
export const IMPORT_MAX_BYTES = 512 * 1024;
const MAX_NAME_LENGTH = 200;
const MAX_EMAIL_LENGTH = 254;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Control + invisible/bidi-override chars — names flow into emails, UI and CSV exports.
// eslint-disable-next-line no-control-regex, no-misleading-character-class
const BAD_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f­​-‏‪-‮⁠-⁤⁦-⁩﻿]/;

export interface ImportSkip {
  /** Spreadsheet row number: header is row 1, first data row is row 2. */
  row: number;
  email: string;
  reason: string;
}

export interface ParsedCandidateRow {
  row: number;
  name: string;
  email: string;
}

export interface ParsedCandidateCsv {
  valid: ParsedCandidateRow[];
  skipped: ImportSkip[];
  /** Non-blank data rows seen (valid + skipped). */
  totalRows: number;
}

/** RFC 4180-ish tokenizer: quoted fields, "" escapes, commas/newlines inside quotes. */
function tokenize(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (inQuotes) {
    throw new ValidationError('CSV has an unterminated quoted field', {
      details: { code: 'CSV_MALFORMED' },
    });
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function parseCandidateCsv(input: string): ParsedCandidateCsv {
  if (Buffer.byteLength(input, 'utf8') > IMPORT_MAX_BYTES) {
    throw new ValidationError(`CSV exceeds ${IMPORT_MAX_BYTES / 1024} KB`, {
      details: { code: 'CSV_TOO_LARGE', maxBytes: IMPORT_MAX_BYTES },
    });
  }
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const all = tokenize(text);
  const header = all[0]?.map((h) => h.trim().toLowerCase()) ?? [];
  const nameIdx = header.indexOf('name');
  const emailIdx = header.indexOf('email');
  if (nameIdx < 0 || emailIdx < 0) {
    throw new ValidationError('CSV header row must contain "name" and "email" columns', {
      details: { code: 'CSV_MISSING_COLUMNS', required: ['name', 'email'] },
    });
  }

  const valid: ParsedCandidateRow[] = [];
  const skipped: ImportSkip[] = [];
  const seen = new Set<string>();
  let totalRows = 0;

  for (let i = 1; i < all.length; i++) {
    const cells = all[i]!;
    if (cells.every((c) => c.trim() === '')) continue; // blank line
    totalRows++;
    if (totalRows > IMPORT_MAX_ROWS) {
      throw new ValidationError(`CSV exceeds ${IMPORT_MAX_ROWS} data rows`, {
        details: { code: 'CSV_TOO_MANY_ROWS', maxRows: IMPORT_MAX_ROWS },
      });
    }
    const row = i + 1;
    const name = (cells[nameIdx] ?? '').replace(/\s+/g, ' ').trim();
    const email = normalizeEmail(cells[emailIdx] ?? '');
    const skip = (reason: string): void => {
      skipped.push({ row, email, reason });
    };
    if (email.length === 0 || email.length > MAX_EMAIL_LENGTH || !EMAIL_REGEX.test(email)) {
      skip('INVALID_EMAIL');
    } else if (name.length === 0) {
      skip('MISSING_NAME');
    } else if (name.length > MAX_NAME_LENGTH) {
      skip('NAME_TOO_LONG');
    } else if (BAD_NAME_CHARS.test(name)) {
      skip('INVALID_NAME_CHARS');
    } else if (seen.has(email)) {
      skip('DUPLICATE_IN_FILE');
    } else {
      seen.add(email);
      valid.push({ row, name, email });
    }
  }
  return { valid, skipped, totalRows };
}

export interface ImportedCandidate {
  userId: string;
  row: number;
  email: string;
}

export interface ImportCandidatesResult {
  created: number;
  existing: number;
  skipped: ImportSkip[];
  /** created + existing candidates, in file order — feed to inviteUsers. */
  candidates: ImportedCandidate[];
}

/**
 * Persist parsed rows in ONE tenant transaction with exactly ONE audit row
 * (counts only — no names/emails). A failing row is isolated via SAVEPOINT so
 * it never aborts the rest.
 */
export async function importCandidates(
  tenantId: string,
  csv: string,
  actorUserId: string,
): Promise<ImportCandidatesResult> {
  const parsed = parseCandidateCsv(csv);
  const skipped = [...parsed.skipped];
  const candidates: ImportedCandidate[] = [];
  let created = 0;
  let existing = 0;

  await withTenant(tenantId, async (client) => {
    for (const r of parsed.valid) {
      const found = await repo.findUserByEmailNormalized(client, r.email);
      if (found !== null) {
        if (found.deleted_at !== null) {
          // Soft-deleted users are never silently revived/re-invited by an import.
          skipped.push({ row: r.row, email: r.email, reason: 'USER_DELETED' });
        } else if (found.role !== 'candidate') {
          skipped.push({ row: r.row, email: r.email, reason: 'EXISTING_USER_NOT_CANDIDATE' });
        } else {
          existing++;
          candidates.push({ userId: found.id, row: r.row, email: r.email });
        }
        continue;
      }
      await client.query('SAVEPOINT import_row');
      try {
        const user = await repo.insertUser(client, {
          id: uuidv7(),
          tenantId,
          email: r.email,
          name: r.name,
          role: 'candidate',
          status: 'active',
          metadata: {},
        });
        await client.query('RELEASE SAVEPOINT import_row');
        created++;
        candidates.push({ userId: user.id, row: r.row, email: r.email });
      } catch {
        await client.query('ROLLBACK TO SAVEPOINT import_row');
        skipped.push({ row: r.row, email: r.email, reason: 'INSERT_FAILED' });
      }
    }
    skipped.sort((a, b) => a.row - b.row);

    await auditInTx(client, {
      tenantId,
      actorKind: 'user',
      actorUserId,
      // ponytail: reuses 'user.created' + kind marker; a dedicated
      // 'user.bulk_imported' needs a 14-audit-log catalog entry (load-bearing).
      action: 'user.created',
      entityType: 'user',
      after: {
        kind: 'bulk_import',
        rows_total: parsed.totalRows,
        created,
        existing,
        skipped: skipped.length,
      },
    });
  });

  return { created, existing, skipped, candidates };
}
