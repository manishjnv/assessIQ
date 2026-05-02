// Decision #8 (PHASE_1_KICKOFF.md) — localStorage backup of in-flight
// answers, written on every save attempt. If the candidate's connection
// drops for more than 2 minutes the page offers a reload that re-hydrates
// from this key so no answer is lost.
//
// Schema is fixed by decision #8:
//   key:   aiq:attempt:<attemptId>:answers
//   value: { answers: Record<questionId, payload>, savedAt: ISO, clientRevision: number }
//
// TTL is enforced by the storage-event cleanup on submit/abandon (see
// `clearBackup`). Stale entries from a prior attempt for the same browser
// are NEVER auto-pruned by age — the candidate may legitimately reload an
// hours-old in-progress attempt.

const KEY_PREFIX = "aiq:attempt:";
const KEY_SUFFIX = ":answers";

export interface BackupEnvelope {
  answers: Record<string, unknown>;
  savedAt: string;
  clientRevision: number;
}

function key(attemptId: string): string {
  return `${KEY_PREFIX}${attemptId}${KEY_SUFFIX}`;
}

/** Read the backup for `attemptId`, or null if missing/corrupt. */
export function readBackup(attemptId: string): BackupEnvelope | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key(attemptId));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as BackupEnvelope;
    if (
      typeof parsed.savedAt !== "string" ||
      typeof parsed.clientRevision !== "number" ||
      typeof parsed.answers !== "object" ||
      parsed.answers === null
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Merge `update` into the backup for `attemptId`. The latest revision
 * across all questions is recorded as `clientRevision` so the resilience
 * layer can report a single per-attempt freshness value.
 */
export function writeBackup(
  attemptId: string,
  update: { questionId: string; answer: unknown; clientRevision: number },
): void {
  if (typeof window === "undefined") return;
  try {
    const existing = readBackup(attemptId);
    const next: BackupEnvelope = {
      answers: { ...(existing?.answers ?? {}), [update.questionId]: update.answer },
      savedAt: new Date().toISOString(),
      clientRevision: Math.max(existing?.clientRevision ?? 0, update.clientRevision),
    };
    window.localStorage.setItem(key(attemptId), JSON.stringify(next));
  } catch {
    // Quota / SecurityError / disabled storage — backup degrades silently.
    // Server-side autosave is the source of truth; backup is belt-and-suspenders.
  }
}

/** Remove the backup for `attemptId`. Called on submit/abandon. */
export function clearBackup(attemptId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key(attemptId));
  } catch {
    // Same as writeBackup — silent on failure.
  }
}
