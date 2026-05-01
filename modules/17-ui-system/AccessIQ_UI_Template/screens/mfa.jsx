/* MFA — TOTP enrollment + verify (admin / reviewer step-up).
 *
 * Reference for apps/web/src/pages/admin/mfa.tsx. Centred-card layout
 * sits on the same neutral page background as login.jsx. Three states
 * are demoed inline (mode toggle): "enroll" shows the QR + manual-entry
 * secret, "verify" omits the QR. An "error" lockout state (423) is
 * shown via the chip + field error variants.
 *
 * Imports: <Logo />, <Icon /> from atoms.jsx; CSS tokens from styles.css.
 */

const MfaScreen = () => {
  const [mode, setMode] = React.useState("enroll"); // "enroll" | "verify" | "lockout"
  const [code, setCode] = React.useState("");
  const isLocked = mode === "lockout";

  return (
    <div className="aiq-screen" style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      {/* Top bar — brand + mode toggle for the canvas (NOT shipped in port). */}
      <header style={{ padding: "24px 32px", display: "flex", alignItems: "center", borderBottom: "1px solid var(--border)" }}>
        <Logo />
        <span className="spacer" style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 11, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em", marginRight: 12 }}>
          design-canvas mode
        </span>
        {["enroll", "verify", "lockout"].map((m) => (
          <button
            key={m}
            className={`btn btn-${mode === m ? "primary" : "ghost"} btn-sm`}
            onClick={() => setMode(m)}
            style={{ marginLeft: 6 }}
          >
            {m}
          </button>
        ))}
      </header>

      {/* Centred card */}
      <main style={{ flex: 1, display: "grid", placeItems: "center", padding: "48px 32px" }}>
        <div className="card" style={{ width: "100%", maxWidth: 480, padding: 32, boxShadow: "var(--shadow)" }}>
          <div className="chip chip-accent" style={{ marginBottom: 16 }}>
            <Icon name="sparkle" size={10} />
            <span>Step 2 of 2</span>
          </div>

          <h1
            className="serif"
            style={{
              fontSize: 32,
              lineHeight: 1.1,
              margin: "0 0 10px",
              fontWeight: 400,
              letterSpacing: "-0.015em",
            }}
          >
            {mode === "enroll" ? "Enrol your authenticator." : "Verify your authenticator."}
          </h1>
          <p style={{ fontSize: 14, color: "var(--text-muted)", margin: "0 0 24px", lineHeight: 1.5 }}>
            {mode === "enroll"
              ? "Scan the QR code with Google Authenticator, Authy, or 1Password, then enter the 6-digit code below."
              : isLocked
                ? "Too many failed attempts. Try again in 15 minutes."
                : "Enter the 6-digit code from your authenticator app."}
          </p>

          {/* QR + manual-entry block — only on enrol */}
          {mode === "enroll" && (
            <div
              style={{
                display: "grid",
                placeItems: "center",
                marginBottom: 20,
                padding: 20,
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-lg)",
              }}
            >
              <Placeholder width={180} height={180} label="QR" radius={8} />
              <p
                className="mono"
                style={{
                  marginTop: 14,
                  fontSize: 11,
                  color: "var(--text-faint)",
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                }}
              >
                Or enter manually
              </p>
              <p
                className="mono"
                style={{
                  marginTop: 4,
                  fontSize: 13,
                  color: "var(--text-muted)",
                  letterSpacing: "0.05em",
                  wordBreak: "break-all",
                  textAlign: "center",
                }}
              >
                JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP
              </p>
            </div>
          )}

          {/* 6-digit code input. Mono font, large character spacing.
              Disabled in lockout state; the field shows the lockout message. */}
          <label
            className="mono"
            style={{
              display: "block",
              fontSize: 11,
              color: "var(--text-faint)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              marginBottom: 6,
            }}
          >
            6-digit code
          </label>
          <input
            className="input"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={isLocked ? "" : code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            disabled={isLocked}
            placeholder="••••••"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 22,
              letterSpacing: "0.4em",
              textAlign: "center",
              ...(isLocked ? { borderColor: "var(--danger)" } : {}),
            }}
          />

          {/* Primary verify button — full-width per template idiom */}
          <button
            className="btn btn-primary btn-lg"
            disabled={isLocked || code.length !== 6}
            style={{ width: "100%", marginTop: 16, justifyContent: "center" }}
          >
            {isLocked ? "Locked — try again later" : mode === "enroll" ? "Confirm and continue" : "Verify and continue"}
            <Icon name="arrow" size={14} />
          </button>

          {/* Secondary action — recovery code link.
              Hidden in enrol mode (no recovery codes yet). */}
          {mode !== "enroll" && (
            <p style={{ marginTop: 18, fontSize: 13, color: "var(--text-muted)", textAlign: "center" }}>
              Lost your authenticator?
              {" "}
              <a
                style={{
                  color: "var(--accent)",
                  cursor: "pointer",
                  textDecoration: "none",
                  fontWeight: 500,
                }}
              >
                Use a recovery code
              </a>
            </p>
          )}
        </div>
      </main>

      {/* Mono footer — same idiom as login.jsx. */}
      <footer
        style={{
          padding: "16px 32px",
          display: "flex",
          gap: 16,
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--text-faint)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          borderTop: "1px solid var(--border)",
        }}
      >
        <span>Phase 0 · 2026</span>
        <span className="spacer" style={{ flex: 1 }} />
        <span>Google SSO · TOTP-ready</span>
      </footer>
    </div>
  );
};

window.MfaScreen = MfaScreen;
