/**
 * HelpContext — React context, value type, and hooks for the AssessIQ help system.
 *
 * Two hooks are exported:
 *   useHelpContext() — full context; throws in dev if no <HelpProvider> ancestor,
 *                      silently returns a no-op sentinel in production.
 *   useHelp(key)     — convenience hook returning the entry for `key` plus an
 *                      openDrawer callback pre-bound to that key.
 */
import { createContext, useContext } from 'react';
import type { HelpReadEnvelope } from '../src/types.js';

// ─── Public value type ────────────────────────────────────────────────────────

export interface HelpContextValue {
  /** e.g. 'admin.assessments.create' — matches the page param used for the batched fetch */
  page: string;
  audience: 'admin' | 'reviewer' | 'candidate' | 'all';
  /** BCP-47 locale tag, e.g. 'en', 'hi-IN' */
  locale: string;
  /** Keyed by help_id; populated after the fetch resolves */
  entries: ReadonlyMap<string, HelpReadEnvelope>;
  loading: boolean;
  error: Error | null;
  /** null when the drawer is closed; a help_id string when open (anchors to that section) */
  drawerOpenKey: string | null;
  /** Open the help drawer. Omitting `key` opens at the top of the drawer. */
  openDrawer: (key?: string) => void;
  closeDrawer: () => void;
  /** Fire-and-forget POST to /api/help/track. Errors are silently swallowed. */
  recordFeedback: (key: string, thumbsUp: boolean) => void;
}

// ─── Context ──────────────────────────────────────────────────────────────────

export const HelpContext = createContext<HelpContextValue | null>(null);
HelpContext.displayName = 'HelpContext';

// ─── Production no-op sentinel ────────────────────────────────────────────────
// Used when useHelpContext() is called outside a <HelpProvider> in production.
// Keeps the page functional even if the provider is accidentally omitted.

const SENTINEL: HelpContextValue = {
  page: '',
  audience: 'all',
  locale: 'en',
  entries: new Map(),
  loading: false,
  error: null,
  drawerOpenKey: null,
  openDrawer: () => {},
  closeDrawer: () => {},
  recordFeedback: () => {},
};

// ─── useHelpContext ───────────────────────────────────────────────────────────

/**
 * Returns the full HelpContextValue.
 *
 * In development: throws a clear Error when called outside a <HelpProvider>
 * so missing-provider bugs surface immediately during development.
 *
 * In production: silently returns the no-op sentinel so a missing provider
 * does not crash the page — help just fails to render.
 */
export function useHelpContext(): HelpContextValue {
  const ctx = useContext(HelpContext);

  if (ctx === null) {
    if (process.env['NODE_ENV'] !== 'production') {
      throw new Error(
        '[HelpContext] useHelpContext() was called outside a <HelpProvider>. ' +
          'Wrap the relevant subtree with <HelpProvider page="..." audience="...">.',
      );
    }
    // Production: degrade gracefully
    return SENTINEL;
  }

  return ctx;
}

// ─── useHelp ─────────────────────────────────────────────────────────────────

/**
 * Convenience hook for a single help entry.
 *
 * Returns:
 *   entry      — the HelpReadEnvelope for `key`, or null if not yet loaded / not
 *                present in the current page set.
 *   openDrawer — callback that opens the help drawer anchored to `key`.
 */
export function useHelp(key: string): {
  entry: HelpReadEnvelope | null;
  openDrawer: () => void;
} {
  const { entries, openDrawer } = useHelpContext();

  return {
    entry: entries.get(key) ?? null,
    openDrawer: () => openDrawer(key),
  };
}
