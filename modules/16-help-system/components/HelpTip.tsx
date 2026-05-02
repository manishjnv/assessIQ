/**
 * HelpTip — wraps a child element with a tooltip showing help shortText,
 * and renders an adjacent (?) icon button that opens the HelpDrawer.
 *
 * If the entry for `helpId` is not yet loaded or the key does not exist in
 * the current page's help set, the children are rendered unchanged with no
 * icon — graceful degradation, zero layout shift.
 */
import React from 'react';
import { Tooltip } from '@assessiq/ui-system';
import { useHelp } from './HelpContext.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HelpTipProps {
  /** The help_id key, e.g. 'admin.assessments.create.title'. */
  helpId: string;
  /** The element to annotate. Must be a single React element (not a string). */
  children: React.ReactElement;
  /** Tooltip placement relative to the wrapped child. Default: 'top'. */
  placement?: 'top' | 'bottom' | 'left' | 'right';
}

// ─── Inline (?) SVG icon ──────────────────────────────────────────────────────
// The Icon catalog (22 icons: search, arrow, arrowLeft, check, clock, home,
// grid, chart, user, settings, plus, close, play, pause, flag, book, code,
// drag, bell, eye, sparkle, google) has no "help" or "info" icon.
// We inline a minimal 14×14 circle-with-question-mark SVG rather than adding
// a dependency on a new icon or importing the branding template.

interface HelpIconProps {
  /** The help_id this icon is associated with; used to build aria-label. */
  helpId: string;
  onClick: React.MouseEventHandler<HTMLButtonElement>;
}

function HelpIcon({ helpId, onClick }: HelpIconProps): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Open help for ${helpId}`}
      aria-haspopup="dialog"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 14,
        height: 14,
        padding: 0,
        marginLeft: 4,
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        color: 'var(--aiq-color-fg-secondary, currentColor)',
        flexShrink: 0,
        verticalAlign: 'middle',
      }}
    >
      {/* 14×14 circle with a "?" glyph — intentionally minimal, inherits currentColor */}
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
        {/* Question mark stem */}
        <path d="M5.2 5.5a1.8 1.8 0 0 1 3.6 0c0 1-1.8 1.5-1.8 2.5" />
        {/* Question mark dot */}
        <circle cx="7" cy="10.5" r="0.4" fill="currentColor" stroke="none" />
      </svg>
    </button>
  );
}

// ─── HelpTip component ────────────────────────────────────────────────────────

export function HelpTip({
  helpId,
  children,
  placement = 'top',
}: HelpTipProps): React.ReactElement {
  const { entry, openDrawer } = useHelp(helpId);

  // Graceful degradation: if no entry, return child unmodified (no icon, no tooltip).
  if (entry === null) {
    return children;
  }

  return (
    <>
      <Tooltip content={entry.shortText} placement={placement}>
        {children}
      </Tooltip>
      <HelpIcon helpId={helpId} onClick={openDrawer} />
    </>
  );
}

HelpTip.displayName = 'HelpTip';
