// AssessIQ — Tenant settings page: company name, Result release mode and DPDP
// Data Retention controls.
//
// Route: /admin/tenant-settings  (tenant admin only; route wiring done in follow-up)
// Also embedded in the Settings page (billing.tsx) via <TenantSettings embedded />.
//
// INVARIANT: This file must never import @anthropic-ai/sdk, @anthropic-ai/claude-agent-sdk,
// or any module that transitively imports them. AI SDK usage is restricted to
// modules/07-ai-grading/runtimes/anthropic-api.ts only.
//
// Style notes (patterned on users.tsx):
//   - Same fetch pattern: adminApi + AdminApiError
//   - Same toast/error display: Chip variant="success" / default for feedback
//   - Same meta label style (mono uppercase), same Card/Button/Field/Chip imports
//   - Same AdminShell wrapper with breadcrumbs
//
// Load-step fallback: GET /api/admin/tenant-settings is attempted first; if that
// returns 404 (endpoint not yet deployed), the page falls back to
// GET /api/admin/me which may carry retention_days in the tenant object.
// If neither provides a value, the input starts empty ("unknown — set value to
// override default") per the contract.  This is the simplest fallback: two
// sequential fetches, no extra dependencies.

import React, { useEffect, useState, type CSSProperties } from "react";
import { Button, Card, Chip, Spinner, Table, ConfirmDialog, TenantLogo, formatDateTime, accentContrast, ACCENT_MIN_CONTRAST } from "@assessiq/ui-system";
import { AdminShell } from "../components/AdminShell.js";
import { CameraSettingsCard } from "../components/CameraSettingsCard.js";
import { MfaStepUp } from "../components/mfa-step-up.js";
import { adminApi, AdminApiError } from "../api.js";
import { useAdminSession, fetchAdminWhoami } from "../session.js";
import { shortId } from "../lib/labels.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** How finished results reach candidates (spec 2026-10-01 SP2). Default: manual. */
type ReleaseMode = "manual" | "auto";

interface TenantSettingsResponse {
  retention_days: number;
  attempt_retention_days?: number | null;
  updated_at?: string;
  /** Absent on servers that predate the Result release setting. */
  result_release_mode?: ReleaseMode;
  /** Absent on servers that predate the Distinction-on-certificates setting (Z-50). */
  certificate_show_distinction?: boolean;
  /** Current organisation logo, or null/absent when none is set. */
  /** Org accent colour (#rrggbb) or null. */
  accent?: string | null;
  logo?: { url: string; width: number; height: number; byte_size: number } | null;
}

const LOGO_MAX_BYTES = 512 * 1024;
const LOGO_TYPES: ReadonlyArray<string> = ["image/png", "image/jpeg"];

const LOGO_ERROR_COPY: Readonly<Record<string, string>> = {
  LOGO_BAD_FORMAT: "The logo must be a PNG or JPEG image.",
  LOGO_BAD_DIMENSIONS: "The logo size is not allowed. Use an image between 64 and 2048 pixels on each side.",
  LOGO_FILE_REQUIRED: "Choose a logo file first.",
  LOGO_TOO_LARGE: "The logo is larger than 512 KB.",
};

function readFileAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onload = () => {
      const r = typeof reader.result === "string" ? reader.result : "";
      resolve(r.slice(r.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

/** Z-115: the logo box. A picked logo is scaled to fit inside it. */
const LOGO_BOX_W = 600;
const LOGO_BOX_H = 200;

/**
 * Z-115: draw the picked image into a canvas that fits 600x200. Keeps the aspect
 * ratio, never stretches, never enlarges. Exports PNG so transparency survives.
 * EXIF rotation is applied by the browser (imageOrientation "from-image").
 */
const LOGO_MIN_SIDE = 64;

async function fitLogoToPng(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const scale = Math.min(1, LOGO_BOX_W / bitmap.width, LOGO_BOX_H / bitmap.height);
    const canvas = document.createElement("canvas");
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    // The API refuses a side under LOGO_MIN_SIDE: pad a very wide or tiny logo with transparent pixels, never stretch it.
    canvas.width = Math.max(LOGO_MIN_SIDE, w);
    canvas.height = Math.max(LOGO_MIN_SIDE, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas unavailable");
    ctx.drawImage(bitmap, Math.round((canvas.width - w) / 2), Math.round((canvas.height - h) / 2), w, h);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("png export failed");
    return blob;
  } finally {
    bitmap.close();
  }
}

const RELEASE_OPTIONS: ReadonlyArray<{ value: ReleaseMode; label: string; help: string }> = [
  {
    value: "manual",
    label: "Manual (default)",
    help: "You release each result yourself. Candidates are not sent a result until you do.",
  },
  {
    value: "auto",
    label: "Automatic",
    help: "Results are released as soon as they are complete. Candidates see their score and are emailed straight away.",
  },
];

interface RetentionReport {
  tenantId: string;
  retentionDays: number;
  candidatesScanned: number;
  candidatesErased: number;
  candidatesSkipped: number;
  errors: string[];
  dryRun: boolean;
  durationMs: number;
}

interface ErasedCandidateRow {
  userId: string;
  erasedAt: string;
  erasedById: string | null;
  erasedByName: string | null;
  erasedByEmail: string | null;
  reason: string | null;
  attemptsKept: number;
  certsKept: number;
}

interface ErasedListResponse {
  items: ErasedCandidateRow[];
  total: number;
}

type ErasedSinceWindow = "30d" | "90d" | "365d" | "all";

// ── Shared style constants (mirrors users.tsx) ────────────────────────────────

const META_LABEL: CSSProperties = {
  fontFamily: "var(--aiq-font-mono)",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "var(--aiq-color-fg-muted)",
};

// ── Main page ─────────────────────────────────────────────────────────────────

export interface TenantSettingsProps {
  /**
   * When true, render the inner sections only (no AdminShell wrapper, no
   * page header). Used to embed the retention controls as a section inside
   * another settings page (e.g. /admin/settings/billing). When false
   * (default), render as the standalone /admin/tenant-settings page.
   */
  embedded?: boolean;
  /**
   * Z-23: when set, the Settings tab strip in AdminShell picks the tab (URL
   * ?tab=) and the inner buttons are not drawn. Unset: standalone behaviour.
   */
  tab?: "organisation" | "results" | "privacy";
}

/** UAT 2026-10-29: one read-only value with a Copy button (organisation code and student sign-in link). */
function CopyRow(props: { label: string; value: string; id: string }): React.ReactElement {
  const [done, setDone] = useState(false);
  return (
    <div style={{ marginBottom: 16 }}>
      <label htmlFor={props.id} style={{ display: "block", fontFamily: "var(--aiq-font-sans)", fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
        {props.label}
      </label>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input
          id={props.id}
          readOnly
          value={props.value}
          onFocus={(e) => e.currentTarget.select()}
          style={{ flex: "1 1 280px", minWidth: 0, height: 36, padding: "0 12px", border: "1px solid var(--aiq-color-border)", borderRadius: 8, background: "var(--aiq-color-bg-raised)", color: "var(--aiq-color-fg-primary)", fontFamily: "var(--aiq-font-mono)", fontSize: 13 }}
        />
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void navigator.clipboard.writeText(props.value).then(() => {
              setDone(true);
              setTimeout(() => setDone(false), 2000);
            });
          }}
        >
          {done ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}

export function TenantSettings({ embedded = false, tab }: TenantSettingsProps = {}): React.ReactElement {
  const [innerTab, setActiveTab] = useState<"company" | "results" | "privacy">("company");
  const activeTab = tab ? (tab === "organisation" ? "company" : tab) : innerTab;
  // ── Load state ────────────────────────────────────────────────────────────
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // retention_days: null means unknown (no value from any endpoint)
  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  // Z-132: blank = keep the attempt activity log forever
  const [attemptRetInput, setAttemptRetInput] = useState("");
  const [attemptRetSaving, setAttemptRetSaving] = useState(false);
  const [attemptRetMsg, setAttemptRetMsg] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState<string>("");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  // ── Save state ────────────────────────────────────────────────────────────
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // ── Organisation logo ─────────────────────────────────────────────────────
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoSuccess, setLogoSuccess] = useState<string | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [logoMfa, setLogoMfa] = useState<"upload" | "remove" | null>(null);
  const [showLogoRemove, setShowLogoRemove] = useState(false);

  // ── Organisation accent colour (Z-119) ────────────────────────────────────
  const [accentInput, setAccentInput] = useState("");
  const [accentBusy, setAccentBusy] = useState(false);
  const [accentMsg, setAccentMsg] = useState<string | null>(null);
  const [accentError, setAccentError] = useState<string | null>(null);
  const [accentMfa, setAccentMfa] = useState(false);
  const accentRatio = accentContrast(accentInput);
  const accentTooLight = accentRatio !== null && accentRatio < ACCENT_MIN_CONTRAST;
  const accentValid = accentInput === "" || (accentRatio !== null && !accentTooLight);

  // ── Result release mode ───────────────────────────────────────────────────
  // releaseMode = what the server has (null: unknown — older API or load
  // failed); releaseChoice = the radio the admin picked but has not saved.
  const [releaseMode, setReleaseMode] = useState<ReleaseMode | null>(null);
  const [releaseChoice, setReleaseChoice] = useState<ReleaseMode | null>(null);
  const [releaseSaving, setReleaseSaving] = useState(false);
  const [releaseSuccess, setReleaseSuccess] = useState<string | null>(null);
  const [releaseError, setReleaseError] = useState<string | null>(null);
  const [releaseMfa, setReleaseMfa] = useState(false);
  const selectedRelease = releaseChoice ?? releaseMode;
  const releaseDirty = selectedRelease !== null && selectedRelease !== releaseMode;

  // ── Distinction on certificates (Z-50) ────────────────────────────────────
  const [certShowDistinction, setCertShowDistinction] = useState(false);
  const [certChoice, setCertChoice] = useState<boolean | null>(null);
  const [certSaving, setCertSaving] = useState(false);
  const [certSuccess, setCertSuccess] = useState<string | null>(null);
  const [certError, setCertError] = useState<string | null>(null);
  const [certMfa, setCertMfa] = useState(false);
  const selectedDistinction = certChoice ?? certShowDistinction;
  const certDirty = selectedDistinction !== certShowDistinction;

  // ── Purge state ───────────────────────────────────────────────────────────
  const [previewLoading, setPreviewLoading] = useState(false);
  const [runLoading, setRunLoading] = useState(false);
  const [purgeError, setPurgeError] = useState<string | null>(null);
  const [previewReport, setPreviewReport] = useState<RetentionReport | null>(null);
  const [runReport, setRunReport] = useState<RetentionReport | null>(null);
  const [showRunConfirm, setShowRunConfirm] = useState(false);

  // ── Erased candidates list state ──────────────────────────────────────────
  const [erasedRows, setErasedRows] = useState<ErasedCandidateRow[]>([]);
  const [erasedTotal, setErasedTotal] = useState<number>(0);
  const [erasedLoading, setErasedLoading] = useState<boolean>(true);
  const [erasedError, setErasedError] = useState<string | null>(null);
  const [erasedSince, setErasedSince] = useState<ErasedSinceWindow>("365d");

  // ── Company name (tenants.name, display only) ─────────────────────────────
  const { session } = useAdminSession();
  const currentName = session?.tenant.name ?? "";
  const [nameInput, setNameInput] = useState<string>("");
  const [nameTouched, setNameTouched] = useState(false);
  const [nameSaving, setNameSaving] = useState(false);
  const [nameSuccess, setNameSuccess] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  useEffect(() => {
    if (!nameTouched) setNameInput(currentName);
  }, [currentName, nameTouched]);

  // Mirrors server normalisation (02-tenancy normalizeTenantName).
  const normalizedName = nameInput.replace(/\s+/g, " ").trim();
  const nameInvalid =
    [...nameInput].some((c) => { const n = c.charCodeAt(0); return !/\s/.test(c) && (n < 32 || (n >= 127 && n <= 159)); }) ||
    normalizedName.length < 2 ||
    normalizedName.length > 120;
  const nameDirty = normalizedName !== currentName;

  const handleSaveName = async (): Promise<void> => {
    if (nameInvalid) {
      setNameError("Organisation name must be 2–120 characters, without control characters.");
      return;
    }
    setNameSaving(true);
    setNameError(null);
    setNameSuccess(null);
    try {
      await adminApi("/admin/tenant", {
        method: "PATCH",
        body: JSON.stringify({ name: normalizedName }),
      });
      await fetchAdminWhoami(true); // refresh shell/header tenant name
      setNameTouched(false);
      setNameSuccess("Organisation name updated.");
      setTimeout(() => setNameSuccess(null), 4000);
    } catch (err) {
      setNameError(
        err instanceof AdminApiError ? err.apiError.message : "Unexpected error — please try again.",
      );
    } finally {
      setNameSaving(false);
    }
  };

  // ── Organisation logo: upload / remove ────────────────────────────────────
  // Both need a fresh MFA check; a 401 (or 403 MFA_REQUIRED) opens the inline
  // MfaStepUp and the action is retried once the code verifies.

  const isFreshMfaError = (err: unknown): boolean =>
    err instanceof AdminApiError &&
    (err.status === 401 || (err.status === 403 && err.apiError.details?.code === "MFA_REQUIRED"));

  const logoErrorMessage = (err: unknown): string => {
    if (err instanceof AdminApiError) {
      const code = typeof err.apiError.details?.code === "string" ? err.apiError.details.code : err.apiError.code;
      return LOGO_ERROR_COPY[code] ?? LOGO_ERROR_COPY[err.apiError.code] ?? err.apiError.message;
    }
    return "Unexpected error — please try again.";
  };

  const handlePickLogo = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0] ?? null;
    setLogoSuccess(null);
    setLogoError(null);
    if (file === null) {
      setLogoFile(null);
      return;
    }
    if (!LOGO_TYPES.includes(file.type)) {
      setLogoFile(null);
      setLogoError(LOGO_ERROR_COPY["LOGO_BAD_FORMAT"] ?? "The logo must be a PNG or JPEG image.");
      return;
    }
    // Z-115: no size gate here. The picked file is resized to 600x200 before upload.
    setLogoFile(file);
  };

  const handleUploadLogo = async (): Promise<void> => {
    if (logoFile === null) return;
    setLogoBusy(true);
    setLogoError(null);
    setLogoSuccess(null);
    try {
      const png = await fitLogoToPng(logoFile).catch(() => null);
      if (png === null) {
        setLogoError("This file could not be read as an image. Choose a PNG or JPEG file.");
        return;
      }
      if (png.size > LOGO_MAX_BYTES) {
        setLogoError(LOGO_ERROR_COPY["LOGO_TOO_LARGE"] ?? "The logo is larger than 512 KB.");
        return;
      }
      const content_base64 = await readFileAsBase64(png);
      const res = await adminApi<{ logo: { url: string } }>("/admin/tenant-settings/logo", {
        method: "PUT",
        body: JSON.stringify({ content_base64 }),
      });
      setLogoUrl(res.logo.url);
      setLogoFile(null);
      setLogoMfa(null);
      setLogoSuccess("Logo updated.");
      setTimeout(() => setLogoSuccess(null), 4000);
      void fetchAdminWhoami(true); // refresh the shell header logo
    } catch (err) {
      if (isFreshMfaError(err)) setLogoMfa("upload");
      else setLogoError(logoErrorMessage(err));
    } finally {
      setLogoBusy(false);
    }
  };

  const handleSaveAccent = async (): Promise<void> => {
    if (!accentValid) return;
    setAccentBusy(true);
    setAccentError(null);
    setAccentMsg(null);
    try {
      const primary = accentInput === "" ? null : accentInput.toLowerCase();
      await adminApi("/admin/tenant-settings/accent", { method: "PATCH", body: JSON.stringify({ primary }) });
      setAccentMfa(false);
      setAccentMsg(primary === null ? "Colour cleared. The default colour is used." : "Colour saved.");
      window.dispatchEvent(new CustomEvent("aiq:accent", { detail: primary }));
    } catch (err) {
      if (isFreshMfaError(err)) setAccentMfa(true);
      else setAccentError(err instanceof AdminApiError ? err.apiError.message : "Could not save the colour. Try again.");
    } finally {
      setAccentBusy(false);
    }
  };

  const handleRemoveLogo = async (): Promise<void> => {
    setShowLogoRemove(false);
    setLogoBusy(true);
    setLogoError(null);
    setLogoSuccess(null);
    try {
      await adminApi("/admin/tenant-settings/logo", { method: "DELETE" });
      setLogoUrl(null);
      setLogoFile(null);
      setLogoMfa(null);
      setLogoSuccess("Logo removed.");
      setTimeout(() => setLogoSuccess(null), 4000);
      void fetchAdminWhoami(true);
    } catch (err) {
      if (isFreshMfaError(err)) setLogoMfa("remove");
      else setLogoError(logoErrorMessage(err));
    } finally {
      setLogoBusy(false);
    }
  };

  // ── Load on mount ─────────────────────────────────────────────────────────

  useEffect(() => {
    void loadSettings();
  }, []);

  useEffect(() => {
    void loadErasedCandidates(erasedSince);
  }, [erasedSince]);

  const loadErasedCandidates = async (window: ErasedSinceWindow): Promise<void> => {
    setErasedLoading(true);
    setErasedError(null);
    try {
      const params = new URLSearchParams();
      if (window !== "all") {
        const days = window === "30d" ? 30 : window === "90d" ? 90 : 365;
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        params.set("since", since);
      } else {
        // "all" → since the epoch start of UNIX time keeps the filter inert
        params.set("since", new Date(0).toISOString());
      }
      params.set("limit", "500");
      const data = await adminApi<ErasedListResponse>(
        `/admin/erased-candidates?${params.toString()}`,
      );
      setErasedRows(data.items);
      setErasedTotal(data.total);
    } catch (err) {
      const msg =
        err instanceof AdminApiError
          ? err.apiError.message
          : "Failed to load erased candidates.";
      setErasedError(msg);
    } finally {
      setErasedLoading(false);
    }
  };

  const loadSettings = async (): Promise<void> => {
    setLoadingSettings(true);
    setLoadError(null);
    try {
      // Primary: GET /api/admin/tenant-settings
      const data = await adminApi<TenantSettingsResponse>("/admin/tenant-settings");
      setRetentionDays(data.retention_days);
      setInputValue(String(data.retention_days));
      setAttemptRetInput(data.attempt_retention_days == null ? "" : String(data.attempt_retention_days));
      setUpdatedAt(data.updated_at ?? null);
      setLogoUrl(data.logo?.url ?? null);
      setAccentInput(data.accent ?? "");
      setReleaseMode(
        data.result_release_mode === "auto" || data.result_release_mode === "manual"
          ? data.result_release_mode
          : null,
      );
      setCertShowDistinction(data.certificate_show_distinction === true);
    } catch (primaryErr) {
      const is404 =
        primaryErr instanceof AdminApiError && primaryErr.status === 404;

      // 404: no settings row yet — leave empty, admin sets the value.
      if (!is404) {
        const msg =
          primaryErr instanceof AdminApiError
            ? primaryErr.apiError.message
            : "Failed to load retention settings.";
        setLoadError(msg);
      }
    } finally {
      setLoadingSettings(false);
    }
  };

  // ── Save ──────────────────────────────────────────────────────────────────

  const handleSaveAttemptRetention = async (): Promise<void> => {
    const trimmed = attemptRetInput.trim();
    const parsed = trimmed === "" ? null : Number(trimmed);
    if (parsed !== null && (!Number.isInteger(parsed) || parsed < 30 || parsed > 3650)) {
      setAttemptRetMsg("Enter a whole number from 30 to 3650, or leave it blank.");
      return;
    }
    setAttemptRetSaving(true);
    setAttemptRetMsg(null);
    try {
      await adminApi("/admin/tenant-settings/attempt-retention-days", {
        method: "PATCH",
        body: JSON.stringify({ attempt_retention_days: parsed }),
      });
      setAttemptRetMsg("Saved.");
    } catch (err) {
      setAttemptRetMsg(
        err instanceof AdminApiError ? err.apiError.message : "Could not save. Try again.",
      );
    } finally {
      setAttemptRetSaving(false);
    }
  };

  const handleSave = async (): Promise<void> => {
    const parsed = parseInt(inputValue, 10);
    if (isNaN(parsed) || parsed < 1 || parsed > 3650) {
      setSaveError("Value must be a whole number between 1 and 3650.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(null);
    try {
      await adminApi("/admin/tenant-settings/retention-days", {
        method: "PATCH",
        body: JSON.stringify({ retention_days: parsed }),
      });
      setRetentionDays(parsed);
      setSaveSuccess("Retention window updated.");
      setUpdatedAt(new Date().toISOString());
      setTimeout(() => setSaveSuccess(null), 4000);
    } catch (err) {
      if (err instanceof AdminApiError) {
        const code = err.apiError.details?.code as string | undefined;
        if (err.status === 403 && code === "MFA_REQUIRED") {
          setSaveError(
            "Fresh authentication required. Please re-authenticate (last MFA must be within 15 minutes) and try again.",
          );
        } else {
          setSaveError(err.apiError.message);
        }
      } else {
        setSaveError("Unexpected error — please try again.");
      }
    } finally {
      setSaving(false);
    }
  };

  // ── Save result release mode ──────────────────────────────────────────────
  // PATCH needs a fresh MFA check. A 401 (or 403 MFA_REQUIRED) opens the shared
  // MfaStepUp inline — the picked option is kept and the save is retried once
  // the code verifies. (/admin/mfa ignores ?return= and always lands on
  // /admin, so a redirect would lose the admin's place.)

  const handleSaveRelease = async (): Promise<void> => {
    if (selectedRelease === null) return;
    setReleaseSaving(true);
    setReleaseError(null);
    setReleaseSuccess(null);
    try {
      await adminApi("/admin/tenant-settings/result-release-mode", {
        method: "PATCH",
        body: JSON.stringify({ mode: selectedRelease }),
      });
      setReleaseMode(selectedRelease);
      setReleaseChoice(null);
      setReleaseMfa(false);
      setReleaseSuccess(
        selectedRelease === "auto"
          ? "Results now release automatically."
          : "Results now wait for you to release them.",
      );
      setTimeout(() => setReleaseSuccess(null), 4000);
    } catch (err) {
      if (
        err instanceof AdminApiError &&
        (err.status === 401 ||
          (err.status === 403 && err.apiError.details?.code === "MFA_REQUIRED"))
      ) {
        setReleaseMfa(true);
      } else {
        setReleaseError(
          err instanceof AdminApiError
            ? err.apiError.message
            : "Unexpected error — please try again.",
        );
      }
    } finally {
      setReleaseSaving(false);
    }
  };

  // ── Save the Distinction-on-certificates switch (Z-50; same fresh-MFA flow) ──

  const handleSaveCertDistinction = async (): Promise<void> => {
    setCertSaving(true);
    setCertError(null);
    setCertSuccess(null);
    try {
      await adminApi("/admin/tenant-settings/certificate-show-distinction", {
        method: "PATCH",
        body: JSON.stringify({ enabled: selectedDistinction }),
      });
      setCertShowDistinction(selectedDistinction);
      setCertChoice(null);
      setCertMfa(false);
      setCertSuccess("Certificate setting saved.");
      setTimeout(() => setCertSuccess(null), 4000);
    } catch (err) {
      if (
        err instanceof AdminApiError &&
        (err.status === 401 ||
          (err.status === 403 && err.apiError.details?.code === "MFA_REQUIRED"))
      ) {
        setCertMfa(true);
      } else {
        setCertError(
          err instanceof AdminApiError
            ? err.apiError.message
            : "Unexpected error — please try again.",
        );
      }
    } finally {
      setCertSaving(false);
    }
  };

  // ── Purge: preview ────────────────────────────────────────────────────────

  const handlePreview = async (): Promise<void> => {
    setPreviewLoading(true);
    setPurgeError(null);
    setPreviewReport(null);
    try {
      const report = await adminApi<RetentionReport>(
        "/admin/retention/run-now?dryRun=true",
        { method: "POST" },
      );
      setPreviewReport(report);
    } catch (err) {
      const msg =
        err instanceof AdminApiError
          ? err.apiError.message
          : "Preview failed — please try again.";
      setPurgeError(msg);
    } finally {
      setPreviewLoading(false);
    }
  };

  // ── Purge: run now (with confirm) ─────────────────────────────────────────

  const handleRunNow = async (): Promise<void> => {
    setShowRunConfirm(false);
    setRunLoading(true);
    setPurgeError(null);
    setRunReport(null);
    try {
      const report = await adminApi<RetentionReport>("/admin/retention/run-now", {
        method: "POST",
      });
      setRunReport(report);
    } catch (err) {
      const msg =
        err instanceof AdminApiError
          ? err.apiError.message
          : "Purge failed — please try again.";
      setPurgeError(msg);
    } finally {
      setRunLoading(false);
    }
  };

  const confirmMessage =
    previewReport !== null
      ? `This will permanently erase personal data for ${previewReport.candidatesErased} candidate${previewReport.candidatesErased === 1 ? "" : "s"}. Continue?`
      : "Run now without preview will erase any candidates past the retention window. Continue?";

  // ── Helpers ───────────────────────────────────────────────────────────────


  const inputIsDirty =
    retentionDays !== null && inputValue !== String(retentionDays);
  const inputIsEmpty = inputValue.trim() === "";

  // ── Report display ────────────────────────────────────────────────────────

  function ReportTable({ report }: { report: RetentionReport }): React.ReactElement {
    return (
      <div
        style={{
          marginTop: 16,
          border: "1px solid var(--aiq-color-border)",
          borderRadius: "var(--aiq-radius-md)",
          overflow: "hidden",
          background: "var(--aiq-color-bg-base)",
        }}
      >
        {(
          [
            ["Staging", report.dryRun ? "Yes" : "No"],
            ["Organisation ID", report.tenantId],
            ["Retention window", `${report.retentionDays} days`],
            ["Candidates scanned", String(report.candidatesScanned)],
            ["Candidates erased", String(report.candidatesErased)],
            ["Candidates skipped", String(report.candidatesSkipped)],
            ["Duration", `${report.durationMs} ms`],
          ] as [string, string][]
        ).map(([label, value], i) => (
          <div
            key={label}
            style={{
              display: "grid",
              gridTemplateColumns: "180px 1fr",
              gap: 12,
              padding: "10px 16px",
              borderTop: i === 0 ? "none" : "1px solid var(--aiq-color-border)",
              background: i % 2 === 1 ? "var(--aiq-color-bg-raised)" : "transparent",
              alignItems: "start",
            }}
          >
            <span style={{ ...META_LABEL, fontSize: 10 }}>{label}</span>
            <span
              style={{
                fontFamily: "var(--aiq-font-mono)",
                fontSize: 13,
                color: "var(--aiq-color-fg-primary)",
              }}
            >
              {value}
            </span>
          </div>
        ))}

        {report.errors.length > 0 && (
          <div
            style={{
              padding: "10px 16px",
              borderTop: "1px solid var(--aiq-color-border)",
              background: "var(--aiq-color-bg-raised)",
            }}
          >
            <span style={{ ...META_LABEL, fontSize: 10, display: "block", marginBottom: 6 }}>
              Errors ({report.errors.length})
            </span>
            <ul
              style={{
                margin: 0,
                paddingLeft: 16,
                fontFamily: "var(--aiq-font-mono)",
                fontSize: 12,
                color: "var(--aiq-color-danger, #dc2626)",
                lineHeight: 1.6,
              }}
            >
              {report.errors.map((e, idx) => (
                <li key={idx}>{e}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  // When embedded, render only the inner DPDP sections (no AdminShell, no
  // page-header chip/title — the parent page owns those). When standalone,
  // wrap with AdminShell + render the page header. Both paths share the
  // same retention + purge JSX below.
  const inner = (
    <>
      <ConfirmDialog
        open={showRunConfirm}
        title="Run retention purge?"
        body={confirmMessage}
        confirmLabel="Run purge"
        onConfirm={() => void handleRunNow()}
        onCancel={() => setShowRunConfirm(false)}
      />

      <ConfirmDialog
        open={showLogoRemove}
        title="Remove the organisation logo?"
        body="Your name is shown instead of the logo in the app header, in candidate emails and on certificates."
        confirmLabel="Remove logo"
        danger
        onConfirm={() => void handleRemoveLogo()}
        onCancel={() => setShowLogoRemove(false)}
      />

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xl)" }}>

        {!embedded && (
          /* Page header */
          <div>
            <div style={{ marginBottom: 12 }}>
              <Chip leftIcon="settings">Organisation settings</Chip>
            </div>
            <h1
              style={{
                fontFamily: "var(--aiq-font-serif)",
                fontSize: "var(--aiq-text-3xl)",
                fontWeight: 400,
                margin: 0,
                letterSpacing: "-0.02em",
              }}
            >
              Settings.
            </h1>
            <p
              style={{
                fontSize: 14,
                color: "var(--aiq-color-fg-secondary)",
                margin: "8px 0 0",
                maxWidth: 520,
                lineHeight: 1.5,
              }}
            >
              Organisation-level configuration: organisation name, result release, and data
              retention and compliance controls.
            </p>
          </div>
        )}

        {/* ── Tabs (inline; hidden panels stay mounted so form state survives) ── */}
        <div role="tablist" hidden={Boolean(tab)} style={{ display: tab ? "none" : "flex", gap: 8, flexWrap: "wrap" }}>
          {(
            [
              ["company", "Organisation"],
              ["results", "Results"],
              ["privacy", "Data privacy"],
            ] as const
          ).map(([id, label]) => (
            <Button
              key={id}
              role="tab"
              aria-selected={activeTab === id}
              variant={activeTab === id ? "primary" : "outline"}
              onClick={() => setActiveTab(id)}
            >
              {label}
            </Button>
          ))}
        </div>

        <div role="tabpanel" hidden={activeTab !== "company"}>
        {/* ── Organisation code and student sign-in link (UAT 2026-10-29) ─── */}
        {session?.tenant.slug && (
          <section aria-labelledby="org-code-heading" data-help-id="admin.tenant_settings.org_code" style={{ marginBottom: "var(--aiq-space-xl)" }}>
            <div style={{ paddingBottom: 16, borderBottom: "1px solid var(--aiq-color-border)", marginBottom: 24 }}>
              <h2 id="org-code-heading" style={{ fontFamily: "var(--aiq-font-serif)", fontSize: 22, fontWeight: 400, margin: 0, letterSpacing: "-0.015em" }}>
                Organisation code.
              </h2>
            </div>
            <Card padding="lg">
              <p style={{ margin: "0 0 16px", fontFamily: "var(--aiq-font-sans)", fontSize: 14, color: "var(--aiq-color-fg-secondary)", lineHeight: 1.55 }}>
                Students sign in to see their results with this code. Invitation emails already carry it. Share the sign-in link below if a student asks.
              </p>
              <CopyRow id="org-code-value" label="Organisation code" value={session.tenant.slug} />
              <CopyRow
                id="org-signin-link"
                label="Student sign-in link"
                value={`${window.location.origin}/candidate/login?tenant=${encodeURIComponent(session.tenant.slug)}`}
              />
            </Card>
          </section>
        )}

        {/* ── Company name section ────────────────────────────────────────── */}
        <section aria-labelledby="company-name-heading" data-help-id="admin.tenant_settings.company_name">
          <div
            style={{
              paddingBottom: 16,
              borderBottom: "1px solid var(--aiq-color-border)",
              marginBottom: 24,
            }}
          >
            <h2
              id="company-name-heading"
              style={{
                fontFamily: "var(--aiq-font-serif)",
                fontSize: 22,
                fontWeight: 400,
                margin: 0,
                letterSpacing: "-0.015em",
              }}
            >
              Organisation name.
            </h2>
          </div>
          <Card padding="lg">
            <div style={{ maxWidth: 400 }}>
              <label
                htmlFor="company-name-input"
                style={{
                  display: "block",
                  fontFamily: "var(--aiq-font-sans)",
                  fontSize: 13,
                  fontWeight: 500,
                  color: "var(--aiq-color-fg-primary)",
                  marginBottom: 6,
                }}
              >
                Display name
              </label>
              <input
                id="company-name-input"
                type="text"
                maxLength={120}
                value={nameInput}
                onChange={(e) => {
                  setNameInput(e.target.value);
                  setNameTouched(true);
                  setNameError(null);
                  setNameSuccess(null);
                }}
                disabled={nameSaving || session === null}
                aria-invalid={nameDirty && nameInvalid}
                style={{
                  display: "block",
                  width: "100%",
                  fontFamily: "var(--aiq-font-sans)",
                  fontSize: 13,
                  padding: "10px 12px",
                  borderRadius: "var(--aiq-radius-md)",
                  border: "1px solid var(--aiq-color-border-strong)",
                  background: "var(--aiq-color-bg-raised)",
                  color: "var(--aiq-color-fg-primary)",
                  boxSizing: "border-box",
                }}
              />
              <p
                style={{
                  marginTop: 8,
                  fontSize: 12,
                  color: "var(--aiq-color-fg-secondary)",
                  lineHeight: 1.5,
                }}
              >
                Shown in the app header and in emails to your candidates. 2–120 characters.
                Your sign-in address and organisation ID do not change.
              </p>
              {nameDirty && nameInvalid && (
                <p role="alert" style={{ fontSize: 12, color: "var(--aiq-color-danger, #dc2626)", margin: "6px 0 0" }}>
                  Organisation name must be 2–120 characters, without control characters.
                </p>
              )}
            </div>
            {nameSuccess && (
              <div style={{ marginTop: 16 }}>
                <Chip variant="success">{nameSuccess}</Chip>
              </div>
            )}
            {nameError && (
              <div role="alert" style={{ marginTop: 16, fontSize: 13, color: "var(--aiq-color-danger, #dc2626)", lineHeight: 1.4 }}>
                {nameError}
              </div>
            )}
            <div style={{ marginTop: 20 }}>
              <Button
                onClick={() => void handleSaveName()}
                loading={nameSaving}
                disabled={!nameDirty || nameInvalid || session === null}
              >
                Save organisation name
              </Button>
            </div>
          </Card>
        </section>

        {/* ── Organisation logo section ───────────────────────────────────── */}
        <section aria-labelledby="org-logo-heading" data-help-id="admin.tenant_settings.logo" style={{ marginTop: "var(--aiq-space-xl)" }}>
          <div
            style={{
              paddingBottom: 16,
              borderBottom: "1px solid var(--aiq-color-border)",
              marginBottom: 24,
            }}
          >
            <h2
              id="org-logo-heading"
              style={{
                fontFamily: "var(--aiq-font-serif)",
                fontSize: 22,
                fontWeight: 400,
                margin: 0,
                letterSpacing: "-0.015em",
              }}
            >
              Organisation logo.
            </h2>
          </div>
          <Card padding="lg">
            <div style={{ marginBottom: 16 }}>
              {logoUrl !== null ? (
                <>
                  <img
                    src={logoUrl}
                    alt={`${currentName} logo`}
                    style={{ maxHeight: 120, maxWidth: 120, objectFit: "contain", display: "block" }}
                  />
                  {/* Real sizes from docs/10-branding-guideline.md § 11.1. */}
                  <div aria-hidden="true" style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 16 }}>
                    <span style={{ fontSize: 12, color: "var(--aiq-color-fg-secondary)" }}>App header, 28 px high</span>
                    <TenantLogo src={logoUrl} name={currentName} height={28} showName />
                    <span style={{ fontSize: 12, color: "var(--aiq-color-fg-secondary)" }}>Verify page, 32 px high</span>
                    <TenantLogo src={logoUrl} name={currentName} height={32} />
                  </div>
                </>
              ) : (
                <p style={{ margin: 0, fontSize: 13, color: "var(--aiq-color-fg-secondary)" }}>No logo set.</p>
              )}
            </div>
            <label
              htmlFor="org-logo-input"
              style={{
                display: "block",
                fontFamily: "var(--aiq-font-sans)",
                fontSize: 13,
                fontWeight: 500,
                color: "var(--aiq-color-fg-primary)",
                marginBottom: 6,
              }}
            >
              Logo file
            </label>
            <input
              id="org-logo-input"
              type="file"
              accept="image/png,image/jpeg"
              onChange={handlePickLogo}
              disabled={logoBusy}
              style={{ fontFamily: "var(--aiq-font-sans)", fontSize: 13 }}
            />
            <p style={{ marginTop: 8, fontSize: 12, color: "var(--aiq-color-fg-secondary)", lineHeight: 1.5 }}>
              PNG or JPEG. Any size is accepted: the logo is resized automatically to fit 600 &times; 200 px,
              keeping its shape. It shows in the app header, candidate emails and certificates.
            </p>
            {logoSuccess && (
              <div style={{ marginTop: 16 }}>
                <Chip variant="success">{logoSuccess}</Chip>
              </div>
            )}
            {logoError && (
              <div role="alert" style={{ marginTop: 16, fontSize: 13, color: "var(--aiq-color-danger, #dc2626)", lineHeight: 1.4 }}>
                {logoError}
              </div>
            )}
            {logoMfa !== null ? (
              <div style={{ marginTop: 20, maxWidth: 520 }}>
                <MfaStepUp
                  prompt="Changing the logo needs a fresh authenticator check. Enter your 6-digit code to continue."
                  confirmLabel="Verify & continue"
                  onVerified={() => {
                    const action = logoMfa;
                    setLogoMfa(null);
                    if (action === "upload") void handleUploadLogo();
                    else void handleRemoveLogo();
                  }}
                  onCancel={() => setLogoMfa(null)}
                />
              </div>
            ) : (
              <div style={{ marginTop: 20, display: "flex", gap: "var(--aiq-space-sm)" }}>
                <Button
                  onClick={() => void handleUploadLogo()}
                  loading={logoBusy}
                  disabled={logoFile === null}
                >
                  Upload logo
                </Button>
                <span data-help-id="admin.tenant_settings.logo.remove">
                  <Button
                    variant="outline"
                    onClick={() => setShowLogoRemove(true)}
                    disabled={logoBusy || logoUrl === null}
                  >
                    Remove logo
                  </Button>
                </span>
              </div>
            )}
          </Card>

          {/* Z-119: org accent colour */}
          <Card padding="lg" data-help-id="admin.tenant_settings.accent_colour">
            <h3 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: 18, fontWeight: 400, margin: "0 0 6px" }}>
              Organisation colour.
            </h3>
            <p style={{ fontSize: 13, color: "var(--aiq-color-fg-secondary)", margin: "0 0 12px", lineHeight: 1.5 }}>
              Buttons and links use this colour. Text must stay readable on white (contrast 4.5 to 1 or more). Leave blank for the default colour.
            </p>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <input
                type="color"
                aria-label="Pick colour"
                value={accentRatio !== null ? accentInput.toLowerCase() : "#3b4cca"}
                onChange={(e) => { setAccentInput(e.target.value); setAccentMsg(null); setAccentError(null); }}
              />
              <input
                type="text"
                aria-label="Accent hex value"
                value={accentInput}
                placeholder="#3b4cca"
                maxLength={7}
                onChange={(e) => { setAccentInput(e.target.value.trim()); setAccentMsg(null); setAccentError(null); }}
                style={{ width: 120, fontFamily: "var(--aiq-font-mono)", fontSize: 13, padding: "8px 10px", borderRadius: "var(--aiq-radius-md)", border: "1px solid var(--aiq-color-border-strong)", background: "var(--aiq-color-bg-raised)", color: "var(--aiq-color-fg-primary)" }}
              />
              {accentRatio !== null && (
                <span
                  data-testid="accent-preview"
                  style={{ background: accentInput, color: "#fff", padding: "8px 16px", borderRadius: "var(--aiq-radius-md)", fontSize: 13 }}
                >
                  Preview button
                </span>
              )}
            </div>
            <p role="status" data-testid="accent-contrast" style={{ marginTop: 8, fontSize: 13 }}>
              {accentInput === ""
                ? "Default colour."
                : accentRatio === null
                  ? "Enter a colour like #3b4cca."
                  : accentTooLight
                    ? `Too light: contrast ${accentRatio.toFixed(1)} to 1. Choose a darker colour (minimum ${ACCENT_MIN_CONTRAST} to 1).`
                    : `Readable: contrast ${accentRatio.toFixed(1)} to 1.`}
            </p>
            {accentMsg && <p role="status" style={{ fontSize: 13 }}>{accentMsg}</p>}
            {accentError && <div role="alert" style={{ fontSize: 13, color: "var(--aiq-color-danger, #dc2626)" }}>{accentError}</div>}
            {accentMfa ? (
              <div style={{ marginTop: 16, maxWidth: 520 }}>
                <MfaStepUp
                  prompt="Changing the colour needs a fresh authenticator check. Enter your 6-digit code to continue."
                  confirmLabel="Verify & continue"
                  onVerified={() => { setAccentMfa(false); void handleSaveAccent(); }}
                  onCancel={() => setAccentMfa(false)}
                />
              </div>
            ) : (
              <div style={{ marginTop: 16 }}>
                <Button onClick={() => void handleSaveAccent()} loading={accentBusy} disabled={!accentValid}>
                  Save colour
                </Button>
              </div>
            )}
          </Card>
        </section>
        </div>

        <div role="tabpanel" hidden={activeTab !== "results"}>
        {/* ── Result release section ──────────────────────────────────────── */}
        <section aria-labelledby="result-release-heading" data-help-id="admin.tenant_settings.result_release_mode">
          <div
            style={{
              paddingBottom: 16,
              borderBottom: "1px solid var(--aiq-color-border)",
              marginBottom: 24,
            }}
          >
            <h2
              id="result-release-heading"
              style={{
                fontFamily: "var(--aiq-font-serif)",
                fontSize: 22,
                fontWeight: 400,
                margin: 0,
                letterSpacing: "-0.015em",
              }}
            >
              Result release.
            </h2>
          </div>
          <Card padding="lg">
            {loadingSettings ? (
              <div style={{ display: "grid", placeItems: "center", padding: "var(--aiq-space-xl) 0" }}>
                <Spinner aria-label="Loading result release setting" />
              </div>
            ) : (
              <>
                <fieldset
                  disabled={releaseSaving}
                  style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}
                >
                  <legend
                    style={{
                      padding: 0,
                      marginBottom: 12,
                      fontFamily: "var(--aiq-font-sans)",
                      fontSize: 13,
                      fontWeight: 500,
                      color: "var(--aiq-color-fg-primary)",
                    }}
                  >
                    When do candidates receive their results?
                  </legend>
                  <div style={{ display: "grid", gap: 12, maxWidth: 520 }}>
                    {RELEASE_OPTIONS.map((opt) => {
                      const selected = selectedRelease === opt.value;
                      return (
                        <label
                          key={opt.value}
                          style={{
                            display: "flex",
                            alignItems: "flex-start",
                            gap: 12,
                            padding: "14px 16px",
                            borderRadius: "var(--aiq-radius-md)",
                            border: `1px solid ${selected ? "var(--aiq-color-accent)" : "var(--aiq-color-border-strong)"}`,
                            background: selected ? "var(--aiq-color-accent-soft)" : "transparent",
                            cursor: "pointer",
                          }}
                        >
                          <input
                            type="radio"
                            name="result-release-mode"
                            value={opt.value}
                            checked={selected}
                            onChange={() => {
                              setReleaseChoice(opt.value);
                              setReleaseError(null);
                              setReleaseSuccess(null);
                              setReleaseMfa(false);
                            }}
                            style={{ marginTop: 3, accentColor: "var(--aiq-color-accent)" }}
                          />
                          <span>
                            <span
                              style={{
                                display: "block",
                                fontFamily: "var(--aiq-font-sans)",
                                fontSize: 13,
                                fontWeight: 500,
                                color: "var(--aiq-color-fg-primary)",
                              }}
                            >
                              {opt.label}
                            </span>
                            <span
                              style={{
                                display: "block",
                                marginTop: 2,
                                fontSize: 12,
                                lineHeight: 1.5,
                                color: "var(--aiq-color-fg-secondary)",
                              }}
                            >
                              {opt.help}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </fieldset>

                <p
                  style={{
                    margin: "12px 0 0",
                    fontSize: 12,
                    lineHeight: 1.5,
                    color: "var(--aiq-color-fg-secondary)",
                    maxWidth: 520,
                  }}
                >
                  Switching to Automatic does not release results that are already
                  waiting. You can still release those yourself.
                </p>

                {releaseSuccess && (
                  <div style={{ marginTop: 16 }}>
                    <Chip variant="success">{releaseSuccess}</Chip>
                  </div>
                )}
                {releaseError && (
                  <div
                    role="alert"
                    style={{
                      marginTop: 16,
                      fontSize: 13,
                      color: "var(--aiq-color-danger, #dc2626)",
                      lineHeight: 1.4,
                    }}
                  >
                    {releaseError}
                  </div>
                )}

                {releaseMfa ? (
                  <div style={{ marginTop: 20, maxWidth: 520 }}>
                    <MfaStepUp
                      prompt="Changing how results are released needs a fresh authenticator check. Enter your 6-digit code to continue."
                      confirmLabel="Verify & save"
                      onVerified={() => {
                        setReleaseMfa(false);
                        void handleSaveRelease();
                      }}
                      onCancel={() => setReleaseMfa(false)}
                    />
                  </div>
                ) : (
                  <div style={{ marginTop: 20 }}>
                    <Button
                      onClick={() => void handleSaveRelease()}
                      loading={releaseSaving}
                      disabled={!releaseDirty}
                    >
                      Save result release
                    </Button>
                  </div>
                )}
              </>
            )}
          </Card>
        </section>

        {/* ── Distinction on certificates (Z-50) ──────────────────────────── */}
        <section
          aria-labelledby="cert-distinction-heading"
          data-help-id="admin.tenant_settings.certificate_show_distinction"
          style={{ marginTop: "var(--aiq-space-xl)" }}
        >
          <div
            style={{
              paddingBottom: 16,
              borderBottom: "1px solid var(--aiq-color-border)",
              marginBottom: 24,
            }}
          >
            <h2
              id="cert-distinction-heading"
              style={{
                fontFamily: "var(--aiq-font-serif)",
                fontSize: 22,
                fontWeight: 400,
                margin: 0,
                letterSpacing: "-0.015em",
              }}
            >
              Certificates.
            </h2>
          </div>
          <Card padding="lg">
            {loadingSettings ? (
              <div style={{ display: "grid", placeItems: "center", padding: "var(--aiq-space-xl) 0" }}>
                <Spinner aria-label="Loading certificate setting" />
              </div>
            ) : (
              <>
                <label style={{ display: "flex", alignItems: "flex-start", gap: 12, maxWidth: 520, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={selectedDistinction}
                    disabled={certSaving}
                    onChange={(e) => {
                      setCertChoice(e.target.checked);
                      setCertError(null);
                      setCertSuccess(null);
                      setCertMfa(false);
                    }}
                    style={{ marginTop: 3, accentColor: "var(--aiq-color-accent)" }}
                  />
                  <span>
                    <span
                      style={{
                        display: "block",
                        fontFamily: "var(--aiq-font-sans)",
                        fontSize: 13,
                        fontWeight: 500,
                        color: "var(--aiq-color-fg-primary)",
                      }}
                    >
                      Write Distinction on certificates
                    </span>
                    <span
                      style={{
                        display: "block",
                        marginTop: 2,
                        fontSize: 12,
                        lineHeight: 1.5,
                        color: "var(--aiq-color-fg-secondary)",
                      }}
                    >
                      Every candidate who passes gets a certificate. When this is on, a score of 90% or more reads
                      Distinction. When it is off, all certificates read Completion.
                    </span>
                  </span>
                </label>

                {certSuccess && (
                  <div style={{ marginTop: 16 }}>
                    <Chip variant="success">{certSuccess}</Chip>
                  </div>
                )}
                {certError && (
                  <div
                    role="alert"
                    style={{
                      marginTop: 16,
                      fontSize: 13,
                      color: "var(--aiq-color-danger, #dc2626)",
                      lineHeight: 1.4,
                    }}
                  >
                    {certError}
                  </div>
                )}

                {certMfa ? (
                  <div style={{ marginTop: 20, maxWidth: 520 }}>
                    <MfaStepUp
                      prompt="Changing certificate wording needs a fresh authenticator check. Enter your 6-digit code to continue."
                      confirmLabel="Verify & save"
                      onVerified={() => {
                        setCertMfa(false);
                        void handleSaveCertDistinction();
                      }}
                      onCancel={() => setCertMfa(false)}
                    />
                  </div>
                ) : (
                  <div style={{ marginTop: 20 }}>
                    <Button
                      onClick={() => void handleSaveCertDistinction()}
                      loading={certSaving}
                      disabled={!certDirty}
                    >
                      Save certificate setting
                    </Button>
                  </div>
                )}
              </>
            )}
          </Card>
        </section>
        </div>

        <div role="tabpanel" hidden={activeTab !== "privacy"} style={{ display: activeTab === "privacy" ? "flex" : undefined, flexDirection: "column", gap: "var(--aiq-space-xl)" }}>
        {/* ── Real-exam camera (camera feature): notice, school switches, reviewers ── */}
        <CameraSettingsCard />

        {/* ── DPDP Data Retention section ─────────────────────────────────── */}
        <section aria-labelledby="dpdp-retention-heading">
          <div
            style={{
              paddingBottom: 16,
              borderBottom: "1px solid var(--aiq-color-border)",
              marginBottom: 24,
            }}
          >
            <h2
              id="dpdp-retention-heading"
              style={{
                fontFamily: "var(--aiq-font-serif)",
                fontSize: 22,
                fontWeight: 400,
                margin: 0,
                letterSpacing: "-0.015em",
              }}
            >
              Delete candidate personal data after N days (DPDP law).
            </h2>
          </div>

          {/* ── Retention window control ─────────────────────────────────── */}
          <Card padding="lg" style={{ marginBottom: 24 }}>

            {loadingSettings ? (
              <div style={{ display: "grid", placeItems: "center", padding: "var(--aiq-space-xl) 0" }}>
                <Spinner aria-label="Loading retention settings" />
              </div>
            ) : (
              <>
                {loadError && (
                  <div style={{ marginBottom: 16 }}>
                    <Chip>{loadError}</Chip>
                  </div>
                )}

                <div style={{ maxWidth: 400 }}>
                  {/* Label row */}
                  <label
                    htmlFor="retention-days-input"
                    style={{
                      display: "block",
                      fontFamily: "var(--aiq-font-sans)",
                      fontSize: 13,
                      fontWeight: 500,
                      color: "var(--aiq-color-fg-primary)",
                      marginBottom: 6,
                    }}
                  >
                    Days (DPDP law)
                    {Number(inputValue) >= 1 && (
                      <span style={{ fontWeight: 400, color: "var(--aiq-color-fg-secondary)" }}>
                        {" "}· {Number(inputValue)} days ={" "}
                        {Number((Number(inputValue) / 365).toFixed(1))}{" "}
                        {Number((Number(inputValue) / 365).toFixed(1)) === 1 ? "year" : "years"}
                      </span>
                    )}
                  </label>

                  {/* Number input — styled to match Field primitives */}
                  <input
                    id="retention-days-input"
                    type="number"
                    min={1}
                    max={3650}
                    step={1}
                    value={inputValue}
                    placeholder="unknown — set value to override default"
                    onChange={(e) => {
                      setInputValue(e.target.value);
                      setSaveError(null);
                      setSaveSuccess(null);
                    }}
                    disabled={saving}
                    style={{
                      display: "block",
                      width: "100%",
                      fontFamily: "var(--aiq-font-sans)",
                      fontSize: 13,
                      padding: "10px 12px",
                      borderRadius: "var(--aiq-radius-md)",
                      border: "1px solid var(--aiq-color-border-strong)",
                      background: "var(--aiq-color-bg-raised)",
                      color: "var(--aiq-color-fg-primary)",
                      boxSizing: "border-box",
                    }}
                  />

                  <p
                    style={{
                      marginTop: 8,
                      fontSize: 12,
                      color: "var(--aiq-color-fg-secondary)",
                      lineHeight: 1.5,
                    }}
                  >
                    Candidates whose last activity is older than this are anonymised by
                    the nightly retention cron. Default 730 (2 years HR-grade). Range 1–3650.
                  </p>

                  {updatedAt && !inputIsDirty && (
                    <p style={{ ...META_LABEL, fontSize: 10, marginTop: 6 }}>
                      Last updated · {formatDateTime(updatedAt)}
                    </p>
                  )}
                </div>

                {/* Feedback */}
                {saveSuccess && (
                  <div style={{ marginTop: 16 }}>
                    <Chip variant="success">{saveSuccess}</Chip>
                  </div>
                )}
                {saveError && (
                  <div
                    role="alert"
                    style={{
                      marginTop: 16,
                      fontSize: 13,
                      color: "var(--aiq-color-danger, #dc2626)",
                      lineHeight: 1.4,
                    }}
                  >
                    {saveError}
                  </div>
                )}

                <div style={{ marginTop: 20 }}>
                  <Button
                    onClick={() => void handleSave()}
                    loading={saving}
                    disabled={inputIsEmpty}
                  >
                    Save retention window
                  </Button>
                </div>

                {/* Z-132: attempt activity log window */}
                <div style={{ maxWidth: 400, marginTop: 28 }} data-help-id="admin.tenant_settings.attempt_retention_days">
                  <label
                    htmlFor="attempt-retention-days-input"
                    style={{ display: "block", fontFamily: "var(--aiq-font-sans)", fontSize: 13, fontWeight: 500, color: "var(--aiq-color-fg-primary)", marginBottom: 6 }}
                  >
                    Keep attempt activity log for (days)
                  </label>
                  <input
                    id="attempt-retention-days-input"
                    type="number"
                    min={30}
                    max={3650}
                    step={1}
                    value={attemptRetInput}
                    placeholder="blank = keep forever"
                    onChange={(e) => { setAttemptRetInput(e.target.value); setAttemptRetMsg(null); }}
                    disabled={attemptRetSaving}
                    style={{ display: "block", width: "100%", fontFamily: "var(--aiq-font-sans)", fontSize: 13, padding: "10px 12px", borderRadius: "var(--aiq-radius-md)", border: "1px solid var(--aiq-color-border-strong)", background: "var(--aiq-color-bg-raised)", color: "var(--aiq-color-fg-primary)", boxSizing: "border-box" }}
                  />
                  <p style={{ marginTop: 8, fontSize: 12, color: "var(--aiq-color-fg-secondary)", lineHeight: 1.5 }}>
                    Removes the activity log (tab switches, answer saves) of finished tests after this many days. Answers, scores and certificates stay. Range 30–3650.
                  </p>
                  {attemptRetMsg && (
                    <p role="status" style={{ fontSize: 13, marginTop: 6 }}>{attemptRetMsg}</p>
                  )}
                  <div style={{ marginTop: 12 }}>
                    <Button onClick={() => void handleSaveAttemptRetention()} loading={attemptRetSaving}>
                      Save activity log window
                    </Button>
                  </div>
                </div>
              </>
            )}
          </Card>

          {/* ── Retention purge panel ────────────────────────────────────── */}
          <Card padding="lg">
            <div style={{ marginBottom: 16 }}>
              <h3
                style={{
                  fontFamily: "var(--aiq-font-serif)",
                  fontSize: 18,
                  fontWeight: 400,
                  margin: "0 0 6px",
                  letterSpacing: "-0.01em",
                }}
              >
                Run retention purge.
              </h3>
              <p
                style={{
                  fontSize: 13,
                  color: "var(--aiq-color-fg-secondary)",
                  margin: 0,
                  lineHeight: 1.5,
                }}
              >
                Manually trigger the retention cron outside its nightly schedule.
                Run a staging preview first to see how many candidates are affected
                before committing.
              </p>
            </div>

            {purgeError && (
              <div style={{ marginBottom: 16 }}>
                <Chip>{purgeError}</Chip>
              </div>
            )}

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Button
                variant="outline"
                onClick={() => void handlePreview()}
                loading={previewLoading}
                disabled={runLoading}
              >
                Preview (staging)
              </Button>
              <Button
                onClick={() => setShowRunConfirm(true)}
                loading={runLoading}
                disabled={previewLoading}
              >
                Run now
              </Button>
            </div>

            {/* Preview report */}
            {previewReport !== null && (
              <div style={{ marginTop: 20 }}>
                <div style={{ marginBottom: 8 }}>
                  <Chip variant="accent">Staging result</Chip>
                </div>
                <ReportTable report={previewReport} />
              </div>
            )}

            {/* Live-run report */}
            {runReport !== null && (
              <div style={{ marginTop: 20 }}>
                <div style={{ marginBottom: 8 }}>
                  <Chip variant="success">Purge complete</Chip>
                </div>
                <ReportTable report={runReport} />
              </div>
            )}
          </Card>
        </section>

        {/* ── Erased candidates section ──────────────────────────────────── */}
        <section aria-labelledby="erased-candidates-heading">
          <div
            style={{
              paddingBottom: 16,
              borderBottom: "1px solid var(--aiq-color-border)",
              marginBottom: 24,
            }}
          >
            <h2
              id="erased-candidates-heading"
              style={{
                fontFamily: "var(--aiq-font-serif)",
                fontSize: 22,
                fontWeight: 400,
                margin: 0,
                letterSpacing: "-0.015em",
              }}
            >
              Erased candidates.
            </h2>
            <p
              style={{
                marginTop: 8,
                fontSize: 13,
                color: "var(--aiq-color-fg-secondary)",
                lineHeight: 1.5,
                maxWidth: 640,
              }}
            >
              Candidates in this organisation whose personal data has been anonymised (via
              admin action or the nightly retention cron). Names and emails
              are not retrievable. Attempts and certificates are preserved
              as required for billing reconciliation and certificate
              signature verification.
            </p>
          </div>

          <Card padding="lg">
            {/* Filter bar */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                marginBottom: 16,
                flexWrap: "wrap",
              }}
            >
              <span style={{ ...META_LABEL, fontSize: 10 }}>Window</span>
              <select
                value={erasedSince}
                onChange={(e) => setErasedSince(e.target.value as ErasedSinceWindow)}
                disabled={erasedLoading}
                style={{
                  fontFamily: "var(--aiq-font-sans)",
                  fontSize: 13,
                  padding: "8px 10px",
                  borderRadius: "var(--aiq-radius-md)",
                  border: "1px solid var(--aiq-color-border-strong)",
                  background: "var(--aiq-color-bg-raised)",
                  color: "var(--aiq-color-fg-primary)",
                }}
              >
                <option value="30d">Last 30 days</option>
                <option value="90d">Last 90 days</option>
                <option value="365d">Last 365 days</option>
                <option value="all">All time</option>
              </select>
              <span style={{ flex: 1 }} />
              <span style={{ ...META_LABEL, fontSize: 10 }}>
                {erasedLoading ? "Loading…" : `${erasedTotal} total`}
              </span>
            </div>

            {erasedError && (
              <div role="alert" style={{ marginBottom: 16 }}>
                <Chip>{erasedError}</Chip>
              </div>
            )}

            {erasedLoading ? (
              <div style={{ display: "grid", placeItems: "center", padding: "var(--aiq-space-xl) 0" }}>
                <Spinner aria-label="Loading erased candidates" />
              </div>
            ) : erasedRows.length === 0 ? (
              <div
                style={{
                  padding: "32px 16px",
                  textAlign: "center",
                  fontSize: 13,
                  color: "var(--aiq-color-fg-secondary)",
                  background: "var(--aiq-color-bg-raised)",
                  borderRadius: "var(--aiq-radius-md)",
                  border: "1px dashed var(--aiq-color-border)",
                }}
              >
                No erased candidates in this window.
              </div>
            ) : (
              <div
                style={{
                  border: "1px solid var(--aiq-color-border)",
                  borderRadius: "var(--aiq-radius-md)",
                  overflow: "hidden",
                }}
              >
                <Table<(typeof erasedRows)[number]>
                  data={erasedRows}
                  columns={[
                    { key: "erasedAt", label: "Erased on", render: (row) => formatDateTime(row.erasedAt) },
                    { key: "userId", label: "Erase", render: (row) => (
                      <span title={row.userId} style={{ fontFamily: "var(--aiq-font-mono)", fontSize: 12, color: "var(--aiq-color-fg-secondary)" }}>{shortId(row.userId)}…</span>
                    ) },
                    { key: "erasedBy", label: "Erased by", render: (row) => row.erasedById === null ? (
                      <span style={{ color: "var(--aiq-color-fg-secondary)", fontStyle: "italic" }}>system (retention cron)</span>
                    ) : (
                      <span>
                        {row.erasedByName ?? "Unknown"}
                        {row.erasedByEmail && (
                          <span style={{ display: "block", fontSize: 11, color: "var(--aiq-color-fg-secondary)" }}>{row.erasedByEmail}</span>
                        )}
                      </span>
                    ) },
                    { key: "reason", label: "Reason", render: (row) => (
                      <span style={{ color: row.reason ? "var(--aiq-color-fg-primary)" : "var(--aiq-color-fg-secondary)", fontStyle: row.reason ? "normal" : "italic" }}>{row.reason ?? "—"}</span>
                    ) },
                    { key: "attemptsKept", label: "Attempts", render: (row) => <span style={{ fontFamily: "var(--aiq-font-mono)" }}>{row.attemptsKept}</span> },
                    { key: "certsKept", label: "Certs", render: (row) => <span style={{ fontFamily: "var(--aiq-font-mono)" }}>{row.certsKept}</span> },
                  ]}
                />
              </div>
            )}
          </Card>
        </section>
        </div>

      </div>
    </>
  );

  if (embedded) {
    return inner;
  }
  return (
    <AdminShell breadcrumbs={["Settings"]} helpPage="admin.tenant_settings">
      {inner}
    </AdminShell>
  );
}
