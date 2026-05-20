/* AssessIQ mobile — Results / Report */

const MobileScoreRing = ({ value = 132, max = 160, size = 184 }) => {
  const [on, setOn] = React.useState(false);
  React.useEffect(() => { const t = setTimeout(() => setOn(true), 200); return () => clearTimeout(t); }, []);
  const display = useCountUp(value, 1600, on);
  const r = (size - 22) / 2;
  const c = 2 * Math.PI * r;
  const pct = on ? value / max : 0;
  return (
    <div style={{ position: "relative", width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--surface-2)" strokeWidth="4"/>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--accent)" strokeWidth="4"
          strokeDasharray={c} strokeDashoffset={c * (1 - pct)} strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 1.6s cubic-bezier(.2,.8,.2,1)" }} />
      </svg>
      <div style={{
        position: "absolute", inset: 0,
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      }}>
        <span className="num" style={{ fontSize: 50, lineHeight: 1, letterSpacing: "-0.04em" }}>{display}</span>
        <span className="mono" style={{
          fontSize: 9, color: "var(--text-faint)",
          textTransform: "uppercase", letterSpacing: "0.1em", marginTop: 6,
        }}>of {max}</span>
      </div>
    </div>
  );
};

const CatRow = ({ name, v, p }) => (
  <div style={{ padding: "12px 0", borderBottom: "1px solid var(--border)" }}>
    <div className="row" style={{ alignItems: "baseline", marginBottom: 6 }}>
      <span style={{ fontSize: 13, fontWeight: 500 }}>{name}</span>
      <span className="spacer"></span>
      <span className="num" style={{ fontSize: 16 }}>{v}</span>
      <span style={{ fontSize: 11, color: "var(--text-muted)", marginLeft: 2 }}>/100</span>
      <span className="mono" style={{ fontSize: 10, color: "var(--text-faint)", marginLeft: 10, width: 30, textAlign: "right" }}>{p}<span style={{ fontSize: 8 }}>th</span></span>
    </div>
    <div style={{ height: 6, background: "var(--surface-2)", borderRadius: 3, overflow: "hidden" }}>
      <div style={{ width: v + "%", height: "100%", background: "var(--text)" }} />
    </div>
  </div>
);

const MobileResults = () => {
  const cats = [
    { name: "Verbal reasoning", v: 88, p: 94 },
    { name: "Logical patterns", v: 92, p: 97 },
    { name: "Spatial reasoning", v: 71, p: 78 },
    { name: "Numerical", v: 84, p: 89 },
    { name: "Working memory", v: 76, p: 82 },
  ];
  return (
    <div className="aiq-mobile">
      <div className="scroll-body safe-top pad-tab">
        {/* Header */}
        <div className="row" style={{ padding: "10px 18px 4px" }}>
          <button style={{
            width: 32, height: 32, borderRadius: 999, border: "1px solid var(--border)",
            background: "var(--bg)", display: "inline-flex", alignItems: "center",
            justifyContent: "center", padding: 0,
          }}>
            <Icon name="arrowLeft" size={14} />
          </button>
          <span className="spacer"></span>
          <button className="btn btn-ghost btn-sm" style={{ padding: "5px 10px" }}>Share</button>
          <button className="btn btn-outline btn-sm" style={{ padding: "5px 10px" }}>PDF</button>
        </div>

        {/* Hero */}
        <div style={{ padding: "16px 22px 8px" }}>
          <div className="row" style={{ gap: 8, marginBottom: 10 }}>
            <span className="chip chip-success" style={{ fontSize: 9 }}>
              <Icon name="check" size={10} stroke={2} /> Completed
            </span>
            <span className="mono" style={{ fontSize: 10, color: "var(--text-faint)" }}>#A-2841</span>
          </div>
          <h1 className="serif" style={{
            margin: 0, fontSize: 28, fontWeight: 500, letterSpacing: "-0.025em", lineHeight: 1.05,
          }}>
            Cognitive Reasoning III
          </h1>
          <div className="mono" style={{
            marginTop: 6, fontSize: 10, color: "var(--text-faint)",
            textTransform: "uppercase", letterSpacing: "0.08em",
          }}>Apr 29, 2026 · 14:32 · 47:12 duration</div>
        </div>

        {/* Score ring */}
        <div style={{ display: "flex", justifyContent: "center", padding: "20px 0 8px" }}>
          <MobileScoreRing />
        </div>

        {/* Subtitle stats */}
        <div className="row" style={{ padding: "0 22px 22px", gap: 0 }}>
          <div style={{ flex: 1, textAlign: "center" }}>
            <div className="mono" style={{ fontSize: 9, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Percentile</div>
            <div className="num" style={{ fontSize: 22, marginTop: 2 }}>97<span style={{ fontSize: 12, color: "var(--text-muted)" }}>th</span></div>
          </div>
          <div style={{ width: 1, background: "var(--border)" }} />
          <div style={{ flex: 1, textAlign: "center" }}>
            <div className="mono" style={{ fontSize: 9, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Band</div>
            <div className="num" style={{ fontSize: 22, marginTop: 2 }}>A<span style={{ fontSize: 14, color: "var(--text-muted)" }}>+</span></div>
          </div>
          <div style={{ width: 1, background: "var(--border)" }} />
          <div style={{ flex: 1, textAlign: "center" }}>
            <div className="mono" style={{ fontSize: 9, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Time</div>
            <div className="num" style={{ fontSize: 22, marginTop: 2, fontVariantNumeric: "tabular-nums" }}>47:12</div>
          </div>
        </div>

        {/* Lede */}
        <p style={{ padding: "0 22px", margin: "0 0 16px", fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5 }}>
          You scored higher than <span style={{ color: "var(--text)", fontWeight: 500 }}>97%</span> of test-takers. Your strongest category was <span style={{ color: "var(--text)", fontWeight: 500 }}>Logical patterns</span>.
        </p>

        {/* Breakdown */}
        <div style={{ padding: "12px 22px 8px" }}>
          <div className="mono" style={{
            fontSize: 9, color: "var(--text-faint)",
            textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4,
          }}>Competency breakdown</div>
          {cats.map((c, i) => <CatRow key={i} {...c} />)}
        </div>

        {/* AI insights */}
        <div style={{ padding: "20px 22px 8px" }}>
          <div className="card" style={{ padding: 18, background: "var(--surface)" }}>
            <div className="row" style={{ marginBottom: 10, gap: 8 }}>
              <Icon name="sparkle" size={13} stroke={2} />
              <span className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-faint)" }}>
                AI insights
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <div className="serif" style={{ fontSize: 14, fontWeight: 500, marginBottom: 2 }}>Strengths</div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
                  Sequence recognition and conditional logic. You handled compound conditionals
                  faster than 99% of test-takers.
                </div>
              </div>
              <div>
                <div className="serif" style={{ fontSize: 14, fontWeight: 500, marginBottom: 2 }}>Growth areas</div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
                  Spatial rotation slowed you down. Try the <a style={{ color: "var(--accent)", textDecoration: "none" }}>Spatial Reasoning II</a> set next.
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Retake CTA */}
        <div style={{ padding: "18px 22px 8px" }}>
          <button className="btn btn-primary btn-lg" style={{ width: "100%", justifyContent: "center", padding: "13px 0" }}>
            Retake assessment <Icon name="arrow" size={14} stroke={2} />
          </button>
        </div>
      </div>
    </div>
  );
};

window.MobileResults = MobileResults;
