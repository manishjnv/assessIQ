/* AssessIQ mobile — Today / Home */

const StatPill = ({ label, value, sub, accent }) => (
  <div className="card" style={{ padding: 16, flex: 1, minWidth: 0 }}>
    <div className="mono" style={{
      fontSize: 9, color: "var(--text-faint)", textTransform: "uppercase",
      letterSpacing: "0.08em", marginBottom: 10,
    }}>{label}</div>
    <div className="row" style={{ alignItems: "baseline", gap: 6 }}>
      <span className="num" style={{
        fontSize: 30, lineHeight: 1, letterSpacing: "-0.03em",
        color: accent ? "var(--accent)" : "var(--text)",
      }}>{value}</span>
      {sub && <span className="mono" style={{ fontSize: 10, color: "var(--text-muted)" }}>{sub}</span>}
    </div>
  </div>
);

const ContinueCard = () => {
  const pct = 64;
  return (
    <div className="card" style={{ padding: 18, marginBottom: 22, position: "relative", overflow: "hidden" }}>
      <div className="row" style={{ alignItems: "flex-start", gap: 14 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="mono" style={{ fontSize: 9, color: "var(--accent)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>
            In progress · #A-2841
          </div>
          <h3 className="serif" style={{ margin: 0, fontSize: 20, fontWeight: 500, letterSpacing: "-0.015em" }}>
            Logical Reasoning III
          </h3>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
            Q 14 / 22 · 23 min left
          </div>
        </div>
        <div style={{
          width: 44, height: 44, borderRadius: 999,
          background: "var(--accent)", color: "white",
          display: "flex", alignItems: "center", justifyContent: "center",
          flexShrink: 0,
        }}>
          <Icon name="play" size={16} stroke={2} />
        </div>
      </div>
      <div style={{ height: 4, background: "var(--surface-2)", borderRadius: 2, overflow: "hidden", marginTop: 14 }}>
        <div style={{ width: pct + "%", height: "100%", background: "var(--accent)" }} />
      </div>
      <div className="row" style={{ marginTop: 8, justifyContent: "space-between" }}>
        <span className="mono" style={{ fontSize: 10, color: "var(--text-faint)" }}>14 / 22 answered</span>
        <span className="mono" style={{ fontSize: 10, color: "var(--text-faint)" }}>64%</span>
      </div>
    </div>
  );
};

const RowItem = ({ cat, title, mins, q, level }) => (
  <div className="row" style={{
    padding: "14px 0", gap: 14, borderBottom: "1px solid var(--border)",
  }}>
    <div style={{
      width: 36, height: 36, borderRadius: 10, flexShrink: 0,
      background: "var(--surface)", border: "1px solid var(--border)",
      display: "flex", alignItems: "center", justifyContent: "center",
      color: "var(--text-muted)",
    }}>
      <Icon name={cat === "code" ? "code" : cat === "book" ? "book" : "chart"} size={15} />
    </div>
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 14, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</div>
      <div className="mono" style={{ fontSize: 10, color: "var(--text-faint)", letterSpacing: "0.06em", textTransform: "uppercase", marginTop: 2 }}>
        {level} · {q}Q · {mins} MIN
      </div>
    </div>
    <Icon name="arrow" size={14} stroke={1.5} />
  </div>
);

const MobileHome = () => (
  <div className="aiq-mobile">
    <div className="scroll-body safe-top pad-tab">
      {/* Header */}
      <MobileHeader
        eyebrow="Wednesday · April 29"
        title={<span>Good afternoon,<br/>Alex.</span>}
        right={<IconBtn icon="bell" />}
      />

      {/* Stats row */}
      <div style={{ padding: "8px 22px 22px", display: "flex", gap: 10 }}>
        <StatPill label="Active" value="12" sub="+3 wk" />
        <StatPill label="Avg score" value="76.4" sub="+2.1" accent />
        <StatPill label="Streak" value="14" sub="days" />
      </div>

      {/* Continue */}
      <div style={{ padding: "0 22px" }}>
        <SectionHeader title="Continue where you left off" />
      </div>
      <div style={{ padding: "0 22px" }}>
        <ContinueCard />
      </div>

      {/* Recommended */}
      <SectionHeader title="Recommended" link="View all →" />
      <div style={{ padding: "0 22px" }}>
        <RowItem cat="chart" title="Numerical Reasoning II" level="Adaptive" q={24} mins={32} />
        <RowItem cat="code" title="Frontend Engineering" level="Intermediate" q={18} mins={45} />
        <RowItem cat="book" title="Business English C1" level="Advanced" q={32} mins={28} />
        <RowItem cat="chart" title="Spatial Reasoning II" level="Adaptive" q={20} mins={22} />
      </div>

      {/* AI insight strip */}
      <div style={{ padding: "26px 22px 8px" }}>
        <div className="card" style={{ padding: 18, background: "var(--surface)" }}>
          <div className="row" style={{ marginBottom: 8, gap: 8 }}>
            <Icon name="sparkle" size={14} stroke={2} />
            <span className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-faint)" }}>
              AI insights
            </span>
          </div>
          <div className="serif" style={{ fontSize: 16, fontWeight: 500, letterSpacing: "-0.01em", lineHeight: 1.35 }}>
            Your numerical scores climbed 12 points this month — pace yourself on word problems next.
          </div>
        </div>
      </div>
    </div>
    <TabBar active="home" />
  </div>
);

window.MobileHome = MobileHome;
