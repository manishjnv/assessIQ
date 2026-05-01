/* Invite accept — admin invitation token redemption.
 *
 * Reference for apps/web/src/pages/invite-accept.tsx. Centred Card sits
 * on the same neutral page background as login.jsx + mfa.jsx. Three
 * states demoed inline (mode toggle): "pending" while the POST resolves,
 * "success" briefly before navigating onward, "error" if the token is
 * invalid / expired / already used.
 *
 * Imports: <Logo />, <Icon /> from atoms.jsx; CSS tokens from styles.css.
 */

const InviteAcceptScreen = () => {
  const [mode, setMode] = React.useState("pending"); // "pending" | "success" | "error"

  const stateProps = {
    pending: {
      chip: { variant: "default", icon: "clock", label: "Verifying" },
      title: "Confirming your invitation…",
      body: "We're checking the token and creating your session. This takes a second.",
      cta: null,
    },
    success: {
      chip: { variant: "chip-success", icon: "check", label: "Confirmed" },
      title: "Welcome aboard.",
      body: "Your account is ready. Redirecting you to the next step…",
      cta: { label: "Continue now", icon: "arrow" },
    },
    error: {
      chip: { variant: "", icon: "close", label: "Invitation error" },
      title: "Could not accept invitation.",
      body: "The link may have expired, already been used, or been revoked. Ask the admin who invited you to send a fresh link.",
      cta: { label: "Back to sign-in", icon: "arrowLeft" },
    },
  };

  const s = stateProps[mode];

  return (
    <div className="aiq-screen" style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      {/* Top bar — brand + design-canvas mode toggle (NOT shipped in port). */}
      <header style={{ padding: "24px 32px", display: "flex", alignItems: "center", borderBottom: "1px solid var(--border)" }}>
        <Logo />
        <span className="spacer" style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 11, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em", marginRight: 12 }}>
          design-canvas mode
        </span>
        {["pending", "success", "error"].map((m) => (
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

      <main style={{ flex: 1, display: "grid", placeItems: "center", padding: "48px 32px" }}>
        <div className="card" style={{ width: "100%", maxWidth: 420, padding: 32, boxShadow: "var(--shadow)", textAlign: "center" }}>
          {/* Status chip — variant + icon depend on state */}
          <span
            className={`chip ${s.chip.variant}`}
            style={{
              marginBottom: 18,
              display: "inline-flex",
              ...(mode === "pending"
                ? {} /* default chip */
                : mode === "error"
                  ? { background: "rgba(220, 60, 60, 0.08)", color: "var(--danger)", border: "none" }
                  : {}),
            }}
          >
            <Icon name={s.chip.icon} size={10} stroke={2} />
            {s.chip.label}
          </span>

          {/* Loader animation — only on pending. Subtle pulse to signal life. */}
          {mode === "pending" && (
            <div
              aria-hidden
              style={{
                margin: "0 auto 18px",
                width: 36,
                height: 36,
                borderRadius: "50%",
                border: "2px solid var(--border)",
                borderTopColor: "var(--accent)",
                animation: "aiq-spin 0.8s linear infinite",
              }}
            />
          )}

          <h1
            className="serif"
            style={{
              fontSize: 26,
              lineHeight: 1.2,
              margin: "0 0 10px",
              fontWeight: 400,
              letterSpacing: "-0.015em",
            }}
          >
            {s.title}
          </h1>
          <p style={{ fontSize: 14, color: "var(--text-muted)", margin: "0 0 22px", lineHeight: 1.5 }}>
            {s.body}
          </p>

          {s.cta && (
            <button
              className={`btn btn-${mode === "success" ? "primary" : "outline"} btn-md`}
              style={{ width: "100%", justifyContent: "center" }}
            >
              {mode === "error" && <Icon name={s.cta.icon} size={14} />}
              {s.cta.label}
              {mode !== "error" && <Icon name={s.cta.icon} size={14} />}
            </button>
          )}

          {/* Mono microcopy footer — token-shaped placeholder, only on pending */}
          {mode === "pending" && (
            <p
              className="mono"
              style={{
                marginTop: 22,
                fontSize: 11,
                color: "var(--text-faint)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
              }}
            >
              Token #INV-7c3a9f · 72 h TTL
            </p>
          )}
        </div>
      </main>

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
        <span>Single-use · 72 h TTL</span>
      </footer>

      {/* CSS keyframes for the pending spinner. Lives in this file so the
          design-canvas can render the screen standalone; the live port
          puts the keyframes in apps/web/src/styles.css or equivalent. */}
      <style>{`
        @keyframes aiq-spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
};

window.InviteAcceptScreen = InviteAcceptScreen;
