/* AssessIQ mobile — shared atoms (tab bar, headers, cards) */

const TabBar = ({ active = "home" }) => {
  const tabs = [
    { id: "home", icon: "home", label: "Today" },
    { id: "library", icon: "grid", label: "Library" },
    { id: "activity", icon: "chart", label: "Activity" },
    { id: "profile", icon: "user", label: "Profile" },
  ];
  return (
    <div style={{
      position: "absolute", left: 0, right: 0, bottom: 0,
      paddingBottom: 34, /* home indicator */
      background: "color-mix(in srgb, var(--bg) 92%, transparent)",
      backdropFilter: "blur(20px) saturate(180%)",
      WebkitBackdropFilter: "blur(20px) saturate(180%)",
      borderTop: "1px solid var(--border)",
      zIndex: 5,
    }}>
      <div style={{ display: "flex", justifyContent: "space-around", padding: "10px 8px 6px" }}>
        {tabs.map(t => {
          const on = t.id === active;
          return (
            <div key={t.id} style={{
              display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
              padding: "6px 10px", minWidth: 60,
              color: on ? "var(--accent)" : "var(--text-faint)",
            }}>
              <Icon name={t.icon} size={22} stroke={on ? 2 : 1.5} />
              <span style={{
                fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.08em",
                textTransform: "uppercase",
              }}>{t.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

/* Mobile page header — small mono eyebrow + serif H1.
   Built to sit just under the iOS status bar (safe-top padding). */
const MobileHeader = ({ eyebrow, title, right }) => (
  <div style={{ padding: "16px 22px 14px" }}>
    {eyebrow && (
      <div className="mono" style={{
        fontSize: 10, color: "var(--text-faint)",
        textTransform: "uppercase", letterSpacing: "0.08em",
        marginBottom: 6,
      }}>{eyebrow}</div>
    )}
    <div className="row" style={{ alignItems: "baseline", gap: 12 }}>
      <h1 className="serif" style={{
        margin: 0, fontSize: 30, lineHeight: 1.1,
        letterSpacing: "-0.025em", fontWeight: 500,
      }}>{title}</h1>
      <span className="spacer"></span>
      {right}
    </div>
  </div>
);

/* Icon button — 36px round, glyph-only */
const IconBtn = ({ icon, onClick, accent }) => (
  <button onClick={onClick} style={{
    width: 36, height: 36, borderRadius: 999,
    border: "1px solid var(--border)",
    background: accent ? "var(--accent)" : "var(--bg)",
    color: accent ? "white" : "var(--text)",
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    padding: 0, cursor: "pointer",
  }}>
    <Icon name={icon} size={16} stroke={accent ? 2 : 1.5} />
  </button>
);

/* Mobile chip — same tokens, smaller */
const MChip = ({ children, variant }) => (
  <span className={`chip${variant ? " chip-" + variant : ""}`} style={{
    fontSize: 10, padding: "3px 8px",
  }}>{children}</span>
);

/* Section header inside a screen — serif H3 + optional link */
const SectionHeader = ({ title, link, count }) => (
  <div className="row" style={{ padding: "0 22px", marginBottom: 12 }}>
    <h3 className="serif" style={{ margin: 0, fontSize: 19, fontWeight: 500, letterSpacing: "-0.015em" }}>
      {title}
    </h3>
    <span className="spacer"></span>
    {count != null && <MChip>{count} items</MChip>}
    {link && <a style={{ color: "var(--accent)", fontSize: 12, textDecoration: "none" }}>{link}</a>}
  </div>
);

/* Animated number — count up, reuse desktop hook but inline simpler */
const useFadeIn = (delay = 0) => {
  const [on, setOn] = React.useState(false);
  React.useEffect(() => {
    const t = setTimeout(() => setOn(true), delay);
    return () => clearTimeout(t);
  }, [delay]);
  return on;
};

Object.assign(window, { TabBar, MobileHeader, IconBtn, MChip, SectionHeader, useFadeIn });
