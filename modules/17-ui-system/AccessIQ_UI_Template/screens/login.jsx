/* Login / Signup screen */

const LoginScreen = () => {
  const [mode, setMode] = React.useState("signin");
  return (
    <div className="aiq-screen" style={{ display: "grid", gridTemplateColumns: "1fr 1fr" }}>
      {/* Left — form */}
      <div style={{ padding: "48px 64px", display: "flex", flexDirection: "column" }}>
        <Logo />
        <div style={{ flex: 1, display: "flex", alignItems: "center" }}>
          <div style={{ width: "100%", maxWidth: 380 }}>
            <div className="chip" style={{ marginBottom: 24 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--success)" }}></span>
              <span>{mode === "signin" ? "Welcome back" : "New account"}</span>
            </div>
            <h1 className="serif" style={{ fontSize: 44, lineHeight: 1.05, margin: "0 0 12px", fontWeight: 400 }}>
              {mode === "signin" ? "Sign in to continue." : "Create your account."}
            </h1>
            <p style={{ color: "var(--text-muted)", fontSize: 15, margin: "0 0 32px", lineHeight: 1.5 }}>
              {mode === "signin"
                ? "Pick up where you left off — your assessments are saved and waiting."
                : "Take and create assessments. Free for individuals."}
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {mode === "signup" && (
                <input className="input" placeholder="Full name" defaultValue="" />
              )}
              <input className="input" placeholder="Email address" defaultValue={mode === "signin" ? "alex@accessiq.io" : ""} />
              <input className="input" placeholder="Password" type="password" defaultValue={mode === "signin" ? "••••••••••" : ""} />
            </div>

            <button className="btn btn-primary btn-lg" style={{ width: "100%", marginTop: 20, justifyContent: "center" }}>
              {mode === "signin" ? "Continue" : "Create account"}
              <Icon name="arrow" size={14} />
            </button>

            <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "24px 0" }}>
              <div className="divider" style={{ flex: 1 }}></div>
              <span className="mono" style={{ fontSize: 11, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em" }}>or</span>
              <div className="divider" style={{ flex: 1 }}></div>
            </div>

            <button className="btn btn-outline btn-lg" style={{ width: "100%", justifyContent: "center" }}>
              <Icon name="google" size={16} />
              Continue with Google
            </button>
            <button className="btn btn-outline btn-lg" style={{ width: "100%", justifyContent: "center", marginTop: 10 }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 14 }}>SSO</span>
              <span>Single sign-on</span>
            </button>

            <p style={{ marginTop: 28, fontSize: 13, color: "var(--text-muted)", textAlign: "center" }}>
              {mode === "signin" ? "New here? " : "Already a member? "}
              <a onClick={() => setMode(mode === "signin" ? "signup" : "signin")} style={{ color: "var(--accent)", cursor: "pointer", textDecoration: "none", fontWeight: 500 }}>
                {mode === "signin" ? "Create an account" : "Sign in"}
              </a>
            </p>
          </div>
        </div>
        <div className="mono" style={{ fontSize: 11, color: "var(--text-faint)", display: "flex", gap: 16 }}>
          <span>v 2.4 · 2026</span>
          <span className="spacer"></span>
          <span>SOC 2 · ISO 27001</span>
        </div>
      </div>

      {/* Right — visual panel */}
      <div style={{
        background: "var(--surface)",
        borderLeft: "1px solid var(--border)",
        position: "relative",
        overflow: "hidden",
        padding: 48,
        display: "flex",
        flexDirection: "column",
      }}>
        <div className="grid-bg" style={{ position: "absolute", inset: 0, opacity: 0.5, maskImage: "radial-gradient(circle at 60% 40%, black, transparent 70%)" }}></div>
        <div style={{ position: "relative", flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ width: "100%", maxWidth: 460 }}>
            {/* Mock score card preview */}
            <div className="card" style={{ padding: 28, background: "var(--bg)", boxShadow: "var(--shadow-lg)" }}>
              <div className="row" style={{ justifyContent: "space-between", marginBottom: 20 }}>
                <span className="mono" style={{ fontSize: 11, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Cognitive · Final score</span>
                <span className="chip chip-success">
                  <Icon name="check" size={10} stroke={2} />
                  Passed
                </span>
              </div>
              <div className="row" style={{ alignItems: "baseline", gap: 12, marginBottom: 24 }}>
                <span className="num" style={{ fontSize: 88, fontWeight: 400, lineHeight: 1, letterSpacing: "-0.04em" }}>132</span>
                <span style={{ color: "var(--text-muted)", fontSize: 14 }}>/ 160</span>
                <span className="spacer"></span>
                <div style={{ textAlign: "right" }}>
                  <div className="mono" style={{ fontSize: 11, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Percentile</div>
                  <div className="num" style={{ fontSize: 22 }}>97<span style={{ fontSize: 14, color: "var(--text-muted)" }}>th</span></div>
                </div>
              </div>
              {/* Mini bar chart */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8, marginBottom: 16 }}>
                {[78, 92, 65, 88, 71].map((v, i) => (
                  <div key={i}>
                    <div style={{ height: 60, display: "flex", alignItems: "flex-end" }}>
                      <div style={{ width: "100%", height: `${v}%`, background: i === 1 ? "var(--accent)" : "var(--surface-2)", borderRadius: 4, transition: "all 0.3s" }}></div>
                    </div>
                    <div className="mono" style={{ fontSize: 9, color: "var(--text-faint)", textAlign: "center", marginTop: 6, textTransform: "uppercase" }}>{["Vrbl", "Lgcl", "Sptl", "Nmrl", "Mem"][i]}</div>
                  </div>
                ))}
              </div>
              <div className="divider" style={{ margin: "16px 0" }}></div>
              <div className="row" style={{ gap: 8, fontSize: 12, color: "var(--text-muted)" }}>
                <Icon name="clock" size={12} />
                <span>Completed in 47:12</span>
                <span className="spacer"></span>
                <span className="mono">#A-2841</span>
              </div>
            </div>

            {/* Floating second card */}
            <div className="card" style={{
              padding: 16, background: "var(--bg)", boxShadow: "var(--shadow)",
              marginTop: -24, marginLeft: 60, marginRight: -40,
              display: "flex", alignItems: "center", gap: 12,
            }}>
              <div style={{ width: 36, height: 36, borderRadius: "50%", background: "var(--accent-soft)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--accent)" }}>
                <Icon name="sparkle" size={16} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>Your AI report is ready</div>
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>3 strengths · 2 growth areas</div>
              </div>
              <Icon name="arrow" size={14} />
            </div>
          </div>
        </div>
        <blockquote className="serif" style={{ fontSize: 22, lineHeight: 1.3, margin: 0, position: "relative", maxWidth: 480 }}>
          "It's the first assessment platform that feels like reading."
          <footer style={{ marginTop: 12, fontFamily: "var(--font-sans)", fontSize: 12, color: "var(--text-muted)" }}>
            — Wired, on AccessIQ 2.0
          </footer>
        </blockquote>
      </div>
    </div>
  );
};

window.LoginScreen = LoginScreen;
