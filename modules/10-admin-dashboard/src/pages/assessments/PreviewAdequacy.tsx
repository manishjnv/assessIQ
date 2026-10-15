import { questionTypeLabel } from "../../lib/labels.js";
import React, { useEffect, useState } from "react";
import { adminApi, AdminApiError } from "../../api.js";
import { type BlueprintPreviewResponse } from "./shared.js";

interface PreviewAdequacyProps {
  assessmentId: string;
}

export function PreviewAdequacy({ assessmentId }: PreviewAdequacyProps): React.ReactElement {
  const [preview, setPreview] = useState<BlueprintPreviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const data = await adminApi<BlueprintPreviewResponse>(
          `/admin/assessments/${assessmentId}/preview`,
        );
        setPreview(data);
      } catch (err) {
        setError(
          err instanceof AdminApiError ? err.apiError.message : "Failed to load preview.",
        );
      } finally {
        setLoading(false);
      }
    })();
  }, [assessmentId]);

  if (loading) {
    return (
      <span style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)" }}>
        Checking pool adequacy…
      </span>
    );
  }

  if (error) {
    return (
      <span style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-error, #dc2626)" }}>
        {error}
      </span>
    );
  }

  if (!preview?.blueprint_criteria) {
    return (
      <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)" }}>
        Pool size: {preview?.pool_size ?? "—"} / {preview?.question_count ?? "—"} required
      </span>
    );
  }

  const allAdequate = preview.blueprint_criteria.every((c) => c.available >= c.required);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {preview.blueprint_criteria.map((c) => {
        const ok = c.available >= c.required;
        return (
          <div
            key={c.criterion_index}
            style={{
              fontFamily: "var(--aiq-font-mono)",
              fontSize: "var(--aiq-text-xs)",
              color: ok ? "var(--aiq-color-success)" : "var(--aiq-color-error, #dc2626)",
            }}
          >
            {ok ? "✓" : "✗"} {questionTypeLabel(c.type)} — {c.available}/{c.required} available
          </div>
        );
      })}
      {allAdequate && (
        <div style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-success)", fontWeight: 600 }}>
          Pool adequate — ready to publish.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FromSetPicker sub-component (Step 2 — clone-on-use, "Assess from a set")
// ---------------------------------------------------------------------------
//
// Company-admin path to consume a licensed PLATFORM-library set. Lists the sets
// this tenant is entitled to (getAvailableSets → GET /billing/available-sets),
// lets the admin pick a set + level (1-based position) + how many questions to
// draw, and reports the selection up. The actual clone-on-use happens server-
// side when createAssessmentFromSet is called on submit — this component only
// reads license-gated METADATA (name, domain, level/question counts, version);
// it never reads platform pack content.
//
// A domain license surfaces all current AND future sets in that domain, so new
// sets the super admin publishes appear here automatically.

