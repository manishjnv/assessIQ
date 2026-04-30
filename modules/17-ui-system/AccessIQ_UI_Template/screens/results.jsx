/* Results / Report screen */

const ScoreRing = ({ value, max = 160, size = 200 }) => {
  const [animated, setAnimated] = React.useState(false);
  React.useEffect(() => {
    const t = setTimeout(() => setAnimated(true), 200);
    return () => clearTimeout(t);
  }, []);
  const display = useCountUp(value, 1600, animated);
  const r = (size - 24) / 2;
  const c = 2 * Math.PI * r;
  const pct = animated ? value / max : 0;
  return (
    <div style={{ position: "relative", width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--surface-2)" strokeWidth="4"/>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--accent)" strokeWidth="4" strokeDasharray={c} strokeDashoffset={c * (1 - pct)} strokeLinecap="round" style={{ transition: "stroke-dashoffset 1.6s cubic-bezier(.2,.8,.2,1)" }}/>
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <span className="num" style={{ fontSize: 56, lineHeight: 1, letterSpacing: "-0.04em" }}>{display}</span>
        <span className="mono" style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.1em", marginTop: 6 }}>of {max}</span>
      </div>
    </div>
  );
};

const ResultsScreen = () => {
  const cats = [
    { name: "Verbal reasoning", v: 88, p: 94 },
    { name: "Logical patterns", v: 92, p: 97 },
    { name: "Spatial reasoning", v: 71, p: 78 },
    { name: "Numerical", v: 84, p: 89 },
    { name: "Working memory", v: 76, p: 82 },
  ];
  return (
    <div className="aiq-screen scroll" style={{ background: "var(--bg)" }}>
      {/* Header */}
      <header style={{ padding: "20px 40px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 16 }}>
        <Logo />
        <span style={{ height: 18, width: 1, background: "var(--border)" }}></span>
        <a className="row" style={{ gap: 6, fontSize: 13, color: "var(--text-muted)", cursor: "pointer" }}>
          <Icon name="arrowLeft" size={14} />
          Back to dashboard
        </a>
        <div className="spacer"></div>
        <button className="btn btn-ghost btn-sm">Share</button>
        <button className="btn btn-outline btn-sm">Download PDF</button>
        <button className="btn btn-primary btn-sm">Retake</button>
      </header>

      <div style={{ maxWidth: 1080, margin: "0 auto", padding: "48px 40px 80px" }}>
        {/* Hero */}
        <div className="row" style={{ gap: 12, marginBottom: 12 }}>
          <span className="chip chip-success">
            <Icon name="check" size={10} stroke={2} />
            Completed
          </span>
          <span className="mono" style={{ fontSize: 11, color: "var(--text-faint)" }}>April 29, 2026 · 14:32</span>
          <span className="mono" style={{ fontSize: 11, color: "var(--text-faint)" }}>· #A-2841</span>
        </div>
        <h1 className="serif" style={{ fontSize: 52, fontWeight: 400, letterSpacing: "-0.025em", lineHeight: 1.05, margin: "0 0 12px" }}>
          Cognitive Reasoning III
        </h1>
        <p style={{ fontSize: 17, color: "var(--text-muted)", margin: 0, maxWidth: 600 }}>
          Strong overall performance with standout logical reasoning. Below is your competency-level breakdown.
        </p>

        {/* Top — score ring + percentile */}
        <div className="card" style={{ padding: 36, marginTop: 36, display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 48, alignItems: "center" }}>
          <ScoreRing value={132} />
          <div>
            <div className="mono" style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>Overall score</div>
            <div className="row" style={{ alignItems: "baseline", gap: 12, marginBottom: 18 }}>
              <span className="num" style={{ fontSize: 56, letterSpacing: "-0.03em", lineHeight: 1 }}>132</span>
              <span style={{ fontSize: 14, color: "var(--text-muted)" }}>/ 160</span>
              <span className="chip chip-success" style={{ marginLeft: 8 }}>Above average</span>
            </div>
            <p style={{ fontSize: 14, color: "var(--text-muted)", margin: 0, lineHeight: 1.5, maxWidth: 380 }}>
              You scored higher than 97% of test-takers in this assessment.
              Your strongest category was <strong style={{ color: "var(--text)", fontWeight: 500 }}>Logical patterns</strong>.
            </p>
          </div>
          <div style={{ borderLeft: "1px solid var(--border)", paddingLeft: 36, textAlign: "left" }}>
            <div className="mono" style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>Percentile</div>
            <div className="num" style={{ fontSize: 48, letterSpacing: "-0.03em", lineHeight: 1 }}>97<span style={{ fontSize: 18, color: "var(--text-muted)" }}>th</span></div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>vs. 4.2M takers</div>
            <div className="divider" style={{ margin: "16px 0" }}></div>
            <div className="mono" style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>Time</div>
            <div className="num" style={{ fontSize: 22 }}>47:12</div>
          </div>
        </div>

        {/* Category breakdown */}
        <div style={{ marginTop: 40 }}>
          <div className="row" style={{ marginBottom: 18 }}>
            <h2 className="serif" style={{ margin: 0, fontSize: 28, fontWeight: 400, letterSpacing: "-0.015em" }}>Competency breakdown</h2>
            <span className="spacer"></span>
            <span className="chip">5 categories</span>
          </div>
          <div className="card">
            {cats.map((c, i) => (
              <div key={i} style={{
                padding: "20px 24px",
                borderBottom: i === cats.length - 1 ? 0 : "1px solid var(--border)",
                display: "grid", gridTemplateColumns: "200px 1fr 80px 80px", gap: 24, alignItems: "center",
              }}>
                <div style={{ fontSize: 14, fontWeight: 500 }}>{c.name}</div>
                <div style={{ height: 6, background: "var(--surface-2)", borderRadius: 3, overflow: "hidden", position: "relative" }}>
                  <div style={{ width: `${c.v}%`, height: "100%", background: "var(--text)", transition: "width 1s ease-out" }}></div>
                </div>
                <div className="mono" style={{ fontSize: 12, textAlign: "right", color: "var(--text-muted)" }}>{c.v}<span style={{ color: "var(--text-faint)" }}>/100</span></div>
                <div className="mono" style={{ fontSize: 12, textAlign: "right", color: "var(--accent)" }}>{c.p}th</div>
              </div>
            ))}
          </div>
        </div>

        {/* AI summary */}
        <div style={{ marginTop: 40, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div className="card" style={{ padding: 28 }}>
            <div className="row" style={{ gap: 8, marginBottom: 14 }}>
              <Icon name="sparkle" size={14} stroke={2} />
              <span className="mono" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-muted)" }}>AI insights</span>
            </div>
            <h3 className="serif" style={{ fontSize: 22, fontWeight: 400, margin: "0 0 16px" }}>Strengths</h3>
            <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 12 }}>
              {[
                "Exceptional pattern recognition under time pressure",
                "Consistent accuracy across multi-step logic",
                "Strong verbal-analogical transfer",
              ].map((s, i) => (
                <li key={i} className="row" style={{ gap: 12, alignItems: "flex-start" }}>
                  <span style={{ width: 4, height: 4, borderRadius: "50%", background: "var(--text)", marginTop: 8 }}></span>
                  <span style={{ fontSize: 14, color: "var(--text)", lineHeight: 1.5 }}>{s}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="card" style={{ padding: 28 }}>
            <div className="row" style={{ gap: 8, marginBottom: 14 }}>
              <Icon name="sparkle" size={14} stroke={2} />
              <span className="mono" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-muted)" }}>Growth areas</span>
            </div>
            <h3 className="serif" style={{ fontSize: 22, fontWeight: 400, margin: "0 0 16px" }}>Where to focus</h3>
            <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 12 }}>
              {[
                { t: "Spatial rotation", h: "Try mental rotation drills 10 min/day" },
                { t: "Working memory span", h: "Practice n-back exercises" },
              ].map((s, i) => (
                <li key={i} className="row" style={{ gap: 12, alignItems: "flex-start" }}>
                  <span style={{ width: 4, height: 4, borderRadius: "50%", background: "var(--accent)", marginTop: 8 }}></span>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 500 }}>{s.t}</div>
                    <div style={{ fontSize: 13, color: "var(--text-muted)" }}>{s.h}</div>
                  </div>
                </li>
              ))}
            </ul>
            <button className="btn btn-outline btn-sm" style={{ marginTop: 18 }}>
              See recommended assessments
              <Icon name="arrow" size={12} />
            </button>
          </div>
        </div>

        {/* Comparison band */}
        <div className="card" style={{ marginTop: 16, padding: 28 }}>
          <div className="row" style={{ marginBottom: 18 }}>
            <h3 className="serif" style={{ margin: 0, fontSize: 22, fontWeight: 400 }}>Score distribution</h3>
            <span className="spacer"></span>
            <span className="mono" style={{ fontSize: 11, color: "var(--text-faint)" }}>You: 132 · Median: 98</span>
          </div>
          <div style={{ position: "relative", height: 90 }}>
            <svg viewBox="0 0 600 90" preserveAspectRatio="none" style={{ width: "100%", height: "100%" }}>
              <path d="M0 90 Q 60 80, 100 70 T 220 30 T 300 20 T 420 35 T 520 70 T 600 90 Z" fill="var(--surface)" stroke="var(--border-strong)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
              {/* Median */}
              <line x1="300" y1="0" x2="300" y2="90" stroke="var(--text-faint)" strokeWidth="1" strokeDasharray="3 3" vectorEffect="non-scaling-stroke"/>
              {/* You */}
              <line x1="495" y1="0" x2="495" y2="90" stroke="var(--accent)" strokeWidth="1.5" vectorEffect="non-scaling-stroke"/>
            </svg>
            <div style={{ position: "absolute", left: "50%", top: -2, transform: "translateX(-50%)", fontSize: 10, color: "var(--text-faint)", fontFamily: "var(--font-mono)" }}>median</div>
            <div style={{ position: "absolute", left: "82.5%", top: -2, transform: "translateX(-50%)", fontSize: 10, color: "var(--accent)", fontFamily: "var(--font-mono)", fontWeight: 500 }}>you · 132</div>
          </div>
          <div className="row" style={{ marginTop: 6 }}>
            <span className="mono" style={{ fontSize: 10, color: "var(--text-faint)" }}>40</span>
            <span className="spacer"></span>
            <span className="mono" style={{ fontSize: 10, color: "var(--text-faint)" }}>160</span>
          </div>
        </div>
      </div>
    </div>
  );
};

window.ResultsScreen = ResultsScreen;
