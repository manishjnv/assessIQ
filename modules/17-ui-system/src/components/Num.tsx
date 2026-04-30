import type React from "react";
import { useCountUp } from "../hooks/useCountUp";

export interface NumProps extends React.HTMLAttributes<HTMLSpanElement> {
  value: number;
  animate?: boolean;              // default false
  duration?: number;              // default 1400 (passed to useCountUp)
  start?: boolean;                // default true (passed to useCountUp)
  format?: (n: number) => string; // optional formatter, e.g. (n) => `${n}%`
}

export const Num: React.FC<NumProps> = ({
  value,
  animate = false,
  duration,
  start,
  format,
  className,
  ...rest
}) => {
  const opts = {
    ...(duration !== undefined ? { duration } : {}),
    ...(start !== undefined ? { start } : {}),
  };

  const animated = useCountUp(animate ? value : 0, opts);
  const raw = animate ? animated : value;
  const display = format !== undefined ? format(raw) : String(raw);

  const composedClassName = ["aiq-num", className].filter(Boolean).join(" ");

  return (
    <span className={composedClassName} {...rest}>
      {display}
    </span>
  );
};

Num.displayName = "Num";
