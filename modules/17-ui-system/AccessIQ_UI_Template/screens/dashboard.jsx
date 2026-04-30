/* Dashboard — for both candidates and admins */

const NavItem = ({ icon, label, active }) => (
  <div style={{
    display: "flex", alignItems: "center", gap: 12,
    padding: "9px 14px", borderRadius: 10,
    color: active ? "var(--text)" : "var(--text-muted)",
    background: active ? "var(--surface)" : "transparent",
    fontSize: 13, fontWeight: active ? 500 : 400,
    cursor: "pointer",
  }}>
    <Icon name={icon} size={16} />
    <span>{label}</span>
  </div>
);

const Sidebar = () => (
  <aside style={{
    width: 240, padding: "24px 16px",
    borderRight: "1px solid var(--border)",
    display: "flex", flexDirection: "column", gap: 4,
    background: "var(--bg)",
    flexShrink: 0,
  }}>
    <div style={{ padding: "0 8px 24px" }}><Logo /></div>
    <div className="mono" style={{ fontSize: 10, color: "var(--text-faint)", padding: "8px 14px", textTransform: "uppercase", letterSpacing: "0.08em" }}>Workspace</div>
    <NavItem icon="home" label="Overview" active />
    <NavItem icon="grid" label="Library" />
    <NavItem icon="chart" label="Reports" />
    <NavItem icon="user" label="Candidates" />
    <div style={{ height: 16 }}></div>
    <div className="mono" style={{ fontSize: 10, color: "var(--text-faint)", padding: "8px 14px", textTransform: "uppercase", letterSpacing: "0.08em" }}>Account</div>
    <NavItem icon="bell" label="Notifications" />
    <NavItem icon="settings" label="Settings" />
    <div className="spacer"></div>
    <div className="card" style={{ padding: 14, background: "var(--surface)" }}>
      <div className="row" style={{ gap: 10 }}>
        <div style={{ width: 32, height: 32, borderRadius: "50%", background: "var(--accent)", color: "white", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 500 }}>A</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>Alex Mitchell</div>
          <div style={{ fontSize: 10, color: "var(--text-muted)" }}>Pro · alex@…</div>
        </div>
      </div>
    </div>
  </aside>
);

const StatCard = ({ label, value, delta, sub, accent }) => (
  <div className="card" style={{ padding: 22, height: "100%" }}>
    <div className="mono" style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 14 }}>{label}</div>
    <div className="row" style={{ alignItems: "baseline", gap: 8 }}>
      <span className="num" style={{ fontSize: 40, lineHeight: 1, letterSpacing: "-0.03em", color: accent ? "var(--accent)" : "var(--text)" }}>{value}</span>
      {delta && <span className="mono" style={{ fontSize: 11, color: delta.startsWith("+") ? "var(--success)" : "var(--danger)" }}>{delta}</span>}
    </div>
    <div style={{ marginTop: 8, fontSize: 12, color: "var(--text-muted)" }}>{sub}</div>
  </div>
);

const Sparkline = ({ data, color = "var(--accent)" }) => {
  const max = Math.max(...data);
  const points = data.map((v, i) => `${(i / (data.length - 1)) * 100},${40 - (v / max) * 35}`).join(" ");
  return (
    <svg viewBox="0 0 100 40" preserveAspectRatio="none" style={{ width: "100%", height: 60 }}>
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
      <polyline points={`0,40 ${points} 100,40`} fill={color} opacity="0.08" />
    </svg>
  );
};

const DashboardScreen = () => (
  <div className="aiq-screen" style={{ display: "flex" }}>
    <Sidebar />
    <main style={{ flex: 1, overflow: "auto", padding: "32px 40px" }}>
      {/* Header */}
      <div className="row" style={{ marginBottom: 28 }}>
        <div>
          <div className="mono" style={{ fontSize: 11, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>Wednesday · April 29</div>
          <h1 className="serif" style={{ fontSize: 36, margin: 0, fontWeight: 400, letterSpacing: "-0.02em" }}>Good afternoon, Alex.</h1>
        </div>
        <div className="spacer"></div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn btn-outline">
            <Icon name="search" size={14} />
            <span>Search</span>
            <span className="mono" style={{ fontSize: 10, color: "var(--text-faint)", marginLeft: 6 }}>⌘K</span>
          </button>
          <button className="btn btn-primary">
            <Icon name="plus" size={14} stroke={2} />
            New assessment
          </button>
        </div>
      </div>

      {/* Stats row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 24 }}>
        <StatCard label="Active assessments" value="12" delta="+3" sub="3 due this week" />
        <StatCard label="Avg. completion" value="84" delta="+6%" sub="of 41 candidates" accent />
        <StatCard label="Avg. score" value="76.4" delta="+2.1" sub="across 6 categories" />
        <StatCard label="Time saved" value="142h" sub="via auto-grading" />
      </div>

      {/* Continue + activity */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 380px", gap: 16, marginBottom: 24 }}>
        <div className="card" style={{ padding: 24 }}>
          <div className="row" style={{ marginBottom: 18 }}>
            <h3 className="serif" style={{ margin: 0, fontSize: 22, fontWeight: 400 }}>Continue where you left off</h3>
            <div className="spacer"></div>
            <a style={{ fontSize: 12, color: "var(--accent)", cursor: "pointer" }}>View all →</a>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
            {[
              { title: "Cognitive Reasoning III", chip: "In progress", progress: 64, time: "12 min left", section: "Section 3 of 5" },
              { title: "Frontend Engineering", chip: "Auto-saved", progress: 28, time: "Resume any time", section: "Question 7 of 24" },
            ].map((t, i) => (
              <div key={i} style={{ padding: 18, border: "1px solid var(--border)", borderRadius: 12, cursor: "pointer", transition: "all .15s" }}>
                <div className="row" style={{ marginBottom: 10 }}>
                  <span className="chip chip-accent">{t.chip}</span>
                  <span className="spacer"></span>
                  <span className="mono" style={{ fontSize: 10, color: "var(--text-faint)" }}>{t.section}</span>
                </div>
                <div style={{ fontSize: 16, fontWeight: 500, marginBottom: 4 }}>{t.title}</div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 14 }}>{t.time}</div>
                <div style={{ height: 4, background: "var(--surface-2)", borderRadius: 2, overflow: "hidden" }}>
                  <div style={{ width: `${t.progress}%`, height: "100%", background: "var(--accent)" }}></div>
                </div>
                <div className="row" style={{ marginTop: 10 }}>
                  <span className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>{t.progress}%</span>
                  <span className="spacer"></span>
                  <button className="btn btn-sm btn-ghost" style={{ padding: "4px 0", color: "var(--accent)" }}>
                    Continue
                    <Icon name="arrow" size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="card" style={{ padding: 24 }}>
          <div className="row" style={{ marginBottom: 18 }}>
            <h3 className="serif" style={{ margin: 0, fontSize: 22, fontWeight: 400 }}>Performance</h3>
            <div className="spacer"></div>
            <span className="chip">30 days</span>
          </div>
          <div className="row" style={{ alignItems: "baseline", gap: 8, marginBottom: 4 }}>
            <span className="num" style={{ fontSize: 36, letterSpacing: "-0.03em" }}>76.4</span>
            <span style={{ fontSize: 13, color: "var(--text-muted)" }}>average</span>
            <span className="spacer"></span>
            <span className="mono" style={{ fontSize: 11, color: "var(--success)" }}>+2.1 ▲</span>
          </div>
          <Sparkline data={[40, 52, 48, 60, 55, 62, 70, 68, 75, 72, 78, 76]} />
          <div className="divider" style={{ margin: "16px 0" }}></div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {[
              { name: "Logical reasoning", v: 89 },
              { name: "Numerical", v: 72 },
              { name: "Verbal", v: 81 },
            ].map((c, i) => (
              <div key={i} className="row" style={{ gap: 12 }}>
                <span style={{ fontSize: 12, color: "var(--text-muted)", width: 120 }}>{c.name}</span>
                <div style={{ flex: 1, height: 4, background: "var(--surface-2)", borderRadius: 2, overflow: "hidden" }}>
                  <div style={{ width: `${c.v}%`, height: "100%", background: "var(--text)" }}></div>
                </div>
                <span className="mono" style={{ fontSize: 11, width: 28, textAlign: "right" }}>{c.v}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Recommended */}
      <div className="row" style={{ marginBottom: 14 }}>
        <h3 className="serif" style={{ margin: 0, fontSize: 22, fontWeight: 400 }}>Recommended for you</h3>
        <div className="spacer"></div>
        <span className="chip"><Icon name="sparkle" size={10} /> AI · matched to your profile</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
        {[
          { title: "Critical Reading", meta: "45 min · Adaptive", level: "Intermediate" },
          { title: "Spatial Reasoning II", meta: "30 min · 24 questions", level: "Advanced" },
          { title: "System Design Basics", meta: "60 min · Open-ended", level: "Beginner" },
        ].map((t, i) => (
          <div key={i} className="card" style={{ padding: 20, cursor: "pointer" }}>
            <Placeholder height={120} label={t.title} radius={8} />
            <div className="row" style={{ marginTop: 14, marginBottom: 6 }}>
              <span className="mono" style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em" }}>{t.level}</span>
              <span className="spacer"></span>
              <span className="mono" style={{ fontSize: 10, color: "var(--text-faint)" }}>{t.meta}</span>
            </div>
            <div style={{ fontSize: 16, fontWeight: 500 }}>{t.title}</div>
          </div>
        ))}
      </div>
    </main>
  </div>
);

window.DashboardScreen = DashboardScreen;
