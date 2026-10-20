// Camera feature: a plain on/off switch (role="switch") in the admin token style.
import React from "react";

export function CameraSwitch({
  checked,
  onChange,
  label,
  disabled = false,
  helpId,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  helpId?: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      data-help-id={helpId}
      onClick={() => onChange(!checked)}
      style={{
        position: "relative",
        width: 40,
        height: 22,
        flexShrink: 0,
        borderRadius: 999,
        border: "1px solid var(--aiq-color-border-strong)",
        background: checked ? "var(--aiq-color-accent)" : "var(--aiq-color-bg-sunken)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
        padding: 0,
        transition: "background 120ms ease",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          top: 2,
          left: checked ? 20 : 2,
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: "var(--aiq-color-bg-raised)",
          transition: "left 120ms ease",
        }}
      />
    </button>
  );
}
