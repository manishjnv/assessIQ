import { forwardRef } from "react";
import type { HTMLAttributes } from "react";
import type { IconName } from "./Icon";
import { Icon } from "./Icon";

export type ChipVariant = "default" | "accent" | "success";

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: ChipVariant;
  leftIcon?: IconName;
  "data-test-id"?: string;
}

export const Chip = forwardRef<HTMLSpanElement, ChipProps>(
  function Chip(props, ref) {
    const {
      variant = "default",
      leftIcon,
      className,
      children,
      ...rest
    } = props;

    const variantClass =
      variant === "accent"
        ? "aiq-chip-accent"
        : variant === "success"
          ? "aiq-chip-success"
          : "";

    const composedClassName = ["aiq-chip", variantClass, className]
      .filter(Boolean)
      .join(" ");

    // If leftIcon is explicitly provided, use it.
    // Else if variant is "success", default to "check" per branding §8.2.
    // Else no icon.
    const resolvedIcon: IconName | undefined =
      leftIcon !== undefined
        ? leftIcon
        : variant === "success"
          ? "check"
          : undefined;

    return (
      <span ref={ref} className={composedClassName} {...rest}>
        {resolvedIcon !== undefined ? (
          <Icon name={resolvedIcon} size={10} aria-hidden />
        ) : null}
        {children}
      </span>
    );
  },
);

Chip.displayName = "Chip";
