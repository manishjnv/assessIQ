import type { FC, HTMLAttributes } from "react";

export interface LogoProps extends HTMLAttributes<HTMLDivElement> {
  size?: number;
  showWordmark?: boolean;
  /**
   * When set, the mark renders inside a plain `<a href>` (full-page navigation)
   * named "AssessIQ home". Owner order 2026-11-10: the logo leads home everywhere
   * except the live timed attempt. Unset = unchanged non-link mark.
   */
  href?: string;
  "data-test-id"?: string;
}

export const Logo: FC<LogoProps> = ({
  size,
  showWordmark,
  href,
  className,
  style,
  "aria-label": ariaLabel,
  ...rest
}) => {
  const mergedStyle =
    size !== undefined
      ? { fontSize: size, ...style }
      : style !== undefined
        ? { ...style }
        : undefined;
  const cls = ["aiq-mark", className].filter(Boolean).join(" ");
  const inner = (
    <>
      <span className="aiq-mark-dot" aria-hidden="true" />
      {showWordmark !== false ? <span>AssessIQ</span> : null}
    </>
  );

  if (href !== undefined) {
    return (
      <a
        href={href}
        className={cls}
        {...(mergedStyle !== undefined ? { style: mergedStyle } : {})}
        aria-label={ariaLabel ?? "AssessIQ home"}
        {...(rest as HTMLAttributes<HTMLAnchorElement>)}
      >
        {inner}
      </a>
    );
  }

  return (
    <div
      className={cls}
      {...(mergedStyle !== undefined ? { style: mergedStyle } : {})}
      aria-label={ariaLabel ?? "AssessIQ"}
      role="img"
      {...rest}
    >
      {inner}
    </div>
  );
};

Logo.displayName = "Logo";
