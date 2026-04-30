/* Assessment in-progress — taking a test */

const QuestionNav = ({ total, current, answered, flagged }) => (
  <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 6 }}>
    {Array.from({ length: total }).map((_, i) => {
      const isCurrent = i === current;
      const isAnswered = answered.includes(i);
      const isFlagged = flagged.includes(i);
      return (
        <div key={i} style={{
          aspectRatio: "1", display: "flex", alignItems: "center", justifyContent: "center",
          borderRadius: 6, fontSize: 11, fontFamily: "var(--font-mono)",
          background: isCurrent ? "var(--accent)" : isAnswered ? "var(--surface)" : "transparent",
          color: isCurrent ? "white" : isAnswered ? "var(--text)" : "var(--text-faint)",
          border: `1px solid ${isCurrent ? "var(--accent)" : isFlagged ? "var(--warn)" : "var(--border)"}`,
          cursor: "pointer", position: "relative",
        }}>
          {i + 1}
          {isFlagged && <span style={{ position: "absolute", top: -3, right: -3, width: 6, height: 6, borderRadius: "50%", background: "var(--warn)" }}></span>}
        </div>
      );
    })}
  </div>
);

const AssessmentScreen = () => {
  const [current, setCurrent] = React.useState(6);
  const [selected, setSelected] = React.useState(2);
  const [secondsLeft, setSecondsLeft] = React.useState(28 * 60 + 14);

  React.useEffect(() => {
    const t = setInterval(() => setSecondsLeft(s => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, []);

  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, "0");
  const ss = String(secondsLeft % 60).padStart(2, "0");

  const answered = [0, 1, 2, 3, 4, 5];
  const flagged = [3, 9];

  return (
    <div className="aiq-screen scroll" style={{ background: "var(--bg)" }}>
      {/* Top bar */}
      <header style={{
        position: "sticky", top: 0, zIndex: 5,
        background: "var(--bg)", borderBottom: "1px solid var(--border)",
        padding: "14px 32px", display: "flex", alignItems: "center", gap: 16,
      }}>
        <Logo />
        <span style={{ height: 18, width: 1, background: "var(--border)" }}></span>
        <div>
          <div style={{ fontSize: 14, fontWeight: 500 }}>Cognitive Reasoning III</div>
          <div className="mono" style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Section 3 of 5 · Logical patterns</div>
        </div>
        <div className="spacer"></div>
        {/* Auto-save status */}
        <span className="row" style={{ gap: 6, fontSize: 12, color: "var(--text-muted)" }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--success)", boxShadow: "0 0 0 4px oklch(0.92 0.06 150)" }}></span>
          Auto-saved · 4s ago
        </span>
        {/* Proctor */}
        <span className="chip">
          <Icon name="eye" size={10} />
          Proctored
        </span>
        {/* Timer */}
        <div className="row" style={{
          gap: 8, padding: "8px 14px",
          border: `1px solid ${secondsLeft < 300 ? "var(--danger)" : "var(--border-strong)"}`,
          borderRadius: 999,
          color: secondsLeft < 300 ? "var(--danger)" : "var(--text)",
        }}>
          <Icon name="clock" size={14} />
          <span className="num" style={{ fontSize: 16, fontVariantNumeric: "tabular-nums", letterSpacing: "0.02em" }}>{mm}:{ss}</span>
        </div>
        <button className="btn btn-outline btn-sm">Save & exit</button>
      </header>

      {/* Progress bar */}
      <div style={{ height: 2, background: "var(--surface-2)" }}>
        <div style={{ width: `${((current + 1) / 16) * 100}%`, height: "100%", background: "var(--accent)", transition: "width .3s" }}></div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 0, maxWidth: 1280, margin: "0 auto" }}>
        {/* Question column */}
        <div style={{ padding: "48px 56px 64px" }}>
          <div className="row" style={{ gap: 10, marginBottom: 28 }}>
            <span className="mono" style={{ fontSize: 11, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Question {current + 1} / 16</span>
            <span style={{ fontSize: 11, color: "var(--text-faint)" }}>·</span>
            <span className="mono" style={{ fontSize: 11, color: "var(--text-faint)" }}>Multiple choice</span>
            <button className="btn btn-ghost btn-sm" style={{ marginLeft: "auto", padding: "4px 10px", color: "var(--text-muted)" }}>
              <Icon name="flag" size={12} />
              Flag for review
            </button>
          </div>

          <h2 className="serif" style={{ fontSize: 30, lineHeight: 1.3, fontWeight: 400, letterSpacing: "-0.015em", margin: "0 0 12px" }}>
            A train leaves station A at 60 km/h. A second train leaves station B, 240 km away, at 80 km/h, traveling toward A. After how many minutes do they meet?
          </h2>
          <p style={{ fontSize: 14, color: "var(--text-muted)", margin: "0 0 32px" }}>Assume both trains depart at the same instant on a single track.</p>

          {/* Visual aid placeholder */}
          <div style={{
            padding: 24, background: "var(--surface)", border: "1px solid var(--border)",
            borderRadius: 12, marginBottom: 32, position: "relative",
          }}>
            <div className="mono" style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 14 }}>Diagram</div>
            <svg viewBox="0 0 600 100" style={{ width: "100%", height: 80 }}>
              <line x1="20" y1="60" x2="580" y2="60" stroke="var(--border-strong)" strokeWidth="1" strokeDasharray="3 4"/>
              <circle cx="20" cy="60" r="6" fill="var(--text)"/>
              <circle cx="580" cy="60" r="6" fill="var(--text)"/>
              <text x="20" y="40" fontFamily="var(--font-mono)" fontSize="11" fill="var(--text-muted)">A · 60 km/h</text>
              <text x="540" y="40" fontFamily="var(--font-mono)" fontSize="11" fill="var(--text-muted)">B · 80 km/h</text>
              <text x="280" y="86" fontFamily="var(--font-mono)" fontSize="11" fill="var(--text-faint)">240 km</text>
              <path d="M 60 60 L 100 60" stroke="var(--accent)" strokeWidth="1.5" markerEnd="url(#arr)"/>
              <path d="M 540 60 L 500 60" stroke="var(--accent)" strokeWidth="1.5" markerEnd="url(#arr)"/>
              <defs>
                <marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)"/>
                </marker>
              </defs>
            </svg>
          </div>

          {/* Options */}
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {["96 minutes", "108 minutes", "102 minutes (240 ÷ 140 × 60)", "120 minutes"].map((opt, i) => {
              const isSel = i === selected;
              return (
                <button key={i} onClick={() => setSelected(i)} style={{
                  textAlign: "left", padding: "18px 20px",
                  background: isSel ? "var(--accent-soft)" : "var(--bg)",
                  border: `1px solid ${isSel ? "var(--accent)" : "var(--border)"}`,
                  borderRadius: 12, cursor: "pointer",
                  display: "flex", alignItems: "center", gap: 16,
                  fontFamily: "inherit", fontSize: 15, color: "var(--text)",
                  transition: "all .15s",
                }}>
                  <span style={{
                    width: 22, height: 22, borderRadius: "50%",
                    border: `1.5px solid ${isSel ? "var(--accent)" : "var(--border-strong)"}`,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    flexShrink: 0,
                  }}>
                    {isSel && <span style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--accent)" }}></span>}
                  </span>
                  <span className="mono" style={{ fontSize: 11, color: "var(--text-faint)", width: 14 }}>{String.fromCharCode(65 + i)}</span>
                  <span style={{ flex: 1 }}>{opt}</span>
                </button>
              );
            })}
          </div>

          {/* Footer nav */}
          <div className="row" style={{ marginTop: 40, gap: 8 }}>
            <button onClick={() => setCurrent(Math.max(0, current - 1))} className="btn btn-outline">
              <Icon name="arrowLeft" size={14} />
              Previous
            </button>
            <span className="spacer"></span>
            <button className="btn btn-ghost" style={{ color: "var(--text-muted)" }}>Skip</button>
            <button onClick={() => setCurrent(current + 1)} className="btn btn-primary">
              Next question
              <Icon name="arrow" size={14} />
            </button>
          </div>
        </div>

        {/* Side panel */}
        <aside style={{ borderLeft: "1px solid var(--border)", padding: "32px 24px", background: "var(--surface)" }}>
          <div className="mono" style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 14 }}>Navigator</div>
          <QuestionNav total={16} current={current} answered={answered} flagged={flagged} />
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 18, fontSize: 11, color: "var(--text-muted)" }}>
            <span className="row" style={{ gap: 8 }}>
              <span style={{ width: 10, height: 10, borderRadius: 3, background: "var(--accent)" }}></span> Current
            </span>
            <span className="row" style={{ gap: 8 }}>
              <span style={{ width: 10, height: 10, borderRadius: 3, background: "var(--surface-2)", border: "1px solid var(--border)" }}></span> Answered
            </span>
            <span className="row" style={{ gap: 8 }}>
              <span style={{ width: 10, height: 10, borderRadius: 3, border: "1px solid var(--warn)" }}></span> Flagged for review
            </span>
            <span className="row" style={{ gap: 8 }}>
              <span style={{ width: 10, height: 10, borderRadius: 3, border: "1px solid var(--border)" }}></span> Unseen
            </span>
          </div>

          <hr className="divider" style={{ margin: "24px 0" }}/>

          <div className="mono" style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 14 }}>Section progress</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {[
              { name: "Verbal analogies", v: 100 },
              { name: "Numerical series", v: 100 },
              { name: "Logical patterns", v: 38 },
              { name: "Spatial reasoning", v: 0 },
              { name: "Working memory", v: 0 },
            ].map((s, i) => (
              <div key={i}>
                <div className="row" style={{ marginBottom: 6 }}>
                  <span style={{ fontSize: 12 }}>{s.name}</span>
                  <span className="spacer"></span>
                  <span className="mono" style={{ fontSize: 10, color: "var(--text-faint)" }}>{s.v}%</span>
                </div>
                <div style={{ height: 3, background: "var(--surface-2)", borderRadius: 2, overflow: "hidden" }}>
                  <div style={{ width: `${s.v}%`, height: "100%", background: s.v === 100 ? "var(--success)" : "var(--accent)" }}></div>
                </div>
              </div>
            ))}
          </div>

          <div className="card" style={{ padding: 14, marginTop: 24, background: "var(--bg)" }}>
            <div className="row" style={{ gap: 8, marginBottom: 6 }}>
              <Icon name="sparkle" size={12} stroke={2} />
              <span style={{ fontSize: 12, fontWeight: 500 }}>Tip</span>
            </div>
            <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>
              You can press <span className="mono" style={{ background: "var(--surface)", padding: "1px 5px", borderRadius: 4 }}>1</span>–<span className="mono" style={{ background: "var(--surface)", padding: "1px 5px", borderRadius: 4 }}>4</span> to select an answer, <span className="mono" style={{ background: "var(--surface)", padding: "1px 5px", borderRadius: 4 }}>F</span> to flag.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
};

window.AssessmentScreen = AssessmentScreen;
