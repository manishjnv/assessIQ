/**
 * FUT-2: tenant admins never see the answer key, rubric or source reference of licensed (platform-owned)
 * content. One definition of "licensed" and one redaction, used by every admin read route.
 */
import { adminViewFor } from "./registry.js";

/**
 * SQL predicate, true for a licensed question row. `alias` is the questions table alias (static text,
 * never user input). Licensed = cloned from a platform question (clone mode, source_question_id) or
 * owned by another tenant than the caller (licensed read, EXP-14 phase 2). Tenant uploads are neither.
 */
export function licensedQuestionSql(alias: string): string {
  return `(${alias}.source_question_id IS NOT NULL OR ${alias}.tenant_id <> current_setting('app.current_tenant', true)::uuid)`;
}

/** Only the platform operator (super_admin) reads master keys. */
export function mayReadMasterKey(role: string | undefined): boolean {
  return role === "super_admin";
}

const DROPPED = ["rubric", "content_i18n", "source_ref", "source_url"] as const;

/**
 * Redact one row: `content` goes through the admin allowlist; rubric, translations and source reference
 * become null (only when present). Returns a copy. The caller decides WHEN (row licensed and viewer is
 * not super_admin); this function does not check, so it cannot be bypassed by a missing flag.
 */
export function redactMasterKey<T extends { type?: string; content?: unknown }>(row: T): T {
  const out: Record<string, unknown> = { ...row };
  if ("content" in out) out["content"] = adminViewFor(String(row.type ?? ""), row.content);
  for (const k of DROPPED) if (k in out) out[k] = null;
  return out as T;
}
