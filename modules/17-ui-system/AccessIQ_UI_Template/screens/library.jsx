/* Test Library / Catalog */

const LibraryScreen = () => {
  const [filter, setFilter] = React.useState("All");
  const filters = ["All", "Cognitive", "Technical", "Personality", "Language", "Custom"];
  const tests = [
    { cat: "Cognitive", title: "General Mental Ability", q: 50, time: 60, takers: "12.4k", level: "Adaptive", popular: true },
    { cat: "Technical", title: "Frontend Engineering", q: 24, time: 45, takers: "8.1k", level: "Mid–Senior" },
    { cat: "Cognitive", title: "Logical Reasoning Pro", q: 30, time: 35, takers: "9.7k", level: "Advanced" },
    { cat: "Personality", title: "Big Five Profile", q: 60, time: 15, takers: "21.0k", level: "All levels" },
    { cat: "Technical", title: "SQL & Data Modeling", q: 28, time: 50, takers: "5.6k", level: "Mid" },
    { cat: "Language", title: "Business English C1", q: 40, time: 30, takers: "6.2k", level: "C1–C2" },
    { cat: "Cognitive", title: "Numerical Reasoning", q: 25, time: 25, takers: "10.3k", level: "Intermediate" },
    { cat: "Custom", title: "Customer Support Sim", q: 12, time: 20, takers: "1.4k", level: "Custom build", custom: true },
  ];
  const visible = filter === "All" ? tests : tests.filter(t => t.cat === filter);

  return (
    <div className="aiq-screen" style={{ display: "flex" }}>
      <Sidebar />
      <main style={{ flex: 1, overflow: "auto" }}>
        {/* Hero search */}
        <div style={{ padding: "48px 40px 32px", borderBottom: "1px solid var(--border)", position: "relative", overflow: "hidden" }}>
          <div className="grid-bg" style={{ position: "absolute", inset: 0, opacity: 0.4, maskImage: "radial-gradient(ellipse at center top, black, transparent 60%)" }}></div>
          <div style={{ position: "relative", maxWidth: 720, margin: "0 auto", textAlign: "center" }}>
            <div className="chip" style={{ marginBottom: 18 }}>
              <Icon name="grid" size={10} />
              <span>184 assessments · 12 categories</span>
            </div>
            <h1 className="serif" style={{ fontSize: 52, lineHeight: 1.05, margin: "0 0 14px", fontWeight: 400, letterSpacing: "-0.025em" }}>
              The library.
            </h1>
            <p style={{ fontSize: 16, color: "var(--text-muted)", margin: "0 0 28px", maxWidth: 520, marginLeft: "auto", marginRight: "auto" }}>
              Validated assessments for hiring, learning, and self-discovery.
              Built with psychometricians, vetted on 4M+ submissions.
            </p>
            <div style={{
              maxWidth: 540, margin: "0 auto",
              background: "var(--bg)", border: "1px solid var(--border-strong)", borderRadius: 999,
              padding: "8px 8px 8px 20px",
              display: "flex", alignItems: "center", gap: 10,
              boxShadow: "var(--shadow)",
            }}>
              <Icon name="search" size={16} stroke={1.8} />
              <input style={{ flex: 1, border: 0, outline: 0, background: "transparent", fontFamily: "inherit", fontSize: 14, color: "var(--text)" }} placeholder="Search by skill, role, or domain…" defaultValue="" />
              <button className="btn btn-primary btn-sm">Search</button>
            </div>
            <div className="row" style={{ justifyContent: "center", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
              {["Engineering", "Product Manager", "Data analyst", "GMAT-style", "Sales aptitude"].map(s => (
                <span key={s} style={{ fontSize: 12, color: "var(--text-muted)", padding: "4px 10px", borderRadius: 999, border: "1px solid var(--border)", cursor: "pointer" }}>{s}</span>
              ))}
            </div>
          </div>
        </div>

        {/* Filters */}
        <div style={{ padding: "24px 40px 0", display: "flex", alignItems: "center", gap: 8, position: "sticky", top: 0, background: "var(--bg)", zIndex: 1, borderBottom: "1px solid var(--border)" }}>
          {filters.map(f => (
            <button key={f} onClick={() => setFilter(f)} className={`btn btn-sm ${filter === f ? "btn-primary" : "btn-ghost"}`} style={{ marginBottom: 24 }}>
              {f}
            </button>
          ))}
          <span className="spacer"></span>
          <span className="mono" style={{ fontSize: 11, color: "var(--text-faint)", marginBottom: 24 }}>{visible.length} results · sorted by relevance</span>
        </div>

        {/* Grid */}
        <div style={{ padding: "28px 40px 48px", display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
          {visible.map((t, i) => (
            <div key={i} className="card" style={{ padding: 22, position: "relative", cursor: "pointer" }}>
              {t.popular && <span className="chip chip-accent" style={{ position: "absolute", top: 16, right: 16 }}>Popular</span>}
              <div className="mono" style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 14 }}>{t.cat} · {t.level}</div>
              <h3 className="serif" style={{ margin: "0 0 8px", fontSize: 22, fontWeight: 400, letterSpacing: "-0.01em" }}>{t.title}</h3>
              <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 20px", lineHeight: 1.5 }}>
                {t.custom
                  ? "Customizable scenario branches simulating real customer interactions."
                  : "Validated, adaptive assessment with detailed competency-level reporting."}
              </p>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, padding: "14px 0", borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)", marginBottom: 14 }}>
                <div>
                  <div className="mono" style={{ fontSize: 9, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Questions</div>
                  <div className="num" style={{ fontSize: 18 }}>{t.q}</div>
                </div>
                <div>
                  <div className="mono" style={{ fontSize: 9, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Minutes</div>
                  <div className="num" style={{ fontSize: 18 }}>{t.time}</div>
                </div>
                <div>
                  <div className="mono" style={{ fontSize: 9, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Takers</div>
                  <div className="num" style={{ fontSize: 18 }}>{t.takers}</div>
                </div>
              </div>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn btn-primary btn-sm" style={{ flex: 1, justifyContent: "center" }}>Start</button>
                <button className="btn btn-outline btn-sm">
                  <Icon name="eye" size={14} />
                  Preview
                </button>
              </div>
            </div>
          ))}
          {/* Build-your-own card */}
          <div className="card" style={{
            padding: 22, cursor: "pointer",
            background: "var(--surface)",
            display: "flex", flexDirection: "column", alignItems: "flex-start", justifyContent: "space-between",
            minHeight: 260,
            borderStyle: "dashed",
          }}>
            <div>
              <div className="mono" style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 14 }}>Custom · From scratch</div>
              <h3 className="serif" style={{ margin: "0 0 8px", fontSize: 22, fontWeight: 400 }}>Build your own.</h3>
              <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
                Mix multiple-choice, code, drag-and-rank, and open-ended questions. AI helps you write and validate.
              </p>
            </div>
            <button className="btn btn-outline" style={{ marginTop: 16 }}>
              <Icon name="plus" size={14} stroke={2} />
              Start a blank assessment
            </button>
          </div>
        </div>
      </main>
    </div>
  );
};

window.LibraryScreen = LibraryScreen;
