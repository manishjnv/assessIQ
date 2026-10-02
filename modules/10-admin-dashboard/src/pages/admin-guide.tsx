// AssessIQ — Admin guide page.
//
// /admin/guide — end-to-end assessment workflow guide for tenant admins (L1→L3).
// Audience: tenant admins + reviewers learning the full workflow.
//
// Option A (v1): static JSX content baked in.  Fast to ship; full styling
// control via @assessiq/ui-system primitives.  No runtime fetch.
//
// Phase 4+ TODO(phase-4): migrate content to modules/16-help-system as structured YAML
// (Option B from the 2026-05-04 session brief) so the guide can be edited
// without a code-change + redeploy.
//
// Wrapped externally by <AdminShell> in apps/web/src/App.tsx — same pattern
// as /admin/users (commit 473fef1).  No AdminShell import here; pure content.
//
// INVARIANTS:
//  - No claude/anthropic imports or references.
//  - No AccessIQ_UI_Template/** imports (ESLint no-restricted-imports enforces).
//  - No new @assessiq/ui-system primitives — TOC and layout are inline flexbox.
//  - Navigation references use human-readable page / element names, never bare
//    URL strings, so future route renames don't silently break the guide.
//  - Step number circles show plain integers (1–12), no zero-padding.
//  - All 12 steps reference live pages as of commit 35f78e6 (Question Bank,
//    Assessments, Reports, Users, Attempts, Grading all in sidebar).
//  - The only "coming soon" note is the Audit log tip (Settings → Audit log
//    UI not yet shipped; raw log access via Settings → Audit is pending).

import React from "react";
import { useNavigate } from "react-router-dom";
import { Card, Icon } from "@assessiq/ui-system";
import type { IconName } from "@assessiq/ui-system";

// ── Section IDs ───────────────────────────────────────────────────────────────

const S = {
  OVERVIEW:      "guide-overview",
  PREREQUISITES: "guide-prerequisites",
  STEPS:         "guide-steps",
  TIPS:          "guide-tips",
  FAQ:           "guide-faq",
  step: (n: number) => `guide-step-${n}`,
} as const;

// ── Short TOC labels (one per step) ──────────────────────────────────────────

const STEP_LABELS: readonly string[] = [
  "Find your sets",      // 01
  "Copy a set",          // 02
  "Question types",      // 03
  "Build an assessment", // 04
  "Sections & timers",   // 05
  "Integrity settings",  // 06
  "Publish assessment",  // 07
  "Invite candidates",   // 08
  "Candidates take",     // 09
  "Evaluation",          // 10
  "Review & publish",    // 11
  "Reports & results",   // 12
];

// ── Shared style objects ──────────────────────────────────────────────────────

const SERIF_HEADING: React.CSSProperties = {
  fontFamily: "var(--aiq-font-serif)",
  fontWeight: 400,
  margin: 0,
  letterSpacing: "-0.02em",
  color: "var(--aiq-color-fg-primary)",
};

const MONO_LABEL: React.CSSProperties = {
  fontFamily: "var(--aiq-font-mono)",
  fontSize: "var(--aiq-text-xs)",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "var(--aiq-color-fg-muted)",
};

const BODY: React.CSSProperties = {
  fontFamily: "var(--aiq-font-sans)",
  fontSize: "var(--aiq-text-sm)",
  color: "var(--aiq-color-fg-secondary)",
  lineHeight: 1.65,
  margin: 0,
};

// ── Small primitives ──────────────────────────────────────────────────────────

function P({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <p style={{ ...BODY, marginBottom: "var(--aiq-space-sm)" }}>{children}</p>
  );
}

function UL({ items }: { items: React.ReactNode[] }): React.ReactElement {
  return (
    <ul
      style={{
        ...BODY,
        margin: 0,
        marginBottom: "var(--aiq-space-sm)",
        paddingLeft: "var(--aiq-space-xl)",
      }}
    >
      {items.map((item, i) => (
        <li key={i} style={{ marginBottom: 4 }}>
          {item}
        </li>
      ))}
    </ul>
  );
}

function _Callout({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div
      style={{
        marginTop: "var(--aiq-space-sm)",
        padding: "var(--aiq-space-sm) var(--aiq-space-md)",
        borderRadius: "var(--aiq-radius-sm)",
        background: "var(--aiq-color-bg-sunken)",
        borderLeft: "3px solid var(--aiq-color-accent)",
      }}
    >
      <p style={{ ...BODY, fontSize: "var(--aiq-text-xs)", margin: 0 }}>
        {children}
      </p>
    </div>
  );
}

function TocLink({
  href,
  label,
  sub = false,
}: {
  href: string;
  label: string;
  sub?: boolean;
}): React.ReactElement {
  const [hovered, setHovered] = React.useState(false);
  return (
    <a
      href={`#${href}`}
      style={{
        display: "block",
        fontFamily: "var(--aiq-font-sans)",
        fontSize: sub ? "var(--aiq-text-xs)" : 12,
        color: hovered
          ? "var(--aiq-color-fg-primary)"
          : "var(--aiq-color-fg-muted)",
        textDecoration: "none",
        padding: `${sub ? 2 : 5}px 0 ${sub ? 2 : 5}px ${sub ? 14 : 0}px`,
        lineHeight: 1.35,
        transition: "color var(--aiq-motion-duration-fast) ease",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {label}
    </a>
  );
}

// ── Step card ─────────────────────────────────────────────────────────────────

function StepCard({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  const numStr = String(number);
  return (
    <div id={S.step(number)} style={{ scrollMarginTop: "var(--aiq-space-xl)" }}>
      <Card padding="lg">
        {/* Step header */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: "var(--aiq-space-md)",
            marginBottom: "var(--aiq-space-md)",
          }}
        >
          {/* Number bubble */}
          <div
            style={{
              flexShrink: 0,
              width: 36,
              height: 36,
              borderRadius: "var(--aiq-radius-pill)",
              border: "1px solid var(--aiq-color-border-strong)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: "var(--aiq-font-mono)",
              fontSize: "var(--aiq-text-xs)",
              fontWeight: 500,
              letterSpacing: "0.04em",
              color: "var(--aiq-color-fg-secondary)",
            }}
          >
            {numStr}
          </div>

          {/* Title */}
          <div style={{ flex: 1, paddingTop: 6 }}>
            <h3
              style={{
                ...SERIF_HEADING,
                fontSize: "var(--aiq-text-lg)",
              }}
            >
              {title}
            </h3>
          </div>
        </div>

        {/* Content indented under the number */}
        <div style={{ paddingLeft: 52 }}>{children}</div>
      </Card>
    </div>
  );
}

// ── Tip card ──────────────────────────────────────────────────────────────────

function TipCard({
  icon,
  title,
  body,
}: {
  icon: IconName;
  title: string;
  body: string;
}): React.ReactElement {
  return (
    <Card padding="md">
      <div style={{ display: "flex", gap: "var(--aiq-space-md)", alignItems: "flex-start" }}>
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: "var(--aiq-radius-md)",
            background: "var(--aiq-color-accent-soft)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <Icon name={icon} size={16} color="var(--aiq-color-accent)" />
        </div>
        <div>
          <h3
            style={{
              fontFamily: "var(--aiq-font-serif)",
              fontSize: "var(--aiq-text-md)",
              fontWeight: 400,
              margin: 0,
              marginBottom: "var(--aiq-space-xs)",
              color: "var(--aiq-color-fg-primary)",
            }}
          >
            {title}
          </h3>
          <p style={{ ...BODY, margin: 0 }}>{body}</p>
        </div>
      </div>
    </Card>
  );
}

// ── Inline code ───────────────────────────────────────────────────────────────

function _Code({ children }: { children: string }): React.ReactElement {
  return (
    <code
      style={{
        fontFamily: "var(--aiq-font-mono)",
        fontSize: "var(--aiq-text-xs)",
        background: "var(--aiq-color-bg-sunken)",
        border: "1px solid var(--aiq-color-border)",
        borderRadius: "var(--aiq-radius-sm)",
        padding: "1px 5px",
      }}
    >
      {children}
    </code>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function AdminGuide(): React.ReactElement {
  const navigate = useNavigate();

  return (
    <div
      style={{
        display: "flex",
        gap: "var(--aiq-space-2xl)",
        alignItems: "flex-start",
      }}
    >
      {/* ── Main content ─────────────────────────────────────────────── */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          gap: "var(--aiq-space-xl)",
        }}
      >
        {/* Page title */}
        <div>
          <span style={MONO_LABEL}>Admin guide</span>
          <h1
            style={{
              ...SERIF_HEADING,
              fontSize: "var(--aiq-text-3xl)",
              marginTop: "var(--aiq-space-xs)",
              marginBottom: "var(--aiq-space-xs)",
            }}
          >
            Conducting an assessment.
          </h1>
          <p
            style={{
              ...BODY,
              fontSize: "var(--aiq-text-md)",
              color: "var(--aiq-color-fg-secondary)",
            }}
          >
            From a licensed question set to candidate results.
          </p>
        </div>

        {/* ── Overview ─────────────────────────────────────────────── */}
        <section
          id={S.OVERVIEW}
          style={{ scrollMarginTop: "var(--aiq-space-xl)" }}
        >
          <h2
            style={{
              ...SERIF_HEADING,
              fontSize: "var(--aiq-text-xl)",
              marginBottom: "var(--aiq-space-md)",
            }}
          >
            Overview — the three-layer model.
          </h2>
          <Card padding="md">
            <P>An assessment in AssessIQ uses three things:</P>
            <UL
              items={[
                <><strong>Licensed set</strong> — a question set that AssessIQ writes and your company is licensed to use.</>,
                <><strong>Your copy</strong> — a copy (clone) of a licensed set in your Question Bank. You build assessments from it.</>,
                <><strong>Assessment</strong> — a scheduled test with invited candidates.</>,
              ]}
            />
            <P>
              End-to-end flow:{" "}
              <strong>
                copy a set → build an assessment → invite candidates →
                candidates take the test → AssessIQ evaluates written answers →
                you review and publish → reports.
              </strong>
            </P>
          </Card>
        </section>

        {/* ── Prerequisites ────────────────────────────────────────── */}
        <section
          id={S.PREREQUISITES}
          style={{ scrollMarginTop: "var(--aiq-space-xl)" }}
        >
          <h2
            style={{
              ...SERIF_HEADING,
              fontSize: "var(--aiq-text-xl)",
              marginBottom: "var(--aiq-space-md)",
            }}
          >
            Prerequisites.
          </h2>
          <Card padding="md">
            <UL
              items={[
                <><strong>Admin role</strong> in your company account.</>,
                <>Two-factor sign-in (MFA) is <strong>optional and recommended</strong>.</>,
                <>List of <strong>candidate email addresses</strong> ready.</>,
              ]}
            />
          </Card>
        </section>

        {/* ── Steps ────────────────────────────────────────────────── */}
        <section id={S.STEPS}>
          <h2
            style={{
              ...SERIF_HEADING,
              fontSize: "var(--aiq-text-xl)",
              marginBottom: "var(--aiq-space-md)",
            }}
          >
            The 12-step workflow.
          </h2>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--aiq-space-md)",
            }}
          >
            {/* ── Step 1 ── */}
            <StepCard number={1} title="Find your licensed sets">
              <P>
                Click <strong>Question Bank</strong> in the sidebar. The
                licensed sets section lists the sets your company can use.
                AssessIQ writes all question sets. Your company does not write
                them. To get more sets, contact your AssessIQ administrator.
              </P>
            </StepCard>

            {/* ── Step 2 ── */}
            <StepCard number={2} title="Copy a set">
              <P>
                Import a licensed set to make your own copy (a clone). The copy
                appears in your Question Bank. When AssessIQ updates the
                original, an update option shows on the set.
              </P>
            </StepCard>

            {/* ── Step 3 ── */}
            <StepCard number={3} title="Know the question types">
              <P>A set can contain these question types:</P>
              <UL
                items={[
                  <><strong>MCQ</strong>, <strong>Multi-select</strong>, <strong>Numeric</strong> and <strong>Ordering</strong> — scored automatically when the candidate submits.</>,
                  <><strong>Subjective</strong>, <strong>KQL</strong>, <strong>Log analysis</strong> and <strong>Scenario</strong> — evaluated by AssessIQ. You review and publish the result.</>,
                ]}
              />
            </StepCard>

            {/* ── Step 4 ── */}
            <StepCard number={4} title="Build an assessment">
              <P>
                Click <strong>Assessments</strong> → <strong>+ New Assessment</strong>.
                Pick a set, then set the name and the open and close window.
                Save the assessment as a draft.
              </P>
            </StepCard>

            {/* ── Step 5 ── */}
            <StepCard number={5} title="Add sections and timers">
              <P>
                When you build from a set, you can split the test into
                sections. Each section has its own time limit. You can allow
                an on-screen calculator in a section.
              </P>
            </StepCard>

            {/* ── Step 6 ── */}
            <StepCard number={6} title="Set integrity options">
              <P>
                Turn on the options you need: a fullscreen requirement for the
                candidate, and a block on copy and paste. You can change these
                on the assessment page. AssessIQ does not use webcam proctoring.
              </P>
            </StepCard>

            {/* ── Step 7 ── */}
            <StepCard number={7} title="Publish the assessment">
              <P>
                Review the settings → <strong>Publish</strong>. The assessment
                is live and you can send invitations.
              </P>
            </StepCard>

            {/* ── Step 8 ── */}
            <StepCard number={8} title="Invite candidates">
              <P>
                Open the assessment page. Invite candidates one by one, or use{" "}
                <strong>Import from CSV</strong> to add many at once (up to 1,000 rows in one file).
              </P>
              <P>
                Each candidate receives an email with a link that is valid for
                7 days. Track invitation status on the assessment page. If a candidate misses the window, press{" "}
                <strong>Resend</strong> on their row (or{" "}
                <strong>Resend to everyone who hasn&apos;t started</strong>) —
                they get a fresh 7-day link and the old one stops working.
              </P>
              <div style={{ marginTop: "var(--aiq-space-sm)" }}>
                <button
                  type="button"
                  className="aiq-btn aiq-btn-outline aiq-btn-sm"
                  onClick={() => navigate("/admin/users")}
                >
                  Open Users →
                </button>
              </div>
            </StepCard>

            {/* ── Step 9 ── */}
            <StepCard number={9} title="Candidates take the assessment">
              <P>
                Candidates open the link and start the test. The timer starts when
                they begin. When a candidate submits, the attempt appears under{" "}
                <strong>Attempts</strong> in your sidebar.
              </P>
              <div style={{ marginTop: "var(--aiq-space-sm)" }}>
                <button
                  type="button"
                  className="aiq-btn aiq-btn-outline aiq-btn-sm"
                  onClick={() => navigate("/admin/attempts")}
                >
                  View Attempts →
                </button>
              </div>
            </StepCard>

            {/* ── Step 10 ── */}
            <StepCard number={10} title="AssessIQ evaluates written answers">
              <P>
                <strong>You don't grade anything.</strong>{" "}
                Multiple-choice answers are scored the moment a candidate
                submits. Written answers are evaluated by AssessIQ evaluators
                with AI assistance. When an attempt is evaluated it shows as{" "}
                <strong>Ready to publish</strong> on the Attempts page; until
                then it shows <strong>Awaiting evaluation</strong> and no score
                is visible.
              </P>
              <div style={{ marginTop: "var(--aiq-space-sm)" }}>
                <button
                  type="button"
                  className="aiq-btn aiq-btn-outline aiq-btn-sm"
                  onClick={() => navigate("/admin/attempts")}
                >
                  View Attempts →
                </button>
              </div>
            </StepCard>

            {/* ── Step 11 ── */}
            <StepCard number={11} title="Review and publish">
              <P>
                Open an attempt marked <strong>Ready to publish</strong> and
                scroll through each question: the final score, the evidence and
                the reasoning behind it. Then:
              </P>
              <UL
                items={[
                  <><strong>Publish to candidate</strong> — the candidate sees the result. On the assessment page, <strong>Publish all ready</strong> does this for every ready attempt at once. In Settings you choose the result release mode: <strong>Manual</strong> (the default) or <strong>Automatic</strong>. With Automatic, results publish when they are ready. Candidates see only complete scores.</>,
                  <><strong>Override</strong> — record your own score with a reason; the evaluator's score is kept beside it (audit trail, never replaced).</>,
                  <><strong>Send back for re-evaluation</strong> — return the attempt to AssessIQ with a note.</>,
                ]}
              />
            </StepCard>

            {/* ── Step 12 ── */}
            <StepCard number={12} title="Generate reports">
              <P>
                <strong>Reports</strong> has a cohort report for each assessment
                and an individual report for each candidate. On the assessment
                page, <strong>Download results (CSV)</strong> exports the
                results. <strong>Certificates</strong> in the sidebar lists the
                certificates you have issued.
              </P>
              <div
                style={{
                  display: "flex",
                  gap: "var(--aiq-space-sm)",
                  marginTop: "var(--aiq-space-sm)",
                }}
              >
                <button
                  type="button"
                  className="aiq-btn aiq-btn-outline aiq-btn-sm"
                  onClick={() => navigate("/admin/attempts")}
                >
                  View Attempts →
                </button>
                <button
                  type="button"
                  className="aiq-btn aiq-btn-outline aiq-btn-sm"
                  onClick={() => navigate("/admin/grading-jobs")}
                >
                  How grading works →
                </button>
              </div>
            </StepCard>
          </div>
        </section>

        {/* ── Tips ─────────────────────────────────────────────────── */}
        <section id={S.TIPS} style={{ scrollMarginTop: "var(--aiq-space-xl)" }}>
          <h2
            style={{
              ...SERIF_HEADING,
              fontSize: "var(--aiq-text-xl)",
              marginBottom: "var(--aiq-space-md)",
            }}
          >
            Tips.
          </h2>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--aiq-space-md)",
            }}
          >
            <TipCard
              icon="chart"
              title="Bands, not percentages"
              body="Written answers are scored in bands: 0, 25, 50, 75 or 100. Each band comes with evidence and reasoning."
            />
            <TipCard
              icon="eye"
              title="Audit log"
              body="Admin actions are recorded."
            />
            <TipCard
              icon="sparkle"
              title="Re-evaluation"
              body="Not happy with a score? Override it with a reason, or send the attempt back to AssessIQ for re-evaluation with a note. AssessIQ does the evaluation, not your company."
            />
            <TipCard
              icon="grid"
              title="Multi-tenant"
              body="Every action is scoped to your tenant. You only see your tenant's data — question sets, users, grades, and reports are strictly isolated at the database row level."
            />
            <TipCard
              icon="sparkle"
              title="Where your questions come from"
              body="AssessIQ writes all question sets. Your company works from the sets it is licensed to use. If you publish an assessment with a set you are not licensed for, publishing is refused and the assessment stays in draft. Contact your AssessIQ administrator to get more sets."
            />
            <TipCard
              icon="chart"
              title="Your plan & usage"
              body="One credit is used when a candidate attempt is graded. Re-grading the same attempt never charges again. The banner at the top of your dashboard turns amber when you reach 80% of your included credits and red when you go over — but grading never stops. Contact your AssessIQ administrator to discuss your plan."
            />
          </div>
        </section>

        {/* ── FAQ ──────────────────────────────────────────────────── */}
        <section id={S.FAQ} style={{ scrollMarginTop: "var(--aiq-space-xl)" }}>
          <h2
            style={{
              ...SERIF_HEADING,
              fontSize: "var(--aiq-text-xl)",
              marginBottom: "var(--aiq-space-md)",
            }}
          >
            FAQ.
          </h2>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--aiq-space-md)",
            }}
          >
            {(
              [
                {
                  q: "Can a candidate retake?",
                  a: "Not by default. Admin manually creates a new invitation if needed.",
                },
                {
                  q: "What if the evaluation of an attempt fails?",
                  a: "AssessIQ handles it. An attempt stays in the AssessIQ queue until every question has a final score, and nothing is shown to the candidate before that.",
                },
                {
                  q: "Does a change to a licensed set change my assessments?",
                  a: "No. Existing assessments keep the questions they were published with.",
                },
                {
                  q: "What happens at the close window?",
                  a: "The cycle closes automatically. In-progress attempts auto-submit at their per-attempt timer expiry, regardless of cycle status.",
                },
                {
                  q: "Why can't I write questions?",
                  a: "AssessIQ writes all question sets. Company admins do not write them. You copy the sets your company is licensed for and build assessments from them. Contact your AssessIQ administrator to request more sets.",
                },
                {
                  q: "What does the usage banner mean — will grading stop if I go over?",
                  a: "No — grading never stops. The banner is informational only. Green means you have used less than 80% of your included credits. Amber means 80–100% used. Red means you are over your included credits, but assigning, submitting, and grading all continue to work. Contact your AssessIQ administrator if you need to discuss your plan.",
                },
              ] as Array<{ q: string; a: string }>
            ).map(({ q, a }) => (
              <Card key={q} padding="md">
                <h3
                  style={{
                    fontFamily: "var(--aiq-font-sans)",
                    fontSize: "var(--aiq-text-sm)",
                    fontWeight: 600,
                    margin: 0,
                    marginBottom: "var(--aiq-space-xs)",
                    color: "var(--aiq-color-fg-primary)",
                  }}
                >
                  {q}
                </h3>
                <p style={{ ...BODY, margin: 0 }}>{a}</p>
              </Card>
            ))}
          </div>
        </section>
      </div>

      {/* ── TOC sidebar ──────────────────────────────────────────────────── */}
      <aside
        style={{
          width: 192,
          flexShrink: 0,
          position: "sticky",
          top: "var(--aiq-space-xl)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <span
          style={{ ...MONO_LABEL, marginBottom: "var(--aiq-space-sm)", display: "block" }}
        >
          On this page
        </span>
        <TocLink href={S.OVERVIEW} label="Overview" />
        <TocLink href={S.PREREQUISITES} label="Prerequisites" />
        <TocLink href={S.STEPS} label="Steps" />
        {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
          <TocLink
            key={n}
            href={S.step(n)}
            label={`${n} — ${STEP_LABELS[n - 1]}`}
            sub
          />
        ))}
        <TocLink href={S.TIPS} label="Tips" />
        <TocLink href={S.FAQ} label="FAQ" />
      </aside>
    </div>
  );
}
