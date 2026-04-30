import { useEffect, useState } from "react";

export interface UseCountUpOptions {
  duration?: number; // ms, default 1400
  start?: boolean;   // default true; when false, value stays at 0
}

/**
 * Animates a number from 0 to `target` over `duration` using cubic-out easing.
 * Respects `prefers-reduced-motion`: returns `target` immediately when reduced.
 * Cleans up the RAF on unmount and re-runs when `target` / `duration` / `start` change.
 */
export function useCountUp(target: number, opts?: UseCountUpOptions): number {
  const { duration = 1400, start = true } = opts ?? {};

  const prefersReducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  const [value, setValue] = useState<number>(prefersReducedMotion ? target : 0);

  useEffect(() => {
    if (prefersReducedMotion) {
      setValue(target);
      return;
    }

    if (!start) {
      setValue(0);
      return;
    }

    let raf: number;
    let t0: number | undefined;

    const step = (t: number) => {
      if (t0 === undefined) t0 = t;
      const p = Math.min(1, (t - t0) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setValue(Math.round(target * eased));
      if (p < 1) raf = requestAnimationFrame(step);
    };

    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration, start, prefersReducedMotion]);

  return value;
}
