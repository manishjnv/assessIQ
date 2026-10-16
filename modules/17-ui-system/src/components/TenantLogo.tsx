import type { FC } from "react";

export interface TenantLogoProps {
  /** Logo URL (or data URI). null/empty falls back to the organisation name. */
  src: string | null | undefined;
  /** Organisation name: alt text base and the text fallback. */
  name: string;
  /** Rendered height in px. Width is auto, capped at 4x the height. */
  height: number;
  /** Co-brand: append a muted "via AssessIQ" caption. */
  viaAssessIQ?: boolean;
  className?: string;
  "data-test-id"?: string;
}

export const TenantLogo: FC<TenantLogoProps> = ({
  src,
  name,
  height,
  viaAssessIQ,
  className,
  "data-test-id": dataTestId,
}) => (
  <span
    className={["aiq-tenant-logo", className].filter(Boolean).join(" ")}
    data-test-id={dataTestId}
    style={{ display: "inline-flex", alignItems: "center", gap: "var(--aiq-space-sm)", minHeight: height }}
  >
    {src ? (
      <img
        src={src}
        alt={`${name} logo`}
        style={{ height, width: "auto", maxWidth: height * 4, objectFit: "contain", display: "block" }}
      />
    ) : (
      <span>{name}</span>
    )}
    {viaAssessIQ ? (
      <span
        className="aiq-tenant-logo-via"
        style={{ color: "var(--aiq-color-fg-muted)", fontSize: "var(--aiq-text-xs)", whiteSpace: "nowrap" }}
      >
        via AssessIQ
      </span>
    ) : null}
  </span>
);

TenantLogo.displayName = "TenantLogo";
