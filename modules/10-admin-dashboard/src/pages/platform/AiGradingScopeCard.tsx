// AiGradingScopeCard - P4 least-AI cap (super admin only; shown in the Platform billing drawer).
// 'written' = AI may grade written answers; 'none' = no AI for this organisation.

import React, { useEffect, useState } from "react";
import { Card, Chip } from "@assessiq/ui-system";
import { HelpTip } from "@assessiq/help-system/components";
import { AdminApiError, getTenantAiGradingScope, updateTenantAiGradingScope, type AiGradingScope } from "../../api.js";
import { META_LABEL } from "./shared.js";

export function AiGradingScopeCard({ tenantId, readOnly }: { tenantId: string; readOnly: boolean }): React.ReactElement {
  const [scope, setScope] = useState<AiGradingScope | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getTenantAiGradingScope(tenantId)
      .then((r) => { if (live) setScope(r.ai_grading_scope); })
      .catch(() => { if (live) setError("Could not load the AI grading setting."); });
    return () => { live = false; };
  }, [tenantId]);

  const change = async (next: AiGradingScope): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const r = await updateTenantAiGradingScope(tenantId, next);
      setScope(r.ai_grading_scope);
    } catch (err) {
      setError(err instanceof AdminApiError ? err.apiError.message : "Save failed. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)", padding: "var(--aiq-space-lg)" }}>
        <HelpTip helpId="admin.platform.tenant.ai_grading_scope">
          <span style={{ ...META_LABEL, fontSize: 10 }}>AI grading scope</span>
        </HelpTip>
        <label htmlFor="ai-grading-scope-select" data-help-id="admin.platform.tenant.ai_grading_scope" style={{ fontSize: "var(--aiq-text-sm)" }}>
          Written answers
        </label>
        <select
          id="ai-grading-scope-select"
          value={scope ?? "written"}
          disabled={readOnly || saving || scope === null}
          onChange={(e) => void change(e.target.value as AiGradingScope)}
          style={{ width: 260, padding: "var(--aiq-space-xs) var(--aiq-space-sm)", borderRadius: "var(--aiq-radius-md)", border: "1px solid var(--aiq-color-border)" }}
        >
          <option value="written">AI may grade written answers</option>
          <option value="none">No AI - score manually</option>
        </select>
        {error !== null && <Chip>{error}</Chip>}
      </div>
    </Card>
  );
}
