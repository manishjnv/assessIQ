// AssessIQ - Z-156: credit pill in the top bar ("available / total granted").
// One number everywhere: reads the shared useCompanyUsage() hook (Z-149). Hidden for super admin, unlimited
// plans, tenants without a ledger and while loading or after a failed read. Click opens the Plan and usage tab.

import React from "react";
import { useNavigate } from "react-router";
import { Icon } from "@assessiq/ui-system";
import { useCompanyUsage } from "../hooks/useCompanyUsage.js";
import { useAdminSession } from "../session.js";
import type { CompanyUsage } from "../api.js";

export type CreditLevel = "normal" | "low" | "zero";

/** Ledger numbers for the pill and banner, or null when the plan is unlimited or has no ledger. */
export function ledgerNumbers(usage: CompanyUsage): { available: number; total: number; held: number; heldInvites: number; used: number } | null {
  const c = usage.credits;
  if (c === undefined || c.unlimited || !c.has_grants || typeof c.available !== "number" || typeof c.total_granted !== "number") return null;
  return { available: c.available, total: c.total_granted, held: c.held ?? 0, heldInvites: c.held_invites ?? 0, used: c.used_this_month ?? 0 };
}

/** zero: nothing left. low: 20% or less of what was granted. */
export function creditLevel(n: { available: number; total: number }): CreditLevel {
  if (n.available <= 0) return "zero";
  return n.total > 0 && n.available / n.total <= 0.2 ? "low" : "normal";
}

const COLOR: Record<CreditLevel, string> = {
  normal: "var(--aiq-color-fg-primary)",
  low: "color-mix(in oklch, var(--aiq-color-warning) 40%, black)",
  zero: "color-mix(in oklch, var(--aiq-color-danger) 60%, black)",
};
const BG: Record<CreditLevel, string> = {
  normal: "var(--aiq-color-bg-raised)",
  low: "var(--aiq-color-warning-soft)",
  zero: "var(--aiq-color-danger-soft, rgba(220,38,38,0.08))",
};

export function CreditPill(): React.ReactElement | null {
  const { usage } = useCompanyUsage();
  const { session } = useAdminSession();
  const navigate = useNavigate();
  if (session?.user.role === "super_admin" || usage === null) return null;
  const n = ledgerNumbers(usage);
  if (n === null) return null;
  const level = creditLevel(n);
  const tip = `${n.available} available. ${n.held} reserved for ${n.heldInvites} invited students. ${n.used} used this month.`;
  return (
    <button
      type="button"
      className="aiq-chip"
      data-help-id="admin.shell.credit_pill"
      data-testid="credit-pill"
      data-level={level}
      title={tip}
      aria-label={`Credits: ${n.available} of ${n.total}. ${tip} Open plan and usage.`}
      onClick={() => navigate("/admin/settings?tab=plan")}
      style={{ cursor: "pointer", color: COLOR[level], background: BG[level], fontWeight: 600 }}
    >
      {level !== "normal" && <Icon name="flag" size={10} aria-hidden />}
      <span className="aiq-tabular">{n.available} / {n.total}</span>
    </button>
  );
}
