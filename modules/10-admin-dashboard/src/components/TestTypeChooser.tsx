// AssessIQ — three-card test type chooser (Z-143): Mock / Real / Real + camera.
// One component for the create form, Start a test and the draft detail page. Radiogroup ARIA
// with roving tabindex. The Mock card holds the two Mock-only integrity checkboxes and a
// `children` slot for the feedback radios (Z-145). Layout: 3 columns >= 960px, 2+1 from 640px, 1 below.

import React, { useId, useRef } from "react";
import { HelpTip } from "@assessiq/help-system/components";
import { Chip } from "@assessiq/ui-system";

export type TestType = "mock" | "real" | "real_camera";

/** assessments.delivery_mode + camera_required -> the card. */
export function toTestType(mode: "real" | "mock" | undefined, camera: boolean | undefined): TestType {
  if (mode === "mock") return "mock";
  return camera === true ? "real_camera" : "real";
}

/** The card -> the two fields the API takes. */
export function fromTestType(t: TestType): { delivery_mode: "real" | "mock"; camera_required: boolean } {
  return { delivery_mode: t === "mock" ? "mock" : "real", camera_required: t === "real_camera" };
}

export function testTypeLabel(t: TestType): string {
  return t === "mock" ? "Mock" : t === "real" ? "Real" : "Real + camera";
}

export interface ChooserCameraSettings {
  isSchool: boolean;
  cameraEnabled: boolean;
  cameraEnforced: boolean;
}

export interface TestTypeChooserProps {
  value: TestType;
  onChange: (next: TestType) => void;
  integrity: { fullscreen: boolean; blockCopyPaste: boolean };
  onIntegrityChange: (next: { fullscreen: boolean; blockCopyPaste: boolean }) => void;
  /** null while loading or on error: the camera card then stays enabled (the server still checks). */
  cameraSettings?: ChooserCameraSettings | null;
  /** After publish: only the chosen card, no controls, with a "Locked after publish" chip. */
  readOnly?: boolean;
  /** Slot inside the Mock card for the feedback radios (Z-145). */
  mockFeedbackSlot?: React.ReactNode;
}

const ORDER: TestType[] = ["mock", "real", "real_camera"];

const CARDS: Record<TestType, {
  title: string; helpId: string; cost: string; device: string; readiness: string;
  certificate: string; analytics: string; camera: string;
}> = {
  mock: {
    title: "Mock", helpId: "admin.assessments.test_type.mock", cost: "Cost: 10 credits per submitted test",
    device: "Any device", readiness: "Optional", certificate: "No", analytics: "Mock dashboard", camera: "No",
  },
  real: {
    title: "Real", helpId: "admin.assessments.test_type.real", cost: "Cost: 20 credits per submitted test",
    device: "Laptop or desktop", readiness: "Required", certificate: "Yes", analytics: "Yes", camera: "No",
  },
  real_camera: {
    title: "Real + camera", helpId: "admin.assessments.test_type.real_camera", cost: "Cost: 30 credits per submitted test",
    device: "Laptop or desktop", readiness: "Required", certificate: "Yes", analytics: "Yes", camera: "Always on",
  },
};

export const CAMERA_OFF_SCHOOL_TEXT = "Your organisation turned the camera off. Turn it on in Settings to use this type.";
export const CAMERA_OFF_PLATFORM_TEXT = "Camera is temporarily off.";
export const CHARGE_NOTE = "Charged when the student submits, or when the time runs out.";

const CSS = `
.aiq-ttc-grid{display:grid;gap:var(--aiq-space-md);grid-template-columns:1fr}
@media (min-width:640px){.aiq-ttc-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (min-width:960px){.aiq-ttc-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
.aiq-ttc-card{display:flex;flex-direction:column;min-width:0;border:1px solid var(--aiq-color-border);
  border-radius:var(--aiq-radius-md);background:var(--aiq-color-bg-base);cursor:pointer}
.aiq-ttc-card[data-selected="true"]{border-color:var(--aiq-color-accent);box-shadow:0 0 0 1px var(--aiq-color-accent);background:var(--aiq-color-accent-soft)}
.aiq-ttc-card[data-disabled="true"]{cursor:not-allowed;background:var(--aiq-color-bg-sunken)}
.aiq-ttc-card[data-readonly="true"]{cursor:default}
.aiq-ttc-radio{padding:var(--aiq-space-md);border-radius:var(--aiq-radius-md);outline:none}
.aiq-ttc-radio:focus-visible{outline:2px solid var(--aiq-color-accent);outline-offset:2px}
.aiq-ttc-extras{padding:0 var(--aiq-space-md) var(--aiq-space-md);display:flex;flex-direction:column;gap:var(--aiq-space-xs)}
`;

const sans: React.CSSProperties = { fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)" };

function Lock(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" focusable="false">
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

function Row({ label, value, locked }: { label: string; value: string; locked?: boolean }): React.ReactElement {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: "var(--aiq-space-sm)", padding: "4px 0", borderTop: "1px solid var(--aiq-color-border)" }}>
      <dt style={{ color: "var(--aiq-color-fg-muted)", display: "flex", alignItems: "center", gap: 4 }}>
        {locked === true && <Lock />}
        {label}
      </dt>
      <dd style={{ margin: 0, fontWeight: 600, textAlign: "right" }}>{value}</dd>
    </div>
  );
}

export function TestTypeChooser({
  value, onChange, integrity, onIntegrityChange, cameraSettings = null, readOnly = false, mockFeedbackSlot,
}: TestTypeChooserProps): React.ReactElement {
  const labelId = useId();
  const refs = useRef<Partial<Record<TestType, HTMLDivElement | null>>>({});

  let cameraOffText: string | null = null;
  if (cameraSettings !== null) {
    if (cameraSettings.isSchool && !cameraSettings.cameraEnabled) cameraOffText = CAMERA_OFF_SCHOOL_TEXT;
    else if (!cameraSettings.cameraEnforced) cameraOffText = CAMERA_OFF_PLATFORM_TEXT;
  }
  const disabled = (t: TestType): boolean => t === "real_camera" && cameraOffText !== null;
  const enabled = ORDER.filter((t) => !disabled(t));

  function select(t: TestType): void {
    if (readOnly || disabled(t) || t === value) return;
    onChange(t);
  }

  function onKey(e: React.KeyboardEvent, t: TestType): void {
    if (readOnly) return;
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      select(t);
      return;
    }
    const fwd = e.key === "ArrowRight" || e.key === "ArrowDown";
    const back = e.key === "ArrowLeft" || e.key === "ArrowUp";
    if (!fwd && !back) return;
    e.preventDefault();
    const i = enabled.indexOf(t);
    const next = enabled[(i + (fwd ? 1 : enabled.length - 1)) % enabled.length];
    if (next === undefined) return;
    select(next);
    refs.current[next]?.focus();
  }

  const shown = readOnly ? ORDER.filter((t) => t === value) : ORDER;
  const mockActive = value === "mock" && !readOnly;
  // Roving tabindex: the checked radio is the tab stop (or the first enabled one if none is checked).
  const tabStop: TestType = disabled(value) ? (enabled[0] ?? "real") : value;

  return (
    <div style={sans}>
      <style>{CSS}</style>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)", marginBottom: "var(--aiq-space-xs)" }}>
        <HelpTip helpId="admin.assessments.test_type">
          <span id={labelId} style={{ fontWeight: 500 }}>Test type</span>
        </HelpTip>
        {readOnly && <Chip leftIcon="check">Locked after publish</Chip>}
      </div>
      <div role="radiogroup" aria-labelledby={labelId} className="aiq-ttc-grid">
        {shown.map((t) => {
          const c = CARDS[t];
          const selected = value === t;
          const off = disabled(t);
          const isMock = t === "mock";
          const titleId = `${labelId}-${t}`;
          return (
            <div
              key={t}
              className="aiq-ttc-card"
              data-selected={selected}
              data-disabled={off}
              data-readonly={readOnly}
              data-testid={`test-type-card-${t}`}
              onClick={() => select(t)}
            >
              <div
                ref={(el) => { refs.current[t] = el; }}
                role="radio"
                aria-checked={selected}
                aria-disabled={off || readOnly}
                aria-labelledby={titleId}
                tabIndex={t === tabStop ? 0 : -1}
                className="aiq-ttc-radio"
                onKeyDown={(e) => onKey(e, t)}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--aiq-space-xs)", marginBottom: "var(--aiq-space-xs)" }}>
                  <HelpTip helpId={c.helpId}>
                    <span id={titleId} style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-xl)" }}>{c.title}</span>
                  </HelpTip>
                  {selected && <Chip variant="accent" leftIcon="check">Selected</Chip>}
                </div>
                <div style={{ fontWeight: 600, marginBottom: "var(--aiq-space-xs)" }}>{c.cost}</div>
                <dl style={{ margin: 0 }}>
                  <Row label="Device" value={c.device} />
                  <Row label="Readiness check" value={c.readiness} />
                  <Row label="Certificate" value={c.certificate} />
                  <Row label="Counts in analytics" value={c.analytics} />
                  <Row label="Camera" value={c.camera} />
                  {!isMock && <Row label="Full screen" value="Fixed: on" locked />}
                  {!isMock && <Row label="Block copy and paste" value="Fixed: on" locked />}
                </dl>
                {off && cameraOffText !== null && (
                  <p style={{ margin: "var(--aiq-space-xs) 0 0", color: "var(--aiq-color-fg-muted)" }}>{cameraOffText}</p>
                )}
              </div>
              {isMock && (
                <div className="aiq-ttc-extras" onClick={(e) => e.stopPropagation()}>
                  <HelpTip helpId="admin.assessments.integrity.fullscreen">
                    <label style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-xs)" }}>
                      <input
                        type="checkbox"
                        checked={integrity.fullscreen}
                        disabled={!mockActive}
                        onChange={(e) => onIntegrityChange({ ...integrity, fullscreen: e.target.checked })}
                      />
                      Require full screen
                    </label>
                  </HelpTip>
                  <HelpTip helpId="admin.assessments.integrity.block_copy_paste">
                    <label style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-xs)" }}>
                      <input
                        type="checkbox"
                        checked={integrity.blockCopyPaste}
                        disabled={!mockActive}
                        onChange={(e) => onIntegrityChange({ ...integrity, blockCopyPaste: e.target.checked })}
                      />
                      Block copy and paste
                    </label>
                  </HelpTip>
                  {/* Z-145: feedback radios go here. */}
                  {mockFeedbackSlot}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {!readOnly && <p style={{ margin: "var(--aiq-space-xs) 0 0", color: "var(--aiq-color-fg-muted)" }}>{CHARGE_NOTE}</p>}
    </div>
  );
}

