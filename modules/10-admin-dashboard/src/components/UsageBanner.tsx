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

import React, { useEffect, useState } from "react";
import { Chip, Icon } from "@assessiq/ui-system";
import { getCompanyUsage, type CompanyUsage } from "../api.js";

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
  const [usage, setUsage] = useState<CompanyUsage | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getCompanyUsage()
      .then((u) => {
        if (!cancelled) setUsage(u);
      })
      .catch(() => {
        // Fail-silent — never break the page
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (usage === null) return null;

  const msg = usageMessage(usage);
  if (msg === null) return null;

  const iconName =
    usage.status === "over"
      ? "bell"
      : usage.status === "warn"
        ? "bell"
        : "sparkle";

  return (
    <div
      data-help-id="admin.billing.usage"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--aiq-space-sm)",
        padding: "10px var(--aiq-space-lg)",
        borderRadius: "var(--aiq-radius-md)",
        background:
          usage.status === "over"
            ? "var(--aiq-color-danger-soft, rgba(220,38,38,0.08))"
            : usage.status === "warn"
              ? "var(--aiq-color-warning-soft, rgba(217,119,6,0.08))"
              : "var(--aiq-color-bg-raised)",
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
      {usage.status !== "ok" && (
        <span style={{ marginLeft: "auto" }}>
          <Chip
            variant={usage.status === "over" ? "warn" : "default"}
            style={{ fontSize: 11 }}
          >
            {usage.status === "over" ? "Over limit" : "Near limit"}
          </Chip>
        </span>
      )}
    </div>
  );
}
