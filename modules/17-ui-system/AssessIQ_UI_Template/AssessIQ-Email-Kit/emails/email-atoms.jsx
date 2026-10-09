/* AssessIQ Emails — shared atoms for all templates
   ─────────────────────────────────────────────────
   Every template composes these. Don't reinvent.
   All widths are 640px (the AssessIQ email canvas width).
*/

const EMAIL_W = 640;

/* ── Email shell ─────────────────────────────────────────────
   The off-white canvas that wraps a centered white "card" — the
   classic email client look. Borders, not shadows.
*/
const EmailShell = ({ children, preheader }) => (
  <div style={{
    width: EMAIL_W,
    background: "#f1efea",
    fontFamily: 'var(--font-sans)',
    color: "var(--text)",
    fontSize: 14,
    lineHeight: 1.55,
    letterSpacing: "-0.005em",
    padding: "32px 24px 40px",
  }}>
    {/* Preheader — hidden preview text in real clients; shown faintly in canvas */}
    {preheader && (
      <div className="mono" style={{
        fontSize: 10, color: "#a8a59f",
        textTransform: "uppercase", letterSpacing: "0.08em",
        marginBottom: 14, textAlign: "center",
      }}>
        Preview · {preheader}
      </div>
    )}
    <div style={{
      background: "var(--bg)",
      border: "1px solid var(--border)",
      borderRadius: 14,
      overflow: "hidden",
    }}>
      {children}
    </div>
  </div>
);

/* ── Email header ────────────────────────────────────────────
   Logo wordmark + hairline border-bottom. Optional right-side
   eyebrow (e.g. "MONTHLY DIGEST", "INVITATION").
*/
const EmailHeader = ({ eyebrow }) => (
  <div style={{
    padding: "22px 36px",
    borderBottom: "1px solid var(--border)",
    display: "flex", alignItems: "center",
  }}>
    <Logo size={17} />
    <span style={{ flex: 1 }}></span>
    {eyebrow && (
      <span className="mono" style={{
        fontSize: 10, color: "var(--text-faint)",
        textTransform: "uppercase", letterSpacing: "0.1em",
      }}>{eyebrow}</span>
    )}
  </div>
);

/* ── Email body container ────────────────────────────────────
   Generous side padding. Pass `pad` to override vertical rhythm.
*/
const EmailBody = ({ children, pad = "36px" }) => (
  <div style={{ padding: `${pad} 40px` }}>
    {children}
  </div>
);

/* ── Eyebrow + serif headline ───────────────────────────────*/
const EmailLede = ({ eyebrow, title, body }) => (
  <div>
    {eyebrow && (
      <div className="mono" style={{
        fontSize: 11, color: "var(--accent)",
        textTransform: "uppercase", letterSpacing: "0.08em",
        marginBottom: 14,
      }}>{eyebrow}</div>
    )}
    <h1 className="serif" style={{
      fontSize: 30, margin: "0 0 14px",
      letterSpacing: "-0.02em", fontWeight: 500,
      lineHeight: 1.15, textWrap: "balance",
    }}>{title}</h1>
    {body && (
      <p style={{
        margin: 0, fontSize: 15, color: "var(--text-muted)",
        lineHeight: 1.55,
      }}>{body}</p>
    )}
  </div>
);

/* ── Big primary CTA — pill button, accent fill ─────────────
   Renders as an <a> so a real email's table-rebuild can swap
   in a bulletproof VML/MSO version.
*/
const EmailCTA = ({ label, href = "#", style = {} }) => (
  <a href={href} style={{
    display: "inline-flex", alignItems: "center", gap: 8,
    background: "var(--accent)",
    color: "white",
    padding: "14px 28px",
    borderRadius: 999,
    fontSize: 14, fontWeight: 500,
    fontFamily: "var(--font-sans)",
    letterSpacing: "-0.005em",
    textDecoration: "none",
    ...style,
  }}>
    {label}
    <Icon name="arrow" size={14} />
  </a>
);

const EmailGhostLink = ({ label, href = "#" }) => (
  <a href={href} style={{
    color: "var(--accent)", textDecoration: "none",
    fontSize: 13, fontWeight: 500, display: "inline-flex",
    alignItems: "center", gap: 4,
  }}>{label} →</a>
);

/* ── Divider ────────────────────────────────────────────────*/
const EmailRule = ({ pad = 28 }) => (
  <hr style={{
    height: 1, background: "var(--border)", border: 0,
    margin: `${pad}px 0`,
  }} />
);

/* ── Meta row — mono uppercase key: value pairs in a box ───*/
const EmailMetaCard = ({ rows }) => (
  <div style={{
    border: "1px solid var(--border)",
    borderRadius: 12,
    overflow: "hidden",
  }}>
    {rows.map((r, i) => (
      <div key={i} style={{
        padding: "14px 20px",
        borderTop: i === 0 ? 0 : "1px solid var(--border)",
        display: "flex", alignItems: "center", gap: 16,
      }}>
        <span className="mono" style={{
          fontSize: 10, color: "var(--text-faint)",
          textTransform: "uppercase", letterSpacing: "0.08em",
          width: 110,
        }}>{r.k}</span>
        <span style={{ flex: 1, fontSize: 14, color: "var(--text)" }}>
          {r.v}
        </span>
      </div>
    ))}
  </div>
);

/* ── Footer ─────────────────────────────────────────────────
   Recessed off-white. Wordmark, address, legal, unsubscribe.
   All mono, all faint. The email "colophon".
*/
const EmailFooter = ({ reason = "You're receiving this because you have an active AssessIQ account." }) => (
  <div style={{
    background: "var(--surface)",
    borderTop: "1px solid var(--border)",
    padding: "28px 40px 32px",
  }}>
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
      <span style={{
        width: 8, height: 8, borderRadius: "50%",
        background: "var(--accent)",
      }}></span>
      <span className="serif" style={{
        fontSize: 14, fontWeight: 500, letterSpacing: "-0.01em",
      }}>AssessIQ</span>
    </div>
    <p style={{
      margin: 0, fontSize: 12, color: "var(--text-muted)",
      lineHeight: 1.55, maxWidth: 460,
    }}>{reason}</p>

    <div style={{
      display: "flex", gap: 18, marginTop: 18,
      fontSize: 12,
    }}>
      <a href="#" style={{ color: "var(--text-muted)", textDecoration: "none" }}>Unsubscribe</a>
      <a href="#" style={{ color: "var(--text-muted)", textDecoration: "none" }}>Email preferences</a>
      <a href="#" style={{ color: "var(--text-muted)", textDecoration: "none" }}>Help center</a>
      <a href="#" style={{ color: "var(--text-muted)", textDecoration: "none" }}>Privacy</a>
    </div>

    <hr style={{ height: 1, background: "var(--border)", border: 0, margin: "20px 0 16px" }} />

    <div className="mono" style={{
      fontSize: 10, color: "var(--text-faint)",
      textTransform: "uppercase", letterSpacing: "0.08em",
      display: "flex", gap: 20, flexWrap: "wrap",
    }}>
      <span>AssessIQ, Inc.</span>
      <span>548 Market St · San Francisco, CA 94104</span>
      <span style={{ marginLeft: "auto" }}>© 2026</span>
    </div>
  </div>
);

Object.assign(window, {
  EMAIL_W, EmailShell, EmailHeader, EmailBody, EmailLede,
  EmailCTA, EmailGhostLink, EmailRule, EmailMetaCard, EmailFooter,
});
