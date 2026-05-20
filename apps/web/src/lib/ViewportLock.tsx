import type { ReactNode } from 'react';

/**
 * ViewportLock — stub for Phase M5 of the Mobile Kit Port.
 *
 * Phase M5 will implement the admin "desktop-required" graceful-degrade
 * interstitial here, gated by `data-viewport="mobile"` on <html> and
 * route-aware (login/MFA routes still render normally; admin work
 * surfaces show the interstitial).
 *
 * See docs/plans/MOBILE_KIT_PORT.md § Phase M5.
 *
 * For M0, this is a pass-through.
 */
export function ViewportLock({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
