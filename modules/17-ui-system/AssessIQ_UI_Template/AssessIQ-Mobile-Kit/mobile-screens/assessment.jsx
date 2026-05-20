/* AssessIQ mobile — Assessment in progress */

const MobileAssessment = () => {
  const [selected, setSelected] = React.useState(2);
  const [secondsLeft, setSecondsLeft] = React.useState(28 * 60 + 14);
  React.useEffect(() => {
    const t = setInterval(() => setSecondsLeft(s => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, []);
  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, "0");
  const ss = String(secondsLeft % 60).padStart(2, "0");
  const current = 6;
  const total = 16;
  const pct = ((current + 1) / total) * 100;

  const options = [
    "1 hour 12 minutes",
    "2 hours",
    "1 hour 42 minutes",
    "2 hours 24 minutes",
  ];

  return (
    <div className="aiq-mobile">
      {/* Sticky top: status-bar safe + meta + timer */}
      <div className="safe-top" style={{
        position: "relative", zIndex: 4,
        background: "var(--bg)", borderBottom: "1px solid var(--border)",
      }}>
        <div className="row" style={{ padding: "8px 18px 10px", gap: 10 }}>
          <button style={{
            width: 32, height: 32, borderRadius: 999, border: "1px solid var(--border)",
            background: "var(--bg)", display: "inline-flex", alignItems: "center",
            justifyContent: "center", padding: 0,
          }}>
            <Icon name="close" size={14} />
          </button>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 500, lineHeight: 1.1 }}>Cognitive Reasoning III</div>
            <div className="mono" style={{
              fontSize: 9, color: "var(--text-faint)", textTransform: "uppercase",
              letterSpacing: "0.08em", marginTop: 2,
            }}>Section 3 of 5 · Logical patterns</div>
          </div>
          {/* Timer pill */}
          <div className="row" style={{
            gap: 6, padding: "6px 12px",
            border: `1px solid ${secondsLeft < 300 ? "var(--danger)" : "var(--border-strong)"}`,
            borderRadius: 999,
            color: secondsLeft < 300 ? "var(--danger)" : "var(--text)",
          }}>
            <Icon name="clock" size={12} />
            <span className="num" style={{
              fontSize: 14, fontVariantNumeric: "tabular-nums", letterSpacing: "0.02em",
            }}>{mm}:{ss}</span>
          </div>
        </div>
        {/* 2px progress */}
        <div style={{ height: 2, background: "var(--surface-2)" }}>
          <div style={{ width: pct + "%", height: "100%", background: "var(--accent)" }} />
        </div>
      </div>

      <div className="scroll-body" style={{ paddingBottom: 110 }}>
        {/* Auto-saved bar */}
        <div className="row" style={{ padding: "10px 22px 0", gap: 8 }}>
          <span className="row" style={{ gap: 6, fontSize: 11, color: "var(--text-muted)" }}>
            <span style={{ width: 6, height: 6, borderRadius: 999, background: "var(--success)", boxShadow: "0 0 0 3px oklch(0.92 0.06 150)" }} />
            Auto-saved · 4s ago
          </span>
          <span className="spacer"></span>
          <span className="chip" style={{ fontSize: 9, padding: "2px 8px" }}>
            <Icon name="eye" size={10} /> Proctored
          </span>
        </div>

        {/* Question meta */}
        <div className="row" style={{ padding: "20px 22px 8px", gap: 8 }}>
          <span className="mono" style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
            Question {current + 1} / {total}
          </span>
          <span className="mono" style={{ fontSize: 10, color: "var(--text-faint)" }}>·</span>
          <span className="mono" style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
            Multiple choice
          </span>
          <span className="spacer"></span>
          <button className="btn btn-ghost btn-sm" style={{ padding: "3px 8px", fontSize: 11, color: "var(--text-muted)" }}>
            <Icon name="flag" size={11} /> Flag
          </button>
        </div>

        {/* Question */}
        <h2 className="serif" style={{
          padding: "0 22px", margin: 0,
          fontSize: 22, lineHeight: 1.35, fontWeight: 500, letterSpacing: "-0.015em",
        }}>
          A train leaves station A at 60 km/h. A second train leaves station B, 240 km away, at 80 km/h, traveling toward A. After how long do they meet?
        </h2>

        {/* Options */}
        <div style={{ padding: "22px 22px 12px", display: "flex", flexDirection: "column", gap: 10 }}>
          {options.map((opt, i) => {
            const on = i === selected;
            return (
              <button key={i} onClick={() => setSelected(i)} style={{
                textAlign: "left", padding: "14px 16px",
                background: on ? "var(--accent-soft)" : "var(--bg)",
                border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`,
                borderRadius: 12, cursor: "pointer", fontFamily: "inherit",
                display: "flex", alignItems: "center", gap: 12, fontSize: 14, color: "var(--text)",
              }}>
                <span style={{
                  width: 18, height: 18, borderRadius: 999, flexShrink: 0,
                  border: `1.5px solid ${on ? "var(--accent)" : "var(--border-strong)"}`,
                  background: "var(--bg)",
                  position: "relative",
                }}>
                  {on && <span style={{
                    position: "absolute", inset: 3, borderRadius: 999, background: "var(--accent)",
                  }} />}
                </span>
                <span className="mono" style={{
                  fontSize: 11, color: "var(--text-faint)", width: 14,
                  textTransform: "uppercase",
                }}>{String.fromCharCode(65 + i)}</span>
                <span style={{ flex: 1 }}>{opt}</span>
              </button>
            );
          })}
        </div>

        {/* Question navigator */}
        <div style={{ padding: "16px 22px 6px" }}>
          <div className="mono" style={{
            fontSize: 9, color: "var(--text-faint)", textTransform: "uppercase",
            letterSpacing: "0.08em", marginBottom: 10,
          }}>Navigator</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 5 }}>
            {Array.from({ length: total }).map((_, i) => {
              const isCurrent = i === current;
              const isAnswered = i < current;
              const isFlagged = i === 3 || i === 9;
              return (
                <div key={i} style={{
                  aspectRatio: "1", display: "flex", alignItems: "center", justifyContent: "center",
                  borderRadius: 5, fontSize: 10, fontFamily: "var(--font-mono)", position: "relative",
                  background: isCurrent ? "var(--accent)" : isAnswered ? "var(--surface)" : "transparent",
                  color: isCurrent ? "white" : isAnswered ? "var(--text)" : "var(--text-faint)",
                  border: `1px solid ${isCurrent ? "var(--accent)" : isFlagged ? "var(--warn)" : "var(--border)"}`,
                }}>
                  {i + 1}
                  {isFlagged && <span style={{ position: "absolute", top: -2, right: -2, width: 5, height: 5, borderRadius: 999, background: "var(--warn)" }} />}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Footer nav — fixed above home indicator */}
      <div style={{
        position: "absolute", left: 0, right: 0, bottom: 0,
        background: "color-mix(in srgb, var(--bg) 95%, transparent)",
        backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)",
        borderTop: "1px solid var(--border)",
        padding: "12px 18px 42px",
        display: "flex", gap: 8, alignItems: "center", zIndex: 5,
      }}>
        <button className="btn btn-outline" style={{ padding: "10px 14px" }}>
          <Icon name="arrowLeft" size={14} /> Prev
        </button>
        <button className="btn btn-ghost" style={{ padding: "10px 12px", color: "var(--text-muted)" }}>Skip</button>
        <span className="spacer"></span>
        <button className="btn btn-primary" style={{ padding: "10px 22px" }}>
          Next <Icon name="arrow" size={14} stroke={2} />
        </button>
      </div>
    </div>
  );
};

window.MobileAssessment = MobileAssessment;
