import React, { useState } from "react";
import { CALC_INITIAL, calcPress, keyToCalc, prettyExpr } from "../calculator-eval";

// Basic on-screen calculator for sections with `calculator: true`.
// A toggle button opens a small fixed panel. Buttons are plain <button type="button">
// (no clipboard involvement, so integrity "block copy and paste" never touches them).
// Keyboard: digits . + - * / x, Enter or =, Backspace, Esc or c to clear — handled
// ONLY while focus is inside the panel, so typing in an answer box is never hijacked.

export interface CalculatorProps {
  "data-help-id"?: string;
}

const KEYS: Array<{ label: string; key: string; kind?: "op" | "eq" | "util" }> = [
  { label: "C", key: "clear", kind: "util" },
  { label: "⌫", key: "back", kind: "util" },
  { label: "÷", key: "/", kind: "op" },
  { label: "×", key: "*", kind: "op" },
  { label: "7", key: "7" }, { label: "8", key: "8" }, { label: "9", key: "9" },
  { label: "−", key: "-", kind: "op" },
  { label: "4", key: "4" }, { label: "5", key: "5" }, { label: "6", key: "6" },
  { label: "+", key: "+", kind: "op" },
  { label: "1", key: "1" }, { label: "2", key: "2" }, { label: "3", key: "3" },
  { label: "=", key: "=", kind: "eq" },
  { label: "0", key: "0" }, { label: ".", key: "." },
];

const ARIA: Record<string, string> = {
  clear: "Clear", back: "Backspace", "/": "Divide", "*": "Multiply", "-": "Subtract",
  "+": "Add", "=": "Equals", ".": "Decimal point",
};

export function Calculator({ "data-help-id": helpId }: CalculatorProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState(CALC_INITIAL);
  const press = (k: string): void => setState((s) => calcPress(s, k));

  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls="aiq-calculator-panel"
        data-help-id={helpId}
        onClick={() => setOpen((o) => !o)}
        style={{
          border: "1px solid var(--aiq-color-border-strong)",
          background: open ? "var(--aiq-color-accent-soft)" : "transparent",
          color: "var(--aiq-color-fg-primary)",
          borderRadius: "var(--aiq-radius-pill)",
          padding: "6px 14px",
          fontFamily: "var(--aiq-font-sans)",
          fontSize: 13,
          fontWeight: 500,
          cursor: "pointer",
        }}
      >
        Calculator
      </button>
      {open && (
        <div
          id="aiq-calculator-panel"
          role="group"
          aria-label="Calculator"
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            const k = keyToCalc(e.key);
            if (k === null) return;
            e.preventDefault(); // also stops Enter from re-clicking a focused button
            press(k);
          }}
          style={{
            // lint-fixed-allow: panel (floating calculator, not a modal)
            position: "fixed",
            right: "var(--aiq-space-lg)",
            bottom: "var(--aiq-space-lg)",
            zIndex: 20,
            width: 248,
            padding: "var(--aiq-space-md)",
            background: "var(--aiq-color-bg-raised)",
            border: "1px solid var(--aiq-color-border)",
            borderRadius: "var(--aiq-radius-md)",
            boxShadow: "var(--aiq-shadow-md)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--aiq-color-fg-secondary)" }}>
              Calculator
            </span>
            <button
              type="button"
              aria-label="Close calculator"
              onClick={() => setOpen(false)}
              style={{ border: 0, background: "transparent", cursor: "pointer", fontSize: 16, color: "var(--aiq-color-fg-secondary)" }}
            >
              ×
            </button>
          </div>
          <output
            aria-live="polite"
            aria-label="Calculator display"
            data-testid="calc-display"
            style={{
              display: "block",
              minHeight: 40,
              margin: "var(--aiq-space-sm) 0",
              padding: "8px 10px",
              textAlign: "right",
              overflowX: "auto",
              whiteSpace: "nowrap",
              fontFamily: "var(--aiq-font-mono)",
              fontSize: 20,
              background: "var(--aiq-color-bg-sunken)",
              borderRadius: "var(--aiq-radius-sm)",
              color: "var(--aiq-color-fg-primary)",
            }}
          >
            {state.expr === "" ? "0" : prettyExpr(state.expr)}
          </output>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
            {KEYS.map((k) => (
              <button
                key={k.key}
                type="button"
                aria-label={ARIA[k.key] ?? k.label}
                onClick={() => press(k.key)}
                style={{
                  gridColumn: k.key === "0" ? "span 1" : undefined,
                  padding: "10px 0",
                  border: "1px solid var(--aiq-color-border)",
                  borderRadius: "var(--aiq-radius-pill)",
                  fontFamily: "var(--aiq-font-sans)",
                  fontSize: 15,
                  fontWeight: 500,
                  cursor: "pointer",
                  background: k.kind === "eq" ? "var(--aiq-color-accent)" : "var(--aiq-color-bg-base)",
                  color: k.kind === "eq" ? "#fff" : "var(--aiq-color-fg-primary)",
                }}
              >
                {k.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
