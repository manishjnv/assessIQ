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
//  - Status badges accurately reflect the current shipped state (2026-05-04):
//    steps 1–7 are Phase 3+ (question-bank + assessment-lifecycle pages not yet
//    routed); steps 8–12 reference live pages (users, attempts, grading, reports).

import React from "react";
import { useNavigate } from "react-router-dom";
import { Card, Chip, Icon } from "@assessiq/ui-system";
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
  "Review verdicts",     // 11
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
  live,
  children,
}: {
  number: number;
  title: string;
  live: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  const numStr = String(number).padStart(2, "0");
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

          {/* Title + status chip */}
          <div style={{ flex: 1, paddingTop: 6 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--aiq-space-sm)",
                flexWrap: "wrap",
              }}
            >
              <h3
                style={{
                  ...SERIF_HEADING,
                  fontSize: "var(--aiq-text-lg)",
                }}
              >
                {title}
              </h3>
              <Chip variant={live ? "success" : "default"}>
                {live ? "Live" : "Phase 3+"}
              </Chip>
            </div>
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
                    label: "Pack",
                    body: "The library of questions, organised into levels. A pack defines the domain (e.g. SOC operations). Publishing a pack creates an immutable snapshot — assessment cycles always reference a fixed version of the content.",
                  },
                  {
                    label: "Level",
                    body: "A tier within the pack: L1 (foundational — scenario knowledge), L2 (applied — tool proficiency under pressure), L3 (expert — cross-domain synthesis). Levels are defined by the pack author, not the platform.",
                  },
                  {
                    label: "Cycle",
                    body: "One run of an assessment against a published pack for a cohort of candidates. Cycles are time-bounded, produce individual and aggregate reports, and can reference any published version of the pack.",
                  },
                ] as Array<{ label: string; body: string }>
              ).map(({ label, body }) => (
                <div
                  key={label}
                  style={{
                    display: "flex",
                    gap: "var(--aiq-space-md)",
                    alignItems: "flex-start",
                  }}
                >
                  <span
                    style={{
                      fontFamily: "var(--aiq-font-mono)",
                      fontSize: "var(--aiq-text-xs)",
                      fontWeight: 500,
                      textTransform: "uppercase",
                      letterSpacing: "0.08em",
                      color: "var(--aiq-color-accent)",
                      width: 52,
                      flexShrink: 0,
                      paddingTop: 2,
                    }}
                  >
                    {label}
                  </span>
                  <p style={{ ...BODY, margin: 0 }}>{body}</p>
                </div>
              ))}
            </div>
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
                <>
                  <strong>Admin role</strong> — reviewer accounts cannot create
                  packs, cycles, or invite users.
                </>,
                <>
                  <strong>Question pack with published questions</strong> —
                  cycles reference a published pack version. Complete steps 1–5
                  before creating a cycle.
                </>,
                <>
                  <strong>Candidate users</strong> — candidates must be added
                  in <strong>Users</strong> (sidebar) with{" "}
                  <Code>role=candidate</Code> before cycle assignment.
                </>,
                <>
                  <strong>AI grading integration</strong> — short-answer, essay,
                  KQL, and code questions use the Claude Code CLI integration on
                  the VPS. Verify the integration is active in{" "}
                  <strong>Settings → Integrations</strong> before triggering
                  grading.
                </>,
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
            <StepCard number={1} title="Create a question pack" live={false}>
              <P>
                Navigate to <strong>Question Bank → Packs</strong> in the
                sidebar and click <strong>+ New pack</strong>. Give the pack a
                name (e.g. "SOC Operations — L1–L3") and a short description.
              </P>
              <P>
                A pack is the container for all levels and questions. It is
                versioned — publishing creates an immutable snapshot, so
                assessment cycles always run against a known version of the
                content.
              </P>
            </StepCard>

            {/* ── Step 2 ── */}
            <StepCard number={2} title="Add three levels — L1, L2, L3" live={false}>
              <P>
                Inside the pack detail page, click <strong>+ Add level</strong>{" "}
                three times. Configure each level:
              </P>
              <UL
                items={[
                  <>
                    <strong>L1 — Foundational:</strong> scenario knowledge,
                    recognition, basic SOC tooling.
                  </>,
                  <>
                    <strong>L2 — Applied:</strong> tool proficiency under time
                    pressure, triage decisions.
                  </>,
                  <>
                    <strong>L3 — Expert:</strong> cross-domain synthesis,
                    escalation judgement, incident command.
                  </>,
                ]}
              />
              <P>
                Level labels and descriptions appear in candidate-facing reports
                and in the cohort rollup. The level ordering determines the
                sequence candidates encounter if level-gating is enabled on the
                cycle.
              </P>
            </StepCard>

            {/* ── Step 3 ── */}
            <StepCard number={3} title="Author questions per level" live={false}>
              <P>
                Select a level and click <strong>+ New question</strong>.
                AssessIQ supports five question types:
              </P>
              <UL
                items={[
                  <>
                    <strong>MCQ</strong> — multiple choice, single correct
                    answer. Auto-graded immediately on submission.
                  </>,
                  <>
                    <strong>KQL pattern</strong> — candidate writes a query; AI
                    grades against expected pattern anchors.
                  </>,
                  <>
                    <strong>Short answer</strong> (≤ 250 words) — AI grades
                    against rubric anchors with a 0/25/50/75/100 band verdict.
                  </>,
                  <>
                    <strong>Long answer / essay</strong> (≤ 2 000 words) — full
                    AI grading with optional human review and override.
                  </>,
                  <>
                    <strong>Code</strong> — language-tagged snippet; AI grades
                    for correctness and clarity against rubric anchors.
                  </>,
                ]}
              />
              <P>
                For every non-MCQ question, configure the{" "}
                <strong>rubric anchors</strong> before publishing the pack. The
                AI grader uses anchors as its scoring reference — they describe
                what a 0-band, 50-band, and 100-band answer looks like in
                concrete terms.
              </P>
            </StepCard>

            {/* ── Step 4 ── */}
            <StepCard number={4} title="Activate questions" live={false}>
              <P>
                Newly authored questions start in <strong>draft</strong> state
                and will not appear in assessments until activated.
              </P>
              <P>
                Select all questions in a level and use the{" "}
                <strong>Activate all</strong> affordance at the top of the
                question list. Each question moves to <Code>active</Code> state.
                You can also activate questions individually, or deactivate a
                question to exclude it from the next pack publish without
                deleting it.
              </P>
            </StepCard>

            {/* ── Step 5 ── */}
            <StepCard number={5} title="Publish the pack" live={false}>
              <P>
                On the pack detail page, click <strong>Publish pack</strong>.
                AssessIQ takes a snapshot of all active questions and their
                current rubric anchors. The snapshot is immutable — future edits
                to questions or anchors do not affect already-published cycles.
                To deploy updated content, publish a new pack version and create
                a new cycle referencing it.
              </P>
              <P>
                The published version number appears on the pack header and in
                cycle detail pages when the pack is referenced.
              </P>
            </StepCard>

            {/* ── Step 6 ── */}
            <StepCard number={6} title="Create an assessment cycle" live={false}>
              <P>
                Navigate to <strong>Assessments</strong> in the sidebar and
                click <strong>+ New assessment</strong>. In the create wizard:
              </P>
              <UL
                items={[
                  <>
                    Set a <strong>name</strong> (displayed to candidates and in
                    reports).
                  </>,
                  <>
                    Select the <strong>question pack</strong> and{" "}
                    <strong>version</strong> to reference.
                  </>,
                  <>
                    Configure <strong>level gates</strong> — whether candidates
                    attempt all levels sequentially or are placed by a
                    pre-screen result.
                  </>,
                  <>
                    Set a <strong>time limit per level</strong> (optional). The
                    attempt engine enforces this with an auto-submit at expiry.
                  </>,
                  <>
                    Set the <strong>cycle window</strong> — open and close dates
                    for candidate access.
                  </>,
                ]}
              />
            </StepCard>

            {/* ── Step 7 ── */}
            <StepCard number={7} title="Publish the assessment" live={false}>
              <P>
                From the assessment detail page, click{" "}
                <strong>Publish</strong>. The cycle moves to{" "}
                <Code>active</Code> state. Candidates can now be assigned and
                will receive magic-link invitations upon assignment.
              </P>
              <P>
                A published assessment cannot be deleted — it can be{" "}
                <strong>closed</strong> (no new attempts accepted) or{" "}
                <strong>archived</strong> (hidden from active views) once the
                cohort completes.
              </P>
            </StepCard>

            {/* ── Step 8 ── */}
            <StepCard number={8} title="Invite candidates" live={true}>
              <P>
                <strong>Add the candidate as a user (live now):</strong> Open{" "}
                <strong>Users</strong> in the sidebar and click{" "}
                <strong>Invite user</strong>. Enter the candidate's email and
                set their role to <Code>candidate</Code>. An invitation email is
                sent immediately.
              </P>
              <P>
                <strong>Assign the candidate to the cycle (Phase 3+):</strong>{" "}
                Once the Assessments page ships, open the cycle detail, go to
                the <strong>Candidates</strong> tab, and click{" "}
                <strong>Add candidate</strong>. A magic-link email is sent
                automatically on assignment.
              </P>
              <Callout>
                <strong>Magic links:</strong> Candidates receive a single-use
                token URL that opens the take-assessment flow without requiring
                a password. The link expires after 72 hours. If the candidate
                loses it or it expires, re-send from the candidate row in the
                cycle's Candidates tab.
              </Callout>
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
            <StepCard number={9} title="Candidates take the assessment" live={true}>
              <P>The candidate's flow once they click their magic link:</P>
              <UL
                items={[
                  <>
                    The platform validates the token and creates a
                    candidate session.
                  </>,
                  <>
                    For each level: read the question, write the answer. Answers
                    auto-save every 30 seconds and on every keystroke pause —
                    the candidate never loses progress.
                  </>,
                  <>
                    When done with a level, click{" "}
                    <strong>Submit level</strong>. Submission is final; the
                    candidate cannot return to a submitted level.
                  </>,
                  <>
                    After the final level, click{" "}
                    <strong>Submit assessment</strong>. Attempt status moves to{" "}
                    <Code>submitted</Code>.
                  </>,
                  <>
                    If the time limit expires, the attempt is{" "}
                    <strong>auto-submitted</strong> with whatever answers are
                    saved at that moment.
                  </>,
                ]}
              />
              <P>
                Monitor live attempt progress in{" "}
                <strong>Attempts</strong> in the sidebar. The status column
                updates in near-real-time.
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
            <StepCard number={10} title="Trigger AI grading per attempt" live={true}>
              <P>
                After submission, an attempt moves to{" "}
                <Code>pending_admin_grading</Code>. AI grading does not run
                automatically — it requires an explicit admin click, keeping the
                Claude Code CLI integration within an admin-in-the-loop model.
              </P>
              <P>To grade an attempt:</P>
              <UL
                items={[
                  <>
                    Open <strong>Attempts</strong> in the sidebar.
                  </>,
                  <>
                    Filter by status <Code>pending_admin_grading</Code> to see
                    the full grading queue.
                  </>,
                  <>
                    Click a row to open the attempt detail page.
                  </>,
                  <>
                    Click <strong>Grade now</strong> at the top of the page.
                    Grading runs synchronously — keep the tab open until all
                    verdicts appear (typically 15–60 seconds per question).
                  </>,
                ]}
              />
              <Callout>
                MCQ answers are graded instantly without AI. Short-answer,
                long-answer, KQL, and code questions go through the AI pipeline.
                If the integration is unavailable, the attempt stays in{" "}
                <Code>pending_admin_grading</Code> and can be manually overridden
                at any time.
              </Callout>
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
            <StepCard number={11} title="Review AI verdicts and override" live={true}>
              <P>
                Once grading completes, each answer shows four pieces of
                information:
              </P>
              <UL
                items={[
                  <>
                    <strong>AI band</strong> — 0, 25, 50, 75, or 100. This is
                    the AI's verdict; never a raw percentage.
                  </>,
                  <>
                    <strong>Anchors used</strong> — the rubric anchors the AI
                    matched against, highlighted inline.
                  </>,
                  <>
                    <strong>Justification</strong> — the AI's reasoning for the
                    band choice, including any partial credit notes.
                  </>,
                  <>
                    <strong>Error class</strong> — if the AI detected a
                    conceptual error (misidentification, tooling gap, etc.) it
                    is named here for reviewer context.
                  </>,
                ]}
              />
              <P>
                To override: click the band selector next to the AI verdict and
                choose a different band. Add a comment explaining the override.
                The override is logged <em>alongside</em> the AI verdict — it
                never replaces it. Both records appear in the audit log with
                timestamps and your user ID.
              </P>
              <P>
                When you are satisfied with all verdicts, click{" "}
                <strong>Release results</strong> on the attempt detail page. The
                candidate's score becomes visible in their candidate portal
                (Phase 2+).
              </P>
            </StepCard>

            {/* ── Step 12 ── */}
            <StepCard number={12} title="Generate reports" live={true}>
              <P>AssessIQ provides two report surfaces:</P>
              <UL
                items={[
                  <>
                    <strong>Cohort report</strong> — per-cycle rollup showing
                    band distribution across all candidates for each question,
                    topic-level heatmap, and archetype breakdown. Accessible
                    from the assessment detail page under{" "}
                    <strong>Reports → Cohort</strong>.
                  </>,
                  <>
                    <strong>Individual report</strong> — per-candidate summary
                    showing the candidate's band per question, overall
                    archetype, level scores, and a downloadable PDF. Accessible
                    from the candidate row in the attempt list.
                  </>,
                ]}
              />
              <P>
                Both reports support <strong>CSV export</strong>. Use this to
                import scores into your HR system (Workday, ServiceNow, custom
                HRMS) or archive alongside the audit log.
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
              title="Banded scoring"
              body="Answers land in 0/25/50/75/100 bands — never raw percentages. Configure per-question rubric anchors before publishing the pack. Bands map to readiness tiers in the cohort report archetype analysis, and are the load-bearing signal for HR scoring outputs."
            />
            <TipCard
              icon="eye"
              title="Audit trail"
              body="Every override, grading event, session change, and admin action is recorded in the append-only audit log (Settings → Audit). HR-grade immutability — records cannot be edited or deleted. Use this for compliance reviews, incident reconstruction, and calibration disputes."
            />
            <TipCard
              icon="sparkle"
              title="Re-grading"
              body="If you update rubric anchors after grading runs, you can re-trigger the AI grader for specific attempts from the attempt detail page. The original AI grade and any overrides are preserved alongside the new verdict — nothing is lost and all versions appear in the audit log."
            />
            <TipCard
              icon="grid"
              title="Multi-tenancy"
              body="If you manage multiple tenants, use the tenant switcher in the top bar. All data — question packs, users, grades, and reports — is strictly isolated between tenants at the database row level. There is no cross-tenant sharing, even for admins with multi-tenant access."
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
                  q: "Can a candidate see their score immediately after submitting?",
                  a: 'No. Scores are released by the admin after the AI grading review cycle is complete. The candidate sees a "Submitted — results pending" state until you click Release results on the attempt detail page.',
                },
                {
                  q: "What if AI grading fails for an attempt?",
                  a: "The attempt stays in pending_admin_grading status. An error note appears on the failed grading row. Manual override is always available — set the band directly on any failed question. There is no dependency on AI grading completing before you can release results.",
                },
                {
                  q: "Can I reuse a question pack across multiple cycles?",
                  a: "Yes. Create a new cycle referencing the same published pack version. Each cycle produces its own independent cohort report. If you publish a new version of the pack, new cycles reference the new version while existing cycles remain pinned to their original snapshot.",
                },
                {
                  q: "What is the difference between L1, L2, and L3?",
                  a: "The levels are defined by the admin when authoring the pack — the platform provides the three-tier structure but not the specific content. Convention for the SOC pack: L1 tests scenario knowledge and tool recognition (foundational); L2 tests applied tool use under time pressure (applied); L3 tests cross-domain synthesis, escalation judgement, and incident command (expert). They represent progressive readiness tiers, not a linear difficulty scale.",
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
            label={`${String(n).padStart(2, "0")} — ${STEP_LABELS[n - 1]}`}
            sub
          />
        ))}
        <TocLink href={S.TIPS} label="Tips" />
        <TocLink href={S.FAQ} label="FAQ" />
      </aside>
    </div>
  );
}
