// AssessIQ — Admin guide page.
//
// /admin/guide — end-to-end assessment workflow guide for tenant admins (L1→L3).
// Audience: tenant admins learning the full workflow.
//
// S16 (2026-10-17): the 12 steps, 6 tips and 6 FAQ now live in
// modules/16-help-system/content/en/admin.yml (admin.guide.step_NN / tip_* /
// faq_*) and load through the help API (HelpProvider page="admin.guide").
// short_text is the title; long_md is the body (paragraphs, "- " lists, **bold**).
// Overview and Prerequisites stay static here.
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
//  - All 12 steps reference live pages as of commit 35f78e6 (Question bank,
//    Assessments, Reports, Users, Attempts, Grading all in sidebar).

import React from "react";
import { useNavigate } from "react-router";
import { Card, Icon } from "@assessiq/ui-system";
import type { IconName } from "@assessiq/ui-system";
import { HelpProvider, useHelpContext } from "@assessiq/help-system/components";

// ── Section IDs ───────────────────────────────────────────────────────────────

const S = {
  OVERVIEW:      "guide-overview",
  PREREQUISITES: "guide-prerequisites",
  STEPS:         "guide-steps",
  TIPS:          "guide-tips",
  FAQ:           "guide-faq",
  step: (n: number) => `guide-step-${n}`,
} as const;

// ── Help keys (order = page order) ───────────────────────────────────────────

const STEP_KEYS = Array.from({ length: 12 }, (_, i) => `admin.guide.step_${String(i + 1).padStart(2, "0")}`);

const TIPS: ReadonlyArray<{ key: string; icon: IconName }> = [
  { key: "admin.guide.tip_score_bands", icon: "chart" },
  { key: "admin.guide.tip_audit_log", icon: "eye" },
  { key: "admin.guide.tip_regrading", icon: "sparkle" },
  { key: "admin.guide.tip_organisations", icon: "grid" },
  { key: "admin.guide.tip_questions", icon: "sparkle" },
  { key: "admin.guide.tip_plan", icon: "chart" },
];

const FAQ_KEYS = [
  "admin.guide.faq_retake",
  "admin.guide.faq_grading_fails",
  "admin.guide.faq_set_change",
  "admin.guide.faq_close_window",
  "admin.guide.faq_write_questions",
  "admin.guide.faq_usage_banner",
];

// Navigation buttons under a step (page names stay in code; text is in the help content).
const STEP_ACTIONS: Readonly<Record<number, ReadonlyArray<{ label: string; to: string }>>> = {
  8: [{ label: "Open Users →", to: "/admin/users" }],
  9: [{ label: "View Attempts →", to: "/admin/attempts" }],
  10: [{ label: "View Attempts →", to: "/admin/attempts" }],
  12: [
    { label: "View Attempts →", to: "/admin/attempts" },
    { label: "How grading works →", to: "/admin/grading-jobs" },
  ],
};

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

// Minimal markdown: blank-line paragraphs, "- " lists, **bold**. Help content is trusted admin copy.
function inline(t: string): React.ReactNode[] {
  return t.split(/\*\*(.+?)\*\*/g).map((x, i) => (i % 2 ? <strong key={i}>{x}</strong> : x));
}

function Md({ text }: { text: string }): React.ReactElement {
  const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  return (
    <>
      {blocks.map((b, i) => {
        const lines = b.split("\n");
        return lines.every((l) => l.startsWith("- ")) ? (
          <UL key={i} items={lines.map((l) => inline(l.slice(2)))} />
        ) : (
          <P key={i}>{inline(lines.join(" "))}</P>
        );
      })}
    </>
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

// ── Main component ────────────────────────────────────────────────────────────

export function AdminGuide(): React.ReactElement {
  return (
    <HelpProvider page="admin.guide" audience="admin">
      <AdminGuideBody />
    </HelpProvider>
  );
}

function AdminGuideBody(): React.ReactElement {
  const navigate = useNavigate();
  const { entries, loading, error } = useHelpContext();
  const title = (k: string): string => entries.get(k)?.shortText ?? "";
  const body = (k: string): string => entries.get(k)?.longMd ?? "";
  const h2 = { ...SERIF_HEADING, fontSize: "var(--aiq-text-xl)", marginBottom: "var(--aiq-space-md)" } as const;
  const stack = { display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)" } as const;

  return (
    <div style={{ display: "flex", gap: "var(--aiq-space-2xl)", alignItems: "flex-start" }}>
      {/* ── Main content ─────────────────────────────────────────────── */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "var(--aiq-space-xl)" }}>
        <div>
          <span style={MONO_LABEL}>Admin guide</span>
          <h1
            style={{
              ...SERIF_HEADING,
              fontSize: "var(--aiq-h1-size)",
              marginTop: "var(--aiq-space-xs)",
              marginBottom: "var(--aiq-space-xs)",
            }}
          >
            Conducting an assessment.
          </h1>
          <p style={{ ...BODY, fontSize: "var(--aiq-text-md)" }}>
            From a licensed question set to candidate results.
          </p>
        </div>

        {/* ── Overview ─────────────────────────────────────────────── */}
        <section id={S.OVERVIEW} style={{ scrollMarginTop: "var(--aiq-space-xl)" }}>
          <h2 style={h2}>Overview — the three-layer model.</h2>
          <Card padding="md">
            <P>An assessment in AssessIQ uses three things:</P>
            <UL
              items={[
                <><strong>Licensed set</strong> — a question set that AssessIQ writes and your organisation is licensed to use.</>,
                <><strong>Your copy</strong> — a copy (clone) of a licensed set in your question bank. You build assessments from it.</>,
                <><strong>Assessment</strong> — a scheduled assessment with invited candidates.</>,
              ]}
            />
            <P>
              End-to-end flow:{" "}
              <strong>
                copy a set → build an assessment → invite candidates →
                candidates take the assessment → AssessIQ grades written answers →
                you review and release → reports.
              </strong>
            </P>
          </Card>
        </section>

        {/* ── Prerequisites ────────────────────────────────────────── */}
        <section id={S.PREREQUISITES} style={{ scrollMarginTop: "var(--aiq-space-xl)" }}>
          <h2 style={h2}>Prerequisites.</h2>
          <Card padding="md">
            <UL
              items={[
                <><strong>Admin role</strong> in your organisation account.</>,
                <>Two-step sign-in is <strong>optional and recommended</strong>.</>,
                <>List of <strong>candidate email addresses</strong> ready.</>,
              ]}
            />
          </Card>
        </section>

        {loading && <p style={BODY}>Loading the guide…</p>}
        {!loading && error && <p style={BODY}>The guide could not load. Refresh the page to try again.</p>}

        {/* ── Steps ────────────────────────────────────────────────── */}
        <section id={S.STEPS}>
          <h2 style={h2}>The 12-step workflow.</h2>
          <div style={stack}>
            {STEP_KEYS.map((k, i) => (
              <StepCard key={k} number={i + 1} title={title(k)}>
                <Md text={body(k)} />
                {STEP_ACTIONS[i + 1] && (
                  <div style={{ display: "flex", gap: "var(--aiq-space-sm)", marginTop: "var(--aiq-space-sm)" }}>
                    {STEP_ACTIONS[i + 1]!.map((a) => (
                      <button
                        key={a.label}
                        type="button"
                        className="aiq-btn aiq-btn-outline aiq-btn-sm"
                        onClick={() => navigate(a.to)}
                      >
                        {a.label}
                      </button>
                    ))}
                  </div>
                )}
              </StepCard>
            ))}
          </div>
        </section>

        {/* ── Tips ─────────────────────────────────────────────────── */}
        <section id={S.TIPS} style={{ scrollMarginTop: "var(--aiq-space-xl)" }}>
          <h2 style={h2}>Tips.</h2>
          <div style={stack}>
            {TIPS.map((t) => (
              <TipCard key={t.key} icon={t.icon} title={title(t.key)} body={body(t.key).trim()} />
            ))}
          </div>
        </section>

        {/* ── FAQ ──────────────────────────────────────────────────── */}
        <section id={S.FAQ} style={{ scrollMarginTop: "var(--aiq-space-xl)" }}>
          <h2 style={h2}>FAQ.</h2>
          <div style={stack}>
            {FAQ_KEYS.map((k) => (
              <Card key={k} padding="md">
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
                  {title(k)}
                </h3>
                <p style={{ ...BODY, margin: 0 }}>{body(k).trim()}</p>
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
        <span style={{ ...MONO_LABEL, marginBottom: "var(--aiq-space-sm)", display: "block" }}>On this page</span>
        <TocLink href={S.OVERVIEW} label="Overview" />
        <TocLink href={S.PREREQUISITES} label="Prerequisites" />
        <TocLink href={S.STEPS} label="Steps" />
        {STEP_KEYS.map((k, i) => (
          <TocLink key={k} href={S.step(i + 1)} label={`${i + 1} — ${title(k)}`} sub />
        ))}
        <TocLink href={S.TIPS} label="Tips" />
        <TocLink href={S.FAQ} label="FAQ" />
      </aside>
    </div>
  );
}
