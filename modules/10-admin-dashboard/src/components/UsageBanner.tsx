// AssessIQ — UsageBanner component (Phase A2).
//
// Slim full-width banner shown to company admins when their usage is at or
// near their plan's included-credits limit.
//
// Behaviour:
//   - Calls GET /api/billing/usage on mount.
//   - Renders nothing while loading, on error, or when status === 'unlimited'.
//   - Soft enforcement only — never blocks the page or shows a modal.
//   - Three states: ok (green/subtle), warn (amber), over (red).
//
// Placement: just under the page header block in dashboard.tsx + assessments.tsx.
//
// INVARIANTS:
//   - No claude/anthropic imports.
//   - No new @assessiq/ui-system primitives (uses existing Chip/Icon).
//   - Fail-silent on fetch error (never break the page).

import React from "react";
import { Chip, Icon } from "@assessiq/ui-system";
import type { CompanyUsage } from "../api.js";
import { useCompanyUsage } from "../hooks/useCompanyUsage.js";
import { creditLevel, ledgerNumbers } from "./CreditPill.js";

// ---------------------------------------------------------------------------
// Shared helper — exported so billing.tsx card can reuse it
// ---------------------------------------------------------------------------

/**
 * usageMessage — pure helper that returns the banner text + accent colour
 * for a given CompanyUsage object.
 *
 * Returns null when status === 'unlimited' (no banner needed).
 */
export function usageMessage(
  usage: CompanyUsage,
): { text: string; color: string } | null {
  const { used, included_credits, overage, status } = usage;

  if (status === "unlimited") return null;

  if (status === "ok") {
    return {
      text: `${used} of ${included_credits ?? "—"} assessment credits used.`,
      color: "var(--aiq-color-fg-muted)",
    };
  }

  if (status === "warn") {
    const pct =
      included_credits !== null && included_credits > 0
        ? Math.round((used / included_credits) * 100)
        : 0;
    return {
      text: `You've used ${used} of ${included_credits ?? "—"} assessment credits (${pct}%). Contact your platform operator to add more.`,
      color: "var(--aiq-color-warning, #d97706)",
    };
  }

  // over
  return {
    text: `You're over your plan: ${used} used, ${included_credits ?? "—"} included (${overage} over). Grading still works — contact your platform operator.`,
    color: "var(--aiq-color-danger, #dc2626)",
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function UsageBanner(): React.ReactElement | null {
  // Z-156: shown only when credits are low or out (warning icon). Fail-silent on a failed read.
  const { usage } = useCompanyUsage();
  if (usage === null) return null;

  // With a ledger the banner follows the pill (available / total_granted); without one, the plan meter decides.
  const ledger = ledgerNumbers(usage);
  const level = ledger !== null ? creditLevel(ledger) : usage.status === "over" ? "zero" : usage.status === "warn" ? "low" : "normal";
  if (level === "normal") return null;
  const planMsg = usageMessage(usage);
  const msg =
    ledger !== null
      ? {
          text:
            level === "zero"
              ? "You are out of credits. Contact your platform operator to add more."
              : `Only ${ledger.available} of ${ledger.total} credits are left. Contact your platform operator to add more.`,
          color: level === "zero" ? "var(--aiq-color-danger, #dc2626)" : "var(--aiq-color-warning, #d97706)",
        }
      : planMsg;
  if (msg === null) return null;
  const out = level === "zero";
  const iconName = "flag";

  return (
    <div
      data-help-id="admin.settings.billing.usage"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--aiq-space-sm)",
        padding: "10px var(--aiq-space-lg)",
        borderRadius: "var(--aiq-radius-md)",
        background:
          out
            ? "var(--aiq-color-danger-soft, rgba(220,38,38,0.08))"
            : "var(--aiq-color-warning-soft, rgba(217,119,6,0.08))",
        border: `1px solid ${msg.color}`,
        marginBottom: "var(--aiq-space-sm)",
      }}
    >
      <Icon name={iconName} size={15} color={msg.color} />
      <span
        style={{
          fontFamily: "var(--aiq-font-sans)",
          fontSize: "var(--aiq-text-sm)",
          color: msg.color,
          lineHeight: 1.4,
        }}
      >
        {msg.text}
      </span>
      <span style={{ marginLeft: "auto" }}>
        <Chip variant={out ? "warn" : "default"} style={{ fontSize: 11 }}>
          {out ? "Out of credits" : "Running low"}
        </Chip>
      </span>
    </div>
  );
}
