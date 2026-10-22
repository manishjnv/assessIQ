// AssessIQ — Account security page (RW-45).
//
// Route: /admin/account-security (admin + super_admin).
// Shows two-factor status. With TOTP enrolled, "Regenerate recovery codes"
// asks for a current code, then shows the new codes once.

import React, { useState } from "react";
import { Link } from "react-router";
import { Button, Card, Chip } from "@assessiq/ui-system";
import { AdminShell } from "../components/AdminShell.js";
import { PageHeader } from "../components/PageHeader.js";
import { RegenerateCodesModal } from "../components/RegenerateCodesModal.js";
import { useAdminSession } from "../session.js";

export function AdminAccountSecurity(): React.ReactElement {
  const { session, loading } = useAdminSession();
  const enrolled = session?.totpEnrolled === true;

  const [dialogOpen, setDialogOpen] = useState(false);
  const [codes, setCodes] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  const copyAll = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopied(true);
    } catch {
      // Clipboard unavailable — the person copies by hand.
    }
  };

  return (
    <AdminShell breadcrumbs={["Account security"]} helpPage="admin.account.security">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xl)" }}>
        <PageHeader
          eyebrow="Account"
          title="Account security"
          lede="Two-factor sign-in and backup codes for your account."
        />

        <Card padding="lg">
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
            <h2 style={{ margin: 0, fontSize: "var(--aiq-text-lg)", fontWeight: 500 }}>Two-factor sign-in</h2>
            {!loading && (
              <Chip variant={enrolled ? "success" : "default"}>{enrolled ? "On" : "Off"}</Chip>
            )}
          </div>

          {codes.length > 0 ? (
            <div data-help-id="admin.account.security.new_codes">
              <p style={{ margin: "0 0 12px", fontSize: 14 }}>
                These backup codes show <strong>once only</strong>. Each code works one time if you lose your authenticator app. Your old codes no longer work.
              </p>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 8,
                  padding: 16,
                  border: "1px solid var(--aiq-color-border)",
                  borderRadius: "var(--aiq-radius-md)",
                  marginBottom: 12,
                }}
              >
                {codes.map((c) => (
                  <code key={c} style={{ fontFamily: "var(--aiq-font-mono)", fontSize: 13 }}>{c}</code>
                ))}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <Button variant="outline" onClick={() => void copyAll()} data-help-id="admin.account.security.copy_codes">
                  {copied ? "Copied" : "Copy all"}
                </Button>
                <Button onClick={() => { setCodes([]); setCopied(false); }} data-help-id="admin.account.security.codes_saved">
                  I saved them
                </Button>
              </div>
            </div>
          ) : enrolled ? (
            <>
              <p style={{ margin: "0 0 12px", fontSize: 14, color: "var(--aiq-color-fg-secondary)" }}>
                Make a new set of backup codes if you lost yours. The old codes stop working.
              </p>
              <Button variant="outline" onClick={() => setDialogOpen(true)} data-help-id="admin.account.security.regenerate">
                Regenerate recovery codes
              </Button>
            </>
          ) : (
            !loading && (
              <p style={{ margin: 0, fontSize: 14, color: "var(--aiq-color-fg-secondary)" }}>
                Two-factor sign-in is off.{" "}
                <Link to="/admin/mfa" data-help-id="admin.account.security.enrol">Set up two-factor sign-in</Link>
              </p>
            )
          )}
        </Card>
      </div>

      <RegenerateCodesModal open={dialogOpen} onClose={() => setDialogOpen(false)} onCodes={setCodes} />
    </AdminShell>
  );
}
