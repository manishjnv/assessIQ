// Camera feature: shows the "Camera review" nav entry only when the access probe says reviewer.
// One probe per user per page load (module cache). Not a reviewer or any error means hidden.
import { useEffect, useState } from "react";
import { cameraAccessApi } from "../api/camera.js";

const cache = new Map<string, Promise<boolean>>();

export function probeCameraReviewer(userKey: string): Promise<boolean> {
  let p = cache.get(userKey);
  if (p === undefined) {
    p = cameraAccessApi().then(
      (r) => r.reviewer,
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
