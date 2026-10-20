// Z-91: readiness check panel on the /take/:token landing.
// REAL exam: Begin stays disabled until every row passes. MOCK: the same panel is an optional
// "dress rehearsal" and never blocks. The signals are sent in the /take/start body and the
// server runs its own check, so a hand-made request cannot skip this page.
// Camera (Z-82): a REAL exam with camera_required adds a camera row. It is checked in the browser only
// and never sent to the server.

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Button, Chip } from '@assessiq/ui-system';
import {
  cameraFailureMessage,
  collectDeviceSignals,
  collectReadinessSignals,
  evaluateReadinessRows,
  type CameraCheckState,
  type DeviceSignals,
  type ReadinessRow,
  type ReadinessSignalsWire,
} from './readiness.js';

const SECTION: CSSProperties = {
  marginBottom: 16,
  padding: '14px 16px',
  border: '1px solid var(--aiq-color-border)',
  borderRadius: 'var(--aiq-radius-md)',
  background: 'var(--aiq-color-bg-raised)',
};

export interface CameraState {
  state: CameraCheckState;
  /** Plain-words message for a failed check. */
  message: string | null;
  stream: MediaStream | null;
  check: () => void;
}

export interface ReadinessState {
  rows: ReadinessRow[];
  running: boolean;
  /** True once the checks ran and every row passed (the camera row too, when it is required). */
  passed: boolean;
  device: DeviceSignals | null;
  signals: ReadinessSignalsWire | null;
  /** Null when the camera is not required for this test. */
  camera: CameraState | null;
  retry: () => void;
}

/**
 * Camera check. The stream runs only while `active`. It stops when `active` turns false,
 * when the candidate begins, and when the component unmounts. A late stream is stopped at once.
 */
export function useCameraCheck(active: boolean): CameraState & { state: CameraCheckState } {
  const [state, setState] = useState<CameraCheckState>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  const stopTracks = useCallback((): void => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setStream(null);
  }, []);

  const check = useCallback((): void => {
    stopTracks();
    setState('checking');
    setMessage(null);
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!md || typeof md.getUserMedia !== 'function') {
      setState('fail');
      setMessage(cameraFailureMessage(new Error('no camera API')));
      return;
    }
    md.getUserMedia({ video: true, audio: false })
      .then((s) => {
        if (!activeRef.current) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = s;
        setStream(s);
        setState('ok');
      })
      .catch((err: unknown) => {
        setState('fail');
        setMessage(cameraFailureMessage(err));
      });
  }, [stopTracks]);

  useEffect(() => {
    if (!active) {
      stopTracks();
      setState('idle');
      setMessage(null);
    }
  }, [active, stopTracks]);

  useEffect(
    () => () => {
      activeRef.current = false;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    },
    [],
  );

  return { state, message, stream, check };
}

/** Runs the checks on mount (when enabled) and on retry. The camera check is separate (button driven). */
export function useReadiness(enabled: boolean, cameraRequired: boolean, cameraActive: boolean): ReadinessState {
  const [rows, setRows] = useState<ReadinessRow[]>([]);
  const [running, setRunning] = useState(false);
  const [device, setDevice] = useState<DeviceSignals | null>(null);
  const [signals, setSignals] = useState<ReadinessSignalsWire | null>(null);
  const cam = useCameraCheck(cameraRequired && cameraActive);

  const run = useCallback((): void => {
    if (!enabled) return;
    setRunning(true);
    const d = collectDeviceSignals();
    setDevice(d);
    void collectReadinessSignals().then((s) => {
      setSignals(s);
      setRows(evaluateReadinessRows(s, d));
      setRunning(false);
    });
  }, [enabled]);

  useEffect(() => {
    run();
  }, [run]);

  const cameraOk = !cameraRequired || cam.state === 'ok';
  const passed = !running && rows.length > 0 && rows.every((r) => r.status === 'ok') && cameraOk;
  const camera: CameraState | null = cameraRequired
    ? { state: cam.state, message: cam.message, stream: cam.stream, check: cam.check }
    : null;
  return { rows, running, passed, device, signals, camera, retry: run };
}

/** Live picture so the candidate can fix angle and light. Muted, no sound. */
function CameraPreview({ stream }: { stream: MediaStream }): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.srcObject = stream;
    try {
      const p = v.play() as Promise<void> | undefined;
      void p?.catch?.(() => undefined);
    } catch {
      // Autoplay refused: the picture still shows once the browser starts it.
    }
  }, [stream]);
  return (
    <video
      ref={videoRef}
      muted
      autoPlay
      playsInline
      aria-label="Live picture from your camera"
      style={{ display: 'block', width: 240, maxWidth: '100%', marginTop: 8, borderRadius: 'var(--aiq-radius-md)', background: '#000' }}
    />
  );
}

export function ReadinessPanel({
  state,
  optional,
}: {
  state: ReadinessState;
  /** Mock test: shown as a dress rehearsal that never blocks Begin. */
  optional: boolean;
}): React.JSX.Element {
  const failed = state.rows.filter((r) => r.status === 'fail');
  const cam = state.camera;
  return (
    <section data-help-id="candidate.intro.readiness" aria-label="Readiness check" style={SECTION}>
      <h2
        style={{
          fontFamily: 'var(--aiq-font-sans)',
          fontSize: 14,
          fontWeight: 600,
          margin: '0 0 10px',
          color: 'var(--aiq-color-fg-primary)',
        }}
      >
        {optional ? 'Dress rehearsal (optional)' : 'Readiness check'}
      </h2>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: 13 }}>
        {state.running && state.rows.length === 0 && (
          <li style={{ color: 'var(--aiq-color-fg-secondary)' }}>Checking your device…</li>
        )}
        {state.rows.map((r) => (
          <li
            key={r.id}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '4px 0',
              color: 'var(--aiq-color-fg-secondary)',
            }}
          >
            <span>{r.label}</span>
            <Chip variant={r.status === 'ok' ? 'success' : 'warn'}>{r.status === 'ok' ? 'Pass' : 'Fix needed'}</Chip>
          </li>
        ))}
        {cam !== null && (
          <li
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '4px 0',
              color: 'var(--aiq-color-fg-secondary)',
            }}
          >
            <span>Camera</span>
            {cam.state === 'ok' ? (
              <Chip variant="success">Pass</Chip>
            ) : cam.state === 'fail' ? (
              <Chip variant="warn">Fix needed</Chip>
            ) : (
              <Chip variant="default">Not checked</Chip>
            )}
          </li>
        )}
      </ul>
      {failed.length > 0 && (
        <div role="alert" style={{ marginTop: 8, fontSize: 13, color: 'var(--aiq-color-fg-secondary)' }}>
          {failed.map((r) => (
            <p key={r.id} style={{ margin: '4px 0' }}>
              {r.message}
            </p>
          ))}
        </div>
      )}
      {cam !== null && (
        <div data-help-id="candidate.intro.camera_check" style={{ marginTop: 12 }}>
          {cam.state === 'fail' && cam.message !== null && (
            <p role="alert" style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--aiq-color-fg-secondary)' }}>
              {cam.message}
            </p>
          )}
          {cam.stream !== null && <CameraPreview stream={cam.stream} />}
          <div style={{ marginTop: 8 }}>
            <Button
              size="sm"
              variant="outline"
              onClick={cam.check}
              disabled={cam.state === 'checking'}
            >
              {cam.state === 'checking' ? 'Checking camera…' : cam.state === 'idle' ? 'Check camera' : 'Retry'}
            </Button>
          </div>
        </div>
      )}
      <div style={{ marginTop: 8 }}>
        <Button size="sm" variant="outline" onClick={state.retry} disabled={state.running}>
          {state.running ? 'Checking…' : 'Retry'}
        </Button>
      </div>
    </section>
  );
}
