// Camera feature: reviewer page. Flagged real-exam attempts, their camera files, and the review actions.
// Only super admins and named camera reviewers get data (the server decides; a 403 shows the not-a-reviewer page).
// Every "View" is logged on the server (camera.file.viewed). Object URLs are revoked when the viewer closes.
import React, { useCallback, useEffect, useState } from "react";
import { Button, Chip, Spinner, formatDateTime } from "@assessiq/ui-system";
import { AdminShell } from "../components/AdminShell.js";
import { AdminApiError } from "../api.js";
import {
  fetchCameraFileBlob,
  listCameraFilesApi,
  listFlaggedCameraApi,
  markCameraAttemptReviewedApi,
  setCameraAppealApi,
  type CameraFileRow,
  type CameraReviewState,
  type FlaggedAttempt,
} from "../api/camera.js";

const FLAG_LABEL: Record<string, string> = {
  camera_stopped: "Camera stopped",
  camera_blocked: "Camera blocked",
};

function flagLabel(reason: string | null): string {
  return (reason !== null && FLAG_LABEL[reason]) || "Flagged";
}

function sizeLabel(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function isNotReviewer(err: unknown): boolean {
  return err instanceof AdminApiError && err.status === 403;
}

const errorText = (err: unknown): string =>
  err instanceof AdminApiError ? err.apiError.message : "Unexpected error. Try again.";

const PANEL: React.CSSProperties = {
  border: "1px solid var(--aiq-color-border)",
  borderRadius: "var(--aiq-radius-md)",
  background: "var(--aiq-color-bg-raised)",
  padding: 16,
  minWidth: 0,
};

interface Viewer {
  fileId: string;
  kind: CameraFileRow["kind"];
  takenAt: string;
  url: string;
}

export function CameraReview(): React.ReactElement {
  const [rows, setRows] = useState<FlaggedAttempt[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notReviewer, setNotReviewer] = useState(false);

  const [selected, setSelected] = useState<FlaggedAttempt | null>(null);
  const [files, setFiles] = useState<CameraFileRow[]>([]);
  const [review, setReview] = useState<CameraReviewState | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [viewBusy, setViewBusy] = useState<string | null>(null);

  // Revoke the object URL when the viewer changes or the page unmounts.
  useEffect(() => {
    if (viewer === null) return;
    return () => URL.revokeObjectURL(viewer.url);
  }, [viewer]);

  const loadPage = useCallback(async (cursor: string | null): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const res = await listFlaggedCameraApi(cursor !== null ? { cursor, limit: 50 } : { limit: 50 });
      setRows((prev) => (cursor === null ? res.items : [...prev, ...res.items]));
      setNextCursor(res.nextCursor);
      setNotReviewer(false);
    } catch (err) {
      if (isNotReviewer(err)) {
        setNotReviewer(true);
      } else {
        setError(errorText(err));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPage(null);
  }, [loadPage]);

  const openAttempt = async (row: FlaggedAttempt): Promise<void> => {
    setSelected(row);
    setViewer(null);
    setFilesLoading(true);
    setFilesError(null);
    setActionError(null);
    try {
      const res = await listCameraFilesApi(row.attemptId);
      setFiles(res.items);
      setReview(res.review);
    } catch (err) {
      setFiles([]);
      setReview(null);
      setFilesError(errorText(err));
    } finally {
      setFilesLoading(false);
    }
  };

  const viewFile = async (file: CameraFileRow): Promise<void> => {
    setViewBusy(file.id);
    setFilesError(null);
    try {
      const blob = await fetchCameraFileBlob(file.id);
      setViewer({ fileId: file.id, kind: file.kind, takenAt: file.takenAt, url: URL.createObjectURL(blob) });
    } catch (err) {
      setFilesError(errorText(err));
    } finally {
      setViewBusy(null);
    }
  };

  const markReviewed = async (): Promise<void> => {
    if (selected === null) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await markCameraAttemptReviewedApi(selected.attemptId);
      setReview((r) => ({ appealState: r?.appealState ?? "none", uploadRefused: r?.uploadRefused ?? false, reviewedAt: new Date().toISOString() }));
    } catch (err) {
      setActionError(errorText(err));
    } finally {
      setActionBusy(false);
    }
  };

  const changeAppeal = async (state: "open" | "closed"): Promise<void> => {
    if (selected === null) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await setCameraAppealApi(selected.attemptId, state);
      setReview((r) => ({ reviewedAt: r?.reviewedAt ?? null, uploadRefused: r?.uploadRefused ?? false, appealState: state }));
    } catch (err) {
      setActionError(errorText(err));
    } finally {
      setActionBusy(false);
    }
  };

  if (notReviewer) {
    return (
      <AdminShell breadcrumbs={["Camera review"]} helpPage="admin.camera">
        <div style={{ maxWidth: 560, padding: "48px 0" }} data-testid="camera-not-reviewer">
          <h1 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-h1-size)", fontWeight: 400, margin: 0 }}>
            You are not a camera reviewer.
          </h1>
          <p style={{ fontSize: 14, color: "var(--aiq-color-fg-secondary)", lineHeight: 1.5, marginTop: 12 }}>
            Only the reviewers named by your organisation can open camera files. Ask your organisation admin to add you.
          </p>
        </div>
      </AdminShell>
    );
  }

  return (
    <AdminShell breadcrumbs={["Camera review"]} helpPage="admin.camera">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xl)" }}>
        <div>
          <h1 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-h1-size)", fontWeight: 400, margin: 0, letterSpacing: "-0.02em" }}>
            Camera review.
          </h1>
          <p style={{ fontSize: 14, color: "var(--aiq-color-fg-secondary)", margin: "8px 0 0", maxWidth: 560, lineHeight: 1.5 }}>
            Attempts with flagged camera files. Open a row to see its files.
          </p>
        </div>

        {error !== null && <Chip>{error}</Chip>}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 340px), 1fr))", gap: 16, alignItems: "start" }}>
          {/* Flagged list */}
          <section data-help-id="admin.camera.review_list" style={PANEL} aria-label="Flagged attempts">
            {loading && rows.length === 0 ? (
              <Spinner aria-label="Loading flagged attempts" />
            ) : rows.length === 0 ? (
              <p style={{ fontSize: 13, color: "var(--aiq-color-fg-secondary)", margin: 0 }}>No flagged attempts.</p>
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column" }}>
                {rows.map((r) => (
                  <li key={r.attemptId} style={{ borderTop: "1px solid var(--aiq-color-border)" }}>
                    <button
                      type="button"
                      onClick={() => void openAttempt(r)}
                      aria-current={selected?.attemptId === r.attemptId ? "true" : undefined}
                      style={{
                        display: "block",
                        width: "100%",
                        textAlign: "left",
                        padding: "12px 8px",
                        background: selected?.attemptId === r.attemptId ? "var(--aiq-color-bg-sunken)" : "transparent",
                        border: "none",
                        cursor: "pointer",
                        color: "var(--aiq-color-fg-primary)",
                        fontFamily: "var(--aiq-font-sans)",
                      }}
                    >
                      <span style={{ display: "block", fontSize: 14, fontWeight: 500 }}>{r.candidateName ?? r.candidateEmail ?? "Candidate"}</span>
                      <span style={{ display: "block", fontSize: 12, color: "var(--aiq-color-fg-secondary)" }}>
                        {r.assessmentName ?? "Assessment"} · {r.flaggedFiles} flagged · {formatDateTime(r.lastFlaggedAt)}
                      </span>
                      <span style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                        {r.reviewedAt !== null && <Chip variant="success">Reviewed</Chip>}
                        {r.appealState === "open" && <Chip variant="warn">Appeal open</Chip>}
                        {r.uploadRefused && <Chip variant="warn">Uploads refused</Chip>}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {nextCursor !== null && (
              <div style={{ marginTop: 12 }}>
                <Button variant="outline" size="sm" disabled={loading} onClick={() => void loadPage(nextCursor)}>
                  {loading ? "Loading…" : "Load more"}
                </Button>
              </div>
            )}
          </section>

          {/* Files panel */}
          <section data-help-id="admin.camera.review_files" style={PANEL} aria-label="Camera files">
            {selected === null ? (
              <p style={{ fontSize: 13, color: "var(--aiq-color-fg-secondary)", margin: 0 }}>Select an attempt to see its files.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 500 }}>{selected.candidateName ?? selected.candidateEmail ?? "Candidate"}</div>
                  <div style={{ fontSize: 12, color: "var(--aiq-color-fg-secondary)" }}>{selected.assessmentName ?? "Assessment"}</div>
                </div>

                {review?.uploadRefused && (
                  <div role="status" style={{ fontSize: 13, padding: "8px 10px", borderRadius: "var(--aiq-radius-md)", border: "1px solid var(--aiq-color-warning-border, var(--aiq-color-warning))", background: "var(--aiq-color-warning-subtle, var(--aiq-color-bg-raised))" }}>
                    Some uploads were refused because storage was full.
                  </div>
                )}

                {review !== null && (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    {review.reviewedAt !== null ? (
                      <Chip variant="success">Reviewed {formatDateTime(review.reviewedAt)}</Chip>
                    ) : (
                      <Button size="sm" variant="outline" disabled={actionBusy} onClick={() => void markReviewed()}>
                        Mark reviewed
                      </Button>
                    )}
                    {review.appealState === "open" ? (
                      <Button size="sm" variant="ghost" disabled={actionBusy} onClick={() => void changeAppeal("closed")}>
                        Close appeal
                      </Button>
                    ) : (
                      <Button size="sm" variant="ghost" disabled={actionBusy} onClick={() => void changeAppeal("open")}>
                        Open appeal
                      </Button>
                    )}
                  </div>
                )}
                {actionError !== null && <Chip>{actionError}</Chip>}

                {filesLoading ? (
                  <Spinner aria-label="Loading camera files" />
                ) : filesError !== null ? (
                  <Chip>{filesError}</Chip>
                ) : files.length === 0 ? (
                  <p style={{ fontSize: 13, color: "var(--aiq-color-fg-secondary)", margin: 0 }}>No camera files.</p>
                ) : (
                  <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column" }}>
                    {files.map((f) => (
                      <li key={f.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderTop: "1px solid var(--aiq-color-border)", flexWrap: "wrap" }}>
                        <span style={{ flex: 1, minWidth: 140, fontSize: 13 }}>
                          {f.kind === "video" ? "Video" : "Photo"} · {formatDateTime(f.takenAt)} · {sizeLabel(f.sizeBytes)}
                        </span>
                        {f.flagged && <Chip variant="warn">{flagLabel(f.flagReason)}</Chip>}
                        <Button size="sm" variant="ghost" loading={viewBusy === f.id} disabled={viewBusy !== null} onClick={() => void viewFile(f)}>
                          View
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}

                {viewer !== null && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {viewer.kind === "video" ? (
                      <video aria-label="Camera video" controls src={viewer.url} style={{ width: "100%", maxHeight: 360, background: "var(--aiq-color-bg-sunken)" }} />
                    ) : (
                      <img alt={`Camera photo taken ${formatDateTime(viewer.takenAt)}`} src={viewer.url} style={{ width: "100%", maxHeight: 360, objectFit: "contain", background: "var(--aiq-color-bg-sunken)" }} />
                    )}
                    <div>
                      <Button size="sm" variant="ghost" onClick={() => setViewer(null)}>Close file</Button>
                    </div>
                  </div>
                )}

                <p style={{ fontSize: 12, color: "var(--aiq-color-fg-muted)", margin: 0 }}>
                  Every view is logged.
                </p>
              </div>
            )}
          </section>
        </div>
      </div>
    </AdminShell>
  );
}
