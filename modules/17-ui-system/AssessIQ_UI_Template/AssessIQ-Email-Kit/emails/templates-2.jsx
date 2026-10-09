/* AssessIQ — Email Templates · Part 2
   ──────────────────────────────────
   Result to candidate, New submission to reviewer.
*/

/* ───── 04 · RESULT TO CANDIDATE ────────────────────────────
   The candidate's score is ready. Score ring, percentile,
   competency rows, single CTA to view the full report.
*/

const ScoreRing = ({ score = 132, max = 160, label = "OVERALL" }) => {
  const r = 56;
  const c = 2 * Math.PI * r;
  const pct = score / max;
  return (
    <div style={{
      width: 156, height: 156, position: "relative",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <svg width="156" height="156" viewBox="0 0 156 156" style={{ position: "absolute", inset: 0, transform: "rotate(-90deg)" }}>
        <circle cx="78" cy="78" r={r} fill="none" stroke="var(--surface-2)" strokeWidth="6" />
        <circle cx="78" cy="78" r={r} fill="none" stroke="var(--accent)" strokeWidth="6"
                strokeLinecap="round" strokeDasharray={c}
                strokeDashoffset={c * (1 - pct)} />
      </svg>
      <div style={{ textAlign: "center", position: "relative" }}>
        <div className="num" style={{ fontSize: 44, lineHeight: 1, letterSpacing: "-0.03em" }}>{score}</div>
        <div className="mono" style={{
          fontSize: 10, color: "var(--text-faint)",
          textTransform: "uppercase", letterSpacing: "0.08em", marginTop: 4,
        }}>{label} · /{max}</div>
      </div>
    </div>
  );
};

const ResultEmail = () => {
  const breakdown = [
    { name: "Pattern recognition", score: 92 },
    { name: "Deductive reasoning", score: 88 },
    { name: "Quantitative", score: 74 },
    { name: "Verbal analogies", score: 81 },
  ];

  return (
    <EmailShell preheader="You scored 132 — higher than 97% of test-takers.">
      <EmailHeader eyebrow="Result · ready" />

      <EmailBody pad="44px">
        <div className="mono" style={{
          fontSize: 10, color: "var(--text-faint)",
          textTransform: "uppercase", letterSpacing: "0.08em",
          marginBottom: 14, display: "flex", gap: 14,
        }}>
          <span>LOGICAL REASONING III</span>
          <span style={{ color: "var(--border-strong)" }}>·</span>
          <span>#A-2841</span>
          <span style={{ color: "var(--border-strong)" }}>·</span>
          <span>WED · MAY 21 · 14:32 PT</span>
        </div>

        <EmailLede
          title="Your score is ready, Jordan."
          body="You completed Logical Reasoning III in 38 minutes, 14 seconds. The full report — with question-by-question breakdown and competency analysis — is waiting in your dashboard."
        />

        {/* Score row */}
        <div style={{
          marginTop: 36, display: "grid",
          gridTemplateColumns: "auto 1fr", gap: 32, alignItems: "center",
        }}>
          <ScoreRing score={132} max={160} />
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <div>
              <div className="mono" style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Percentile</div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span className="num" style={{ fontSize: 32 }}>97</span>
                <span style={{ fontSize: 14, color: "var(--text-muted)" }}>th — top 3%</span>
              </div>
            </div>
            <div>
              <div className="mono" style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Time</div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span className="num mono" style={{ fontSize: 32, fontFamily: "var(--font-serif)" }}>38:14</span>
                <span style={{ fontSize: 14, color: "var(--text-muted)" }}>of 45:00</span>
              </div>
            </div>
            <div>
              <span className="chip chip-success">
                <Icon name="check" size={10} stroke={2} /> Passed
              </span>
            </div>
          </div>
        </div>

        <EmailRule pad={32} />

        {/* Competency breakdown */}
        <div>
          <div className="mono" style={{
            fontSize: 10, color: "var(--text-faint)",
            textTransform: "uppercase", letterSpacing: "0.08em",
            marginBottom: 14,
          }}>Competency breakdown</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {breakdown.map((b, i) => (
              <div key={i} style={{
                display: "grid", gridTemplateColumns: "180px 1fr 40px",
                alignItems: "center", gap: 14,
              }}>
                <span style={{ fontSize: 13 }}>{b.name}</span>
                <div style={{
                  height: 6, background: "var(--surface-2)",
                  borderRadius: 3, overflow: "hidden",
                }}>
                  <div style={{
                    width: `${b.score}%`, height: "100%",
                    background: "var(--text)",
                  }}></div>
                </div>
                <span className="mono" style={{ fontSize: 12, textAlign: "right" }}>{b.score}</span>
              </div>
            ))}
          </div>
        </div>

        <div style={{ marginTop: 36 }}>
          <EmailCTA label="View full report" />
        </div>

        <EmailRule pad={32} />

        {/* AI insight teaser */}
        <div style={{
          padding: "20px 22px",
          background: "var(--accent-soft)",
          borderRadius: 12,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <Icon name="sparkle" size={13} stroke={2} />
            <span className="mono" style={{
              fontSize: 10, color: "var(--accent)",
              textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 500,
            }}>AI insights · preview</span>
          </div>
          <p style={{ margin: 0, fontSize: 14, color: "var(--text)", lineHeight: 1.55 }}>
            Your strongest pattern was <b style={{ fontWeight: 500 }}>matrix-style visual reasoning</b> —
            you answered 11 of 12 correctly, and faster than 92% of takers. The full report breaks down
            where your timing slipped on quantitative questions.
          </p>
        </div>

        <div style={{ marginTop: 24, fontSize: 13, color: "var(--text-muted)" }}>
          Acme Corp will receive this score automatically. They typically respond within 3 business days —
          you can <a href="#" style={{ color: "var(--accent)", textDecoration: "none" }}>check application status here</a>.
        </div>
      </EmailBody>

      <EmailFooter reason="You're receiving this because you completed an assessment via AssessIQ. Score notifications cannot be disabled, but you can manage other email preferences below." />
    </EmailShell>
  );
};

/* ───── 05 · NEW SUBMISSION (for reviewer / admin) ──────────
   Notify the hiring manager that a candidate just finished.
   Compact summary, link to review.
*/
const SubmissionEmail = () => (
  <EmailShell preheader="Score 132 · 38m 14s · ready for review.">
    <EmailHeader eyebrow="Submission · received" />

    <EmailBody pad="40px">
      <EmailLede
        eyebrow="New submission"
        title="Jordan Avery just finished Logical Reasoning III."
        body="Submitted 4 minutes ago. The full report and recorded session are ready for your review."
      />

      {/* Candidate card */}
      <div style={{
        marginTop: 32,
        border: "1px solid var(--border)", borderRadius: 12,
        padding: "22px 24px",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 18 }}>
          <div style={{
            width: 44, height: 44, borderRadius: "50%",
            background: "oklch(0.92 0.05 220)",
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "oklch(0.42 0.12 220)", fontFamily: "var(--font-serif)",
            fontSize: 18, fontWeight: 500,
          }}>JA</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 500 }}>Jordan Avery</div>
            <div className="mono" style={{
              fontSize: 11, color: "var(--text-faint)",
              textTransform: "uppercase", letterSpacing: "0.06em",
              marginTop: 2, display: "flex", gap: 10,
            }}>
              <span>jordan@gmail.com</span>
              <span style={{ color: "var(--border-strong)" }}>·</span>
              <span>#C-1294</span>
            </div>
          </div>
          <span className="chip chip-success">
            <Icon name="check" size={10} stroke={2} /> Passed
          </span>
        </div>

        {/* Stat row */}
        <div style={{
          display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr",
          gap: 14,
          borderTop: "1px solid var(--border)", paddingTop: 18,
        }}>
          {[
            { l: "SCORE", v: "132", denom: "/160" },
            { l: "PERCENTILE", v: "97", denom: "th" },
            { l: "TIME", v: "38:14", denom: "/45:00" },
            { l: "FLAGGED", v: "0", denom: "items" },
          ].map((s, i) => (
            <div key={i}>
              <div className="mono" style={{
                fontSize: 9, color: "var(--text-faint)",
                textTransform: "uppercase", letterSpacing: "0.08em",
              }}>{s.l}</div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 4, marginTop: 4 }}>
                <span className="num" style={{
                  fontSize: 24,
                  fontFamily: s.l === "TIME" ? "var(--font-serif)" : undefined,
                }}>{s.v}</span>
                <span className="mono" style={{ fontSize: 10, color: "var(--text-faint)" }}>{s.denom}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Meta details */}
      <div style={{ marginTop: 20 }}>
        <EmailMetaCard rows={[
          { k: "Assessment", v: "Logical Reasoning III · Adaptive" },
          { k: "Role applied", v: "Senior Product Engineer · Engineering" },
          { k: "Submitted", v: <span><span className="mono">MAY 21 · 14:32 PT</span> <span style={{ color: "var(--text-faint)" }}>· 4 min ago</span></span> },
          { k: "Proctor", v: <span><span className="chip">Clean</span> <span style={{ color: "var(--text-muted)", marginLeft: 8 }}>No flags · webcam recorded</span></span> },
        ]} />
      </div>

      <div style={{ marginTop: 28, display: "flex", alignItems: "center", gap: 18 }}>
        <EmailCTA label="Review submission" />
        <EmailGhostLink label="Download report (PDF)" />
      </div>

      <EmailRule pad={32} />

      {/* AI summary */}
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <Icon name="sparkle" size={13} stroke={2} />
          <span className="mono" style={{
            fontSize: 10, color: "var(--accent)",
            textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 500,
          }}>AI summary</span>
        </div>
        <p style={{ margin: 0, fontSize: 14, color: "var(--text)", lineHeight: 1.6 }}>
          Strong performance, particularly on pattern recognition (top 1% of cohort).
          Time management slipped on the quantitative section — spent 42% of total time
          on 31% of questions. No proctor anomalies. <b style={{ fontWeight: 500 }}>Recommend
          advancing to technical round.</b>
        </p>
        <div style={{ marginTop: 12 }}>
          <EmailGhostLink label="See full insight" />
        </div>
      </div>

      <EmailRule pad={28} />

      {/* Compare to pool */}
      <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
        <div style={{ flex: 1 }}>
          <div className="mono" style={{
            fontSize: 10, color: "var(--text-faint)",
            textTransform: "uppercase", letterSpacing: "0.08em",
            marginBottom: 8,
          }}>vs. Acme Corp pool · 142 candidates</div>
          <div style={{ fontSize: 14, color: "var(--text-muted)", lineHeight: 1.55 }}>
            Jordan ranks <b style={{ color: "var(--text)", fontWeight: 500 }}>3rd</b> of 142
            for this role · <span className="mono" style={{ color: "var(--success)" }}>↑ 14 pts</span> above pool median.
          </div>
        </div>
      </div>
    </EmailBody>

    <EmailFooter reason="You're receiving this because you own the 'Senior Product Engineer' assessment funnel on AssessIQ. Adjust which submission types ping you in email preferences." />
  </EmailShell>
);

Object.assign(window, { ResultEmail, SubmissionEmail });
