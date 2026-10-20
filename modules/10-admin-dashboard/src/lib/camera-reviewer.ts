// Camera feature: shows the "Camera review" nav entry only when the flagged-list probe succeeds.
// One probe per user per page load (module cache). A 403 (not a reviewer) or any error means hidden.
import { useEffect, useState } from "react";
import { listFlaggedCameraApi } from "../api/camera.js";

const cache = new Map<string, Promise<boolean>>();

export function probeCameraReviewer(userKey: string): Promise<boolean> {
  let p = cache.get(userKey);
  if (p === undefined) {
    p = listFlaggedCameraApi({ limit: 1 }).then(
      () => true,
      () => false,
    );
    cache.set(userKey, p);
  }
  return p;
}

export function useCameraReviewer(userKey: string | undefined): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    if (userKey === undefined) {
      setOk(false);
      return;
    }
    let live = true;
    void probeCameraReviewer(userKey).then((v) => {
      if (live) setOk(v);
    });
    return () => {
      live = false;
    };
  }, [userKey]);
  return ok;
}
