import { forwardRef } from "react";
import type { HTMLAttributes } from "react";

export type SpinnerSize = "sm" | "md" | "lg";

export interface SpinnerProps extends Omit<HTMLAttributes<HTMLSpanElement>, "aria-label"> {
  size?: SpinnerSize;
  "aria-label"?: string;
  "data-test-id"?: string;
}

export const Spinner = forwardRef<HTMLSpanElement, SpinnerProps>(
  function Spinner(props, ref) {
    const {
      size = "md",
      "aria-label": ariaLabel,
      className,
      ...rest
    } = props;

    const sizeClass =
      size === "sm"
        ? "aiq-spinner-sm"
        : size === "lg"
          ? "aiq-spinner-lg"
          : "";

    const composedClassName = ["aiq-spinner", sizeClass, className]
      .filter(Boolean)
      .join(" ");

    return (
      <span
        ref={ref}
        role="status"
        aria-live="polite"
        aria-label={ariaLabel ?? "Loading"}
        className={composedClassName}
        {...rest}
      />
    );
  },
);

Spinner.displayName = "Spinner";
