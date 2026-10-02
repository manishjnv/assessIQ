// AssessIQ — Super-admin Platform page.
//
// Provision new company tenants and list all provisioned tenants.
// Gate: super_admin role + fresh TOTP (enforced by backend — 401 AUTHN_FAILED
// with "fresh totp" triggers in-form MFA step-up, preserving all entered values).
//
// Pattern mirrors users.tsx exactly:
//   - AdminShell wrapper
//   - Serif h1 + count Chip + lede + primary CTA
//   - Fixed-position centred Card modal with backdrop + stopPropagation
//   - Field / Button / Chip / Spinner from @assessiq/ui-system
//   - META_LABEL / ROW_GRID / zebra rows
//   - data-help-id on form controls


import React, { useCallback, useEffect, useState } from "react";
import { Button, Chip, Spinner, type ChipVariant } from "@assessiq/ui-system";
import { AdminShell } from "../components/AdminShell.js";
import { AdminApiError, resendInvitationApi, listTenantsApi, suspendTenantApi, resumeTenantApi, archiveTenantApi, unarchiveTenantApi, type TenantListItem, type LifecycleResponse } from "../api.js";
import { type LifecycleAction, META_LABEL, ROW_PADDING, formatDate } from "./platform/shared.js";
import { CreateCompanyForm } from "./platform/CreateCompanyForm.js";
import { EditAdminModal } from "./platform/EditAdminModal.js";
import { LifecycleConfirmModal } from "./platform/LifecycleConfirmModal.js";
import { BillingDrawer } from "./platform/BillingDrawer.js";
import { ManageMenu } from "./platform/ManageMenu.js";
import { PlatformDomainsSection } from "./platform/PlatformDomainsSection.js";
import { LIFECYCLE_COPY } from "./platform/LifecycleConfirmModal.js";

// ── Types ────────────────────────────────────────────────────────────────────

type TenantStatus = "active" | "provisioning" | "suspended" | "archived" | string;


interface LifecycleModalState {
  action: LifecycleAction;
  tenant: TenantListItem;
}

const STATUS_VARIANT: Record<string, ChipVariant> = {
  active: "success",
  provisioning: "accent",
  suspended: "default",
  archived: "default",
};

function statusVariant(status: TenantStatus): ChipVariant {
  return (STATUS_VARIANT[status] as ChipVariant | undefined) ?? "default";
}

const ROW_GRID = "1fr 1.2fr 2.1fr 150px 110px 110px";
const ROW_GRID_GAP = 12;

// ── Main page ─────────────────────────────────────────────────────────────────

export function AdminPlatform(): React.ReactElement {
  const [tenants, setTenants] = useState<TenantListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [drawerTenant, setDrawerTenant] = useState<TenantListItem | null>(null);
  const [editTenant, setEditTenant] = useState<TenantListItem | null>(null);
  const [editToast, setEditToast] = useState<string | null>(null);
  const [resendingTenantId, setResendingTenantId] = useState<string | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);
  const [resendToast, setResendToast] = useState<string | null>(null);

  // Phase B: Show archived toggle (session-scoped, default false)
  const [includeArchived, setIncludeArchived] = useState(false);

  // Phase B: Lifecycle modal + action state
  const [lifecycleModal, setLifecycleModal] = useState<LifecycleModalState | null>(null);
  const [lifecycleToast, setLifecycleToast] = useState<string | null>(null);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);

  const fetchTenants = useCallback(async (archived = includeArchived): Promise<void> => {
    setLoading(true);
    setFetchError(null);
    try {
      const data = await listTenantsApi({ includeArchived: archived });
      setTenants(data.tenants);
    } catch (err) {
      if (err instanceof AdminApiError) {
        setFetchError(err.apiError.message);
      } else {
        setFetchError("Failed to load tenants.");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchTenants(includeArchived);
  }, [fetchTenants, includeArchived]);

  const handleResend = async (tenantId: string): Promise<void> => {
    setResendingTenantId(tenantId);
    setResendError(null);
    setResendToast(null);
    try {
      const res = await resendInvitationApi(tenantId);
      setResendToast(
        `Resent invite to ${res.invitation.email} · expires ${formatDate(res.invitation.expires_at)}`,
      );
      setTimeout(() => setResendToast(null), 4000);
      void fetchTenants(includeArchived);
    } catch (err) {
      setResendError(
        err instanceof AdminApiError ? err.apiError.message : "Resend failed — please try again.",
      );
    } finally {
      setResendingTenantId(null);
    }
  };

  // Phase B: Lifecycle action handler — called by LifecycleConfirmModal.onConfirm
  const handleLifecycleConfirm = async (
    action: LifecycleAction,
    tenant: TenantListItem,
    reason: string | undefined,
  ): Promise<void> => {
    setLifecycleError(null);
    setLifecycleToast(null);
    const apiMap: Record<LifecycleAction, (id: string, r?: string) => Promise<LifecycleResponse>> = {
      suspend: suspendTenantApi,
      resume: resumeTenantApi,
      archive: archiveTenantApi,
      unarchive: unarchiveTenantApi,
    };
    const verb = LIFECYCLE_COPY[action].verb;
    try {
      const res = await apiMap[action](tenant.id, reason);
      setLifecycleModal(null);
      if (res.noOp) {
        setLifecycleToast(`${verb} ${tenant.name} — already in target state`);
      } else {
        const revoked = res.sessionsRevoked?.count ?? 0;
        setLifecycleToast(`${verb} ${tenant.name} — ${revoked} user${revoked !== 1 ? "s" : ""} signed out`);
      }
      setTimeout(() => setLifecycleToast(null), 4000);
      void fetchTenants(includeArchived);
    } catch (err) {
      // Fresh-MFA challenge: hand control back to the modal so it can drive
      // in-place TOTP re-verification (mirrors CreateCompanyForm). Re-throw
      // WITHOUT closing the modal or setting a page-level error — the modal's
      // handleConfirm catch flips to its MFA sub-state and retries on success.
      if (
        err instanceof AdminApiError &&
        err.status === 401 &&
        /fresh totp/i.test(err.apiError.message)
      ) {
        throw err;
      }
      if (err instanceof AdminApiError) {
        const details = err.apiError.details as Record<string, unknown> | undefined;
        if (details?.code === "INVALID_LIFECYCLE_TRANSITION") {
          const current = details.currentStatus as string | undefined;
          setLifecycleError(
            `${tenant.name} is in ${current ?? "unknown"} state and cannot be ${verb.toLowerCase()}d`,
          );
        } else {
          setLifecycleError(err.apiError.message);
        }
      } else {
        setLifecycleError("Unexpected error — please try again.");
      }
      // Keep modal closed on error; error shows at page level
      setLifecycleModal(null);
    }
  };

  // Updated ROW_GRID to accommodate Manage column at end
  const ROW_GRID_WITH_MANAGE = `${ROW_GRID} 120px`;

  return (
    <AdminShell breadcrumbs={["Platform"]} helpPage="admin.platform">
      {showCreate && (
        <CreateCompanyForm
          onSuccess={() => {
            setShowCreate(false);
            void fetchTenants(includeArchived);
          }}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {drawerTenant !== null && (
        <BillingDrawer
          tenant={drawerTenant}
          onClose={() => setDrawerTenant(null)}
          onPlanUpdated={() => void fetchTenants(includeArchived)}
        />
      )}

      {editTenant !== null && (
        <EditAdminModal
          tenant={editTenant}
          onSuccess={(summary) => {
            setEditTenant(null);
            setEditToast(summary);
            setTimeout(() => setEditToast(null), 4000);
            void fetchTenants(includeArchived);
          }}
          onCancel={() => setEditTenant(null)}
        />
      )}

      {lifecycleModal !== null && (
        <LifecycleConfirmModal
          action={lifecycleModal.action}
          tenant={lifecycleModal.tenant}
          onConfirm={(reason) =>
            handleLifecycleConfirm(lifecycleModal.action, lifecycleModal.tenant, reason)
          }
          onCancel={() => setLifecycleModal(null)}
        />
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xl)" }}>
        {/* Page header — count Chip + serif h1 + lede + CTA */}
        <div style={{ display: "flex", alignItems: "flex-end" }}>
          <div>
            <div style={{ marginBottom: 12 }}>
              <Chip leftIcon="grid">{tenants.length} companies</Chip>
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
              Companies.
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
              Provision a new company tenant and invite its first admin. Platform operators only.
            </p>
          </div>
          <span style={{ flex: 1 }} />
          <Button leftIcon="plus" onClick={() => setShowCreate(true)}>
            Create company
          </Button>
        </div>

        {/* Error state */}
        {fetchError && (
          <div style={{ marginBottom: 16 }}>
            <Chip>{fetchError}</Chip>
          </div>
        )}
        {resendError && (
          <div style={{ marginBottom: 16 }}>
            <Chip>{resendError}</Chip>
          </div>
        )}
        {resendToast && (
          <div style={{ marginBottom: 16 }}>
            <Chip variant="success">{resendToast}</Chip>
          </div>
        )}
        {editToast && (
          <div style={{ marginBottom: 16 }}>
            <Chip variant="success">{editToast}</Chip>
          </div>
        )}
        {/* Phase B: lifecycle action toast / error */}
        {lifecycleToast && (
          <div style={{ marginBottom: 16 }}>
            <Chip variant="success">{lifecycleToast}</Chip>
          </div>
        )}
        {lifecycleError && (
          <div style={{ marginBottom: 16 }}>
            <Chip>{lifecycleError}</Chip>
          </div>
        )}

        {/* Phase B: Show archived toggle */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              cursor: "pointer",
              userSelect: "none",
              fontFamily: "var(--aiq-font-sans)",
              fontSize: 13,
              color: "var(--aiq-color-fg-secondary)",
            }}
          >
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
              style={{ cursor: "pointer" }}
            />
            Show archived tenants
          </label>
        </div>

        {/* Data rows or loading / empty */}
        {loading ? (
          <div style={{ display: "grid", placeItems: "center", padding: "var(--aiq-space-3xl) 0" }}>
            <Spinner aria-label="Loading tenants" />
          </div>
        ) : tenants.length === 0 ? (
          /* Empty state — serif headline + secondary copy + primary CTA (mirrors users.tsx) */
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
              No companies yet.
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
              Provision your first company tenant to get started.
            </p>
            <Button leftIcon="plus" onClick={() => setShowCreate(true)}>
              Create company
            </Button>
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
                gridTemplateColumns: ROW_GRID_WITH_MANAGE,
                gap: ROW_GRID_GAP,
                padding: "12px 20px",
                background: "var(--aiq-color-bg-raised)",
                borderBottom: "1px solid var(--aiq-color-border)",
                ...META_LABEL,
                fontSize: 10,
              }}
            >
              <span>Slug</span>
              <span>Organisation</span>
              <span>Primary contact</span>
              <span>Usage</span>
              <span>Status</span>
              <span>Created</span>
              <span></span>
            </div>
            {tenants.map((t, i) => {
              const isArchived = t.status === "archived";
              return (
                <div
                  key={t.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: ROW_GRID_WITH_MANAGE,
                    gap: ROW_GRID_GAP,
                    padding: ROW_PADDING,
                    alignItems: "center",
                    borderTop: i === 0 ? "none" : "1px solid var(--aiq-color-border)",
                    background: i % 2 === 1 ? "var(--aiq-color-bg-raised)" : "transparent",
                    opacity: isArchived ? 0.7 : 1,
                  }}
                >
                  {/* Slug — mono, strikethrough on archived */}
                  <span
                    style={{
                      fontFamily: "var(--aiq-font-mono)",
                      fontSize: 12,
                      color: "var(--aiq-color-fg-secondary)",
                      textDecoration: isArchived ? "line-through" : "none",
                    }}
                  >
                    {t.slug}
                  </span>
                  {/* Name — strikethrough on archived */}
                  <span
                    style={{
                      fontSize: 14,
                      fontWeight: 500,
                      color: "var(--aiq-color-fg-primary)",
                      textDecoration: isArchived ? "line-through" : "none",
                    }}
                  >
                    {t.name}
                  </span>
                  {/* Primary contact — email (+ name secondary), pending/active hint + Phase B count badge */}
                  <div style={{ minWidth: 0 }}>
                    {t.admin_email === null ? (
                      <span
                        style={{
                          fontSize: 13,
                          color: "var(--aiq-color-fg-muted)",
                        }}
                      >
                        —
                      </span>
                    ) : (
                      <>
                        <div
                          style={{
                            fontSize: 13,
                            color: "var(--aiq-color-fg-primary)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                          title={t.admin_email}
                        >
                          {t.admin_email}
                        </div>
                        <div style={{ marginTop: 4, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
                          {t.admin_status === "pending" ? (
                            <>
                              <Chip variant="warn" leftIcon="clock">Invite pending</Chip>
                              {t.admin_invitation_expires_at !== null && (
                                <span
                                  style={{
                                    fontFamily: "var(--aiq-font-mono)",
                                    fontSize: 10,
                                    color: "var(--aiq-color-fg-muted)",
                                  }}
                                >
                                  · expires {formatDate(t.admin_invitation_expires_at)}
                                </span>
                              )}
                              <Button
                                size="sm"
                                variant="ghost"
                                loading={resendingTenantId === t.id}
                                disabled={resendingTenantId !== null}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void handleResend(t.id);
                                }}
                              >
                                {resendingTenantId === t.id ? "Resending…" : "Resend invite"}
                              </Button>
                            </>
                          ) : t.admin_status === "active" ? (
                            <>
                              {t.admin_name && t.admin_name !== t.admin_email && (
                                <span
                                  style={{
                                    fontSize: 11,
                                    color: "var(--aiq-color-fg-secondary)",
                                  }}
                                >
                                  {t.admin_name}
                                </span>
                              )}
                              <Chip variant="success" leftIcon="check">Accepted</Chip>
                            </>
                          ) : (
                            <span
                              style={{
                                fontSize: 11,
                                color: "var(--aiq-color-fg-secondary)",
                              }}
                            >
                              {t.admin_name && t.admin_name !== t.admin_email
                                ? `${t.admin_name} · `
                                : ""}
                              {t.admin_status ?? ""}
                            </span>
                          )}
                        </div>
                        {/* Phase B: admin/reviewer count badge */}
                        {((t.admin_count ?? 0) > 0 || (t.reviewer_count ?? 0) > 0) && (
                          <div style={{ marginTop: 4 }}>
                            <span style={{ ...META_LABEL, fontSize: 10 }}>
                              {t.admin_count ?? 0} admin{(t.admin_count ?? 0) !== 1 ? "s" : ""} · {t.reviewer_count ?? 0} reviewer{(t.reviewer_count ?? 0) !== 1 ? "s" : ""}
                            </span>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                  {/* Usage — A2 */}
                  <span>
                    {t.usage === null || t.usage === undefined ? (
                      <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: 11, color: "var(--aiq-color-fg-muted)" }}>—</span>
                    ) : t.usage.status === "unlimited" ? (
                      <Chip>Unlimited</Chip>
                    ) : (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: 11, color: "var(--aiq-color-fg-secondary)" }}>
                          {t.usage.used} / {t.usage.included_credits}
                        </span>
                        {t.usage.overage > 0 && (
                          <Chip variant="warn" style={{ fontSize: 10 }}>+{t.usage.overage}</Chip>
                        )}
                        {t.usage.overage === 0 && t.usage.status === "warn" && (
                          <Chip style={{ fontSize: 10 }}>Near limit</Chip>
                        )}
                      </span>
                    )}
                  </span>
                  {/* Status chip — Phase B: archived gets strikethrough label */}
                  <span>
                    {t.status === "archived" ? (
                      <Chip variant="default">
                        <span style={{ textDecoration: "line-through" }}>archived</span>
                      </Chip>
                    ) : (
                      <Chip variant={statusVariant(t.status)}>{t.status}</Chip>
                    )}
                  </span>
                  {/* Created — mono, en-GB */}
                  <span
                    style={{
                      fontFamily: "var(--aiq-font-mono)",
                      fontSize: 11,
                      color: "var(--aiq-color-fg-muted)",
                    }}
                  >
                    {formatDate(t.created_at)}
                  </span>
                  {/* Phase B: Manage menu */}
                  <div style={{ display: "flex", justifyContent: "flex-end" }}>
                    <ManageMenu
                      tenant={t}
                      onOpenBilling={() => setDrawerTenant(t)}
                      onEditAdmin={() => setEditTenant(t)}
                      onLifecycleAction={(action) => setLifecycleModal({ action, tenant: t })}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Platform domains — super-admin catalog management */}
        <PlatformDomainsSection />
      </div>
    </AdminShell>
  );
}
