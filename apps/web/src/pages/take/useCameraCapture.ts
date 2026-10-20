// Real-exam camera capture (candidate side). No AI, no face detection, no audio.
// Server contract: docs/03-api-contract.md "Real-exam camera routes".
// Photos: one JPEG every photoIntervalSeconds. Video: the latest 5 s segment is kept in memory
// and uploaded only when the camera stops or is blocked (a webm chunk is valid only with its header,
// so the recorder restarts for each segment instead of slicing one recording).

import { useCallback, useEffect, useRef, useState } from 'react';

export type CameraState = 'off' | 'starting' | 'on' | 'lost' | 'denied';
type Reason = 'camera_stopped' | 'camera_blocked';
interface CameraStatus { required: boolean; photos: boolean; video: boolean; photoIntervalSeconds: number }

const FIRST_PHOTO_MS = 5000;
const SEGMENT_MS = 5000;
const MAX_PHOTO_BYTES = 380 * 1024;
const MAX_VIDEOS = 10;

// Never throws; the candidate is never blocked by an upload error.
async function post(url: string, body: Blob, type: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'POST', credentials: 'include', headers: { 'Content-Type': type }, body });
    // eslint-disable-next-line no-console
    if (!res.ok && (res.status === 507 || res.status === 429)) console.warn('[camera] upload refused', res.status);
    return res.ok;
  } catch {
    return false;
  }
}

const toBlob = (c: HTMLCanvasElement, q: number): Promise<Blob | null> =>
  new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', q));

export function useCameraCapture(attemptId: string, opts: { active: boolean }): { state: CameraState; retry: () => void } {
  const [state, setState] = useState<CameraState>('off');
  const retryRef = useRef<() => void>(() => undefined);
  const { active } = opts;

  useEffect(() => {
    if (!active || attemptId === '') return;
    let dead = false;
    let stream: MediaStream | null = null;
    let recorder: MediaRecorder | null = null;
    let segTimer: ReturnType<typeof setTimeout> | undefined;
    let photoTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingReason: Reason | null = null;
    let incident = false;
    let videosSent = 0;
    let status: CameraStatus | null = null;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    const failedPhotos: Blob[] = []; // ponytail: each failed photo gets one more try at the next tick
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;

    const uploadVideo = (blob: Blob, reason: Reason): void => {
      if (videosSent >= MAX_VIDEOS || blob.size === 0) return;
      videosSent += 1;
      void post(`/api/me/attempts/${encodeURIComponent(attemptId)}/camera/video?reason=${reason}`, blob, 'video/webm');
    };

    // One segment: record SEGMENT_MS, keep it, then restart (or upload it when an incident is pending).
    const startSegment = (): void => {
      if (dead || stream === null || typeof MediaRecorder === 'undefined') return;
      const chunks: Blob[] = [];
      const r = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 250000 });
      recorder = r;
      r.ondataavailable = (e: BlobEvent) => { if (e.data.size > 0) chunks.push(e.data); };
      r.onstop = () => {
        if (dead) return;
        const blob = new Blob(chunks, { type: 'video/webm' });
        if (pendingReason !== null) { uploadVideo(blob, pendingReason); pendingReason = null; return; }
        startSegment();
      };
      r.start();
      segTimer = setTimeout(() => { if (r.state !== 'inactive') r.stop(); }, SEGMENT_MS);
    };

    const incidentStop = (reason: Reason): void => {
      if (dead || incident) return;
      incident = true;
      setState('lost');
      clearTimeout(segTimer);
      if (status?.video === true && recorder !== null && recorder.state !== 'inactive') {
        pendingReason = reason;
        recorder.stop();
      }
    };

    const takePhoto = async (): Promise<void> => {
      const ctx = canvas.getContext('2d');
      if (ctx === null) return;
      ctx.drawImage(video, 0, 0, 640, 480);
      let blob: Blob | null = null;
      for (const q of [0.6, 0.5, 0.4, 0.3, 0.2]) {
        blob = await toBlob(canvas, q);
        if (blob === null || blob.size <= MAX_PHOTO_BYTES) break;
      }
      if (blob === null || dead) return;
      const url = `/api/me/attempts/${encodeURIComponent(attemptId)}/camera/photo`;
      for (const old of failedPhotos.splice(0)) void post(url, old, 'image/jpeg'); // second and last try
      if (!(await post(url, blob, 'image/jpeg')) && !dead) failedPhotos.push(blob);
    };

    const schedulePhoto = (ms: number): void => {
      photoTimer = setTimeout(() => {
        if (dead) return;
        if (!incident) void takePhoto();
        schedulePhoto((status?.photoIntervalSeconds ?? 60) * 1000);
      }, ms);
    };

    const openCamera = async (): Promise<boolean> => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' }, audio: false });
      } catch (err) {
        if (!dead) setState(err instanceof DOMException && err.name === 'NotAllowedError' ? 'denied' : 'lost');
        return false;
      }
      if (dead) { stream.getTracks().forEach((t) => t.stop()); return false; }
      const track = stream.getVideoTracks()[0];
      track?.addEventListener('ended', () => incidentStop('camera_stopped'));
      track?.addEventListener('mute', () => incidentStop('camera_blocked'));
      video.srcObject = stream;
      void Promise.resolve(video.play()).catch(() => undefined);
      incident = false;
      setState('on');
      if (status?.video === true) startSegment();
      if (status?.photos === true && photoTimer === undefined) schedulePhoto(FIRST_PHOTO_MS);
      return true;
    };

    retryRef.current = () => {
      if (dead) return;
      clearTimeout(segTimer);
      stream?.getTracks().forEach((t) => t.stop());
      setState('starting');
      void openCamera();
    };

    void (async () => {
      try {
        const res = await fetch(`/api/me/attempts/${encodeURIComponent(attemptId)}/camera/status`, { credentials: 'include' });
        if (!res.ok) return;
        status = (await res.json()) as CameraStatus;
      } catch {
        return;
      }
      if (dead || !status.required) return;
      setState('starting');
      await openCamera();
    })();

    return () => {
      dead = true;
      clearTimeout(segTimer);
      clearTimeout(photoTimer);
      if (recorder !== null && recorder.state !== 'inactive') { recorder.onstop = null; recorder.stop(); }
      stream?.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
      setState('off');
    };
  }, [attemptId, active]);

  const retry = useCallback(() => retryRef.current(), []);
  return { state, retry };
}
