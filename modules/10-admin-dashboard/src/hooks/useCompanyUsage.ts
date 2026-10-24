// AssessIQ - Z-149: one shared read of GET /api/billing/usage.
// All mounted consumers (shell pill, banner, page cards) share one fetch. The first consumer to mount fetches;
// when the last one unmounts the cache is dropped, so the next page mount reads fresh numbers.
// refetch() re-reads for everyone (call it after a grant or an invite).

import { useCallback, useEffect, useState } from "react";
import { getCompanyUsage, type CompanyUsage } from "../api.js";

interface Store { usage: CompanyUsage | null; loading: boolean; failed: boolean }

let store: Store = { usage: null, loading: false, failed: false };
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(next: Store): void {
  store = next;
  listeners.forEach((l) => l());
}

function load(): Promise<void> {
  if (inflight !== null) return inflight;
  set({ ...store, loading: true });
  inflight = getCompanyUsage()
    .then((u) => set({ usage: u, loading: false, failed: false }))
    .catch(() => set({ usage: store.usage, loading: false, failed: true })) // fail-silent: callers hide their UI
    .finally(() => { inflight = null; });
  return inflight;
}

export interface CompanyUsageState extends Store { refetch: () => Promise<void> }

export function useCompanyUsage(): CompanyUsageState {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = (): void => bump((n) => n + 1);
    listeners.add(l);
    if (store.usage === null && inflight === null) void load();
    return () => {
      listeners.delete(l);
      if (listeners.size === 0) store = { usage: null, loading: false, failed: false };
    };
  }, []);
  const refetch = useCallback(() => load(), []);
  return { ...store, refetch };
}

/** Test helper: drop the shared state. */
export function resetCompanyUsageForTests(): void {
  store = { usage: null, loading: false, failed: false };
  inflight = null;
  listeners.clear();
}
