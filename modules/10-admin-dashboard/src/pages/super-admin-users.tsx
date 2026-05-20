// AssessIQ — Super-admin per-tenant user drill-down.
//
// Route: /admin/platform/:tenantId/users  (super_admin only)
// Linked from ManageMenu → "Manage users" in platform.tsx.
//
// This thin wrapper:
//   1. Reads :tenantId from the URL.
//   2. Fetches the tenant's user list via listTenantUsersAsSuperApi.
//   3. Passes superContext into AdminUsers, which swaps breadcrumbs,
//      API handlers, and data source to the super-admin variants.
//   4. Maps SuperUserListItem → AdminUser so AdminUsers needs no type changes.
//
// Super-admin overrides allowed here:
//   - Disable of the last active admin (with extra warning + checkbox)
//   - All other lifecycle actions without LAST_ADMIN guard
//   - audit rows carry is_override:true server-side

import React, { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import {
  AdminApiError,
  listTenantUsersAsSuperApi,
  listTenantsApi,
  superDisableUserApi,
  superReenableUserApi,
  superSoftDeleteUserApi,
  superRestoreUserApi,
  superCancelInvitationApi,
  type SuperUserListItem,
  type SuperPendingInvitation,
} from "../api.js";
import { AdminUsers, type AdminUser, type PendingInvitation, type UserLifecycleApiHandlers } from "./users.js";

// ── Type coercions ────────────────────────────────────────────────────────────

function toAdminUser(u: SuperUserListItem): AdminUser {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    // Cast: backend returns same set of status strings
    status: u.status as AdminUser["status"],
    created_at: u.created_at,
    deleted_at: u.deleted_at,
  };
}

function toPendingInvitation(inv: SuperPendingInvitation): PendingInvitation {
  return {
    id: inv.id,
    email: inv.email,
    role: inv.role,
    expires_at: inv.expires_at,
    created_at: inv.created_at,
  };
}

// ── Component ─────────────────────────────────────────────────────────────────

export function SuperAdminUsers(): React.ReactElement {
  const { tenantId } = useParams<{ tenantId: string }>();

  // Tenant name + status — needed for breadcrumb and read-only banner.
  // We fetch from the tenant list on mount; fall back to the ID while loading.
  const [tenantName, setTenantName] = useState<string>("");
  const [tenantStatus, setTenantStatus] = useState<string>("active");

  // User list state
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [pendingInvitations, setPendingInvitations] = useState<PendingInvitation[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Show disabled / removed toggles live here so we can pass them to the
  // fetch call.  AdminUsers renders the toggle chips from its own state,
  // but the actual filter is applied inside AdminUsers against the
  // pre-fetched full list (it client-filters the already-fetched data).
  // For the super context, we always fetch the widest set (include_disabled +
  // include_deleted = true) so the toggles work purely client-side.

  const resolvedTenantId = tenantId ?? "";

  const fetchTenantMeta = useCallback(async (): Promise<void> => {
    if (!resolvedTenantId) return;
    try {
      const data = await listTenantsApi({ includeArchived: true });
      const match = data.tenants.find((t) => t.id === resolvedTenantId);
      if (match) {
        setTenantName(match.name);
        setTenantStatus(match.status);
      }
    } catch {
      // Non-fatal — breadcrumb falls back to tenantId
    }
  }, [resolvedTenantId]);

  const fetchUsers = useCallback(async (): Promise<void> => {
    if (!resolvedTenantId) return;
    setLoading(true);
    setFetchError(null);
    try {
      const data = await listTenantUsersAsSuperApi(resolvedTenantId, {
        includeDisabled: true,
        includeDeleted: true,
      });
      setUsers(data.users.map(toAdminUser));
      setPendingInvitations(data.pending_invitations.map(toPendingInvitation));
    } catch (err) {
      if (err instanceof AdminApiError) {
        setFetchError(err.apiError.message);
      } else {
        setFetchError("Failed to load users for this tenant.");
      }
    } finally {
      setLoading(false);
    }
  }, [resolvedTenantId]);

  useEffect(() => {
    void fetchTenantMeta();
    void fetchUsers();
  }, [fetchTenantMeta, fetchUsers]);

  // Super-admin lifecycle handlers — forward confirm_last_admin when the
  // calling component passes it.  superDisableUserApi accepts it as the
  // third argument; the others don't need it but accept it for symmetry.
  const lifecycleHandlers: UserLifecycleApiHandlers = {
    disable: (userId: string, reason?: string, confirmLastAdmin?: boolean) =>
      superDisableUserApi(userId, reason, confirmLastAdmin),
    reenable: (userId: string, reason?: string) => superReenableUserApi(userId, reason),
    softDelete: (userId: string, reason?: string) => superSoftDeleteUserApi(userId, reason),
    restore: (userId: string, reason?: string) => superRestoreUserApi(userId, reason),
    cancelInvitation: (invitationId: string, reason?: string) =>
      superCancelInvitationApi(invitationId, reason),
  };

  return (
    <AdminUsers
      superContext={{
        tenantId: resolvedTenantId,
        tenantName: tenantName || resolvedTenantId,
        tenantStatus,
        lifecycleHandlers,
        users,
        pendingInvitations,
        loading,
        fetchError,
        onRefetch: fetchUsers,
      }}
    />
  );
}
