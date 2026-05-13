import { forwardRef } from "react";
import type { HTMLAttributes } from "react";

export interface PlaceholderProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  caption?: string;
  "data-test-id"?: string;
}

export const Placeholder = forwardRef<HTMLDivElement, PlaceholderProps>(
  function Placeholder(props, ref) {
    const { width = "100%", height = 200, radius, caption, className, style, ...rest } = props;

    return (
      <div
        ref={ref}
        className={["aiq-placeholder", className].filter(Boolean).join(" ")}
        style={{
          width,
          height,
          ...(radius !== undefined ? { borderRadius: radius } : {}),
          ...style,
        }}
        role="img"
        aria-label={caption ?? "image"}
        {...rest}
      >
        {caption ?? "image"}
      </div>
    );
  },
);

Placeholder.displayName = "Placeholder";
