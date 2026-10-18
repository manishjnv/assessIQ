import { useEffect, useState } from "react";

const STORE_KEY = "aiq.take.keyShortcuts";

/** WCAG 2.1.4 (Z-41): P and N can be switched off. Kept per browser; default ON. */
export function useKeyShortcuts(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(STORE_KEY) !== "off";
    } catch {
      return true;
    }
  });
  return [
    on,
    (v: boolean): void => {
      setOn(v);
      try {
        window.localStorage.setItem(STORE_KEY, v ? "on" : "off");
      } catch {
        /* storage blocked: the choice lasts for this page view only */
      }
    },
  ];
}

export function KeyShortcutsToggle(props: { on: boolean; onChange: (on: boolean) => void }): React.JSX.Element {
  return (
    <label
      data-help-id="candidate.attempt.key_shortcuts"
      style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}
    >
      <input type="checkbox" checked={props.on} onChange={(e) => props.onChange(e.target.checked)} />
      Keyboard shortcuts P and N
    </label>
  );
}

/**
 * Z-7: P = previous, N = next question. Ignored while typing in a field, with a
 * modifier key held, or while a dialog is open (`disabled`).
 */
export function KeyNav(props: { onPrev: () => void; onNext: () => void; disabled: boolean; enabled?: boolean }): null {
  const { onPrev, onNext, disabled, enabled = true } = props;
  useEffect(() => {
    if (disabled || !enabled) return;
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
  }, [disabled, enabled, onPrev, onNext]);
  return null;
}
