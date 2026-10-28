import { useEffect, useState } from "react";

/** True while the viewport is at most `px` wide. False where matchMedia is missing (tests, SSR). */
export function useMaxWidth(px: number): boolean {
  const query = `(max-width: ${px}px)`;
  const read = (): boolean => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  const [match, setMatch] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const on = (): void => setMatch(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return match;
}
