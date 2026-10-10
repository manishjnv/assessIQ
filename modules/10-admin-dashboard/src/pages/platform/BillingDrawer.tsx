// BillingDrawer — split from platform.tsx (E9, no behaviour change).

import { planTierLabel, grantScopeLabel, organisationStatusDisplay } from "../../lib/labels.js";
import React, { useEffect, useState } from "react";
import { Button, Card, Chip, Spinner } from "@assessiq/ui-system";
import { AdminApiError, getTenantBillingDetail, updateTenantPlan, tenantBillingCsvUrl, getTenantEntitlements, getTenantContentScopes, listPlatformPublishedPacks, grantTenantEntitlement, revokeTenantEntitlement, type TenantListItem, type TenantBillingDetail, type TenantEntitlement, type TenantContentScopes, type PlatformPackOption } from "../../api.js";
import { HelpTip } from "@assessiq/help-system/components";
import { META_LABEL, formatDate } from "./shared.js";

// ── Billing drawer ────────────────────────────────────────────────────────────

const TIER_OPTIONS = [
  { value: "free", label: "free" },
  { value: "pro", label: "pro" },
  { value: "enterprise", label: "enterprise" },
  { value: "internal", label: "internal" },
];

export function BillingDrawer({
  tenant,
  onClose,
  onPlanUpdated,
}: {
  tenant: TenantListItem;
  onClose: () => void;
  onPlanUpdated: () => void;
}): React.ReactElement {
  // Editing is locked when tenant is not in an active/provisioning state
  const isReadOnly = tenant.status !== "active" && tenant.status !== "provisioning";
  const [detail, setDetail] = useState<TenantBillingDetail | null>(null);
  const [drawerLoading, setDrawerLoading] = useState(true);
  const [drawerError, setDrawerError] = useState<string | null>(null);

  // Plan editor state
  const [editTier, setEditTier] = useState<string>("free");
  const [editCredits, setEditCredits] = useState<string>("25");
  const [planConfirmPending, setPlanConfirmPending] = useState(false);
  const [planSaving, setPlanSaving] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planAuditId, setPlanAuditId] = useState<string | null>(null);
  const [planToast, setPlanToast] = useState(false);

  // Entitlement state
  const [entitlements, setEntitlements] = useState<TenantEntitlement[]>([]);
  const [entitlementsLoading, setEntitlementsLoading] = useState(true);
  const [entitlementsError, setEntitlementsError] = useState<string | null>(null);
  // 5a — scope type is now selectable (domain | pack). Domain = standing license
  // to all current+future packs in the domain; pack = one specific platform set.
  const [grantScopeType, setGrantScopeType] = useState<'domain' | 'pack'>('domain');
  const [grantScopeId, setGrantScopeId] = useState('');
  const [grantSaving, setGrantSaving] = useState(false);
  const [grantError, setGrantError] = useState<string | null>(null);
  const [grantToastAuditId, setGrantToastAuditId] = useState<string | null>(null);
  const [revokeSaving, setRevokeSaving] = useState<string | null>(null); // entitlement id being revoked
  const [revokeError, setRevokeError] = useState<string | null>(null);

  // Responsive: full-screen on mobile (≤640px), right-panel on desktop
  const [isMobile, setIsMobile] = useState<boolean>(
    typeof window !== 'undefined' ? window.matchMedia('(max-width: 640px)').matches : false
  );
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 640px)');
    const handler = (e: MediaQueryListEvent): void => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Content-scopes state (D1/D2) — for dropdown grant form
  const [contentScopes, setContentScopes] = useState<TenantContentScopes | null>(null);
  const [contentScopesError, setContentScopesError] = useState<string | null>(null);

  // Platform published packs (5a) — source for pack-scope grants. The SA session
  // operates inside the platform tenant, so this lists the master library.
  const [platformPacks, setPlatformPacks] = useState<PlatformPackOption[] | null>(null);
  const [platformPacksError, setPlatformPacksError] = useState<string | null>(null);

  const fetchEntitlements = (): void => {
    setEntitlementsLoading(true);
    setEntitlementsError(null);
    void getTenantEntitlements(tenant.id)
      .then((d) => {
        setEntitlements(d.entitlements);
      })
      .catch((err) => {
        setEntitlementsError(err instanceof AdminApiError ? err.apiError.message : "Failed to load entitlements.");
      })
      .finally(() => {
        setEntitlementsLoading(false);
      });
  };

  useEffect(() => {
    let cancelled = false;
    setDrawerLoading(true);
    setDrawerError(null);
    void getTenantBillingDetail(tenant.id)
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        setEditTier(d.tier);
        setEditCredits(d.included_credits !== null ? String(d.included_credits) : "");
      })
      .catch((err) => {
        if (cancelled) return;
        setDrawerError(err instanceof AdminApiError ? err.apiError.message : "Failed to load billing detail.");
      })
      .finally(() => {
        if (!cancelled) setDrawerLoading(false);
      });
    return () => { cancelled = true; };
  }, [tenant.id]);

  useEffect(() => {
    fetchEntitlements();
    // Also fetch content-scopes for the grant dropdown (D1/D2)
    setContentScopesError(null);
    void getTenantContentScopes(tenant.id)
      .then((s) => setContentScopes(s))
      .catch((err) => {
        setContentScopesError(err instanceof AdminApiError ? err.apiError.message : "couldn't load list — type manually");
      });
  }, [tenant.id]);

  // 5a — load platform published packs once for the pack-scope grant dropdown.
  // The master library is the SA's platform tenant, independent of the company
  // whose drawer is open, so this is mount-only.
  useEffect(() => {
    setPlatformPacksError(null);
    void listPlatformPublishedPacks()
      .then((r) => setPlatformPacks(r.packs))
      .catch((err) => {
        setPlatformPacksError(err instanceof AdminApiError ? err.apiError.message : "couldn't load question sets — type the question set id manually");
      });
  }, []);

  const isInternalTier = editTier === "internal";

  const handleGrantEntitlement = async (): Promise<void> => {
    if (!grantScopeId.trim()) return;
    setGrantSaving(true);
    setGrantError(null);
    setGrantToastAuditId(null);
    try {
      const res = await grantTenantEntitlement(tenant.id, { scopeType: grantScopeType, scopeId: grantScopeId.trim() });
      setGrantToastAuditId(res.auditId);
      setGrantScopeId('');
      setTimeout(() => setGrantToastAuditId(null), 8_000);
      fetchEntitlements();
    } catch (err) {
      setGrantError(err instanceof AdminApiError ? err.apiError.message : "Grant failed — please try again.");
    } finally {
      setGrantSaving(false);
    }
  };

  const handleRevokeEntitlement = async (ent: TenantEntitlement): Promise<void> => {
    setRevokeSaving(ent.id);
    setRevokeError(null);
    try {
      await revokeTenantEntitlement(tenant.id, { scopeType: ent.scope_type, scopeId: ent.scope_id });
      fetchEntitlements();
    } catch (err) {
      setRevokeError(err instanceof AdminApiError ? err.apiError.message : "Revoke failed — please try again.");
    } finally {
      setRevokeSaving(null);
    }
  };

  const handleSavePlan = async (): Promise<void> => {
    setPlanSaving(true);
    setPlanError(null);
    try {
      const includedCredits = isInternalTier ? null : parseInt(editCredits, 10);
      const res = await updateTenantPlan(tenant.id, {
        tier: editTier,
        includedCredits,
      });
      setPlanAuditId(res.auditId);
      setPlanToast(true);
      setPlanConfirmPending(false);
      setTimeout(() => setPlanToast(false), 8_000);
      onPlanUpdated();
    } catch (err) {
      if (err instanceof AdminApiError) {
        const code = err.apiError.details?.code as string | undefined;
        setPlanError(
          code === "INTERNAL_REQUIRES_NULL_CREDITS"
            ? "Internal tier requires credits to be blank (unlimited)."
            : code === "FINITE_TIER_REQUIRES_CREDITS"
              ? "This tier requires a finite credits value."
              : err.apiError.message,
        );
      } else {
        setPlanError("Save failed — please try again.");
      }
      setPlanConfirmPending(false);
    } finally {
      setPlanSaving(false);
    }
  };

  return (
    <div
      style={{
        // lint-fixed-allow: drawer
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.32)",
        display: "flex",
        justifyContent: "flex-end",
        zIndex: 200,
      }}
      onClick={onClose}
      role="presentation"
    >
      <div
        style={isMobile ? {
          // lint-fixed-allow: drawer
          position: "fixed",
          inset: 0,
          width: "100vw",
          height: "100dvh",
          maxWidth: "100vw",
          borderRadius: 0,
          overflowY: "auto",
          background: "var(--aiq-color-bg-base)",
          padding: "var(--aiq-space-xl)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--aiq-space-lg)",
        } : {
          width: "min(720px, 92vw)",
          height: "100%",
          overflowY: "auto",
          background: "var(--aiq-color-bg-base)",
          borderLeft: "1px solid var(--aiq-color-border)",
          padding: "var(--aiq-space-xl)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--aiq-space-lg)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drawer header — sticky on mobile so close button is always reachable */}
        <div style={{
          display: "flex",
          alignItems: "center",
          ...(isMobile ? {
            position: "sticky",
            top: 0,
            background: "var(--aiq-color-bg-base)",
            zIndex: 1,
            marginTop: "calc(-1 * var(--aiq-space-xl))",
            marginLeft: "calc(-1 * var(--aiq-space-xl))",
            marginRight: "calc(-1 * var(--aiq-space-xl))",
            padding: "var(--aiq-space-md) var(--aiq-space-xl)",
            borderBottom: "1px solid var(--aiq-color-border)",
          } : {}),
        }}>
          <div>
            <div style={{ ...META_LABEL, fontSize: 10 }}>Billing — {tenant.slug}</div>
            <h2
              className="aiq-serif"
              style={{ fontSize: 20, margin: 0, fontWeight: 400, letterSpacing: "-0.015em" }}
            >
              {tenant.name}
            </h2>
          </div>
          <span style={{ flex: 1 }} />
          <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close drawer">
            ×
          </Button>
        </div>

        {/* Read-only banner — shown when tenant is suspended or archived */}
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
            This organisation is <strong>{organisationStatusDisplay(tenant.status).label.toLowerCase()}</strong>. Configuration is read-only.
          </div>
        )}

        {drawerLoading && (
          <div style={{ display: "grid", placeItems: "center", padding: 40 }}>
            <Spinner aria-label="Loading billing detail" />
          </div>
        )}

        {drawerError && !drawerLoading && (
          <Chip>{drawerError}</Chip>
        )}

        {detail !== null && !drawerLoading && (
          <>
            {/* Read-only stats */}
            <Card>
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)", padding: "var(--aiq-space-lg)" }}>
                {/* Section heading with HelpTip — admin.platform.billing */}
                <div style={{ display: "flex", alignItems: "center" }}>
                  <HelpTip helpId="admin.platform.billing">
                    <span style={{ ...META_LABEL, fontSize: 10 }}>Usage &amp; plan</span>
                  </HelpTip>
                </div>
                <div className="aiq-admin-detail-two-col" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--aiq-space-md)" }}>
                <div>
                  <p style={{ ...META_LABEL, display: "block", fontSize: 10 }}>Tier</p>
                  <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: 14, fontWeight: 600, margin: "4px 0 0", textTransform: "capitalize" }}>
                    {planTierLabel(detail.tier)}
                  </p>
                </div>
                <div>
                  <p style={{ ...META_LABEL, display: "block", fontSize: 10 }}>Included credits</p>
                  <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: 14, fontWeight: 600, margin: "4px 0 0" }}>
                    {detail.included_credits !== null ? detail.included_credits : "Unlimited"}
                  </p>
                </div>
                <div>
                  <p style={{ ...META_LABEL, display: "block", fontSize: 10 }}>Used</p>
                  <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: 14, fontWeight: 600, margin: "4px 0 0" }}>
                    {detail.used}
                  </p>
                </div>
                <div>
                  <p style={{ ...META_LABEL, display: "block", fontSize: 10 }}>Remaining</p>
                  <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: 14, fontWeight: 600, margin: "4px 0 0" }}>
                    {detail.remaining !== null ? detail.remaining : "Unlimited"}
                  </p>
                </div>
                {detail.overage > 0 && (
                  <div>
                    <p style={{ ...META_LABEL, display: "block", fontSize: 10 }}>Overage</p>
                    <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: 14, fontWeight: 600, margin: "4px 0 0", color: "var(--aiq-color-danger, #dc2626)" }}>
                      +{detail.overage}
                    </p>
                  </div>
                )}
                <div>
                  <p style={{ ...META_LABEL, display: "block", fontSize: 10 }}>Cycle start</p>
                  <p style={{ fontFamily: "var(--aiq-font-mono)", fontSize: 12, margin: "4px 0 0", color: "var(--aiq-color-fg-muted)" }}>
                    {formatDate(detail.cycle_start)}
                    {detail.cycle_window_start ? ` · this month from ${formatDate(detail.cycle_window_start)}` : ""}
                  </p>
                </div>
                {/* FU-A9: AI-evaluated answers meter (current month) */}
                {detail.ai_answers_used !== undefined && (
                  <div>
                    <p style={{ ...META_LABEL, display: "block", fontSize: 10 }}>AI-graded answers</p>
                    <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: 14, fontWeight: 600, margin: "4px 0 0" }}>
                      {detail.ai_answers_used} / {detail.ai_answers_included ?? "no cap"}
                    </p>
                  </div>
                )}
                </div>{/* end inner grid */}
              </div>{/* end outer flex column */}
            </Card>

            {/* Recent events */}
            {detail.recent_events.length > 0 && (
              <div>
                <div style={{ ...META_LABEL, fontSize: 10, marginBottom: 8 }}>
                  Recent events ({detail.recent_events.length})
                </div>
                <div
                  style={{
                    border: "1px solid var(--aiq-color-border)",
                    borderRadius: "var(--aiq-radius-md)",
                    overflow: "hidden",
                    maxHeight: 220,
                    overflowY: "auto",
                  }}
                >
                  {detail.recent_events.map((ev) => (
                    <div
                      key={ev.id}
                      className="aiq-admin-detail-two-col"
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr 1fr",
                        gap: 8,
                        padding: "8px 12px",
                        borderBottom: "1px solid var(--aiq-color-border)",
                        fontSize: 11,
                        fontFamily: "var(--aiq-font-mono)",
                        color: "var(--aiq-color-fg-muted)",
                      }}
                    >
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={ev.attempt_id}>
                        {ev.attempt_id.slice(0, 8)}…
                      </span>
                      <span style={{ textAlign: "right" }}>
                        {formatDate(ev.occurred_at)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* CSV download */}
            <div>
              <a
                href={tenantBillingCsvUrl(tenant.id)}
                download
                style={{
                  fontFamily: "var(--aiq-font-sans)",
                  fontSize: 13,
                  color: "var(--aiq-color-accent)",
                  textDecoration: "underline",
                  cursor: "pointer",
                }}
              >
                Download CSV
              </a>
            </div>

            {/* Plan editor */}
            <Card>
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)", padding: "var(--aiq-space-lg)" }}>
                <div style={{ ...META_LABEL, fontSize: 10 }}>Edit plan</div>

                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <label
                    htmlFor={`tier-select-${tenant.id}`}
                    style={{ fontFamily: "var(--aiq-font-sans)", fontSize: 12, fontWeight: 500 }}
                  >
                    Tier
                  </label>
                  <select
                    id={`tier-select-${tenant.id}`}
                    value={editTier}
                    onChange={(e) => {
                      setEditTier(e.target.value);
                      if (e.target.value === "internal") setEditCredits("");
                      setPlanError(null);
                    }}
                    style={{
                      fontFamily: "var(--aiq-font-sans)",
                      fontSize: 13,
                      padding: "6px 10px",
                      borderRadius: "var(--aiq-radius-md)",
                      border: "1px solid var(--aiq-color-border)",
                      background: "var(--aiq-color-bg-raised)",
                      color: "var(--aiq-color-fg-primary)",
                      width: "100%",
                    }}
                  >
                    {TIER_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <label
                    htmlFor={`credits-input-${tenant.id}`}
                    style={{ fontFamily: "var(--aiq-font-sans)", fontSize: 12, fontWeight: 500 }}
                  >
                    Included credits {isInternalTier && "(disabled — internal tier is unlimited)"}
                  </label>
                  <input
                    id={`credits-input-${tenant.id}`}
                    type="number"
                    min={0}
                    value={isInternalTier ? "" : editCredits}
                    disabled={isInternalTier}
                    onChange={(e) => { setEditCredits(e.target.value); setPlanError(null); }}
                    placeholder={isInternalTier ? "Unlimited" : "e.g. 25"}
                    style={{
                      fontFamily: "var(--aiq-font-sans)",
                      fontSize: 13,
                      padding: "6px 10px",
                      borderRadius: "var(--aiq-radius-md)",
                      border: "1px solid var(--aiq-color-border)",
                      background: isInternalTier
                        ? "var(--aiq-color-bg-sunken)"
                        : "var(--aiq-color-bg-raised)",
                      color: "var(--aiq-color-fg-primary)",
                      width: "100%",
                      opacity: isInternalTier ? 0.5 : 1,
                    }}
                  />
                </div>

                {planError !== null && (
                  <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: 12, color: "var(--aiq-color-danger, #dc2626)", margin: 0 }}>
                    {planError}
                  </p>
                )}

                {planToast && planAuditId !== null && (
                  <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: 12, color: "var(--aiq-color-success, #16a34a)", margin: 0 }}>
                    Plan updated. Audit: {planAuditId}
                  </p>
                )}

                {planConfirmPending ? (
                  <div
                    style={{
                      padding: "var(--aiq-space-md)",
                      background: "var(--aiq-color-bg-sunken)",
                      borderRadius: "var(--aiq-radius-md)",
                      border: "1px solid var(--aiq-color-warning, #d97706)",
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                    }}
                  >
                    <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: 12, margin: 0 }}>
                      Update plan to <strong>{editTier}</strong>
                      {!isInternalTier ? ` / ${editCredits} credits` : " (unlimited)"}?
                      This change is audit-logged.
                    </p>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        type="button"
                        className="aiq-btn aiq-btn-primary aiq-btn-sm"
                        disabled={planSaving || isReadOnly}
                        onClick={() => void handleSavePlan()}
                      >
                        {planSaving ? "Saving…" : "Confirm"}
                      </button>
                      <button
                        type="button"
                        className="aiq-btn aiq-btn-outline aiq-btn-sm"
                        disabled={planSaving}
                        onClick={() => setPlanConfirmPending(false)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="aiq-btn aiq-btn-primary aiq-btn-sm"
                    disabled={isReadOnly}
                    onClick={() => { setPlanConfirmPending(true); setPlanError(null); }}
                  >
                    Save
                  </button>
                )}
              </div>
            </Card>
            {/* Entitlements subsection — B1 */}
            <Card>
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)", padding: "var(--aiq-space-lg)" }}>
                <div style={{ display: "flex", alignItems: "center" }}>
                  <HelpTip helpId="admin.platform.entitlements">
                    <span style={{ ...META_LABEL, fontSize: 10 }}>Entitlements</span>
                  </HelpTip>
                </div>

                {/* Active entitlements list */}
                {entitlementsLoading && (
                  <div style={{ display: "grid", placeItems: "center", padding: 16 }}>
                    <Spinner aria-label="Loading entitlements" />
                  </div>
                )}
                {entitlementsError && !entitlementsLoading && (
                  <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: 12, color: "var(--aiq-color-danger, #dc2626)", margin: 0 }}>
                    {entitlementsError}
                  </p>
                )}
                {!entitlementsLoading && !entitlementsError && (
                  <>
                    {entitlements.filter((e) => e.status === 'active').length === 0 ? (
                      <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: 12, color: "var(--aiq-color-fg-muted)", margin: 0 }}>
                        No active entitlements.
                      </p>
                    ) : (
                      <div
                        style={{
                          border: "1px solid var(--aiq-color-border)",
                          borderRadius: "var(--aiq-radius-md)",
                          overflow: "hidden",
                        }}
                      >
                        {entitlements
                          .filter((e) => e.status === 'active')
                          .map((ent) => (
                            <div
                              key={ent.id}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 8,
                                padding: "8px 12px",
                                borderBottom: "1px solid var(--aiq-color-border)",
                                fontSize: 12,
                                fontFamily: "var(--aiq-font-sans)",
                              }}
                            >
                              <span
                                style={{
                                  fontFamily: "var(--aiq-font-mono)",
                                  fontSize: 10,
                                  padding: "2px 6px",
                                  background: "var(--aiq-color-bg-sunken)",
                                  borderRadius: "var(--aiq-radius-sm)",
                                  color: "var(--aiq-color-fg-secondary)",
                                  flexShrink: 0,
                                }}
                              >
                                {grantScopeLabel(ent.scope_type)}
                              </span>
                              <span
                                style={{
                                  flex: 1,
                                  fontFamily: "var(--aiq-font-mono)",
                                  fontSize: 12,
                                  color: "var(--aiq-color-fg-primary)",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                                title={ent.scope_id}
                              >
                                {ent.scope_type === 'pack'
                                  ? (platformPacks?.find((p) => p.id === ent.scope_id)?.name ?? ent.scope_id)
                                  : ent.scope_id}
                              </span>
                              <button
                                type="button"
                                className="aiq-btn aiq-btn-outline aiq-btn-sm"
                                disabled={revokeSaving === ent.id || isReadOnly}
                                onClick={() => void handleRevokeEntitlement(ent)}
                                style={{ flexShrink: 0 }}
                              >
                                {revokeSaving === ent.id ? "Revoking…" : "Revoke"}
                              </button>
                            </div>
                          ))}
                      </div>
                    )}
                  </>
                )}

                {revokeError !== null && (
                  <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: 12, color: "var(--aiq-color-danger, #dc2626)", margin: 0 }}>
                    {revokeError}
                  </p>
                )}

                {/* Grant form — scope-type toggle (domain | single set), then scope picker (5a) */}
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 4 }}>

                  {/* 5a — scope-type toggle */}
                  <div style={{ display: "flex", gap: 6 }}>
                    {(["domain", "pack"] as const).map((st) => (
                      <button
                        key={st}
                        type="button"
                        className={`aiq-btn aiq-btn-sm ${grantScopeType === st ? "aiq-btn-primary" : "aiq-btn-outline"}`}
                        disabled={grantSaving || isReadOnly}
                        onClick={() => { setGrantScopeType(st); setGrantScopeId(""); setGrantError(null); }}
                      >
                        {st === "domain" ? "Subject" : "Single set"}
                      </button>
                    ))}
                  </div>

                  <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                    <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
                      <label
                        style={{ fontFamily: "var(--aiq-font-sans)", fontSize: 12, fontWeight: 500 }}
                      >
                        {grantScopeType === "domain" ? "Subject" : "Question set"}
                      </label>

                      {grantScopeType === "domain" ? (
                        /* D2: dropdown from content-scopes when available; fallback to free-text */
                        contentScopes !== null && !contentScopesError ? (
                          <select
                            value={grantScopeId}
                            onChange={(e) => { setGrantScopeId(e.target.value); setGrantError(null); }}
                            disabled={grantSaving}
                            style={{
                              fontFamily: "var(--aiq-font-mono)",
                              fontSize: 12,
                              padding: "5px 8px",
                              borderRadius: "var(--aiq-radius-md)",
                              border: "1px solid var(--aiq-color-border)",
                              background: "var(--aiq-color-bg-raised)",
                              color: "var(--aiq-color-fg-primary)",
                              width: "100%",
                            }}
                          >
                            <option value="">— Select subject —</option>
                            {contentScopes.domains
                              .filter((d) => !entitlements.some((e) => e.status === 'active' && e.scope_type === 'domain' && e.scope_id === d))
                              .map((d) => <option key={d} value={d}>{d}</option>)
                            }
                          </select>
                        ) : (
                          <>
                            <input
                              type="text"
                              value={grantScopeId}
                              onChange={(e) => { setGrantScopeId(e.target.value); setGrantError(null); }}
                              placeholder="e.g. soc"
                              disabled={grantSaving}
                              style={{
                                fontFamily: "var(--aiq-font-mono)",
                                fontSize: 12,
                                padding: "5px 8px",
                                borderRadius: "var(--aiq-radius-md)",
                                border: "1px solid var(--aiq-color-border)",
                                background: "var(--aiq-color-bg-raised)",
                                color: "var(--aiq-color-fg-primary)",
                                width: "100%",
                              }}
                            />
                            {contentScopesError !== null && (
                              <span style={{ fontFamily: "var(--aiq-font-sans)", fontSize: 10, color: "var(--aiq-color-fg-muted)" }}>
                                {contentScopesError}
                              </span>
                            )}
                          </>
                        )
                      ) : (
                        /* 5a — pack scope: platform published packs (scope_id = platform pack id) */
                        platformPacks !== null && !platformPacksError ? (
                          <select
                            value={grantScopeId}
                            onChange={(e) => { setGrantScopeId(e.target.value); setGrantError(null); }}
                            disabled={grantSaving}
                            style={{
                              fontFamily: "var(--aiq-font-mono)",
                              fontSize: 12,
                              padding: "5px 8px",
                              borderRadius: "var(--aiq-radius-md)",
                              border: "1px solid var(--aiq-color-border)",
                              background: "var(--aiq-color-bg-raised)",
                              color: "var(--aiq-color-fg-primary)",
                              width: "100%",
                            }}
                          >
                            <option value="">— Select set —</option>
                            {platformPacks
                              .filter((p) => !entitlements.some((e) => e.status === 'active' && e.scope_type === 'pack' && e.scope_id === p.id))
                              .map((p) => <option key={p.id} value={p.id}>{p.name} · {p.domain}</option>)
                            }
                          </select>
                        ) : (
                          <>
                            <input
                              type="text"
                              value={grantScopeId}
                              onChange={(e) => { setGrantScopeId(e.target.value); setGrantError(null); }}
                              placeholder="platform question set id (UUID)"
                              disabled={grantSaving}
                              style={{
                                fontFamily: "var(--aiq-font-mono)",
                                fontSize: 12,
                                padding: "5px 8px",
                                borderRadius: "var(--aiq-radius-md)",
                                border: "1px solid var(--aiq-color-border)",
                                background: "var(--aiq-color-bg-raised)",
                                color: "var(--aiq-color-fg-primary)",
                                width: "100%",
                              }}
                            />
                            {platformPacksError !== null && (
                              <span style={{ fontFamily: "var(--aiq-font-sans)", fontSize: 10, color: "var(--aiq-color-fg-muted)" }}>
                                {platformPacksError}
                              </span>
                            )}
                          </>
                        )
                      )}
                    </div>
                    <button
                      type="button"
                      className="aiq-btn aiq-btn-primary aiq-btn-sm"
                      disabled={grantSaving || !grantScopeId.trim() || isReadOnly}
                      onClick={() => void handleGrantEntitlement()}
                      style={{ flexShrink: 0 }}
                    >
                      {grantSaving ? "Granting…" : "Grant"}
                    </button>
                  </div>
                  <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: 11, color: "var(--aiq-color-fg-muted)", margin: 0 }}>
                    {grantScopeType === "domain"
                      ? "Granting a subject lets this organisation use every published set in it — current and future."
                      : "Granting a single set licenses only that one published platform set. Use a subject grant to cover the whole subject."}
                  </p>

                  {grantError !== null && (
                    <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: 12, color: "var(--aiq-color-danger, #dc2626)", margin: 0 }}>
                      {grantError}
                    </p>
                  )}

                  {grantToastAuditId !== null && (
                    <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: 12, color: "var(--aiq-color-success, #16a34a)", margin: 0 }}>
                      Granted. Audit: {grantToastAuditId}
                    </p>
                  )}
                </div>
              </div>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

