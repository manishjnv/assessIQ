import { formatDate } from "@assessiq/ui-system";
import { type IntegrityValue } from "../../components/IntegrityCard.js";
import { type RemindersValue } from "../../components/RemindersCard.js";

type AssessmentStatus = "draft" | "published" | "active" | "closed" | "cancelled";
// Mirrors the server enum (modules/05 INVITATION_STATUSES). NOTE: 'expired' is
// what an admin REVOKE writes; a link that merely ran out of time keeps
// 'pending' / 'viewed' with an expires_at in the past (shown as "Expired").
type InvitationStatus = "pending" | "viewed" | "started" | "submitted" | "expired";

export interface Assessment {
  id: string;
  name: string;
  status: AssessmentStatus;
  pack_id: string | null;
  opens_at: string | null;
  closes_at: string | null;
  created_at: string;
  level_label?: string | null;
  pack_name?: string | null;
  settings?: { score_counts?: "latest" | "best"; integrity?: IntegrityValue; reminders?: RemindersValue; high_stakes?: boolean; sections?: unknown; scoring?: { negative_marks_default?: number } } | null;
  question_count?: number;
  passing_score_pct?: number;
  /** Z-39: null or 1 = no retake; 2..10 = attempts allowed. */
  max_attempts?: number | null;
  /** Z-89: default test type for new invitations. */
  delivery_mode?: "real" | "mock";
}

export interface Invitation {
  id: string;
  user_id: string;
  user_email?: string | null;
  user_name?: string | null;
  status: InvitationStatus;
  created_at: string;
  expires_at: string | null;
  reminded_at?: string | null;
  attempt_id?: string | null;
  attempt_status?: string | null;
  started_at?: string | null;
  submitted_at?: string | null;
  total_earned?: number | null;
  total_max?: number | null;
  auto_pct?: number | null;
  pending_review?: boolean | null;
  /** Server-computed: Resend is allowed (assessment open + candidate not started). */
  can_resend?: boolean;
  /** Z-39: attempts used and allowed (max_attempts + extras). */
  attempts_used?: number;
  attempts_allowed?: number;
  /** Z-39: Re-open is allowed (submitted, attempts left, assessment open). */
  can_reopen?: boolean;
  /** Z-39: Give extra attempt is allowed. */
  can_grant_extra?: boolean;
  /** Z-89: 'mock' invitations show a Mock badge. */
  delivery_mode?: "real" | "mock";
}

/** API cap for /admin/assessments/:id/invitations (routes.ts parsePagination). */
export const INV_PAGE_SIZE = 100;

export interface InvitationsResponse {
  items: Invitation[];
  total: number;
  /** How many invitations "Resend to everyone who hasn't started" would send (all pages). */
  resendable?: number;
}

/** POST /admin/assessments/:id/invitations/resend */
export interface ResendAllResponse {
  resent: number;
  skipped: Array<{ id: string; code: string }>;
  remaining: number;
}

/** Server cap per bulk-resend call (modules/05 BULK_RESEND_MAX). */
export const RESEND_ALL_CAP = 200;

/** Plain-language reasons for the skip codes the bulk resend returns. */
export const RESEND_SKIP_REASON: Record<string, string> = {
  INVITATION_ALREADY_STARTED: "already started",
  USER_INACTIVE: "account disabled",
  INVITATION_EMAIL_FAILED: "email could not be sent",
  INVITATION_NOT_FOUND: "no longer exists",
  ASSESSMENT_NOT_ACTIVE: "assessment closed",
};

export interface UserItem {
  id: string;
  email: string;
  name?: string;
  role?: string;
  status?: string;
}

export interface UsersResponse {
  items: UserItem[];
}

/** POST /admin/assessments/:id/release-all */
export interface ReleaseAllResponse {
  released: string[];
  skipped: Array<{ id: string; code: string }>;
}

/** Plain-language reasons for the skip codes release-all returns. */
export const SKIP_REASON: Record<string, string> = {
  RESULT_NOT_READY: "not ready yet",
  ATTEMPT_NOT_RELEASABLE_ERASED: "candidate data erased",
};

export type SortDir = "asc" | "desc";

/** Client-side row sort. Keys ending in `_at` sort as dates; numeric columns
 *  numerically; everything else case-insensitively. */
export function sortRows<T>(rows: T[], key: string, dir: SortDir): T[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = (a as unknown as Record<string, unknown>)[key];
    const bv = (b as unknown as Record<string, unknown>)[key];
    if (key.endsWith("_at")) {
      const at = av ? new Date(av as string).getTime() : 0;
      const bt = bv ? new Date(bv as string).getTime() : 0;
      return sign * (at - bt);
    }
    if (typeof av === "number" && typeof bv === "number") return sign * (av - bv);
    const as = String(av ?? "").toLowerCase();
    const bs = String(bv ?? "").toLowerCase();
    return as < bs ? -1 * sign : as > bs ? 1 * sign : 0;
  });
}

export function assessmentStatusVariant(s: string): "default" | "accent" | "success" {
  return s === "active" ? "success" : s === "published" ? "accent" : "default";
}

export function invitationStatusColor(s: string): { bg: string; color: string } {
  switch (s) {
    case "started":
      return { bg: "var(--aiq-color-accent-soft)", color: "var(--aiq-color-accent)" };
    case "submitted":
      return { bg: "var(--aiq-color-success-soft)", color: "var(--aiq-color-success)" };
    case "expired":
      return { bg: "var(--aiq-color-bg-sunken)", color: "var(--aiq-color-fg-muted)" };
    default:
      return { bg: "var(--aiq-color-bg-sunken)", color: "var(--aiq-color-fg-secondary)" };
  }
}

/** The server writes 'expired' when an admin REVOKES an invitation — say so in plain words. */
export function invitationStatusLabel(s: string): string {
  return s === "expired" ? "revoked" : s;
}

/**
 * "Expires 8 Oct 2026" / "Expired" — only for links that still matter (pending
 * or viewed). Started, submitted and revoked rows have no expiry worth showing.
 */
export function invitationExpiry(
  inv: Invitation,
  now: number,
): { text: string; lapsed: boolean } | null {
  if ((inv.status !== "pending" && inv.status !== "viewed") || inv.expires_at == null) {
    return null;
  }
  const at = new Date(inv.expires_at);
  if (at.getTime() <= now) return { text: "Expired", lapsed: true };
  const date = formatDate(at);
  return { text: `Expires ${date}`, lapsed: false };
}

