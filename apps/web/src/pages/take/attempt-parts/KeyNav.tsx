import { useEffect } from "react";

/**
 * Z-7: P = previous, N = next question. Ignored while typing in a field, with a
 * modifier key held, or while a dialog is open (`disabled`).
 */
export function KeyNav(props: { onPrev: () => void; onNext: () => void; disabled: boolean }): null {
  const { onPrev, onNext, disabled } = props;
  useEffect(() => {
    if (disabled) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const typing =
        t !== null &&
        (t.isContentEditable ||
          /^(TEXTAREA|SELECT)$/.test(t.tagName) ||
          (t.tagName === "INPUT" && !/^(radio|checkbox|button)$/.test((t as HTMLInputElement).type)));
      if (typing) return;
      const k = e.key.toLowerCase();
      if (k === "p") onPrev();
      else if (k === "n") onNext();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [disabled, onPrev, onNext]);
  return null;
}
