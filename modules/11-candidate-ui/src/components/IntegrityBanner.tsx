import { Button, Icon } from "@assessiq/ui-system";
import type { IconName } from "@assessiq/ui-system";

// ─── Public contract ────────────────────────────────────────────────────────

export type IntegrityBannerKind =
  | "multi_tab"        // another tab is open with the same attempt
  | "reconnecting"     // server save failed, retrying
  | "tab_was_blurred"  // candidate switched away and came back
  | "stale_connection"; // hard-stale > 2 min

export interface IntegrityBannerProps {
  kind: IntegrityBannerKind;
  /** Optional dismiss callback. If provided, render a close X. */
  onDismiss?: () => void;
  /** Optional primary action — e.g. "Reload page" for stale_connection. */
  action?: { label: string; onClick: () => void };
  "data-test-id"?: string;
}

// ─── Internal variant config ─────────────────────────────────────────────────

interface VariantConfig {
  icon: IconName;
  copy: string;
  borderColor: string;
  background: string;
  role: "status" | "alert";
  ariaLive: "polite" | "assertive";
}

const VARIANT_CONFIG: Record<IntegrityBannerKind, VariantConfig> = {
  multi_tab: {
    icon: "eye",
    copy: "Multiple tabs detected. Only the most recent save wins — close the other tab to avoid losing answers.",
    borderColor: "var(--aiq-color-warning)",
    // TODO(token): --aiq-color-warning-soft
    background: "oklch(0.97 0.05 70)",
    role: "status",
    ariaLive: "polite",
  },
  reconnecting: {
    icon: "bell",
    copy: "Reconnecting to the server. Your answers are queued and will save automatically.",
    borderColor: "var(--aiq-color-info)",
    background: "var(--aiq-color-bg-raised)",
    role: "status",
    ariaLive: "polite",
  },
  tab_was_blurred: {
    icon: "eye",
    copy: "You returned to the tab. Time continues server-side; check your timer.",
    borderColor: "var(--aiq-color-fg-muted)",
    background: "var(--aiq-color-bg-raised)",
    role: "status",
    ariaLive: "polite",
  },
  stale_connection: {
    icon: "bell",
    copy: "Connection has been stale for over 2 minutes. Reload to restore your saved answers.",
    borderColor: "var(--aiq-color-danger)",
    background: "var(--aiq-color-bg-raised)",
    role: "alert",
    ariaLive: "assertive",
  },
};

// ─── Component ───────────────────────────────────────────────────────────────

export function IntegrityBanner({
  kind,
  onDismiss,
  action,
  "data-test-id": testId,
}: IntegrityBannerProps) {
  const { icon, copy, borderColor, background, role, ariaLive } =
    VARIANT_CONFIG[kind];

  return (
    <div
      role={role}
      aria-live={ariaLive}
      data-test-id={testId}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--aiq-space-md)",
        padding: "var(--aiq-space-sm) var(--aiq-space-md)",
        borderRadius: "var(--aiq-radius-md)",
        border: `1px solid ${borderColor}`,
        background,
        fontFamily: "var(--aiq-font-sans)",
        fontSize: "var(--aiq-text-sm)",
      }}
    >
      {/* Leading icon */}
      <Icon
        name={icon}
        size={18}
        style={{ flexShrink: 0, color: borderColor }}
        aria-hidden
      />

      {/* Message */}
      <span style={{ flex: 1 }}>{copy}</span>

      {/* Optional primary action */}
      {action !== undefined && (
        <Button variant="outline" size="sm" onClick={action.onClick}>
          {action.label}
        </Button>
      )}

      {/* Optional dismiss */}
      {onDismiss !== undefined && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: "var(--aiq-space-2xs)",
            color: "var(--aiq-color-fg-secondary)",
            display: "flex",
            alignItems: "center",
          }}
        >
          <Icon name="close" size={14} aria-hidden />
        </button>
      )}
    </div>
  );
}

IntegrityBanner.displayName = "IntegrityBanner";
