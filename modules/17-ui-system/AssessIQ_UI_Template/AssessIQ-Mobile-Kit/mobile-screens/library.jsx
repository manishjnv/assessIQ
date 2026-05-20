/* AssessIQ mobile — Test library */

const FilterChip = ({ label, active, onClick }) => (
  <button onClick={onClick} style={{
    flexShrink: 0, padding: "7px 14px", fontSize: 12, fontWeight: 500,
    borderRadius: 999, cursor: "pointer", fontFamily: "inherit",
    border: `1px solid ${active ? "var(--accent)" : "var(--border-strong)"}`,
    background: active ? "var(--accent)" : "var(--bg)",
    color: active ? "white" : "var(--text)",
  }}>{label}</button>
);

const LibraryCard = ({ cat, title, level, q, mins, takers, popular }) => (
  <div className="card" style={{ padding: 18, marginBottom: 12, position: "relative" }}>
    {popular && <span className="chip chip-accent" style={{ position: "absolute", top: 14, right: 14, fontSize: 9 }}>Popular</span>}
    <div className="mono" style={{
      fontSize: 9, color: "var(--text-faint)",
      textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8,
    }}>{cat} · {level}</div>
    <h3 className="serif" style={{ margin: "0 0 4px", fontSize: 19, fontWeight: 500, letterSpacing: "-0.015em" }}>
      {title}
    </h3>
    <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 14px", lineHeight: 1.4 }}>
      Validated, adaptive assessment with competency-level reporting.
    </p>
    <div className="row" style={{
      padding: "10px 0", borderTop: "1px solid var(--border)",
      gap: 18, fontSize: 11, color: "var(--text-muted)",
    }}>
      <div>
        <span className="num" style={{ fontSize: 16, color: "var(--text)" }}>{q}</span>
        <span className="mono" style={{ fontSize: 9, color: "var(--text-faint)", marginLeft: 4, textTransform: "uppercase", letterSpacing: "0.08em" }}>Q</span>
      </div>
      <div>
        <span className="num" style={{ fontSize: 16, color: "var(--text)" }}>{mins}</span>
        <span className="mono" style={{ fontSize: 9, color: "var(--text-faint)", marginLeft: 4, textTransform: "uppercase", letterSpacing: "0.08em" }}>MIN</span>
      </div>
      <div>
        <span className="num" style={{ fontSize: 16, color: "var(--text)" }}>{takers}</span>
        <span className="mono" style={{ fontSize: 9, color: "var(--text-faint)", marginLeft: 4, textTransform: "uppercase", letterSpacing: "0.08em" }}>TAKERS</span>
      </div>
      <span className="spacer"></span>
      <button className="btn btn-primary btn-sm" style={{ padding: "5px 12px" }}>
        Start <Icon name="arrow" size={11} stroke={2} />
      </button>
    </div>
  </div>
);

const MobileLibrary = () => {
  const [filter, setFilter] = React.useState("All");
  const filters = ["All", "Cognitive", "Technical", "Personality", "Language", "Custom"];
  const tests = [
    { cat: "Cognitive", title: "General Mental Ability", q: 50, mins: 60, takers: "12.4k", level: "Adaptive", popular: true },
    { cat: "Technical", title: "Frontend Engineering", q: 24, mins: 45, takers: "8.1k", level: "Mid–Senior" },
    { cat: "Cognitive", title: "Logical Reasoning Pro", q: 30, mins: 35, takers: "9.7k", level: "Advanced" },
    { cat: "Personality", title: "Big Five Profile", q: 60, mins: 15, takers: "21.0k", level: "All levels" },
    { cat: "Language", title: "Business English C1", q: 40, mins: 30, takers: "6.2k", level: "C1–C2" },
  ];
  const visible = filter === "All" ? tests : tests.filter(t => t.cat === filter);

  return (
    <div className="aiq-mobile">
      <div className="scroll-body safe-top pad-tab">
        {/* Hero */}
        <div style={{ padding: "14px 22px 18px", position: "relative" }}>
          <span className="chip" style={{ fontSize: 9, marginBottom: 14 }}>
            <Icon name="grid" size={10} /> 184 assessments
          </span>
          <h1 className="serif" style={{ margin: "8px 0 6px", fontSize: 34, fontWeight: 500, letterSpacing: "-0.025em", lineHeight: 1.05 }}>
            The library.
          </h1>
          <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 16px", lineHeight: 1.5 }}>
            Validated assessments for hiring, learning, and self-discovery.
          </p>
          {/* Search pill */}
          <div style={{
            border: "1px solid var(--border-strong)", borderRadius: 999,
            padding: "6px 6px 6px 16px",
            display: "flex", alignItems: "center", gap: 8,
            boxShadow: "var(--shadow)", background: "var(--bg)",
          }}>
            <Icon name="search" size={15} />
            <input style={{
              flex: 1, border: 0, outline: 0, background: "transparent",
              fontFamily: "inherit", fontSize: 13, color: "var(--text)", padding: "8px 0",
            }} placeholder="Skill, role, domain…" />
            <button className="btn btn-primary btn-sm" style={{ padding: "5px 12px" }}>Search</button>
          </div>
        </div>

        {/* Filter row — horizontally scrollable */}
        <div style={{
          position: "sticky", top: 0, zIndex: 2,
          background: "var(--bg)", borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)",
          padding: "10px 22px", display: "flex", gap: 8, overflowX: "auto",
        }}>
          {filters.map(f => (
            <FilterChip key={f} label={f} active={filter === f} onClick={() => setFilter(f)} />
          ))}
        </div>

        <div className="row" style={{ padding: "14px 22px 6px" }}>
          <span className="mono" style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
            {visible.length} results · by relevance
          </span>
          <span className="spacer"></span>
          <button className="btn btn-ghost btn-sm" style={{ padding: "4px 8px", fontSize: 11, color: "var(--text-muted)" }}>
            <Icon name="settings" size={12} /> Sort
          </button>
        </div>

        {/* Cards */}
        <div style={{ padding: "4px 22px 8px" }}>
          {visible.map((t, i) => <LibraryCard key={i} {...t} />)}
          {/* Build-your-own */}
          <div className="card" style={{
            padding: 22, marginBottom: 12, textAlign: "center",
            border: "1px dashed var(--border-strong)", background: "var(--surface)",
          }}>
            <div style={{ fontSize: 20, color: "var(--text-faint)", marginBottom: 4 }}>+</div>
            <div className="serif" style={{ fontSize: 16, fontWeight: 500, letterSpacing: "-0.01em" }}>Build your own.</div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>Custom assessments in minutes.</div>
          </div>
        </div>
      </div>
      <TabBar active="library" />
    </div>
  );
};

window.MobileLibrary = MobileLibrary;
