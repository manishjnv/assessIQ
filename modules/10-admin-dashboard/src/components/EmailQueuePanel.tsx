// AssessIQ — "invitation emails are queued" panel (Q11), shown on the
// assessment detail → Invitations section. Read-only: GET /admin/email-queue.
// Hidden when nothing is queued or the call fails (it is a courtesy notice).

import React, { useEffect, useState } from "react";
import { adminApi } from "../api.js";

interface EmailQueueStatus {
  queuedCount: number;
  nextSendAt: string | null;
  dailyCap: number;
  sentToday: number;
}

export function EmailQueuePanel({ refreshKey }: { refreshKey: number }): React.ReactElement | null {
  const [status, setStatus] = useState<EmailQueueStatus | null>(null);

  useEffect(() => {
    let live = true;
    adminApi<EmailQueueStatus>("/admin/email-queue")
      .then((s) => { if (live) setStatus(s); })
      .catch(() => { if (live) setStatus(null); });
    return () => { live = false; };
  }, [refreshKey]);

  if (status === null || status.queuedCount <= 0) return null;
  const when = status.nextSendAt
    ? new Date(status.nextSendAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
    : null;
  return (
    <div
      role="status"
      data-testid="email-queue-panel"
      data-help-id="admin.assessments.invitations.email_queue"
      style={{
        fontFamily: "var(--aiq-font-sans)",
        fontSize: "var(--aiq-text-sm)",
        color: "var(--aiq-color-fg-secondary)",
        marginBottom: "var(--aiq-space-md)",
      }}
    >
      {status.queuedCount} invitation email{status.queuedCount === 1 ? " is" : "s are"} queued.
      {when ? ` The next ones send on ${when}.` : ""}
    </div>
  );
}
