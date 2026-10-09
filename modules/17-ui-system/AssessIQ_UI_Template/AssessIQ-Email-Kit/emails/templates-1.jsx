/* AssessIQ — Email Templates · Part 1
   ──────────────────────────────────
   Newsletter, Assessment invite, Company invite.
*/

/* ───── 01 · NEWSLETTER ─────────────────────────────────────
   Monthly editorial digest. Serif headline, lede, 3 articles.
*/
const NewsletterEmail = () => {
  const articles = [
    {
      kind: "FIELD NOTE",
      title: "Why we removed time pressure from one assessment family.",
      lede: "A six-month study of 14,000 candidates on cognitive batteries. The shorter answer: time pressure measures typing speed more than reasoning.",
      read: "8 min read",
    },
    {
      kind: "PRODUCT",
      title: "Adaptive scoring, now with a per-section confidence band.",
      lede: "You can see exactly when the model has stopped learning about a candidate. Live in the report this week.",
      read: "4 min read",
    },
    {
      kind: "INTERVIEW",
      title: "Ariane Wu on hiring for taste, not just competence.",
      lede: "The head of design at Linear on why she runs a 20-minute portfolio walkthrough instead of a take-home.",
      read: "12 min read",
    },
  ];

  return (
    <EmailShell preheader="What we shipped in May, and one piece worth your weekend.">
      <EmailHeader eyebrow="Monthly digest · Vol. 14" />

      <EmailBody pad="44px">
        <EmailLede
          eyebrow="The Pulse · May 2026"
          title="Four reads on assessment design."
          body="A field note on time pressure, a product change you'll feel in the next report, and one interview about hiring for taste. 24 minutes, end to end."
        />

        <div style={{ marginTop: 36 }}>
          <Placeholder height={220} label="Cover image · 600×220" radius={10} />
        </div>

        <EmailRule pad={32} />

        <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
          {articles.map((a, i) => (
            <div key={i}>
              <div className="mono" style={{
                fontSize: 10, color: "var(--text-faint)",
                textTransform: "uppercase", letterSpacing: "0.08em",
                marginBottom: 8,
              }}>{a.kind} · {a.read}</div>
              <h3 className="serif" style={{
                margin: "0 0 6px", fontSize: 20, fontWeight: 500,
                letterSpacing: "-0.015em", lineHeight: 1.25,
              }}>{a.title}</h3>
              <p style={{ margin: "0 0 10px", fontSize: 14, color: "var(--text-muted)", lineHeight: 1.55 }}>
                {a.lede}
              </p>
              <EmailGhostLink label="Read the piece" />
              {i < articles.length - 1 && (
                <div style={{ height: 1, background: "var(--border)", marginTop: 28 }}></div>
              )}
            </div>
          ))}
        </div>

        <EmailRule pad={32} />

        <div>
          <div className="mono" style={{
            fontSize: 10, color: "var(--text-faint)",
            textTransform: "uppercase", letterSpacing: "0.08em",
            marginBottom: 10,
          }}>From the team</div>
          <p style={{ margin: 0, fontSize: 14, color: "var(--text)", maxWidth: 480, lineHeight: 1.6 }}>
            We're hiring an applied researcher to lead our adaptive-scoring work.
            If you've thought hard about IRT, or just want to recommend someone, we'd love a note.
          </p>
          <div style={{ marginTop: 18 }}>
            <EmailCTA label="See the role" />
          </div>
        </div>
      </EmailBody>

      <EmailFooter reason="You subscribed to The Pulse when you signed up for AssessIQ. We send one issue per month — never more." />
    </EmailShell>
  );
};

/* ───── 02 · ASSESSMENT INVITE ──────────────────────────────
   Candidate gets invited to take a specific test. Meta card.
*/
const AssessmentInviteEmail = () => (
  <EmailShell preheader="Acme Corp · 45 minutes · expires in 72 hours.">
    <EmailHeader eyebrow="Invitation" />

    <EmailBody pad="44px">
      {/* Sender block */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 28 }}>
        <div style={{
          width: 36, height: 36, borderRadius: 8,
          background: "oklch(0.92 0.04 30)",
          display: "flex", alignItems: "center", justifyContent: "center",
          color: "oklch(0.45 0.12 30)", fontFamily: "var(--font-serif)",
          fontSize: 16, fontWeight: 500,
        }}>A</div>
        <div>
          <div style={{ fontSize: 13, color: "var(--text)" }}>
            <b style={{ fontWeight: 500 }}>Mira Patel</b> from <b style={{ fontWeight: 500 }}>Acme Corp</b>
          </div>
          <div className="mono" style={{
            fontSize: 10, color: "var(--text-faint)",
            textTransform: "uppercase", letterSpacing: "0.08em",
            marginTop: 2,
          }}>mira@acme.co · Hiring manager</div>
        </div>
      </div>

      <EmailLede
        title="You've been invited to take Logical Reasoning III."
        body="Mira at Acme Corp would like you to complete a short cognitive assessment as part of your application for the Senior Product Engineer role. You have 72 hours from now."
      />

      <div style={{ marginTop: 28 }}>
        <EmailMetaCard rows={[
          { k: "Assessment", v: "Logical Reasoning III · Adaptive" },
          { k: "Duration", v: "45 minutes · single sitting · no pause" },
          { k: "Questions", v: "32 · multiple choice + 2 short-answer" },
          { k: "Window closes", v: <span><span className="mono">FRI · MAY 23 · 18:00 PT</span> <span style={{ color: "var(--text-faint)" }}> · in 71h 42m</span></span> },
          { k: "Reference", v: <span className="mono" style={{ color: "var(--text-faint)" }}>#A-2841</span> },
        ]} />
      </div>

      <div style={{ marginTop: 32, display: "flex", alignItems: "center", gap: 18 }}>
        <EmailCTA label="Accept and start" />
        <EmailGhostLink label="Decline politely" />
      </div>

      <EmailRule pad={32} />

      <div style={{
        display: "flex", gap: 14, padding: "16px 18px",
        background: "var(--surface)", borderRadius: 10,
      }}>
        <Icon name="clock" size={16} />
        <div style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.55 }}>
          <b style={{ color: "var(--text)", fontWeight: 500 }}>Before you start:</b> close other tabs,
          plug in, and put your phone in another room. Once the timer starts, it doesn't pause —
          even for a refresh. Your answers auto-save every 4 seconds.
        </div>
      </div>

      <div style={{ marginTop: 24, fontSize: 13, color: "var(--text-muted)" }}>
        Need to reschedule? <a href="#" style={{ color: "var(--accent)", textDecoration: "none" }}>Reply to Mira directly</a> — she'll be in touch within a business day.
      </div>
    </EmailBody>

    <EmailFooter reason="You're receiving this because Acme Corp invited you via AssessIQ to complete an assessment as part of an application." />
  </EmailShell>
);

/* ───── 03 · COMPANY INVITATION ─────────────────────────────
   Joining a workspace as a teammate. Acme invited you.
*/
const CompanyInviteEmail = () => (
  <EmailShell preheader="Pick a username and you're in. Takes 30 seconds.">
    <EmailHeader eyebrow="Team invitation" />

    <EmailBody pad="48px">
      {/* Avatars */}
      <div style={{ display: "flex", alignItems: "center", gap: -10, marginBottom: 28 }}>
        <div style={{
          width: 56, height: 56, borderRadius: "50%",
          background: "oklch(0.92 0.04 30)",
          display: "flex", alignItems: "center", justifyContent: "center",
          color: "oklch(0.45 0.12 30)", fontFamily: "var(--font-serif)",
          fontSize: 22, fontWeight: 500,
          border: "3px solid var(--bg)", boxShadow: "0 0 0 1px var(--border)",
        }}>A</div>
        <div style={{
          width: 56, height: 56, borderRadius: "50%",
          background: "var(--accent-soft)",
          display: "flex", alignItems: "center", justifyContent: "center",
          color: "var(--accent)",
          border: "3px solid var(--bg)", boxShadow: "0 0 0 1px var(--border)",
          marginLeft: -14,
        }}>
          <span style={{ width: 16, height: 16, borderRadius: "50%", background: "var(--accent)" }}></span>
        </div>
      </div>

      <EmailLede
        title="Acme Corp invited you to join their team."
        body="Mira Patel added you as an Admin on the Acme Corp workspace. You'll be able to build assessments, invite candidates, and review submissions alongside the team."
      />

      <div style={{ marginTop: 32 }}>
        <div style={{
          border: "1px solid var(--border)", borderRadius: 12,
          padding: "20px 22px",
        }}>
          <div className="mono" style={{
            fontSize: 10, color: "var(--text-faint)",
            textTransform: "uppercase", letterSpacing: "0.08em",
            marginBottom: 10,
          }}>Workspace</div>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{
              width: 42, height: 42, borderRadius: 10,
              background: "oklch(0.92 0.04 30)",
              display: "flex", alignItems: "center", justifyContent: "center",
              color: "oklch(0.45 0.12 30)", fontFamily: "var(--font-serif)",
              fontSize: 19, fontWeight: 500,
            }}>A</div>
            <div style={{ flex: 1 }}>
              <div className="serif" style={{ fontSize: 18, fontWeight: 500, letterSpacing: "-0.01em" }}>Acme Corp</div>
              <div className="mono" style={{
                fontSize: 11, color: "var(--text-faint)",
                textTransform: "uppercase", letterSpacing: "0.06em", marginTop: 2,
              }}>acme.assessiq.com · 24 teammates</div>
            </div>
            <span className="chip chip-accent">Admin</span>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 28, display: "flex", alignItems: "center", gap: 18 }}>
        <EmailCTA label="Join workspace" />
        <EmailGhostLink label="See who's already on the team" />
      </div>

      <EmailRule pad={32} />

      <div>
        <div className="mono" style={{
          fontSize: 10, color: "var(--text-faint)",
          textTransform: "uppercase", letterSpacing: "0.08em",
          marginBottom: 14,
        }}>Or use a link</div>
        <div style={{
          padding: "12px 16px",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          fontFamily: "var(--font-mono)", fontSize: 12,
          color: "var(--text-muted)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          https://assessiq.com/join/acme?token=8h2-Wf3a-z9qX-VeL4
        </div>
        <p style={{ marginTop: 12, fontSize: 12, color: "var(--text-faint)", lineHeight: 1.55 }}>
          Link expires in 7 days. If you weren't expecting this invitation,
          you can safely ignore it — nothing happens until you click through.
        </p>
      </div>
    </EmailBody>

    <EmailFooter reason="Mira Patel (mira@acme.co) invited you to join the Acme Corp workspace on AssessIQ." />
  </EmailShell>
);

Object.assign(window, { NewsletterEmail, AssessmentInviteEmail, CompanyInviteEmail });
