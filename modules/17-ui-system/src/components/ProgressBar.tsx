import { forwardRef } from "react";
import type { HTMLAttributes } from "react";

export type ProgressBarVariant = "accent" | "success" | "fg";
export type ProgressBarHeight = 2 | 4 | 6;

export interface ProgressBarProps
  extends Omit<
    HTMLAttributes<HTMLDivElement>,
    "role" | "aria-valuenow" | "aria-valuemin" | "aria-valuemax"
  > {
  value: number;
  max?: number;
  height?: ProgressBarHeight;
  variant?: ProgressBarVariant;
  label?: string;
  "data-test-id"?: string;
}

export const ProgressBar = forwardRef<HTMLDivElement, ProgressBarProps>(
  function ProgressBar(props, ref) {
    const {
      value,
      max = 100,
      height = 4,
      variant = "accent",
      label,
      className,
      ...rest
    } = props;

    const pct = Math.max(0, Math.min(100, (value / max) * 100));

    return (
      <div
        ref={ref}
        className={["aiq-progress-bar", className].filter(Boolean).join(" ")}
        role="progressbar"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-label={label}
        data-height={height === 4 ? undefined : String(height)}
        {...rest}
      >
        <div
          className="aiq-progress-bar-fill"
          style={{ width: `${pct}%` }}
          data-variant={variant === "accent" ? undefined : variant}
        />
      </div>
    );
  },
);

ProgressBar.displayName = "ProgressBar";
