// Camera feature: organisation camera settings card (tenant settings, privacy tab).
// Notice confirmation: all organisations. Camera and photo switches: schools only.
import React, { useCallback, useEffect, useState } from "react";
import { Card, Chip, Spinner } from "@assessiq/ui-system";
import {
  confirmCameraNoticeApi,
  getCameraSettingsApi,
  patchCameraSettingsApi,
  type CameraSettings,
} from "../api/camera.js";
import { AdminApiError } from "../api.js";
import { CameraSwitch } from "./CameraSwitch.js";
import { CameraReviewersCard } from "./CameraReviewersCard.js";

const AMBER_BOX: React.CSSProperties = {
  padding: "10px 12px",
  borderRadius: "var(--aiq-radius-md)",
  border: "1px solid var(--aiq-color-warning-border, var(--aiq-color-warning))",
  background: "var(--aiq-color-warning-subtle, var(--aiq-color-bg-raised))",
  color: "var(--aiq-color-fg-primary)",
  fontSize: 13,
  lineHeight: 1.5,
};

const ROW: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "12px 0",
  borderTop: "1px solid var(--aiq-color-border)",
};

const errorText = (err: unknown): string =>
  err instanceof AdminApiError ? err.apiError.message : "Unexpected error. Try again.";

export function CameraSettingsCard(): React.ReactElement {
  const [settings, setSettings] = useState<CameraSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setSettings(await getCameraSettingsApi());
      setLoadError(null);
    } catch (err) {
      setLoadError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const flash = (message: string): void => {
    setSaveSuccess(message);
    setTimeout(() => setSaveSuccess(null), 4000);
  };

  const confirmNotice = async (): Promise<void> => {
    setBusy(true);
    setSaveError(null);
    try {
      const res = await confirmCameraNoticeApi();
      flash(`Confirmed, version ${res.noticeConfirmedVersion}.`);
      await load();
    } catch (err) {
      setSaveError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const patch = async (body: { cameraEnabled?: boolean; photosEnabled?: boolean }, message: string): Promise<void> => {
    setBusy(true);
    setSaveError(null);
    try {
      await patchCameraSettingsApi(body);
      flash(message);
      await load();
    } catch (err) {
      setSaveError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (loadError !== null) {
    return (
      <section data-help-id="admin.tenant_settings.camera">
        <Chip>{loadError}</Chip>
      </section>
    );
  }
  if (settings === null) {
    return (
      <section data-help-id="admin.tenant_settings.camera" style={{ display: "grid", placeItems: "center", padding: "var(--aiq-space-xl) 0" }}>
        <Spinner aria-label="Loading camera settings" />
      </section>
    );
  }

  const noticeCurrent = settings.noticeConfirmedVersion === settings.requiredNoticeVersion;
  const noticeChanged = settings.noticeConfirmedVersion !== null && !noticeCurrent;

  return (
    <section data-help-id="admin.tenant_settings.camera" style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-lg)" }}>
      <Card padding="lg">
        <h3 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: 20, fontWeight: 400, margin: 0 }}>Camera.</h3>
        <p style={{ fontSize: 13, color: "var(--aiq-color-fg-secondary)", lineHeight: 1.5, margin: "8px 0 0", maxWidth: 640 }}>
          The camera can check a real test. Mock tests never use the camera.
        </p>

        {settings.storage.warn && (
          <div role="alert" style={{ ...AMBER_BOX, marginTop: 16 }}>
            Camera storage is almost full. Contact AssessIQ support.
          </div>
        )}

        {/* Notice confirmation — all organisations */}
        <div style={{ ...ROW, borderTop: "none", paddingTop: 16 }}>
          <label
            data-help-id="admin.tenant_settings.camera_notice"
            style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: noticeCurrent ? "default" : "pointer", fontSize: 14, lineHeight: 1.5 }}
          >
            <input
              type="checkbox"
              checked={noticeCurrent}
              disabled={noticeCurrent || busy}
              onChange={(e) => { if (e.target.checked) void confirmNotice(); }}
              style={{ marginTop: 3 }}
            />
            <span>I have the consent and notice my candidates need for camera use.</span>
          </label>
        </div>
        {noticeCurrent && (
          <div style={{ marginTop: 4 }}>
            <Chip variant="success">Confirmed, version {settings.noticeConfirmedVersion}</Chip>
          </div>
        )}
        {noticeChanged && (
          <div role="status" style={{ ...AMBER_BOX, marginTop: 12 }}>
            The camera notice changed to version {settings.requiredNoticeVersion}. Confirm again.
          </div>
        )}

        {settings.cameraEnforced === false && (
          <p role="status" style={{ margin: "12px 0 0", fontSize: 13, color: "var(--aiq-color-fg-secondary)", lineHeight: 1.5 }}>
            Camera tests are temporarily off. Choose Real for new tests.
          </p>
        )}

        {/* School switches, or the non-school line */}
        {settings.isSchool ? (
          <>
            <div style={ROW}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 500 }}>Camera for real tests</div>
                <div style={{ fontSize: 12, color: "var(--aiq-color-fg-secondary)", marginTop: 2 }}>
                  {settings.cameraEnabled ? "On. The camera checks real tests." : "Off. The camera is off until you turn it on."}
                </div>
              </div>
              <CameraSwitch
                checked={settings.cameraEnabled}
                disabled={busy}
                label="Camera for real tests"
                onChange={(next) => void patch({ cameraEnabled: next }, `Camera for real tests ${next ? "on" : "off"}.`)}
              />
            </div>
            <div style={ROW}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 500 }}>Photos</div>
                <div style={{ fontSize: 12, color: "var(--aiq-color-fg-secondary)", marginTop: 2 }}>
                  {settings.photosEnabled ? "On. Photos are taken during real tests." : "Off. No photos are taken."}
                </div>
              </div>
              <CameraSwitch
                checked={settings.photosEnabled}
                disabled={busy}
                label="Photos"
                onChange={(next) => void patch({ photosEnabled: next }, `Photos ${next ? "on" : "off"}.`)}
              />
            </div>
          </>
        ) : (
          <p style={{ ...ROW, margin: 0, fontSize: 13, color: "var(--aiq-color-fg-secondary)", lineHeight: 1.5 }}>
            Confirm the camera notice to publish tests with the camera.
          </p>
        )}

        {saveError !== null && (
          <div role="alert" style={{ marginTop: 12 }}>
            <Chip>{saveError}</Chip>
          </div>
        )}
        {saveSuccess !== null && (
          <div role="status" style={{ marginTop: 12 }}>
            <Chip variant="success">{saveSuccess}</Chip>
          </div>
        )}
      </Card>

      <CameraReviewersCard />
    </section>
  );
}
