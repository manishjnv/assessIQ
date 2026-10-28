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
 * Z-7: P = previous, N = next question. Z-168: also the arrow keys, A-D / 1-5 (pick an
 * option) and F (flag). Ignored while typing in a field, with a modifier key held, or
 * while a dialog is open (`disabled`). Arrows are left to a focused radio group.
 */
export function KeyNav(props: {
  onPrev: () => void;
  onNext: () => void;
  disabled: boolean;
  enabled?: boolean;
  /** Z-168: option index 0-3 from A-D, or 0-4 from 1-5. */
  onPick?: (index: number) => void;
  onFlag?: () => void;
}): null {
  const { onPrev, onNext, disabled, enabled = true, onPick, onFlag } = props;
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
      const onRadio = t !== null && t.tagName === "INPUT" && (t as HTMLInputElement).type === "radio";
      const k = e.key.toLowerCase();
      if (k === "p") onPrev();
      else if (k === "n") onNext();
      else if (k === "arrowleft" && !onRadio) onPrev();
      else if (k === "arrowright" && !onRadio) onNext();
      else if (k === "f" && onFlag !== undefined) onFlag();
      else if (onPick !== undefined && /^[a-d]$/.test(k)) onPick(k.charCodeAt(0) - 97);
      else if (onPick !== undefined && /^[1-5]$/.test(k)) onPick(Number(k) - 1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [disabled, enabled, onPrev, onNext, onPick, onFlag]);
  return null;
}
