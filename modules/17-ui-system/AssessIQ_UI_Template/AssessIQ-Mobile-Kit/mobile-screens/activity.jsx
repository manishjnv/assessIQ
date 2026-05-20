/* AssessIQ mobile — Activity */

const intensities = ["var(--surface-2)", "oklch(0.92 0.06 258)", "oklch(0.82 0.12 258)", "oklch(0.68 0.16 258)", "oklch(0.55 0.18 258)"];

const Heatmap = () => {
  // 18 weeks × 7 days for mobile width
  const weeks = 18;
  const seed = (i, j) => {
    const x = Math.sin((i + 1) * 13.7 + (j + 1) * 4.2) * 1000;
    const v = Math.abs(x - Math.floor(x));
    if (v < 0.45) return 0;
    if (v < 0.65) return 1;
    if (v < 0.82) return 2;
    if (v < 0.93) return 3;
    return 4;
  };
  return (
    <div>
      {/* Month strip */}
      <div style={{
        display: "grid", gridTemplateColumns: `12px repeat(${weeks}, 1fr)`,
        gap: 3, marginBottom: 4, alignItems: "end",
      }}>
        <div />
        {Array.from({ length: weeks }).map((_, i) => (
          <div key={i} className="mono" style={{
            fontSize: 8, color: "var(--text-faint)",
            textTransform: "uppercase", letterSpacing: "0.06em",
            textAlign: "center",
          }}>{i === 0 ? "Dec" : i === 5 ? "Jan" : i === 10 ? "Feb" : i === 14 ? "Mar" : ""}</div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "12px 1fr", gap: 4 }}>
        <div style={{ display: "grid", gridTemplateRows: "repeat(7, 1fr)", gap: 3 }}>
          {["", "M", "", "W", "", "F", ""].map((d, i) => (
            <div key={i} className="mono" style={{
              fontSize: 8, color: "var(--text-faint)", lineHeight: 1, alignSelf: "center",
            }}>{d}</div>
          ))}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${weeks}, 1fr)`, gap: 3 }}>
          {Array.from({ length: weeks }).map((_, w) => (
            <div key={w} style={{ display: "grid", gridTemplateRows: "repeat(7, 1fr)", gap: 3 }}>
              {Array.from({ length: 7 }).map((_, d) => {
                const v = seed(w, d);
                return <div key={d} style={{
                  aspectRatio: "1", borderRadius: 2, background: intensities[v],
                }} />;
              })}
            </div>
          ))}
        </div>
      </div>
      {/* Legend */}
      <div className="row" style={{ marginTop: 12, gap: 6 }}>
        <span className="mono" style={{ fontSize: 9, color: "var(--text-faint)" }}>Less</span>
        {intensities.map((c, i) => (
          <span key={i} style={{ width: 10, height: 10, borderRadius: 2, background: c }} />
        ))}
        <span className="mono" style={{ fontSize: 9, color: "var(--text-faint)" }}>More</span>
        <span className="spacer"></span>
        <span className="mono" style={{ fontSize: 10, color: "var(--text)" }}>
          <span style={{ color: "var(--accent)" }}>●</span> 14-day streak
        </span>
      </div>
    </div>
  );
};

const ACT_COLORS = ["oklch(0.58 0.17 258)", "oklch(0.65 0.15 150)", "oklch(0.72 0.15 70)", "oklch(0.62 0.20 25)"];

const StackedMini = () => {
  const weeks = [
    [3, 1, 0, 0], [2, 2, 1, 0], [4, 1, 1, 0], [3, 3, 0, 0],
    [5, 2, 1, 1], [4, 4, 2, 0], [6, 3, 1, 0], [5, 5, 2, 1], [3, 2, 1, 0],
  ];
  const max = Math.max(...weeks.map(w => w.reduce((a, b) => a + b, 0)));
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 5, height: 80 }}>
      {weeks.map((w, i) => {
        const tot = w.reduce((a, b) => a + b, 0);
        const h = (tot / max) * 100;
        return (
          <div key={i} style={{
            flex: 1, height: h + "%",
            display: "flex", flexDirection: "column-reverse", borderRadius: 3, overflow: "hidden",
            opacity: i === weeks.length - 1 ? 0.5 : 1,
          }}>
            {w.map((v, j) => (
              <div key={j} style={{ height: (v / tot) * 100 + "%", background: ACT_COLORS[j] }} />
            ))}
          </div>
        );
      })}
    </div>
  );
};

const LBRow = ({ rank, name, by, takers, delta, up }) => (
  <div className="row" style={{ padding: "10px 0", borderBottom: "1px solid var(--border)", gap: 10 }}>
    <span className="mono" style={{ fontSize: 12, color: "var(--text-faint)", width: 18, textAlign: "right" }}>{rank}.</span>
    <div style={{
      width: 28, height: 28, borderRadius: 999, flexShrink: 0,
      background: "color-mix(in oklch, var(--accent) 14%, transparent)",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <span style={{ width: 10, height: 10, borderRadius: 999, background: "var(--accent)" }} />
    </div>
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 13, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</div>
      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{by}</div>
    </div>
    <div style={{ textAlign: "right" }}>
      <div className="mono" style={{ fontSize: 12 }}>{takers}</div>
      <div className="mono" style={{ fontSize: 10, color: up ? "var(--success)" : "var(--danger)" }}>{up ? "↑" : "↓"} {delta}</div>
    </div>
  </div>
);

const MobileActivity = () => (
  <div className="aiq-mobile">
    <div className="scroll-body safe-top pad-tab">
      {/* Header */}
      <MobileHeader
        eyebrow="Last 90 days"
        title="Activity"
        right={<IconBtn icon="settings" />}
      />

      {/* Stat strip */}
      <div style={{ padding: "4px 22px 18px", display: "flex", gap: 10 }}>
        <StatPill label="Sessions" value="142" sub="+18%" />
        <StatPill label="Hours" value="34.5" sub="this qtr" accent />
        <StatPill label="Avg/day" value="1.6" sub="of 1.2" />
      </div>

      {/* Heatmap card */}
      <div style={{ padding: "0 22px 18px" }}>
        <div className="card" style={{ padding: 18 }}>
          <div className="row" style={{ alignItems: "flex-start", marginBottom: 14 }}>
            <div>
              <div className="mono" style={{
                fontSize: 9, color: "var(--text-faint)",
                textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6,
              }}>Daily activity</div>
              <h3 className="serif" style={{ margin: 0, fontSize: 18, fontWeight: 500, letterSpacing: "-0.015em" }}>
                126 active days
              </h3>
            </div>
            <span className="spacer"></span>
            <span className="chip chip-accent" style={{ fontSize: 9 }}>3.1 / day</span>
          </div>
          <Heatmap />
        </div>
      </div>

      {/* Weekly tokens */}
      <div style={{ padding: "0 22px 18px" }}>
        <div className="card" style={{ padding: 18 }}>
          <div className="row" style={{ marginBottom: 14 }}>
            <div>
              <div className="mono" style={{
                fontSize: 9, color: "var(--text-faint)",
                textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6,
              }}>Sessions by category</div>
              <h3 className="serif" style={{ margin: 0, fontSize: 18, fontWeight: 500, letterSpacing: "-0.015em" }}>
                Weekly mix
              </h3>
            </div>
            <span className="spacer"></span>
            <span className="mono" style={{ fontSize: 10, color: "var(--text-muted)" }}>9 wks</span>
          </div>
          <StackedMini />
          <div className="row" style={{ marginTop: 12, gap: 12, flexWrap: "wrap" }}>
            {[
              { label: "Cognitive", c: ACT_COLORS[0] },
              { label: "Technical", c: ACT_COLORS[1] },
              { label: "Personality", c: ACT_COLORS[2] },
              { label: "Custom", c: ACT_COLORS[3] },
            ].map((l, i) => (
              <span key={i} className="row" style={{ gap: 6, fontSize: 11, color: "var(--text-muted)" }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: l.c }} />
                {l.label}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Leaderboard */}
      <SectionHeader title="Most active this week" link="View all →" />
      <div style={{ padding: "0 22px 20px" }}>
        <LBRow rank={1} name="Logical Reasoning III" by="AssessIQ Cognitive" takers="4.2k" delta="12%" up />
        <LBRow rank={2} name="Frontend Engineering" by="AssessIQ Technical" takers="3.8k" delta="8%" up />
        <LBRow rank={3} name="Big Five Profile" by="AssessIQ Personality" takers="3.4k" delta="4%" up />
        <LBRow rank={4} name="Numerical Reasoning" by="AssessIQ Cognitive" takers="2.7k" delta="18%" up />
        <LBRow rank={5} name="SQL & Data Modeling" by="AssessIQ Technical" takers="2.9k" delta="3%" up={false} />
      </div>
    </div>
    <TabBar active="activity" />
  </div>
);

window.MobileActivity = MobileActivity;
