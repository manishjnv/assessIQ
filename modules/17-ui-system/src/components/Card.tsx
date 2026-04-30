import { forwardRef } from "react";
import type { HTMLAttributes, ElementType, CSSProperties } from "react";

export type CardPadding = "none" | "sm" | "md" | "lg";

export interface CardProps extends HTMLAttributes<HTMLElement> {
  as?: "div" | "section" | "article";
  padding?: CardPadding;
  interactive?: boolean;
  floating?: boolean;
  "data-test-id"?: string;
}

const paddingMap: Record<CardPadding, string> = {
  none: "0",
  sm: "var(--aiq-space-md)",
  md: "var(--aiq-space-lg)",
  lg: "var(--aiq-space-xl)",
};

export const Card = forwardRef<HTMLElement, CardProps>(function Card(
  {
    as,
    padding = "md",
    interactive = false,
    floating = false,
    className,
    style,
    children,
    ...rest
  },
  ref,
) {
  const Tag = (as ?? "div") as ElementType;

  const paddingValue = paddingMap[padding];

  const mergedStyle: CSSProperties = {
    padding: paddingValue,
    ...(floating ? { boxShadow: "var(--aiq-shadow-lg)" } : {}),
    ...style,
  };

  return (
    <Tag
      ref={ref}
      className={["aiq-card", className].filter(Boolean).join(" ")}
      style={mergedStyle}
      {...(interactive ? { "data-interactive": "true" } : {})}
      {...rest}
    >
      {children}
    </Tag>
  );
});

Card.displayName = "Card";
