// AssessIQ — Admin guide page.
//
// /admin/guide — end-to-end assessment workflow guide for tenant admins (L1→L3).
// Audience: tenant admins + reviewers learning the full workflow.
//
// Option A (v1): static JSX content baked in.  Fast to ship; full styling
// control via @assessiq/ui-system primitives.  No runtime fetch.
//
// Phase 4+ TODO: migrate content to modules/16-help-system as structured YAML
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
  "Create a pack",       // 01
  "Add levels",          // 02
  "Author questions",    // 03
  "Activate questions",  // 04
  "Publish the pack",    // 05
  "Create a cycle",      // 06
  "Publish assessment",  // 07
  "Invite candidates",   // 08
  "Candidates take",     // 09
  "Trigger grading",     // 10
  "Review & override",    // 11
  "Generate reports",    // 12
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

function Callout({ children }: { children: React.ReactNode }): React.ReactElement {
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

function Code({ children }: { children: string }): React.ReactElement {
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
            End-to-end flow from question pack to candidate report — L1
            (foundational) through L3 (expert).
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
            <P>A scenario-driven assessment in AssessIQ has three layers:</P>
            <UL
              items={[
                <><strong>Question Pack</strong> — a versioned bundle of questions.</>,
                <><strong>Level</strong> — difficulty tier within a pack (L1 junior, L2 mid, L3 senior).</>,
                <><strong>Assessment Cycle</strong> — a scheduled instance of a published pack with invited candidates.</>,
              ]}
            />
            <P>
              End-to-end flow:{" "}
              <strong>
                build pack → add levels → add questions → publish pack →
                create assessment → invite candidates → candidates take →
                AI grades → admin reviews → reports.
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
                <><strong>Admin role</strong> in your tenant.</>,
                <>Google Workspace account with <strong>TOTP MFA enrolled</strong>.</>,
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
            <StepCard number={1} title="Create a question pack">
              <P>
                Click <strong>Question Bank</strong> in the sidebar →{" "}
                <strong>+ New pack</strong> → name it (e.g. "SOC Analyst Q2
                2026") → add description + tags → <strong>Save</strong>.
              </P>
            </StepCard>

            {/* ── Step 2 ── */}
            <StepCard number={2} title="Add three levels — L1, L2, L3">
              <P>
                Open the pack → <strong>+ Add level</strong>. Create three
                levels:
              </P>
              <UL
                items={[
                  <><strong>L1 Foundational</strong> — knowledge checks, basic recognition.</>,
                  <><strong>L2 Applied</strong> — multi-step scenarios, intermediate reasoning.</>,
                  <><strong>L3 Expert</strong> — complex incident response, edge-case judgment.</>,
                ]}
              />
              <P>
                Each level has its own pass-band threshold (defaults are
                sensible).
              </P>
            </StepCard>

            {/* ── Step 3 ── */}
            <StepCard number={3} title="Author questions per level">
              <P>
                Open a level → <strong>+ Add question</strong>. Pick a type:
              </P>
              <UL
                items={[
                  <><strong>MCQ</strong> — auto-graded.</>,
                  <><strong>Short answer / KQL pattern</strong> — auto-graded.</>,
                  <><strong>Long answer</strong> — AI-graded with admin review.</>,
                  <><strong>Code paste</strong> — AI-graded.</>,
                ]}
              />
              <P>
                Write the prompt and <strong>rubric anchors</strong>. For each
                anchor band (0 / 25 / 50 / 75 / 100) describe what that level
                of answer looks like and provide one or two example answers.
                Add at least 5 questions per level.
              </P>
            </StepCard>

            {/* ── Step 4 ── */}
            <StepCard number={4} title="Activate questions">
              <P>
                Questions are <strong>draft</strong> by default. Use the{" "}
                <strong>Activate all</strong> affordance on the level page.
                Activated questions become eligible for assessments.
              </P>
            </StepCard>

            {/* ── Step 5 ── */}
            <StepCard number={5} title="Publish the pack">
              <P>
                From the pack overview → <strong>Publish</strong>. This
                snapshots the current pack version. New edits land in a new
                draft version; assessments stay locked to the published version
                they were created against.
              </P>
            </StepCard>
            </StepCard>

            {/* ── Step 6 ── */}
            <StepCard number={6} title="Create an assessment cycle">
              <P>
                Use the <strong>+ New assessment</strong> affordance on the
                Assessments page. Pick the published pack, set the open + close
                window, optionally pre-select levels. Save as draft.
              </P>
            </StepCard>

            {/* ── Step 7 ── */}
            <StepCard number={7} title="Publish the assessment">
              <P>
                Review settings → <strong>Publish</strong>. The cycle is live;
                invitations can now be sent.
              </P>
            </StepCard>

            {/* ── Step 8 ── */}
            <StepCard number={8} title="Invite candidates">
              <P>
                <strong>Users → + Invite user</strong> → role{" "}
                <Code>candidate</Code>, paste email, save.
              </P>
              <P>
                From the cycle detail page →{" "}
                <strong>+ Invite to assessment</strong> → select candidates →
                Send. Each candidate receives a magic-link email
                (single-use, 7-day TTL). Track invitation status on the cycle
                detail page.
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
                Candidates click the magic link → token landing → Start → the
                SPA shows the attempt UI. Autosave every 5 s, timer per level.
                Submit moves status <Code>in_progress</Code> →{" "}
                <Code>submitted</Code>. The attempt appears under{" "}
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
            <StepCard number={10} title="Trigger AI grading per attempt">
              <P>
                <strong>Attempts → click an attempt → Grade now.</strong>{" "}
                Phase 1 grading is synchronous — wait ~30–60 s while the AI
                grading engine runs under your admin account. Each subjective
                answer receives anchor + band (0/25/50/75/100) + justification.
                MCQ + KQL are scored immediately.
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
            <StepCard number={11} title="Review and accept or override">
              <P>
                On the attempt detail page, scroll through each question. The AI
                grade shows anchor + justification. For each subjective answer:
              </P>
              <UL
                items={[
                  <><strong>Accept</strong> — AI verdict stands.</>,
                  <><strong>Override</strong> — record your own band; the AI verdict is preserved beside it (audit trail, never replaced).</>,
                  <>Add reasoning in the <strong>comment field</strong>.</>,
                ]}
              />
            </StepCard>

            {/* ── Step 12 ── */}
            <StepCard number={12} title="Generate reports">
              <P>
                <strong>Reports → Cohort report</strong> — per-cycle rollup:
                pass rate, average band per level, archetype distribution. Or{" "}
                <strong>Individual report</strong> — per-candidate summary with
                anchor citations + recommendations. Export CSV from either
                view.
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
                  Grading jobs →
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
              body="AssessIQ never shows a raw '73%' — every score is one of {0, 25, 50, 75, 100}. Configure rubric anchors per question before publishing the pack."
            />
            <TipCard
              icon="eye"
              title="Audit log"
              body="Every grade trigger, override, and invite is captured in the append-only audit log. The Settings → Audit log page is coming soon. Records cannot be edited or deleted."
            />
            <TipCard
              icon="sparkle"
              title="Re-grading"
              body="Only the admin can re-trigger grading — no background AI calls. Re-trigger from the attempt detail page at any time."
            />
            <TipCard
              icon="grid"
              title="Multi-tenant"
              body="Every action is scoped to your tenant. You only see your tenant's data — question packs, users, grades, and reports are strictly isolated at the database row level."
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
                  q: "What if AI grading fails?",
                  a: "Admin can re-trigger. Failures are logged; no auto-retry in Phase 1.",
                },
                {
                  q: "Can I edit a published pack?",
                  a: "Yes, edits land in a new version. Existing assessments stay locked to the version snapshot they were created against.",
                },
                {
                  q: "What happens at the close window?",
                  a: "The cycle closes automatically. In-progress attempts auto-submit at their per-attempt timer expiry, regardless of cycle status.",
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
