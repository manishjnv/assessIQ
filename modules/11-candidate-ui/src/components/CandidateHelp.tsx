// CandidateHelp — self-contained inline help drawer for the candidate take flow.
//
// Intentionally STANDALONE from @assessiq/help-system (Phase 4+ TODO: connect
// to 16-help-system content store for i18n + admin-overridable copy).
//
// Renders in two modes:
//   1. Default (<CandidateHelp />) — circular (?) trigger button, same glyph
//      as HelpDrawerTrigger. Placed in the Attempt.tsx top bar.
//   2. Text link (<CandidateHelp triggerLabel="Need more help?" />) — plain
//      link-style button for TokenLanding's "Before you begin" block.
//
// Drawer closes on: Escape, click-outside (backdrop), or Close button.
// Uses Drawer from @assessiq/ui-system (exported since G2.C 18fece2).
//
// Hard rules honoured:
//  - Zero claude/anthropic mentions in candidate-facing copy.
//  - No jargon (Phase 1, BullMQ, tenant_id, anchor band).
//  - No AssessIQ support contact — always via the person who invited you.
//  - No AccessIQ_UI_Template import.
//  - Content verified against Attempt.tsx v1 shipped behavior:
//      - Next/Prev: bottom bar ✓
//      - Flag: bottom bar flag toggle ✓
//      - AutosaveIndicator: "Saved" / "Saved · Xm ago" label ✓
//      - Timer auto-submit: handleExpire → navigate(.../submitted) ✓
//      - Submit button: bottom bar (NOT top) — copy corrected from spec draft.
//      - Magic-link TTL: 7 days per 01-auth addendum ✓

import React, { useState, type CSSProperties } from "react";
import { Drawer } from "@assessiq/ui-system";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CandidateHelpProps {
  /**
   * When provided, renders a plain text-link trigger instead of the circular
   * (?) icon button. Use on TokenLanding's "Before you begin" block.
   */
  triggerLabel?: string;
  /** data-test-id forwarded to the trigger element. */
  "data-test-id"?: string;
}

// ---------------------------------------------------------------------------
// Style constants
// ---------------------------------------------------------------------------

const SECTION_H2: CSSProperties = {
  fontFamily: "var(--aiq-font-sans)",
  fontSize: 13,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--aiq-color-fg-muted)",
  margin: "0 0 10px",
  padding: "0",
};

const BODY_P: CSSProperties = {
  fontFamily: "var(--aiq-font-sans)",
  fontSize: 14,
  lineHeight: 1.6,
  color: "var(--aiq-color-fg-primary)",
  margin: "0 0 8px",
};

const UL: CSSProperties = {
  margin: "0 0 8px",
  paddingLeft: 20,
};

const LI: CSSProperties = {
  fontFamily: "var(--aiq-font-sans)",
  fontSize: 14,
  lineHeight: 1.6,
  color: "var(--aiq-color-fg-primary)",
  marginBottom: 6,
};

const SECTION: CSSProperties = {
  marginBottom: 28,
};

const DIVIDER: CSSProperties = {
  borderTop: "1px solid var(--aiq-color-border)",
  margin: "0 0 24px",
};

const FOOTER_P: CSSProperties = {
  fontFamily: "var(--aiq-font-sans)",
  fontSize: 13,
  color: "var(--aiq-color-fg-muted)",
  margin: 0,
  lineHeight: 1.5,
};

// ---------------------------------------------------------------------------
// FAQ content — pure JSX, no markdown parser
// ---------------------------------------------------------------------------

function FaqContent(): React.ReactElement {
  return (
    <div>
      {/* ── How does this work? ────────────────────────────────────────── */}
      <section style={SECTION} aria-label="How does this work?">
        <h2 style={SECTION_H2}>How does this work?</h2>
        <ul style={UL}>
          <li style={LI}>The assessment has questions across difficulty levels.</li>
          <li style={LI}>
            Each question shows on its own page. Use Next / Previous to move
            between them. You can flag a question to come back to it later.
          </li>
          <li style={LI}>A timer at the top counts down the time you have left.</li>
        </ul>
      </section>

      <hr style={DIVIDER} aria-hidden="true" />

      {/* ── About my answers ──────────────────────────────────────────── */}
      <section style={SECTION} aria-label="About my answers">
        <h2 style={SECTION_H2}>About my answers</h2>
        <ul style={UL}>
          <li style={LI}>
            Your answers save automatically every few seconds. The{" "}
            <strong>Saved</strong> status shows when the latest save completed.
          </li>
          <li style={LI}>
            You don't need to click Save anywhere — there isn't a Save button.
            {" "}(If your network is slow, autosave queues your changes; they'll go
            through when connection recovers.)
          </li>
          <li style={LI}>
            Multiple choice and code questions get scored automatically. Long
            answer questions are reviewed by an AI grader plus a human reviewer.
          </li>
        </ul>
      </section>

      <hr style={DIVIDER} aria-hidden="true" />

      {/* ── Submitting ────────────────────────────────────────────────── */}
      <section style={SECTION} aria-label="Submitting">
        <h2 style={SECTION_H2}>Submitting</h2>
        <ul style={UL}>
          <li style={LI}>
            Click <strong>Submit</strong> on the last question (or use the Submit
            button at the bottom) when you're done.
          </li>
          <li style={LI}>Once submitted, you cannot change your answers.</li>
          <li style={LI}>
            You'll see a confirmation page. After that, your hiring team takes
            over.
          </li>
        </ul>
      </section>

      <hr style={DIVIDER} aria-hidden="true" />

      {/* ── If something goes wrong ────────────────────────────────────── */}
      <section style={SECTION} aria-label="If something goes wrong">
        <h2 style={SECTION_H2}>If something goes wrong</h2>
        <ul style={UL}>
          <li style={LI}>
            <strong>Browser crashed</strong> → open the same magic-link email
            again. Your answers are saved.
          </li>
          <li style={LI}>
            <strong>Internet dropped</strong> → keep the page open if possible;
            autosave will catch up when you reconnect. If you need to close, your
            latest saved answers are safe.
          </li>
          <li style={LI}>
            <strong>Timer ran out</strong> → your attempt auto-submits with
            whatever you've saved.
          </li>
          <li style={LI}>
            <strong>Magic link doesn't work</strong> → contact the person who
            invited you. The link expires 7 days after it's sent, and is
            single-use after you start (a new link can be issued by the admin).
          </li>
        </ul>
      </section>

      <hr style={DIVIDER} aria-hidden="true" />

      {/* ── Privacy ────────────────────────────────────────────────────── */}
      <section style={SECTION} aria-label="Privacy">
        <h2 style={SECTION_H2}>Privacy</h2>
        <ul style={UL}>
          <li style={LI}>
            Your answers are visible only to the hiring team for this assessment.
          </li>
          <li style={LI}>
            AssessIQ does not share your answers with any third party.
          </li>
        </ul>
      </section>

      <hr style={DIVIDER} aria-hidden="true" />

      {/* ── Tips ──────────────────────────────────────────────────────── */}
      <section style={SECTION} aria-label="Tips">
        <h2 style={SECTION_H2}>Tips</h2>
        <ul style={UL}>
          <li style={LI}>
            Read each question carefully. Partial credit is awarded — answers are
            rated on a band (not all-or-nothing).
          </li>
          <li style={LI}>
            For code or scenario questions, include your reasoning, not just the
            final answer.
          </li>
          <li style={LI}>
            If a question seems unclear, answer to the best of your understanding.
            Reviewers see what you wrote; they understand candidates may interpret
            ambiguity differently.
          </li>
        </ul>
      </section>

      <hr style={DIVIDER} aria-hidden="true" />

      {/* ── Footer ────────────────────────────────────────────────────── */}
      <p style={FOOTER_P}>
        Questions about this assessment? Contact the person who sent you the
        invitation.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CandidateHelp component
// ---------------------------------------------------------------------------

export function CandidateHelp({
  triggerLabel,
  "data-test-id": testId,
}: CandidateHelpProps): React.ReactElement {
  const [open, setOpen] = useState(false);

  // ── Trigger button ────────────────────────────────────────────────────────

  const circularTrigger = (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label="Open help"
      aria-haspopup="dialog"
      data-test-id={testId ?? "candidate-help-trigger"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 28,
        height: 28,
        padding: 0,
        background: "none",
        border: "1px solid var(--aiq-color-border, currentColor)",
        borderRadius: "50%",
        cursor: "pointer",
        color: "var(--aiq-color-fg-secondary, currentColor)",
        flexShrink: 0,
      }}
    >
      {/* (?) glyph — same as HelpDrawerTrigger; kept inline to avoid coupling */}
      <svg
        width={14}
        height={14}
        viewBox="0 0 14 14"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="7" cy="7" r="6" />
        <path d="M5.2 5.5a1.8 1.8 0 0 1 3.6 0c0 1-1.8 1.5-1.8 2.5" />
        <circle cx="7" cy="10.5" r="0.4" fill="currentColor" stroke="none" />
      </svg>
    </button>
  );

  const textTrigger = (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label="Open help"
      aria-haspopup="dialog"
      data-test-id={testId ?? "candidate-help-trigger"}
      style={{
        background: "none",
        border: "none",
        padding: 0,
        cursor: "pointer",
        fontFamily: "var(--aiq-font-sans)",
        fontSize: 13,
        color: "var(--aiq-color-accent)",
        textDecoration: "underline",
        textUnderlineOffset: 2,
      }}
    >
      {triggerLabel}
    </button>
  );

  // ── Drawer ────────────────────────────────────────────────────────────────

  return (
    <>
      {triggerLabel !== undefined ? textTrigger : circularTrigger}
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="Help"
        width={520}
        data-test-id="candidate-help-drawer"
      >
        <FaqContent />
      </Drawer>
    </>
  );
}

CandidateHelp.displayName = "CandidateHelp";
