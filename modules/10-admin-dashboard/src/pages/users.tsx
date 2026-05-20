// Admin users page — list / filter / invite / role-change / soft-delete.
//
// Migrated from apps/web/src/pages/admin/users.tsx into the module pattern.
//
// Changes from the source file:
// 1. Custom top bar (Logo + tenant slug + user button) removed — AdminShell
//    already renders that.
// 2. Outer aiq-screen / main layout replaced with AdminShell wrapper.
// 3. API calls use adminApi + AdminApiError from "../api.js" (not api/ApiCallError
//    from apps/web/src/lib/api).
// 4. logout + useSession imports removed (AdminShell handles sign-out).
// 5. var(--aiq-color-bg-elevated) replaced with var(--aiq-color-bg-raised).
// 6. Loading block replaced with centred <Spinner>.
// 7. fetchUsers simplified to async/await (AbortController pattern dropped so
//    it returns Promise<void> and can be called directly from onSuccess).
//
// Phase C additions:
// 8. Per-row [Manage ▾] menu with state-aware lifecycle actions.
// 9. UserLifecycleConfirmModal — single modal parameterised per action.
// 10. Show disabled / Show removed session-scoped toggles above table.
// 11. Page-level toast (4 s auto-dismiss) + sticky error chip.
// 12. Pending-invitation rows rendered from a separate pending_invitations array
//     when provided (super-admin context supplies it; tenant-admin list uses
//     the existing items array which may include pending-status users).
//
// Translation notes (intentional divergences from screens/admin-list.jsx):
//
// 1. Filter chips — template demoes status filters (All / Active / Pending /
//    Disabled). The live page uses ROLE filters (admin, reviewer) plus
//    show-disabled / show-removed toggles, because role is the primary axis
//    users actually filter by, and the soft-delete view is the audit-trail
//    recovery path.  Same idiom (chip-strip with accent-when-selected),
//    different semantics.
//
// 2. Empty state — keeps the template's serif headline + secondary copy + CTA
//    shape, with admin-users-specific copy.
//
// 3. Invite "drawer" — template uses a fixed-position centred Card with a
//    click-outside backdrop. Live page mirrors that exactly.
//
// 4. Mono pager idiom (prev / "X / Y" / next with ghost buttons + arrow icons).

import React, { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Button, Card, Chip, Field, Spinner } from "@assessiq/ui-system";
import type { ChipVariant } from "@assessiq/ui-system";
import { AdminShell } from "../components/AdminShell.js";
import {
  adminApi,
  AdminApiError,
  disableUserApi,
  reenableUserApi,
  softDeleteUserApi,
  restoreUserApi,
  cancelInvitationApi,
} from "../api.js";

// ── Types ────────────────────────────────────────────────────────────────────

type UserRole = "admin" | "reviewer";
type UserStatus = "active" | "pending" | "disabled";

export interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  role: string;
  status: UserStatus;
  created_at: string;
  deleted_at?: string | null;
}

export interface PendingInvitation {
  id: string;
  email: string;
  role: string;
  expires_at: string;
  created_at: string;
}

interface UsersResponse {
  // GET /api/admin/users returns the @assessiq/users service's PaginatedUsers
  // shape with `items` (matches api-keys list + the rest of the workspace).
  items: AdminUser[];
  total: number;
  page: number;
  pageSize: number;
}

// Phase C: lifecycle action types for users
type UserLifecycleAction =
  | "disable"
  | "reenable"
  | "softDelete"
  | "restore"
  | "cancelInvitation";

interface UserLifecycleTarget {
  action: UserLifecycleAction;
  user?: AdminUser;
  invitation?: PendingInvitation;
}

// Per-action API callbacks (injected from outside so super-admin page can
// swap in the super-admin variant helpers without duplicating this component).
// The optional third parameter on `disable` carries confirmLastAdmin for the
// super-admin last-active-admin override path.
export interface UserLifecycleApiHandlers {
  disable: (userId: string, reason?: string, confirmLastAdmin?: boolean) => Promise<unknown>;
  reenable: (userId: string, reason?: string) => Promise<unknown>;
  softDelete: (userId: string, reason?: string) => Promise<unknown>;
  restore: (userId: string, reason?: string) => Promise<unknown>;
  cancelInvitation: (invitationId: string, reason?: string) => Promise<unknown>;
}

const DEFAULT_LIFECYCLE_HANDLERS: UserLifecycleApiHandlers = {
  disable: disableUserApi,
  reenable: reenableUserApi,
  softDelete: softDeleteUserApi,
  restore: restoreUserApi,
  cancelInvitation: cancelInvitationApi,
};

// Props for super-admin context injection
export interface AdminUsersProps {
  /** When present, switches to super-admin scope (different breadcrumb +
   *  API handlers; read-only when tenantStatus !== 'active'). */
  superContext?: {
    tenantId: string;
    tenantName: string;
    tenantStatus: string;
    lifecycleHandlers: UserLifecycleApiHandlers;
    /** Pre-fetched user list from super endpoint (replaces internal fetch) */
    users: AdminUser[];
    pendingInvitations: PendingInvitation[];
    loading: boolean;
    fetchError: string | null;
    /** Trigger a refetch in the parent after a mutation */
    onRefetch: () => void;
  };
}

const STATUS_VARIANT: Record<string, ChipVariant> = {
  active: "success",
  pending: "accent",
  disabled: "default",
};

const PAGE_SIZE = 20;

const META_LABEL: CSSProperties = {
  fontFamily: "var(--aiq-font-mono)",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "var(--aiq-color-fg-muted)",
};

// Column grid — kept consistent across header + every row.
// Phase C: added Manage column at end.
const ROW_GRID = "120px 2fr 1fr 110px 110px 120px";
const ROW_GRID_GAP = 12;
const ROW_PADDING = "16px 20px";

// Pending invitation row reuses same grid but role/status/manage differ.
const INV_GRID = "120px 2fr 1fr 110px 110px 120px";

// ── Invite drawer (fixed-position centred Card, matches screens/admin-list.jsx) ─

function InviteForm({
  onSuccess,
  onCancel,
}: {
  onSuccess: () => void;
  onCancel: () => void;
}): React.ReactElement {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<UserRole>("reviewer");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState(false);

  const submit = async (): Promise<void> => {
    if (!email.trim()) {
      setError("Email is required.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await adminApi("/admin/invitations", {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), role }),
      });
      setToast(true);
      setTimeout(() => {
        setToast(false);
        onSuccess();
      }, 1500);
    } catch (err) {
      if (err instanceof AdminApiError) {
        setError(err.apiError.message);
      } else {
        setError("Unexpected error — please try again.");
      }
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.36)",
        display: "grid",
        placeItems: "center",
        zIndex: 100,
      }}
      onClick={onCancel}
      role="presentation"
    >
      <Card
        padding="lg"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 440 }}
      >
        <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
          <h2
            className="aiq-serif"
            style={{ fontSize: 22, margin: 0, fontWeight: 400, letterSpacing: "-0.015em" }}
          >
            Invite teammate
          </h2>
          <span style={{ flex: 1 }} />
          <Button size="sm" variant="ghost" onClick={onCancel} aria-label="Close">
            ×
          </Button>
        </div>
        <p
          style={{
            fontSize: 13,
            color: "var(--aiq-color-fg-secondary)",
            margin: "0 0 20px",
            lineHeight: 1.5,
          }}
        >
          They will receive a one-time sign-in link, valid for 72 hours.
        </p>

        {toast && (
          <div style={{ marginBottom: 16 }}>
            <Chip variant="success">Invitation sent.</Chip>
          </div>
        )}

        <div style={{ display: "grid", gap: 16 }}>
          <Field
            label="Email address"
            type="email"
            placeholder="name@company.com"
            value={email}
            onChange={(e) => { setEmail(e.target.value); setError(null); }}
            {...(error ? { error } : {})}
          />
          <div data-help-id="admin.users.role">
            <span style={{ ...META_LABEL, display: "block", marginBottom: 6 }}>Role</span>
            <div style={{ display: "flex", gap: 8 }}>
              {(["admin", "reviewer"] as UserRole[]).map((r) => (
                <Button
                  key={r}
                  size="sm"
                  variant={role === r ? "primary" : "outline"}
                  onClick={() => setRole(r)}
                >
                  {r}
                </Button>
              ))}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 24 }}>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button onClick={submit} loading={loading} disabled={toast} rightIcon="arrow">
            Send invite
          </Button>
        </div>
      </Card>
    </div>
  );
}

// ── Pager — ghost buttons with arrow icons + mono "X / Y" microcopy ──────────

function Pager({
  page,
  totalPages,
  onPrev,
  onNext,
}: {
  page: number;
  totalPages: number;
  onPrev: () => void;
  onNext: () => void;
}): React.ReactElement {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 12 }}>
      <Button size="sm" variant="ghost" leftIcon="arrowLeft" onClick={onPrev} disabled={page <= 1}>
        Prev
      </Button>
      <span style={META_LABEL}>
        {page} / {totalPages || 1}
      </span>
      <Button size="sm" variant="ghost" rightIcon="arrow" onClick={onNext} disabled={page >= totalPages}>
        Next
      </Button>
    </div>
  );
}

// ── UserLifecycleConfirmModal ─────────────────────────────────────────────────

interface UserModalCopy {
  title: string;
  body: string;
  verb: string;
  reasonLabel: string;
  reasonRequired?: boolean | undefined;
  /** Extra warning shown in a highlighted box (super-admin last-admin override) */
  extraWarning?: string | undefined;
  /** When true, render a "I understand" checkbox that must be ticked */
  requireAcknowledge?: boolean | undefined;
}

function buildModalCopy(
  action: UserLifecycleAction,
  user?: AdminUser,
  invitation?: PendingInvitation,
  extraWarning?: string,
): UserModalCopy {
  const name = user?.name ?? user?.email ?? invitation?.email ?? "this user";
  const email = user?.email ?? invitation?.email ?? "";

  switch (action) {
    case "disable":
      return {
        title: `Disable ${name}?`,
        body: `${name} (${email}) will be signed out immediately and prevented from logging in. Their data is preserved. You can re-enable any time.`,
        verb: "Disable",
        reasonLabel: "Reason (optional)",
        extraWarning,
        requireAcknowledge: !!extraWarning,
      };
    case "reenable":
      return {
        title: `Re-enable ${name}?`,
        body: `${name} will be able to sign in again. They'll need to re-authenticate.`,
        verb: "Re-enable",
        reasonLabel: "Reason (optional)",
      };
    case "softDelete":
      return {
        title: `Remove ${name}?`,
        body: `${name} will be hidden from the active list. Their data is preserved for 6 months. Restore is possible while the row exists.`,
        verb: "Remove",
        reasonLabel: "Reason (optional)",
      };
    case "restore":
      return {
        title: `Restore ${name}?`,
        body: `${name} will reappear in the disabled-users view. Re-enable to grant access.`,
        verb: "Restore",
        reasonLabel: "Reason (optional)",
      };
    case "cancelInvitation":
      return {
        title: `Cancel invitation for ${email}?`,
        body: `The pending invitation will be deleted and the magic link will stop working. The pending user record will also be removed.`,
        verb: "Cancel invitation",
        reasonLabel: "Reason (optional)",
      };
  }
}

export function UserLifecycleConfirmModal({
  action,
  user,
  invitation,
  extraWarning,
  onConfirm,
  onCancel,
}: {
  action: UserLifecycleAction;
  user?: AdminUser;
  invitation?: PendingInvitation;
  /** Super-admin last-admin override warning */
  extraWarning?: string;
  onConfirm: (reason: string | undefined) => Promise<void>;
  onCancel: () => void;
}): React.ReactElement {
  const [reason, setReason] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [loading, setLoading] = useState(false);
  const copy = buildModalCopy(action, user, invitation, extraWarning);

  const canConfirm = !copy.requireAcknowledge || acknowledged;

  const handleConfirm = async (): Promise<void> => {
    setLoading(true);
    try {
      await onConfirm(reason.trim() || undefined);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.36)",
        display: "grid",
        placeItems: "center",
        zIndex: 300,
      }}
      onClick={onCancel}
      role="presentation"
    >
      <Card
        padding="lg"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 480 }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
          <h2
            className="aiq-serif"
            style={{ fontSize: 22, margin: 0, fontWeight: 400, letterSpacing: "-0.015em" }}
          >
            {copy.title}
          </h2>
          <span style={{ flex: 1 }} />
          <Button size="sm" variant="ghost" onClick={onCancel} aria-label="Close" disabled={loading}>
            ×
          </Button>
        </div>

        <p
          style={{
            fontSize: 13,
            color: "var(--aiq-color-fg-secondary)",
            margin: "0 0 20px",
            lineHeight: 1.5,
          }}
        >
          {copy.body}
        </p>

        {/* Extra warning (super-admin last-admin override) */}
        {copy.extraWarning && (
          <div
            style={{
              padding: "10px 14px",
              background: "var(--aiq-color-bg-sunken)",
              border: "1px solid var(--aiq-color-warning, #d97706)",
              borderRadius: "var(--aiq-radius-md)",
              marginBottom: 16,
              fontSize: 13,
              lineHeight: 1.5,
            }}
          >
            {copy.extraWarning}
          </div>
        )}

        {/* Optional reason textarea */}
        <div style={{ marginBottom: copy.requireAcknowledge ? 12 : 20 }}>
          <label
            style={{
              display: "block",
              fontFamily: "var(--aiq-font-sans)",
              fontSize: 12,
              fontWeight: 500,
              marginBottom: 6,
            }}
          >
            {copy.reasonLabel}
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            disabled={loading}
            placeholder="Briefly describe why (recorded in the audit log)…"
            rows={3}
            style={{
              width: "100%",
              fontFamily: "var(--aiq-font-sans)",
              fontSize: 13,
              padding: "8px 10px",
              borderRadius: "var(--aiq-radius-md)",
              border: "1px solid var(--aiq-color-border)",
              background: "var(--aiq-color-bg-raised)",
              color: "var(--aiq-color-fg-primary)",
              resize: "vertical",
              boxSizing: "border-box",
            }}
          />
          <span style={{ ...META_LABEL, display: "block", marginTop: 4, fontSize: 10 }}>
            {reason.length} / 500
          </span>
        </div>

        {/* Acknowledge checkbox for last-admin overrides */}
        {copy.requireAcknowledge && (
          <label
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
              marginBottom: 20,
              cursor: "pointer",
              fontFamily: "var(--aiq-font-sans)",
              fontSize: 13,
              lineHeight: 1.4,
              color: "var(--aiq-color-fg-primary)",
            }}
          >
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              disabled={loading}
              style={{ marginTop: 2, cursor: "pointer" }}
            />
            I understand this is the last active admin
          </label>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button variant="ghost" onClick={onCancel} disabled={loading}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleConfirm()}
            loading={loading}
            disabled={!canConfirm}
          >
            {copy.verb}
          </Button>
        </div>
      </Card>
    </div>
  );
}

// ── Per-row Manage menu ───────────────────────────────────────────────────────

function UserManageMenu({
  user,
  currentUserId,
  isLastActiveAdmin,
  readOnly,
  onAction,
}: {
  user: AdminUser;
  currentUserId?: string;
  isLastActiveAdmin: boolean;
  readOnly: boolean;
  onAction: (action: UserLifecycleAction, extraWarning?: string) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const menuItem = (
    label: string,
    onClick: () => void,
    danger = false,
    disabled = false,
  ): React.ReactElement => (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        if (disabled) return;
        setOpen(false);
        onClick();
      }}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "7px 14px",
        background: "none",
        border: "none",
        cursor: disabled ? "default" : "pointer",
        fontFamily: "var(--aiq-font-sans)",
        fontSize: 13,
        color: disabled
          ? "var(--aiq-color-fg-muted)"
          : danger
            ? "var(--aiq-color-danger, #dc2626)"
            : "var(--aiq-color-fg-primary)",
        whiteSpace: "nowrap",
        opacity: disabled ? 0.5 : 1,
      }}
      onMouseEnter={(e) => {
        if (!disabled) (e.currentTarget as HTMLElement).style.background = "var(--aiq-color-bg-sunken)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = "none";
      }}
    >
      {label}
    </button>
  );

  const isSelf = user.id === currentUserId;
  const items: React.ReactElement[] = [];

  if (user.status === "active") {
    if (!isSelf) {
      if (!isLastActiveAdmin) {
        items.push(menuItem("Disable user", () => onAction("disable"), true));
      } else {
        // Last active admin — show item but with a special extra-warning for
        // super-admin (non-super sees no Disable at all; super gets the override)
        items.push(
          menuItem(
            "Disable user (last admin)",
            () =>
              onAction(
                "disable",
                `⚠ This will disable the last active admin of this tenant. The tenant will have no remaining active admin. Are you sure?`,
              ),
            true,
          ),
        );
      }
    }
    // soft-delete: only when not self and not last active admin
    if (!isSelf && !isLastActiveAdmin) {
      items.push(menuItem("Remove permanently", () => onAction("softDelete"), true));
    }
  } else if (user.status === "disabled") {
    items.push(menuItem("Re-enable user", () => onAction("reenable")));
    items.push(menuItem("Remove permanently", () => onAction("softDelete"), true));
  }
  // deleted_at rows: Restore only
  if (user.deleted_at) {
    items.length = 0; // clear status-based items — deleted overrides
    items.push(menuItem("Restore user", () => onAction("restore")));
  }

  if (readOnly || items.length === 0) {
    return <></>;
  }

  return (
    <div ref={menuRef} style={{ position: "relative", display: "inline-block" }}>
      <Button
        size="sm"
        variant="ghost"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        Manage ▾
      </Button>
      {open && (
        <div
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 4px)",
            background: "var(--aiq-color-bg-base)",
            border: "1px solid var(--aiq-color-border)",
            borderRadius: "var(--aiq-radius-md)",
            boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
            zIndex: 400,
            minWidth: 180,
            paddingTop: 4,
            paddingBottom: 4,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {items}
        </div>
      )}
    </div>
  );
}

// ── Per-invitation Manage menu ────────────────────────────────────────────────

function InvitationManageMenu({
  readOnly,
  onCancel,
}: {
  readOnly: boolean;
  onCancel: () => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  if (readOnly) return <></>;

  return (
    <div ref={menuRef} style={{ position: "relative", display: "inline-block" }}>
      <Button
        size="sm"
        variant="ghost"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        Manage ▾
      </Button>
      {open && (
        <div
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 4px)",
            background: "var(--aiq-color-bg-base)",
            border: "1px solid var(--aiq-color-border)",
            borderRadius: "var(--aiq-radius-md)",
            boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
            zIndex: 400,
            minWidth: 180,
            paddingTop: 4,
            paddingBottom: 4,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onCancel();
            }}
            style={{
              display: "block",
              width: "100%",
              textAlign: "left",
              padding: "7px 14px",
              background: "none",
              border: "none",
              cursor: "pointer",
              fontFamily: "var(--aiq-font-sans)",
              fontSize: 13,
              color: "var(--aiq-color-danger, #dc2626)",
              whiteSpace: "nowrap",
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--aiq-color-bg-sunken)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "none"; }}
          >
            Cancel invitation
          </button>
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function AdminUsers({ superContext }: AdminUsersProps = {}): React.ReactElement {
  const isSuperContext = superContext !== undefined;

  // ── Tenant-admin–scoped fetch state (unused in super context) ──
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);

  // Phase C toggles — session-scoped (no localStorage)
  const [showDisabled, setShowDisabled] = useState(false);
  const [showRemoved, setShowRemoved] = useState(false);

  // Phase C page-level feedback
  const [actionToast, setActionToast] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Phase C lifecycle modal
  const [lifecycleTarget, setLifecycleTarget] = useState<UserLifecycleTarget | null>(null);
  const [lifecycleExtraWarning, setLifecycleExtraWarning] = useState<string | undefined>(undefined);

  // Debounce search input (300ms)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSearchChange = (value: string): void => {
    setSearch(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(value);
      setPage(1);
    }, 300);
  };

  const fetchUsers = useCallback(async (): Promise<void> => {
    if (isSuperContext) return; // super context manages its own fetch
    setLoading(true);
    setFetchError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (roleFilter) params.set("role", roleFilter);
      if (showDisabled) params.set("includeDisabled", "true");
      if (showRemoved) params.set("includeDeleted", "true");
      const data = await adminApi<UsersResponse>(`/admin/users?${params.toString()}`);
      setUsers(data.items);
      setTotal(data.total);
    } catch (err) {
      if (err instanceof AdminApiError) {
        setFetchError(err.apiError.message);
      } else {
        setFetchError("Failed to load users.");
      }
    } finally {
      setLoading(false);
    }
  }, [isSuperContext, page, debouncedSearch, roleFilter, showDisabled, showRemoved]);

  useEffect(() => { void fetchUsers(); }, [fetchUsers]);

  // Resolved values — in super context, use what the parent provides
  const resolvedUsers: AdminUser[] = isSuperContext ? superContext.users : users;
  const resolvedLoading = isSuperContext ? superContext.loading : loading;
  const resolvedFetchError = isSuperContext ? superContext.fetchError : fetchError;
  const resolvedTotal = isSuperContext ? superContext.users.length : total;
  const resolvedPendingInvitations: PendingInvitation[] = isSuperContext
    ? superContext.pendingInvitations
    : [];

  const lifecycleHandlers: UserLifecycleApiHandlers = isSuperContext
    ? superContext.lifecycleHandlers
    : DEFAULT_LIFECYCLE_HANDLERS;

  const isReadOnly =
    isSuperContext && superContext.tenantStatus !== "active";

  const totalPages = Math.ceil(resolvedTotal / PAGE_SIZE);

  const formatDate = (iso: string): string =>
    new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

  // Resolve the current user's ID from session for self-disable guard
  // We don't have a session hook here; super-admin context leaves it undefined
  // (the backend enforces CANNOT_DISABLE_SELF anyway — this is a UX convenience only).
  const currentUserId: string | undefined = undefined;

  // Detect last-active-admin: only meaningful in super context where we have
  // the full list. In tenant-admin context the backend enforces LAST_ADMIN.
  const activeAdminCount = resolvedUsers.filter(
    (u) => u.role === "admin" && u.status === "active" && !u.deleted_at,
  ).length;

  // ── Lifecycle confirm handler ──────────────────────────────────────────────

  const handleLifecycleConfirm = async (reason: string | undefined): Promise<void> => {
    if (!lifecycleTarget) return;
    setActionError(null);
    setActionToast(null);

    const { action, user, invitation } = lifecycleTarget;
    const displayName = user?.name ?? user?.email ?? invitation?.email ?? "user";

    try {
      if (action === "cancelInvitation" && invitation) {
        await lifecycleHandlers.cancelInvitation(invitation.id, reason);
        setActionToast(`Invitation for ${invitation.email} cancelled.`);
      } else if (user) {
        if (action === "disable") {
          const confirmLastAdmin = isSuperContext && !!lifecycleExtraWarning && activeAdminCount <= 1;
          await lifecycleHandlers.disable(user.id, reason, confirmLastAdmin || undefined);
          setActionToast(`${displayName} disabled.`);
        } else if (action === "reenable") {
          await lifecycleHandlers.reenable(user.id, reason);
          setActionToast(`${displayName} re-enabled.`);
        } else if (action === "softDelete") {
          await lifecycleHandlers.softDelete(user.id, reason);
          setActionToast(`${displayName} removed.`);
        } else if (action === "restore") {
          await lifecycleHandlers.restore(user.id, reason);
          setActionToast(`${displayName} restored.`);
        }
      }
      setLifecycleTarget(null);
      setLifecycleExtraWarning(undefined);
      // Refetch
      if (isSuperContext) {
        superContext.onRefetch();
      } else {
        void fetchUsers();
      }
      setTimeout(() => setActionToast(null), 4000);
    } catch (err) {
      const code = err instanceof AdminApiError
        ? (err.apiError.details?.code as string | undefined)
        : undefined;
      const message = err instanceof AdminApiError ? err.apiError.message : "Unexpected error — please try again.";

      let displayMessage = message;
      if (code === "CANNOT_DISABLE_SELF") displayMessage = "You cannot disable your own account.";
      else if (code === "CANNOT_DELETE_SELF") displayMessage = "You cannot remove your own account.";
      else if (code === "LAST_ADMIN") displayMessage = "Cannot disable the last active admin of this tenant.";
      else if (code === "INVITATION_ALREADY_ACCEPTED") displayMessage = "This invitation has already been accepted.";
      else if (code === "INVITATION_NOT_FOUND") displayMessage = "Invitation not found — it may have already been cancelled.";

      setActionError(displayMessage);
      setLifecycleTarget(null);
      setLifecycleExtraWarning(undefined);
    }
  };

  // ── Breadcrumbs ──────────────────────────────────────────────────────────

  const breadcrumbs: string[] = isSuperContext
    ? ["Platform", superContext.tenantName, "Users"]
    : ["Users"];

  return (
    <AdminShell breadcrumbs={breadcrumbs} helpPage="admin.users.list">
      {showInvite && !isSuperContext && (
        <InviteForm
          onSuccess={() => { setShowInvite(false); void fetchUsers(); }}
          onCancel={() => setShowInvite(false)}
        />
      )}

      {lifecycleTarget !== null && (
        <UserLifecycleConfirmModal
          action={lifecycleTarget.action}
          {...(lifecycleTarget.user !== undefined ? { user: lifecycleTarget.user } : {})}
          {...(lifecycleTarget.invitation !== undefined ? { invitation: lifecycleTarget.invitation } : {})}
          {...(lifecycleExtraWarning !== undefined ? { extraWarning: lifecycleExtraWarning } : {})}
          onConfirm={handleLifecycleConfirm}
          onCancel={() => { setLifecycleTarget(null); setLifecycleExtraWarning(undefined); }}
        />
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xl)" }}>

        {/* Read-only banner (super-admin, non-active tenant) */}
        {isReadOnly && (
          <div
            style={{
              padding: "10px 14px",
              background: "var(--aiq-color-bg-sunken)",
              borderRadius: "var(--aiq-radius-md)",
              border: "1px solid var(--aiq-color-border)",
              fontSize: 13,
              color: "var(--aiq-color-fg-secondary)",
              lineHeight: 1.5,
            }}
          >
            This tenant is <strong>{superContext?.tenantStatus}</strong>. User management is read-only.
          </div>
        )}

        {/* Page header — count chip + serif h1 + lede + CTA */}
        <div style={{ display: "flex", alignItems: "flex-end" }}>
          <div>
            <div style={{ marginBottom: 12 }}>
              <Chip leftIcon="grid">{resolvedUsers.length} of {resolvedTotal}</Chip>
            </div>
            <h1
              style={{
                fontFamily: "var(--aiq-font-serif)",
                fontSize: "var(--aiq-text-3xl)",
                fontWeight: 400,
                margin: 0,
                letterSpacing: "-0.02em",
              }}
            >
              Users.
            </h1>
            <p
              style={{
                fontSize: 14,
                color: "var(--aiq-color-fg-secondary)",
                margin: "8px 0 0",
                maxWidth: 520,
                lineHeight: 1.5,
              }}
            >
              Admins manage the tenant. Reviewers grade submissions. Candidates take assessments.
            </p>
          </div>
          <span style={{ flex: 1 }} />
          {!isSuperContext && (
            <Button leftIcon="plus" onClick={() => setShowInvite(true)}>
              Invite user
            </Button>
          )}
        </div>

        {/* Filter strip */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            paddingBottom: 16,
            borderBottom: "1px solid var(--aiq-color-border)",
            flexWrap: "wrap",
          }}
        >
          {!isSuperContext && (
            <div style={{ flex: "1 1 320px", maxWidth: 360 }}>
              <Field
                label=""
                placeholder="Search by name or email…"
                value={search}
                onChange={(e) => handleSearchChange(e.target.value)}
              />
            </div>
          )}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {!isSuperContext && (["admin", "reviewer"] as const).map((r) => (
              <span
                key={r}
                onClick={() => { setRoleFilter(roleFilter === r ? null : r); setPage(1); }}
                style={{ cursor: "pointer" }}
                role="button"
                aria-pressed={roleFilter === r}
              >
                <Chip variant={roleFilter === r ? "accent" : "default"}>{r}</Chip>
              </span>
            ))}
            {/* Show disabled toggle */}
            <span
              onClick={() => { setShowDisabled(!showDisabled); setPage(1); }}
              style={{ cursor: "pointer" }}
              role="button"
              aria-pressed={showDisabled}
            >
              <Chip variant={showDisabled ? "accent" : "default"}>
                {showDisabled ? "Showing disabled" : "Show disabled users"}
              </Chip>
            </span>
            {/* Show removed toggle */}
            <span
              onClick={() => { setShowRemoved(!showRemoved); setPage(1); }}
              style={{ cursor: "pointer" }}
              role="button"
              aria-pressed={showRemoved}
            >
              <Chip variant={showRemoved ? "accent" : "default"}>
                {showRemoved ? "Showing removed" : "Show removed users"}
              </Chip>
            </span>
          </div>
        </div>

        {/* Page-level error + toast */}
        {resolvedFetchError && (
          <div style={{ marginBottom: 16 }}>
            <Chip>{resolvedFetchError}</Chip>
          </div>
        )}
        {actionError && (
          <div style={{ marginBottom: 16 }}>
            <Chip>{actionError}</Chip>
          </div>
        )}
        {actionToast && (
          <div style={{ marginBottom: 16 }}>
            <Chip variant="success">{actionToast}</Chip>
          </div>
        )}

        {/* Data rows or loading / empty */}
        {resolvedLoading ? (
          <div style={{ display: "grid", placeItems: "center", padding: "var(--aiq-space-3xl) 0" }}>
            <Spinner aria-label="Loading users" />
          </div>
        ) : resolvedUsers.length === 0 && resolvedPendingInvitations.length === 0 ? (
          /* Empty state — serif headline + secondary copy + primary CTA */
          <div
            style={{
              padding: 64,
              textAlign: "center",
              border: "1px dashed var(--aiq-color-border-strong)",
              borderRadius: "var(--aiq-radius-lg)",
              background: "var(--aiq-color-bg-raised)",
            }}
          >
            <h2
              className="aiq-serif"
              style={{ fontSize: 24, margin: 0, fontWeight: 400, letterSpacing: "-0.015em" }}
            >
              Nothing here yet.
            </h2>
            <p
              style={{
                fontSize: 14,
                color: "var(--aiq-color-fg-secondary)",
                margin: "8px 0 20px",
                maxWidth: 360,
                marginLeft: "auto",
                marginRight: "auto",
                lineHeight: 1.5,
              }}
            >
              Invite your first teammate to get started. They will receive an email with a sign-in link.
            </p>
            {!isSuperContext && (
              <Button leftIcon="plus" onClick={() => setShowInvite(true)}>
                Invite user
              </Button>
            )}
          </div>
        ) : (
          <div
            style={{
              border: "1px solid var(--aiq-color-border)",
              borderRadius: "var(--aiq-radius-md)",
              overflow: "hidden",
              background: "var(--aiq-color-bg-base)",
            }}
          >
            {/* Column heads */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: ROW_GRID,
                gap: ROW_GRID_GAP,
                padding: "12px 20px",
                background: "var(--aiq-color-bg-raised)",
                borderBottom: "1px solid var(--aiq-color-border)",
                ...META_LABEL,
                fontSize: 10,
              }}
            >
              <span>ID</span>
              <span>User</span>
              <span>Role</span>
              <span>Status</span>
              <span>Created</span>
              <span></span>
            </div>

            {/* User rows */}
            {resolvedUsers
              .filter((u) => {
                if (u.deleted_at && !showRemoved) return false;
                if (u.status === "disabled" && !u.deleted_at && !showDisabled) return false;
                return true;
              })
              .map((u, i) => {
                const isDeleted = !!u.deleted_at;
                const isDisabled = u.status === "disabled" && !isDeleted;
                const isLastAdmin =
                  u.role === "admin" && u.status === "active" && activeAdminCount <= 1;

                const statusChipVariant: ChipVariant = isDeleted
                  ? "default"
                  : (STATUS_VARIANT[u.status] ?? "default");
                const statusLabel = isDeleted ? "Removed" : u.status;

                return (
                  <div
                    key={u.id}
                    style={{
                      display: "grid",
                      gridTemplateColumns: ROW_GRID,
                      gap: ROW_GRID_GAP,
                      padding: ROW_PADDING,
                      alignItems: "center",
                      borderTop: i === 0 ? "none" : "1px solid var(--aiq-color-border)",
                      background: i % 2 === 1 ? "var(--aiq-color-bg-raised)" : "transparent",
                      opacity: isDeleted ? 0.6 : isDisabled ? 0.75 : 1,
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "var(--aiq-font-mono)",
                        fontSize: 12,
                        color: "var(--aiq-color-fg-muted)",
                      }}
                    >
                      #{u.id.slice(0, 8)}
                    </span>
                    <div>
                      <div
                        style={{
                          fontSize: 14,
                          fontWeight: 500,
                          color: "var(--aiq-color-fg-primary)",
                          textDecoration: isDeleted ? "line-through" : "none",
                        }}
                      >
                        {u.name ?? "—"}
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: "var(--aiq-color-fg-secondary)",
                          textDecoration: isDeleted ? "line-through" : "none",
                        }}
                      >
                        {u.email}
                      </div>
                    </div>
                    <span
                      style={{
                        fontFamily: "var(--aiq-font-mono)",
                        fontSize: 11,
                        textTransform: "uppercase",
                        letterSpacing: "0.06em",
                        color: "var(--aiq-color-fg-secondary)",
                      }}
                    >
                      {u.role}
                    </span>
                    <span>
                      <Chip variant={statusChipVariant}>{statusLabel}</Chip>
                    </span>
                    <span
                      style={{
                        fontFamily: "var(--aiq-font-mono)",
                        fontSize: 11,
                        color: "var(--aiq-color-fg-muted)",
                      }}
                    >
                      {formatDate(u.created_at)}
                    </span>
                    <div style={{ display: "flex", justifyContent: "flex-end" }}>
                      <UserManageMenu
                        user={u}
                        {...(currentUserId !== undefined ? { currentUserId } : {})}
                        isLastActiveAdmin={isLastAdmin}
                        readOnly={isReadOnly}
                        onAction={(action, extraWarning) => {
                          setLifecycleTarget({ action, user: u });
                          if (extraWarning !== undefined) {
                            setLifecycleExtraWarning(extraWarning);
                          } else {
                            setLifecycleExtraWarning(undefined);
                          }
                          setActionError(null);
                        }}
                      />
                    </div>
                  </div>
                );
              })}

            {/* Pending invitation rows (super-admin context) */}
            {resolvedPendingInvitations.map((inv, idx) => {
              const rowIndex = resolvedUsers.filter((u) => {
                if (u.deleted_at && !showRemoved) return false;
                if (u.status === "disabled" && !u.deleted_at && !showDisabled) return false;
                return true;
              }).length + idx;
              return (
                <div
                  key={inv.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: INV_GRID,
                    gap: ROW_GRID_GAP,
                    padding: ROW_PADDING,
                    alignItems: "center",
                    borderTop: "1px solid var(--aiq-color-border)",
                    background: rowIndex % 2 === 1 ? "var(--aiq-color-bg-raised)" : "transparent",
                  }}
                >
                  <span
                    style={{
                      fontFamily: "var(--aiq-font-mono)",
                      fontSize: 12,
                      color: "var(--aiq-color-fg-muted)",
                    }}
                  >
                    #{inv.id.slice(0, 8)}
                  </span>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 500, color: "var(--aiq-color-fg-primary)" }}>
                      —
                    </div>
                    <div style={{ fontSize: 12, color: "var(--aiq-color-fg-secondary)" }}>
                      {inv.email}
                    </div>
                  </div>
                  <span
                    style={{
                      fontFamily: "var(--aiq-font-mono)",
                      fontSize: 11,
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                      color: "var(--aiq-color-fg-secondary)",
                    }}
                  >
                    {inv.role}
                  </span>
                  <span>
                    <Chip variant="accent" leftIcon="clock">Invite pending</Chip>
                  </span>
                  <span
                    style={{
                      fontFamily: "var(--aiq-font-mono)",
                      fontSize: 11,
                      color: "var(--aiq-color-fg-muted)",
                    }}
                  >
                    {formatDate(inv.created_at)}
                  </span>
                  <div style={{ display: "flex", justifyContent: "flex-end" }}>
                    <InvitationManageMenu
                      readOnly={isReadOnly}
                      onCancel={() => {
                        setLifecycleTarget({ action: "cancelInvitation", invitation: inv });
                        setLifecycleExtraWarning(undefined);
                        setActionError(null);
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Pager — only in tenant-admin context */}
        {!isSuperContext && resolvedUsers.length > 0 && (
          <div style={{ marginTop: "var(--aiq-space-sm)" }}>
            <Pager
              page={page}
              totalPages={totalPages}
              onPrev={() => setPage((p) => Math.max(1, p - 1))}
              onNext={() => setPage((p) => Math.min(totalPages, p + 1))}
            />
          </div>
        )}
      </div>
    </AdminShell>
  );
}
