/**
 * HelpDrawerTrigger — circular (?) button for the page header.
 *
 * Click opens the help drawer at `<page>.page` (the convention from
 * docs/07-help-system.md § "The drawer is keyed by *page*"). Also installs a
 * global Cmd/Ctrl + / keyboard handler with input/textarea/contenteditable
 * guard so the shortcut never steals keys from text fields.
 *
 * If rendered outside a HelpProvider in production, the sentinel context
 * makes openDrawer a no-op — clicks do nothing, no crash.
 */
import React, { useEffect } from 'react';
import { useHelpContext } from './HelpContext.js';
import { HELP_DRAWER_ID } from './HelpDrawer.js';

export interface HelpDrawerTriggerProps {
  testId?: string;
}

export function HelpDrawerTrigger({ testId }: HelpDrawerTriggerProps): React.ReactElement {
  const { page, openDrawer } = useHelpContext();
  const drawerKey = `${page}.page`;

  // Cmd/Ctrl + / global keyboard shortcut. Bails when the key is being typed
  // into an input, textarea, or contenteditable element so the shortcut
  // does not interfere with normal text entry.
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key !== '/') return;

      const target = e.target;
      if (target instanceof HTMLInputElement) return;
      if (target instanceof HTMLTextAreaElement) return;
      if (target instanceof HTMLElement && target.isContentEditable) return;

      e.preventDefault();
      openDrawer(drawerKey);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [openDrawer, drawerKey]);

  return (
    <button
      type="button"
      onClick={() => openDrawer(drawerKey)}
      aria-label="Open help"
      aria-haspopup="dialog"
      aria-controls={HELP_DRAWER_ID}
      data-test-id={testId}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
        padding: 0,
        background: 'none',
        border: '1px solid var(--aiq-color-border, currentColor)',
        borderRadius: '50%',
        cursor: 'pointer',
        color: 'var(--aiq-color-fg-secondary, currentColor)',
        flexShrink: 0,
      }}
    >
      {/* Same minimal (?) glyph used in HelpTip — kept inline rather than
          importing a shared file to avoid coupling between trigger and tip. */}
      <svg
        width={14}
        height={14}
        viewBox="0 0 14 14"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <circle cx="7" cy="7" r="6" />
        <path d="M5.2 5.5a1.8 1.8 0 0 1 3.6 0c0 1-1.8 1.5-1.8 2.5" />
        <circle cx="7" cy="10.5" r="0.4" fill="currentColor" stroke="none" />
      </svg>
    </button>
  );
}

HelpDrawerTrigger.displayName = 'HelpDrawerTrigger';
