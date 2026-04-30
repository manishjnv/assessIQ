import type { FC, HTMLAttributes } from "react";

export interface LogoProps extends HTMLAttributes<HTMLDivElement> {
  size?: number;
  showWordmark?: boolean;
  "data-test-id"?: string;
}

export const Logo: FC<LogoProps> = ({
  size,
  showWordmark,
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

  return (
    <div
      className={["aiq-mark", className].filter(Boolean).join(" ")}
      {...(mergedStyle !== undefined ? { style: mergedStyle } : {})}
      aria-label={ariaLabel ?? "AssessIQ"}
      role="img"
      {...rest}
    >
      <span className="aiq-mark-dot" aria-hidden="true" />
      {showWordmark !== false ? <span>AssessIQ</span> : null}
    </div>
  );
};

Logo.displayName = "Logo";
