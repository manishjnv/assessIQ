/* Activity / Usage screen — OpenRouter-inspired patterns
   - Multi-stat cards with colored category breakdown
   - GitHub-style heatmap calendar
   - Leaderboard rows
   - Top-models stacked-bar over time
*/

const ACT_COLORS = ["#1a73e8", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#06b6d4", "#ef4444", "#6366f1"];

const StatChart = ({ title, value, breakdown, total }) => {
  // Render mini stacked bar(s) — one tall column showing category split
  return (
    <div className="card" style={{ padding: 24, height: "100%" }}>
      <div className="row" style={{ alignItems: "flex-start", marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 13, color: "var(--text-muted)", fontWeight: 500, marginBottom: 6 }}>{title}</div>
          <div className="num" style={{ fontSize: 32, letterSpacing: "-0.03em", lineHeight: 1, color: "var(--text)" }}>{value}</div>
        </div>
        <span className="spacer"></span>
        <button style={{ background: "transparent", border: 0, color: "var(--text-faint)", cursor: "pointer", padding: 4 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M15 3h6v6M14 10l7-7M9 21H3v-6M10 14l-7 7"/></svg>
        </button>
      </div>
      {/* Sparse mini chart: 5 columns, only last has data */}
      <div style={{ height: 80, display: "flex", alignItems: "flex-end", gap: 16, marginBottom: 16, padding: "0 4px" }}>
        {[0, 0, 0.08, 0, 1].map((h, i) => (
          <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column-reverse", height: "100%" }}>
            {h > 0 ? breakdown.map((b, j) => (
              <div key={j} style={{
                width: "100%",
                height: `${b.pct * h * 100}%`,
                background: ACT_COLORS[j % ACT_COLORS.length],
                opacity: i === 4 ? 1 : 0.7,
              }}></div>
            )) : null}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {breakdown.slice(0, 4).map((b, i) => (
          <div key={i} className="row" style={{ gap: 8, fontSize: 13 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: ACT_COLORS[i % ACT_COLORS.length], flexShrink: 0 }}></span>
            <span style={{ color: "var(--text)" }}>{b.label}</span>
            <span className="spacer"></span>
            <span className="mono" style={{ color: "var(--text-muted)", fontSize: 12 }}>{b.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

const Heatmap = () => {
  // 52 weeks × 7 days
  const weeks = 52;
  const days = 7;
  // deterministic pseudo-random based on index, weighted toward zero with bursts
  const intensity = (w, d) => {
    const seed = (w * 7 + d) * 9301 + 49297;
    const r = ((seed * 233280) % 100) / 100;
    const burst = (w > 38 && w < 46) || (w > 22 && w < 26);
    const base = burst ? 0.55 : 0.18;
    if (r < base) return Math.min(4, Math.floor(r * 8) + 1);
    return 0;
  };
  const monthLabels = ["Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May"];
  return (
    <div>
      {/* Month labels */}
      <div style={{ display: "grid", gridTemplateColumns: `28px repeat(${weeks}, 1fr)`, gap: 3, marginBottom: 6 }}>
        <div></div>
        {monthLabels.map((m, i) => (
          <div key={i} className="mono" style={{
            gridColumn: `${2 + Math.floor(i * weeks / 12)} / span ${Math.floor(weeks / 12)}`,
            fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em",
          }}>{m}</div>
        ))}
      </div>
      {/* Grid: 7 rows of weeks-cols */}
      <div style={{ display: "grid", gridTemplateColumns: "28px 1fr", gap: 6 }}>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "2px 0", fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-faint)" }}>
          <span>M</span><span>W</span><span>F</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${weeks}, 1fr)`, gridTemplateRows: `repeat(${days}, 1fr)`, gap: 3, gridAutoFlow: "column" }}>
          {Array.from({ length: weeks * days }).map((_, i) => {
            const w = Math.floor(i / days);
            const d = i % days;
            const v = intensity(w, d);
            const colors = ["var(--surface-2)", "oklch(0.92 0.06 258)", "oklch(0.82 0.12 258)", "oklch(0.68 0.16 258)", "oklch(0.55 0.18 258)"];
            return <div key={i} style={{ aspectRatio: "1", borderRadius: 2, background: colors[v], minWidth: 8 }} />;
          })}
        </div>
      </div>
      {/* Legend */}
      <div className="row" style={{ gap: 6, marginTop: 14, fontSize: 11, color: "var(--text-faint)" }}>
        <span className="mono" style={{ textTransform: "uppercase", letterSpacing: "0.08em" }}>Less</span>
        {[0, 1, 2, 3, 4].map(v => {
          const colors = ["var(--surface-2)", "oklch(0.92 0.06 258)", "oklch(0.82 0.12 258)", "oklch(0.68 0.16 258)", "oklch(0.55 0.18 258)"];
          return <span key={v} style={{ width: 11, height: 11, borderRadius: 2, background: colors[v] }}></span>;
        })}
        <span className="mono" style={{ textTransform: "uppercase", letterSpacing: "0.08em" }}>More</span>
        <span className="spacer"></span>
        <span className="mono">42-day streak · longest 71 days</span>
      </div>
    </div>
  );
};

const StackedBars = ({ count = 36 }) => {
  const segments = [0.46, 0.18, 0.14, 0.10, 0.06, 0.04, 0.02]; // distribution
  // Generate heights that climb over time
  const heights = Array.from({ length: count }, (_, i) => {
    const t = i / count;
    const base = 12 + t * 70;
    const noise = ((i * 9301) % 47) / 47 * 18 - 9;
    return Math.max(8, base + noise);
  });
  const max = Math.max(...heights);
  return (
    <div style={{ width: "100%" }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 200, paddingLeft: 36, borderLeft: "1px solid var(--border)", borderBottom: "1px solid var(--border)", position: "relative" }}>
        {/* y-axis labels */}
        {[0, 25, 50, 75, 100].reverse().map((y, i) => (
          <div key={y} className="mono" style={{ position: "absolute", left: -32, top: `${i * 25}%`, transform: "translateY(-50%)", fontSize: 10, color: "var(--text-faint)" }}>{y === 100 ? "28T" : y === 75 ? "21T" : y === 50 ? "14T" : y === 25 ? "7T" : "0"}</div>
        ))}
        {heights.map((h, i) => {
          const totalPct = (h / max) * 100;
          return (
            <div key={i} style={{ flex: 1, height: `${totalPct}%`, display: "flex", flexDirection: "column-reverse", minWidth: 4 }}>
              {segments.map((s, j) => (
                <div key={j} style={{ width: "100%", height: `${s * 100}%`, background: ACT_COLORS[j % ACT_COLORS.length], opacity: 0.85 }}></div>
              ))}
            </div>
          );
        })}
      </div>
      <div className="row" style={{ marginTop: 8, paddingLeft: 36 }}>
        <span className="mono" style={{ fontSize: 10, color: "var(--text-faint)" }}>May 2025</span>
        <span className="spacer"></span>
        <span className="mono" style={{ fontSize: 10, color: "var(--text-faint)" }}>May 2026</span>
      </div>
    </div>
  );
};

const Leaderboard = () => {
  const items = [
    { name: "Logical Reasoning III", by: "AccessIQ Cognitive", score: "4.2k", delta: "+12%", up: true },
    { name: "Frontend Engineering", by: "AccessIQ Technical", score: "3.8k", delta: "+8%", up: true },
    { name: "Big Five Profile", by: "AccessIQ Personality", score: "3.4k", delta: "+4%", up: true },
    { name: "SQL & Data Modeling", by: "AccessIQ Technical", score: "2.9k", delta: "-3%", up: false },
    { name: "Numerical Reasoning", by: "AccessIQ Cognitive", score: "2.7k", delta: "+18%", up: true },
    { name: "Business English C1", by: "AccessIQ Language", score: "2.1k", delta: "+6%", up: true },
    { name: "Spatial Reasoning II", by: "AccessIQ Cognitive", score: "1.8k", delta: "-1%", up: false },
    { name: "Customer Support Sim", by: "AccessIQ Custom", score: "1.4k", delta: "+22%", up: true },
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", columnGap: 40, rowGap: 4 }}>
      {items.map((it, i) => (
        <div key={i} className="row" style={{ padding: "12px 0", borderBottom: i < items.length - 2 ? "1px solid var(--border)" : 0, gap: 14 }}>
          <span className="mono" style={{ fontSize: 13, color: "var(--text-faint)", width: 24, textAlign: "right" }}>{i + 1}.</span>
          <div style={{
            width: 32, height: 32, borderRadius: "50%",
            background: ACT_COLORS[i % ACT_COLORS.length],
            opacity: 0.18,
            display: "flex", alignItems: "center", justifyContent: "center",
            flexShrink: 0,
          }}>
            <span style={{ width: 12, height: 12, borderRadius: "50%", background: ACT_COLORS[i % ACT_COLORS.length] }}></span>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 500, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.name}</div>
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>by <a style={{ color: "var(--accent)", textDecoration: "none" }}>{it.by}</a></div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="mono" style={{ fontSize: 13, color: "var(--text)" }}>{it.score} takers</div>
            <div className="mono" style={{ fontSize: 11, color: it.up ? "var(--success)" : "var(--danger)" }}>
              {it.up ? "↑" : "↓"} {it.delta.replace("+", "").replace("-", "")}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};

const ActivityScreen = () => (
  <div className="aiq-screen" style={{ display: "flex" }}>
    <Sidebar />
    <main style={{ flex: 1, overflow: "auto", padding: "32px 40px 48px" }}>
      {/* Header */}
      <div className="row" style={{ marginBottom: 28 }}>
        <div>
          <h1 className="serif" style={{ fontSize: 36, margin: 0, letterSpacing: "-0.02em" }}>Activity</h1>
          <p style={{ fontSize: 14, color: "var(--text-muted)", margin: "6px 0 0" }}>Your usage across assessments on AccessIQ.</p>
        </div>
        <div className="spacer"></div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn btn-outline btn-sm">
            <Icon name="settings" size={13} />
            Filter
          </button>
          <button className="btn btn-outline btn-sm">
            1 Month
            <Icon name="arrow" size={12} />
          </button>
          <button className="btn btn-outline btn-sm">By model</button>
          <button className="btn btn-primary btn-sm">View logs</button>
        </div>
      </div>

      {/* Stat-card row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 16 }}>
        <StatChart
          title="Assessments completed"
          value="142"
          breakdown={[
            { label: "Cognitive", value: "61", pct: 0.43 },
            { label: "Technical", value: "38", pct: 0.27 },
            { label: "Personality", value: "26", pct: 0.18 },
            { label: "Language", value: "17", pct: 0.12 },
          ]}
        />
        <StatChart
          title="Active candidates"
          value="2,418"
          breakdown={[
            { label: "Engineering", value: "984", pct: 0.41 },
            { label: "Product", value: "612", pct: 0.25 },
            { label: "Sales", value: "434", pct: 0.18 },
            { label: "Others", value: "388", pct: 0.16 },
          ]}
        />
        <StatChart
          title="Avg. score"
          value="76.4"
          breakdown={[
            { label: "Top quartile", value: "92.1", pct: 0.32 },
            { label: "Above median", value: "78.4", pct: 0.36 },
            { label: "Below median", value: "61.2", pct: 0.22 },
            { label: "Bottom quartile", value: "48.7", pct: 0.10 },
          ]}
        />
      </div>

      {/* Activity heatmap card */}
      <div className="card" style={{ padding: 28, marginBottom: 16 }}>
        <div className="row" style={{ marginBottom: 22 }}>
          <div>
            <h2 className="serif" style={{ margin: 0, fontSize: 22, letterSpacing: "-0.01em" }}>Activity streak</h2>
            <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "4px 0 0" }}>Assessments completed each day, last 12 months.</p>
          </div>
          <div className="spacer"></div>
          <div style={{ display: "flex", gap: 28 }}>
            <div>
              <div className="mono" style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Total</div>
              <div className="num" style={{ fontSize: 22 }}>1,284</div>
            </div>
            <div>
              <div className="mono" style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Avg / day</div>
              <div className="num" style={{ fontSize: 22 }}>3.5</div>
            </div>
            <div>
              <div className="mono" style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Active days</div>
              <div className="num" style={{ fontSize: 22 }}>218</div>
            </div>
          </div>
        </div>
        <Heatmap />
      </div>

      {/* Top assessments stacked bar */}
      <div className="card" style={{ padding: 28, marginBottom: 16 }}>
        <div className="row" style={{ marginBottom: 22 }}>
          <div>
            <h2 className="serif" style={{ margin: 0, fontSize: 22, letterSpacing: "-0.01em" }}>Top assessments</h2>
            <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "4px 0 0" }}>Weekly completions across the catalog.</p>
          </div>
          <div className="spacer"></div>
          <span className="chip">52 weeks</span>
        </div>
        <StackedBars />
        <div className="row" style={{ gap: 16, marginTop: 18, flexWrap: "wrap" }}>
          {["Cognitive", "Technical", "Personality", "Language", "Sales", "Custom", "Other"].map((l, i) => (
            <div key={l} className="row" style={{ gap: 6, fontSize: 12, color: "var(--text-muted)" }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: ACT_COLORS[i % ACT_COLORS.length] }}></span>
              {l}
            </div>
          ))}
        </div>
      </div>

      {/* Leaderboard */}
      <div className="card" style={{ padding: 28 }}>
        <div className="row" style={{ marginBottom: 4 }}>
          <h2 className="serif" style={{ margin: 0, fontSize: 22, letterSpacing: "-0.01em" }}>
            <Icon name="chart" size={18} /> &nbsp;Assessment leaderboard
          </h2>
          <div className="spacer"></div>
          <button className="btn btn-outline btn-sm">This week <Icon name="arrow" size={12} /></button>
        </div>
        <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "4px 0 22px" }}>Most-completed assessments on AccessIQ this week.</p>
        <Leaderboard />
        <div style={{ textAlign: "center", marginTop: 16 }}>
          <button className="btn btn-ghost btn-sm" style={{ color: "var(--text-muted)" }}>
            Show more
            <Icon name="arrow" size={12} />
          </button>
        </div>
      </div>
    </main>
  </div>
);

window.ActivityScreen = ActivityScreen;
