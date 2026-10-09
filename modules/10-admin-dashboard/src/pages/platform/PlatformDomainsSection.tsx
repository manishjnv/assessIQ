// PlatformDomainsSection — split from platform.tsx (E9, no behaviour change).

import React, { useEffect, useState } from "react";
import { Button, Card, Chip, Field, Spinner } from "@assessiq/ui-system";
import { MfaStepUp } from "../../components/mfa-step-up.js";
import { AdminApiError, listPlatformDomainsApi, createPlatformDomainApi, setPlatformDomainStatusApi, type PlatformDomainItem, type CreatePlatformDomainRequest } from "../../api.js";
import { HelpTip } from "@assessiq/help-system/components";
import { META_LABEL, ROW_PADDING } from "./shared.js";

// ── Platform Domains section ──────────────────────────────────────────────────

const DOMAINS_ROW_GRID = "1fr 1.4fr 100px 110px";
const DOMAINS_ROW_GAP = 12;

type DomainCreateModalState = "form" | "mfa";
type DomainStatusModalState = "confirm" | "mfa";

interface DomainCreateFieldErrors {
  name?: string | undefined;
}

interface DomainStatusPending {
  domain: PlatformDomainItem;
  nextStatus: "active" | "archived";
}

export function PlatformDomainsSection(): React.ReactElement {
  // ── list state ──
  const [domains, setDomains] = useState<PlatformDomainItem[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [sectionToast, setSectionToast] = useState<string | null>(null);

  // ── create modal state ──
  const [showCreate, setShowCreate] = useState(false);
  const [createModalState, setCreateModalState] = useState<DomainCreateModalState>("form");
  const [createName, setCreateName] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [createFieldErrors, setCreateFieldErrors] = useState<DomainCreateFieldErrors>({});
  const [createGlobalError, setCreateGlobalError] = useState<string | null>(null);
  const [createLoading, setCreateLoading] = useState(false);

  // ── status-change modal state ──
  const [statusPending, setStatusPending] = useState<DomainStatusPending | null>(null);
  const [statusModalState, setStatusModalState] = useState<DomainStatusModalState>("confirm");
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);

  const showToast = (msg: string): void => {
    setSectionToast(msg);
    setTimeout(() => setSectionToast(null), 4000);
  };

  const fetchDomains = (): void => {
    setListLoading(true);
    setListError(null);
    void listPlatformDomainsApi()
      .then((r) => {
        const sorted = [...r.domains].sort((a, b) => a.display_order - b.display_order);
        setDomains(sorted);
      })
      .catch((err) => {
        setListError(err instanceof AdminApiError ? err.apiError.message : "Failed to load platform subjects.");
      })
      .finally(() => setListLoading(false));
  };

  useEffect(() => {
    fetchDomains();
  }, []);

  // ── Create domain ──

  const openCreate = (): void => {
    setCreateName("");
    setCreateDescription("");
    setCreateFieldErrors({});
    setCreateGlobalError(null);
    setCreateLoading(false);
    setCreateModalState("form");
    setShowCreate(true);
  };

  const closeCreate = (): void => setShowCreate(false);

  const buildCreatePayload = (): CreatePlatformDomainRequest => {
    const body: CreatePlatformDomainRequest = { name: createName.trim() };
    if (createDescription.trim()) body.description = createDescription.trim();
    return body;
  };

  const doCreate = async (): Promise<void> => {
    setCreateLoading(true);
    setCreateGlobalError(null);
    try {
      const res = await createPlatformDomainApi(buildCreatePayload());
      closeCreate();
      showToast(`Created "${res.name}" — added to ${res.propagatedTenants} organisations`);
      fetchDomains();
    } catch (err) {
      if (err instanceof AdminApiError) {
        if (err.status === 401 && /fresh totp/i.test(err.apiError.message)) {
          setCreateModalState("mfa");
        } else if (err.status === 409 && err.apiError.code === "DOMAIN_SLUG_EXISTS") {
          setCreateFieldErrors((e) => ({ ...e, name: "A platform subject with that name already exists." }));
          setCreateModalState("form");
        } else if (err.status === 400) {
          setCreateGlobalError(err.apiError.message);
          setCreateModalState("form");
        } else {
          setCreateGlobalError(err.apiError.message);
          setCreateModalState("form");
        }
      } else {
        setCreateGlobalError("Unexpected error — please try again.");
        setCreateModalState("form");
      }
    } finally {
      setCreateLoading(false);
    }
  };

  const submitCreate = async (): Promise<void> => {
    const errs: DomainCreateFieldErrors = {};
    if (!createName.trim()) errs.name = "Subject name is required.";
    setCreateFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;
    await doCreate();
  };

  const handleCreateMfaVerified = (): void => {
    setCreateModalState("form");
    void doCreate();
  };

  // ── Status change (archive / reactivate) ──

  const openStatusModal = (domain: PlatformDomainItem): void => {
    const nextStatus: "active" | "archived" = domain.status === "active" ? "archived" : "active";
    setStatusPending({ domain, nextStatus });
    setStatusModalState("confirm");
    setStatusError(null);
    setStatusLoading(false);
  };

  const closeStatusModal = (): void => setStatusPending(null);

  const doStatusChange = async (): Promise<void> => {
    if (statusPending === null) return;
    setStatusLoading(true);
    setStatusError(null);
    try {
      const res = await setPlatformDomainStatusApi(statusPending.domain.id, statusPending.nextStatus);
      closeStatusModal();
      const verb = statusPending.nextStatus === "archived" ? "Archived" : "Reactivated";
      showToast(`${verb} "${res.name}" across ${res.affectedRows} rows`);
      fetchDomains();
    } catch (err) {
      if (
        err instanceof AdminApiError &&
        err.status === 401 &&
        /fresh totp/i.test(err.apiError.message)
      ) {
        // Re-throw so the modal can catch and flip to MFA sub-state
        throw err;
      }
      setStatusError(
        err instanceof AdminApiError ? err.apiError.message : "Unexpected error — please try again.",
      );
      setStatusLoading(false);
    }
  };

  const handleStatusConfirm = async (): Promise<void> => {
    setStatusLoading(true);
    try {
      await doStatusChange();
    } catch (err) {
      if (
        err instanceof AdminApiError &&
        err.status === 401 &&
        /fresh totp/i.test(err.apiError.message)
      ) {
        setStatusModalState("mfa");
      }
    } finally {
      setStatusLoading(false);
    }
  };

  const handleStatusMfaVerified = (): void => {
    setStatusModalState("confirm");
    void doStatusChange();
  };

  return (
    <>
      {/* ── Create domain modal ── */}
      {showCreate && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.36)",
            display: "grid",
            placeItems: "center",
            zIndex: 100,
          }}
          onClick={closeCreate}
          role="presentation"
        >
          <Card
            padding="lg"
            onClick={(e) => e.stopPropagation()}
            style={{ width: "100%", maxWidth: 480 }}
          >
            <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
              <h2
                className="aiq-serif"
                style={{ fontSize: 22, margin: 0, fontWeight: 400, letterSpacing: "-0.015em" }}
              >
                {createModalState === "mfa" ? "Verify MFA" : "Add platform subject"}
              </h2>
              <span style={{ flex: 1 }} />
              <Button size="sm" variant="ghost" onClick={closeCreate} aria-label="Close">
                ×
              </Button>
            </div>

            {createModalState === "mfa" ? (
              <MfaStepUp
                prompt="Your admin MFA needs to be verified before creating a platform subject. Enter your 6-digit authenticator code to continue."
                confirmLabel="Verify & create"
                onVerified={handleCreateMfaVerified}
                onCancel={closeCreate}
              />
            ) : (
              <>
                <p
                  style={{
                    fontSize: 13,
                    color: "var(--aiq-color-fg-secondary)",
                    margin: "0 0 20px",
                    lineHeight: 1.5,
                  }}
                >
                  Create a subject shared across every organisation. A URL slug is generated automatically.
                </p>

                {createGlobalError && (
                  <div style={{ marginBottom: 16 }}>
                    <Chip>{createGlobalError}</Chip>
                  </div>
                )}

                <div style={{ display: "grid", gap: 16 }}>
                  <div data-help-id="admin.platform.domain_name">
                    <Field
                      label="Subject name"
                      placeholder="e.g. Security Operations"
                      value={createName}
                      onChange={(e) => {
                        setCreateName(e.target.value);
                        setCreateFieldErrors((fe) => ({ ...fe, name: undefined }));
                      }}
                      {...(createFieldErrors.name ? { error: createFieldErrors.name } : {})}
                    />
                    <span
                      style={{
                        ...META_LABEL,
                        display: "block",
                        marginTop: 4,
                        fontSize: 10,
                      }}
                    >
                      The URL slug is generated automatically and shared across all organisations.
                    </span>
                  </div>

                  <div>
                    <Field
                      label="Description (optional)"
                      placeholder="Brief description of this subject"
                      value={createDescription}
                      onChange={(e) => setCreateDescription(e.target.value)}
                    />
                  </div>
                </div>

                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 24 }}>
                  <Button variant="ghost" onClick={closeCreate}>
                    Cancel
                  </Button>
                  <Button
                    leftIcon="plus"
                    onClick={() => void submitCreate()}
                    loading={createLoading}
                  >
                    Create subject
                  </Button>
                </div>
              </>
            )}
          </Card>
        </div>
      )}

      {/* ── Archive / reactivate confirm modal ── */}
      {statusPending !== null && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.36)",
            display: "grid",
            placeItems: "center",
            zIndex: 100,
          }}
          onClick={closeStatusModal}
          role="presentation"
        >
          <Card
            padding="lg"
            onClick={(e) => e.stopPropagation()}
            style={{ width: "100%", maxWidth: 480 }}
          >
            <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
              <h2
                className="aiq-serif"
                style={{ fontSize: 22, margin: 0, fontWeight: 400, letterSpacing: "-0.015em" }}
              >
                {statusModalState === "mfa"
                  ? "Verify MFA"
                  : statusPending.nextStatus === "archived"
                    ? `Archive "${statusPending.domain.name}"?`
                    : `Reactivate "${statusPending.domain.name}"?`}
              </h2>
              <span style={{ flex: 1 }} />
              <Button size="sm" variant="ghost" onClick={closeStatusModal} aria-label="Close" disabled={statusLoading}>
                ×
              </Button>
            </div>

            {statusModalState === "mfa" ? (
              <MfaStepUp
                prompt={`Your admin MFA needs to be re-verified before you can ${statusPending.nextStatus === "archived" ? "archive" : "reactivate"} this subject. Enter your 6-digit authenticator code to continue.`}
                confirmLabel={statusPending.nextStatus === "archived" ? "Verify & archive" : "Verify & reactivate"}
                onVerified={handleStatusMfaVerified}
                onCancel={closeStatusModal}
              />
            ) : (
              <>
                <p
                  style={{
                    fontSize: 13,
                    color: "var(--aiq-color-fg-secondary)",
                    margin: "0 0 20px",
                    lineHeight: 1.5,
                  }}
                >
                  {statusPending.nextStatus === "archived"
                    ? `Archive "${statusPending.domain.name}"? It will disappear from every organisation's subject pickers and become non-grantable. Existing licenses and tagged questions are unaffected. You can reactivate it later.`
                    : `Reactivate "${statusPending.domain.name}"? It will reappear in every organisation's subject pickers.`}
                </p>

                {statusError && (
                  <div style={{ marginBottom: 16 }}>
                    <Chip>{statusError}</Chip>
                  </div>
                )}

                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <Button variant="ghost" onClick={closeStatusModal} disabled={statusLoading}>
                    Cancel
                  </Button>
                  <Button
                    onClick={() => void handleStatusConfirm()}
                    loading={statusLoading}
                  >
                    {statusPending.nextStatus === "archived" ? "Archive" : "Reactivate"}
                  </Button>
                </div>
              </>
            )}
          </Card>
        </div>
      )}

      {/* ── Section body ── */}
      <div>
        {/* Heading row */}
        <div style={{ display: "flex", alignItems: "flex-end", marginBottom: 16 }}>
          <div>
            <div style={{ marginBottom: 12 }}>
              <Chip leftIcon="grid">{domains.length} subjects</Chip>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <h2
                style={{
                  fontFamily: "var(--aiq-font-serif)",
                  fontSize: "var(--aiq-text-2xl)",
                  fontWeight: 400,
                  margin: 0,
                  letterSpacing: "-0.02em",
                }}
              >
                Platform subjects.
              </h2>
              <HelpTip helpId="admin.platform.domains">
                <span style={{ ...META_LABEL, fontSize: 10 }}>Subjects</span>
              </HelpTip>
            </div>
            <p
              style={{
                fontSize: 14,
                color: "var(--aiq-color-fg-secondary)",
                margin: "8px 0 0",
                maxWidth: 520,
                lineHeight: 1.5,
              }}
            >
              Create or archive subjects shared across every organisation. Archiving hides a subject everywhere; existing licenses keep working.
            </p>
          </div>
          <span style={{ flex: 1 }} />
          <Button leftIcon="plus" onClick={openCreate}>
            Add subject
          </Button>
        </div>

        {/* Toast / error slots */}
        {listError && (
          <div style={{ marginBottom: 16 }}>
            <Chip>{listError}</Chip>
          </div>
        )}
        {sectionToast && (
          <div style={{ marginBottom: 16 }}>
            <Chip variant="success">{sectionToast}</Chip>
          </div>
        )}

        {/* Table / loading / empty */}
        {listLoading ? (
          <div style={{ display: "grid", placeItems: "center", padding: "var(--aiq-space-3xl) 0" }}>
            <Spinner aria-label="Loading subjects" />
          </div>
        ) : domains.length === 0 ? (
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
              No platform subjects yet.
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
              Add a subject to share it across every organisation.
            </p>
            <Button leftIcon="plus" onClick={openCreate}>
              Add subject
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
                gridTemplateColumns: DOMAINS_ROW_GRID,
                gap: DOMAINS_ROW_GAP,
                padding: "12px 20px",
                background: "var(--aiq-color-bg-raised)",
                borderBottom: "1px solid var(--aiq-color-border)",
                ...META_LABEL,
                fontSize: 10,
              }}
            >
              <span>Subject</span>
              <span>Slug</span>
              <span>Status</span>
              <span></span>
            </div>

            {domains.map((d, i) => {
              const isArchived = d.status === "archived";
              return (
                <div
                  key={d.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: DOMAINS_ROW_GRID,
                    gap: DOMAINS_ROW_GAP,
                    padding: ROW_PADDING,
                    alignItems: "center",
                    borderTop: i === 0 ? "none" : "1px solid var(--aiq-color-border)",
                    background: i % 2 === 1 ? "var(--aiq-color-bg-raised)" : "transparent",
                    opacity: isArchived ? 0.7 : 1,
                  }}
                >
                  {/* Name */}
                  <span style={{ fontSize: 14, fontWeight: 500, color: "var(--aiq-color-fg-primary)" }}>
                    {d.name}
                  </span>
                  {/* Slug — mono, strikethrough when archived */}
                  <span
                    style={{
                      fontFamily: "var(--aiq-font-mono)",
                      fontSize: 12,
                      color: "var(--aiq-color-fg-secondary)",
                      textDecoration: isArchived ? "line-through" : "none",
                    }}
                  >
                    {d.slug}
                  </span>
                  {/* Status chip */}
                  <span>
                    <Chip>{isArchived ? "Archived" : "Active"}</Chip>
                  </span>
                  {/* Action */}
                  <div style={{ display: "flex", justifyContent: "flex-end" }}>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => openStatusModal(d)}
                    >
                      {isArchived ? "Reactivate" : "Archive"}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
