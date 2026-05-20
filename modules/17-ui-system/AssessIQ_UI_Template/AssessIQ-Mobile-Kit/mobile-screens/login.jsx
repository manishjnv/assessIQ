/* AssessIQ mobile — Sign in */

const MobileLogin = () => (
  <div className="aiq-mobile">
    {/* Hero background — grid-bg with mask */}
    <div style={{ position: "absolute", inset: 0, opacity: 0.5,
      WebkitMaskImage: "radial-gradient(ellipse at 50% 20%, black, transparent 65%)",
      maskImage: "radial-gradient(ellipse at 50% 20%, black, transparent 65%)" }}
      className="grid-bg" />

    <div className="scroll-body safe-top" style={{ position: "relative" }}>
      {/* Logo bar */}
      <div style={{ padding: "10px 24px 0", display: "flex", justifyContent: "center" }}>
        <Logo size={20} />
      </div>

      {/* Hero copy */}
      <div style={{ padding: "44px 28px 24px", textAlign: "left" }}>
        <span className="chip chip-accent" style={{ fontSize: 10, marginBottom: 18, display: "inline-flex" }}>
          <Icon name="sparkle" size={10} stroke={2} /> AssessIQ 2.0
        </span>
        <h1 className="serif" style={{
          fontSize: 36, lineHeight: 1.05, margin: "12px 0 10px",
          letterSpacing: "-0.025em", fontWeight: 500,
        }}>
          Sign in to continue.
        </h1>
        <p style={{ fontSize: 14, color: "var(--text-muted)", margin: 0, maxWidth: 320 }}>
          Pick up where you left off. 3 assessments are waiting on you.
        </p>
      </div>

      {/* Form */}
      <div style={{ padding: "0 24px", display: "flex", flexDirection: "column", gap: 10 }}>
        <input className="input" placeholder="Email address" defaultValue="alex@assessiq.io" />
        <input className="input" placeholder="Password" type="password" defaultValue="••••••••••" />
        <div className="row" style={{ marginTop: 2, marginBottom: 6 }}>
          <span className="spacer"></span>
          <a style={{ color: "var(--text-muted)", fontSize: 12, textDecoration: "none" }}>Forgot? →</a>
        </div>
        <button className="btn btn-primary btn-lg" style={{ justifyContent: "center", padding: "14px 0" }}>
          Continue <Icon name="arrow" size={14} stroke={2} />
        </button>
        <div className="row" style={{ gap: 10, margin: "16px 0 10px" }}>
          <hr className="divider" style={{ flex: 1 }} />
          <span className="mono" style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em" }}>or</span>
          <hr className="divider" style={{ flex: 1 }} />
        </div>
        <button className="btn btn-outline btn-lg" style={{ justifyContent: "center", padding: "13px 0" }}>
          <Icon name="google" size={16} /> Continue with Google
        </button>
      </div>

      {/* Footer */}
      <div style={{ padding: "30px 24px 32px", textAlign: "center" }}>
        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
          New here? <a style={{ color: "var(--accent)", textDecoration: "none", fontWeight: 500 }}>Create an account →</a>
        </div>
        <div className="mono" style={{
          marginTop: 18, fontSize: 10, color: "var(--text-faint)",
          textTransform: "uppercase", letterSpacing: "0.08em",
        }}>
          v2.0.4 · SOC 2 · GDPR
        </div>
      </div>
    </div>
  </div>
);

window.MobileLogin = MobileLogin;
