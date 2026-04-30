import { forwardRef } from "react";
import type { ButtonHTMLAttributes } from "react";
import type { IconName } from "./Icon";
import { Icon } from "./Icon";

export type ButtonVariant = "primary" | "outline" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "size"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  leftIcon?: IconName;
  rightIcon?: IconName;
  loading?: boolean;
  "data-test-id"?: string;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "aiq-btn-primary",
  outline: "aiq-btn-outline",
  ghost: "aiq-btn-ghost",
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: "aiq-btn-sm",
  md: "",
  lg: "aiq-btn-lg",
};

const ICON_SIZE: Record<ButtonSize, number> = {
  sm: 12,
  md: 14,
  lg: 16,
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(props, ref) {
    const {
      variant = "primary",
      size = "md",
      leftIcon,
      rightIcon,
      loading = false,
      disabled,
      className,
      children,
      type = "button",
      ...rest
    } = props;

    const isDisabled = disabled === true || loading;
    const iconSize = ICON_SIZE[size];
    const variantClass = VARIANT_CLASS[variant];
    const sizeClass = SIZE_CLASS[size];

    const composedClassName = ["aiq-btn", variantClass, sizeClass, className]
      .filter(Boolean)
      .join(" ");

    return (
      <button
        {...rest}
        ref={ref}
        type={type}
        disabled={isDisabled}
        aria-busy={loading ? "true" : undefined}
        className={composedClassName}
      >
        {loading ? (
          <span
            aria-hidden="true"
            style={{
              width: iconSize,
              height: iconSize,
              borderRadius: "50%",
              background: "currentColor",
              opacity: 0.5,
              display: "inline-block",
            }}
          />
        ) : leftIcon !== undefined ? (
          <Icon name={leftIcon} size={iconSize} aria-hidden />
        ) : null}
        {children}
        {rightIcon !== undefined ? (
          <Icon name={rightIcon} size={iconSize} aria-hidden />
        ) : null}
      </button>
    );
  },
);

Button.displayName = "Button";
