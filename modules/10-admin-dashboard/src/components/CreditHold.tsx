// AssessIQ - Z-147/Z-152: credit cost line, refusal block and "Held" chip for invitations.
// The server (assertCreditsAvailable) is the authority; these only show the numbers early.

import React from "react";
import { Chip } from "@assessiq/ui-system";
import { HelpTip } from "@assessiq/help-system/components";

/** BURN cost per invitation by type (mirror of modules/19-billing burn-rates; the server decides). */
export const INVITE_COST = { mock: 10, real: 20, real_camera: 30 } as const;

const sans: React.CSSProperties = { fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)" };

/** "N students x cost = X credits, you have Y available". Hidden when nothing is selected or the plan is unlimited. */
export function CreditCostLine(props: { count: number; cost: number; available: number | null; helpId: string }): React.ReactElement | null {
  const { count, cost, available, helpId } = props;
  if (count <= 0 || available === null) return null;
  return (
    <HelpTip helpId={helpId}>
      <p data-testid="credit-cost-line" style={{ ...sans, margin: "0 0 var(--aiq-space-sm)", color: "var(--aiq-color-fg-secondary)" }}>
        {count} student{count === 1 ? "" : "s"} x {cost} = {count * cost} credits, you have {available} available
      </p>
    </HelpTip>
  );
}

export interface CreditsRefusal { message: string; canInvite: number }

/** The CREDITS_INSUFFICIENT 409 as {message, canInvite}, or null for any other error. */
export function creditsRefusal(err: unknown): CreditsRefusal | null {
  const e = (err as { apiError?: { message?: string; details?: Record<string, unknown> } } | null)?.apiError;
  if (e?.details?.["code"] !== "CREDITS_INSUFFICIENT") return null;
  const n = e.details["canInvite"];
  return { message: e.message ?? "Not enough credits.", canInvite: typeof n === "number" ? n : 0 };
}

/** Message + "Buy credits" (opens /contact in the same tab) + optional "Invite N now". */
export function CreditsRefusalBlock(props: { refusal: CreditsRefusal; onInviteNow?: ((n: number) => void) | undefined }): React.ReactElement {
  const { refusal, onInviteNow } = props;
  return (
    <div role="alert" data-testid="credits-refusal" style={{ ...sans, color: "var(--aiq-color-danger)", marginBottom: "var(--aiq-space-sm)" }}>
      <div>{refusal.message}</div>
      <div style={{ display: "flex", gap: "var(--aiq-space-sm)", marginTop: "var(--aiq-space-xs)" }}>
        <a className="aiq-btn aiq-btn-primary aiq-btn-sm" href="/contact">Buy credits</a>
        {refusal.canInvite > 0 && onInviteNow !== undefined && (
          <button type="button" className="aiq-btn aiq-btn-outline aiq-btn-sm" onClick={() => onInviteNow(refusal.canInvite)}>
            Invite {refusal.canInvite} now
          </button>
        )}
      </div>
    </div>
  );
}

/** "Held" chip for an invitation that holds credits (pending/viewed with a live link, or started). */
export function HeldChip(): React.ReactElement {
  return (
    <HelpTip helpId="admin.assessments.invite.held">
      <span data-testid="held-chip"><Chip variant="default">Held</Chip></span>
    </HelpTip>
  );
}
