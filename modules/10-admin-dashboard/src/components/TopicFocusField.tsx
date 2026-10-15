// AssessIQ — optional "Topic focus" field for the generate wizard (RW-46).
// The API caps topic_focus at 200 characters (modules/04-question-bank/src/routes.ts).
import React from "react";
import { HelpTip } from "@assessiq/help-system/components";

export const TOPIC_FOCUS_MAX = 200;

export function TopicFocusField({ value, onChange, helpId }: {
  value: string;
  onChange: (v: string) => void;
  helpId: string;
}): React.ReactElement {
  const over = value.trim().length > TOPIC_FOCUS_MAX;
  return (
    <div style={{ marginBottom: "var(--aiq-space-md)" }}>
      <HelpTip helpId={helpId}>
        <label htmlFor="topic-focus" data-help-id={helpId} style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", fontWeight: 500 }}>
          Topic focus (optional)
        </label>
      </HelpTip>
      <input
        id="topic-focus"
        type="text"
        className="aiq-input"
        style={{ width: "100%", marginTop: "var(--aiq-space-xs)" }}
        value={value}
        aria-invalid={over}
        onChange={(e) => onChange(e.target.value)}
        placeholder="For example: phishing triage"
      />
      <div style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-xs)", color: over ? "var(--aiq-color-error, #dc2626)" : "var(--aiq-color-fg-muted)" }}>
        {over
          ? `Topic focus is too long. Use ${TOPIC_FOCUS_MAX} characters or fewer.`
          : `${value.trim().length}/${TOPIC_FOCUS_MAX}`}
      </div>
    </div>
  );
}
