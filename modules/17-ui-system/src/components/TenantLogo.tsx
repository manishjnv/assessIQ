import type { FC } from "react";

export interface TenantLogoProps {
  /** Logo URL (or data URI). null/empty falls back to the organisation name. */
  src: string | null | undefined;
  /** Organisation name: alt text base and the text fallback. */
  name: string;
  /** Rendered height in px. Width is auto, capped at 4x the height. */
  height: number;
  /** Co-brand: append a muted "via AssessIQ" caption. Used on certificates and the verify page only. */
  viaAssessIQ?: boolean;
  /**
   * Show the name next to the logo. The logo alt text is then empty so the
   * name is not read twice. Without a logo the name always shows.
   */
  showName?: boolean;
  className?: string;
  "data-test-id"?: string;
}

export const TenantLogo: FC<TenantLogoProps> = ({
  src,
  name,
  height,
  viaAssessIQ,
  showName,
  className,
  "data-test-id": dataTestId,
}) => (
  <span
    className={["aiq-tenant-logo", className].filter(Boolean).join(" ")}
    data-test-id={dataTestId}
    style={{ display: "inline-flex", alignItems: "center", gap: "var(--aiq-space-sm)", minHeight: height, minWidth: 0 }}
  >
    {src ? (
      <img
        src={src}
        alt={showName ? "" : `${name} logo`}
        style={{ height, width: "auto", maxWidth: height * 4, objectFit: "contain", display: "block", flexShrink: 0 }}
      />
    ) : null}
    {!src || showName ? (
      <span
        title={name}
        style={
          showName
            ? { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }
            : undefined
        }
      >
        {name}
      </span>
    ) : null}
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
