/* Admin list — generic pattern for admin/users, admin/packs, admin/assessments,
 * admin/results-list, admin/embed-secrets, etc. EVERY admin-side list page
 * ports from this single screen so admin surfaces stay consistent.
 *
 * Reference for apps/web/src/pages/admin/users.tsx (and future admin lists).
 *
 * Layout — single full-width column, no sidebar (Phase 0; navigation is
 * Phase 1+ when admin-shell ships):
 *
 *   1. Page header — serif title + count chip + primary action button
 *   2. Filter strip — search field on left + filter chips on right
 *   3. Rows — striped table (mono ID + primary text + meta + chips + actions)
 *   4. Pager — prev / current / total / next
 *   5. Empty state — serif headline + secondary copy + primary CTA
 *
 * Imports: <Logo />, <Icon /> from atoms.jsx; CSS tokens from styles.css.
 */

const AdminListScreen = () => {
  const [filter, setFilter] = React.useState("All");
  const [page, setPage] = React.useState(1);
  const [showInvite, setShowInvite] = React.useState(false);

  const filters = ["All", "Active", "Pending", "Disabled"];

  // Sample rows — admin/users-shaped. Real ports re-shape per their domain.
  const rows = [
    { id: "u-2841", email: "alex@wipro.com", name: "Alex Chen", role: "admin", status: "active", created: "2026-04-12" },
    { id: "u-2842", email: "priya@wipro.com", name: "Priya Sharma", role: "reviewer", status: "active", created: "2026-04-15" },
    { id: "u-2843", email: "marcus@wipro.com", name: "Marcus Reed", role: "reviewer", status: "pending", created: "2026-04-22" },
    { id: "u-2844", email: "—", name: "—", role: "candidate", status: "active", created: "2026-04-28" },
    { id: "u-2845", email: "sara@wipro.com", name: "Sara Lee", role: "admin", status: "disabled", created: "2026-04-30" },
  ];
  const visible = filter === "All" ? rows : rows.filter((r) => r.status === filter.toLowerCase());
  const totalPages = 3;

  return (
    <div className="aiq-screen" style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      {/* Top bar — brand + meta + log out. */}
      <header style={{ padding: "20px 32px", display: "flex", alignItems: "center", borderBottom: "1px solid var(--border)" }}>
        <Logo />
        <span className="spacer" style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 11, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
          wipro-soc
        </span>
        <button className="btn btn-ghost btn-sm" style={{ marginLeft: 16 }}>
          <Icon name="user" size={14} /> alex@wipro.com
        </button>
      </header>

      <main style={{ flex: 1, padding: "32px 40px", maxWidth: 1280, width: "100%", margin: "0 auto" }}>
        {/* 1. Page header — serif title + count chip + primary action */}
        <div style={{ display: "flex", alignItems: "flex-end", marginBottom: 28 }}>
          <div>
            <div className="chip" style={{ marginBottom: 12 }}>
              <Icon name="grid" size={10} />
              <span>{visible.length} of {rows.length}</span>
            </div>
            <h1
              className="serif"
              style={{
                fontSize: 36,
                lineHeight: 1.1,
                margin: 0,
                fontWeight: 400,
                letterSpacing: "-0.02em",
              }}
            >
              Users.
            </h1>
            <p style={{ fontSize: 14, color: "var(--text-muted)", margin: "8px 0 0", maxWidth: 520 }}>
              Admins manage the tenant. Reviewers grade submissions. Candidates take assessments.
            </p>
          </div>
          <span className="spacer" style={{ flex: 1 }} />
          <button className="btn btn-primary btn-md" onClick={() => setShowInvite(true)}>
            <Icon name="plus" size={14} />
            Invite user
          </button>
        </div>

        {/* 2. Filter strip — search + filter chips */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            marginBottom: 16,
            paddingBottom: 16,
            borderBottom: "1px solid var(--border)",
          }}
        >
          <div
            style={{
              flex: "0 0 320px",
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 14px",
              background: "var(--bg)",
              border: "1px solid var(--border-strong)",
              borderRadius: "var(--radius-pill)",
            }}
          >
            <Icon name="search" size={14} />
            <input
              placeholder="Search by name or email…"
              style={{
                flex: 1,
                border: "none",
                outline: "none",
                background: "transparent",
                fontFamily: "var(--font-sans)",
                fontSize: 13,
                color: "var(--text)",
              }}
            />
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {filters.map((f) => (
              <button
                key={f}
                className={`chip ${filter === f ? "chip-accent" : ""}`}
                onClick={() => setFilter(f)}
                style={{ cursor: "pointer", border: "none" }}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        {/* 3. Rows — striped table */}
        {visible.length > 0 ? (
          <div
            style={{
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              overflow: "hidden",
              background: "var(--bg)",
            }}
          >
            {/* Column headings */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "120px 2fr 1fr 100px 110px 80px",
                gap: 12,
                padding: "12px 20px",
                background: "var(--surface)",
                borderBottom: "1px solid var(--border)",
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                color: "var(--text-faint)",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
              }}
            >
              <span>ID</span>
              <span>User</span>
              <span>Role</span>
              <span>Status</span>
              <span>Created</span>
              <span style={{ textAlign: "right" }}>Actions</span>
            </div>

            {visible.map((r, i) => (
              <div
                key={r.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "120px 2fr 1fr 100px 110px 80px",
                  gap: 12,
                  padding: "16px 20px",
                  alignItems: "center",
                  borderTop: i === 0 ? "none" : "1px solid var(--border)",
                  background: i % 2 === 1 ? "var(--surface)" : "transparent",
                }}
              >
                <span className="mono" style={{ fontSize: 12, color: "var(--text-faint)" }}>
                  #{r.id}
                </span>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 500, color: "var(--text)" }}>{r.name}</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{r.email}</div>
                </div>
                <span
                  className="chip"
                  style={{
                    background:
                      r.role === "admin"
                        ? "var(--accent-soft)"
                        : "var(--surface-2)",
                    color: r.role === "admin" ? "var(--accent)" : "var(--text-muted)",
                    border: "none",
                  }}
                >
                  {r.role}
                </span>
                <span
                  className={`chip ${
                    r.status === "active"
                      ? "chip-success"
                      : r.status === "pending"
                        ? "chip-accent"
                        : ""
                  }`}
                  style={{ border: "none" }}
                >
                  {r.status === "active" && <Icon name="check" size={10} stroke={2} />}
                  {r.status}
                </span>
                <span className="mono" style={{ fontSize: 11, color: "var(--text-faint)" }}>
                  {r.created}
                </span>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 4 }}>
                  <button className="btn btn-ghost btn-sm" aria-label="Edit">
                    <Icon name="settings" size={12} />
                  </button>
                  <button className="btn btn-ghost btn-sm" aria-label="Disable">
                    <Icon name="close" size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          /* 5. Empty state — serif headline + secondary copy + primary CTA */
          <div
            style={{
              padding: 64,
              textAlign: "center",
              border: "1px dashed var(--border-strong)",
              borderRadius: "var(--radius-lg)",
              background: "var(--surface)",
            }}
          >
            <h2 className="serif" style={{ fontSize: 24, margin: 0, fontWeight: 400 }}>
              Nothing here yet.
            </h2>
            <p style={{ fontSize: 14, color: "var(--text-muted)", margin: "8px 0 20px", maxWidth: 360, marginLeft: "auto", marginRight: "auto" }}>
              Invite your first teammate to get started. They will receive an email with a sign-in link.
            </p>
            <button className="btn btn-primary btn-md">
              <Icon name="plus" size={14} />
              Invite user
            </button>
          </div>
        )}

        {/* 4. Pager */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 12,
            marginTop: 20,
          }}
        >
          <button
            className="btn btn-ghost btn-sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <Icon name="arrowLeft" size={12} /> Prev
          </button>
          <span
            className="mono"
            style={{
              fontSize: 11,
              color: "var(--text-faint)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            {page} / {totalPages}
          </span>
          <button
            className="btn btn-ghost btn-sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            Next <Icon name="arrow" size={12} />
          </button>
        </div>
      </main>

      {/* Invite drawer / modal — slides up from the centre. Triggered by
          the page-header's primary action. */}
      {showInvite && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.36)",
            display: "grid",
            placeItems: "center",
            zIndex: 100,
          }}
          onClick={() => setShowInvite(false)}
        >
          <div
            className="card"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: 440,
              padding: 28,
              boxShadow: "var(--shadow-lg)",
            }}
          >
            <div className="row" style={{ alignItems: "center", marginBottom: 16 }}>
              <h2 className="serif" style={{ fontSize: 22, margin: 0, fontWeight: 400 }}>Invite teammate</h2>
              <span className="spacer" style={{ flex: 1 }} />
              <button className="btn btn-ghost btn-sm" onClick={() => setShowInvite(false)} aria-label="Close">
                <Icon name="close" size={14} />
              </button>
            </div>
            <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 20px" }}>
              They will receive a one-time sign-in link, valid for 72 hours.
            </p>
            <label className="mono" style={{ display: "block", fontSize: 11, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>Email</label>
            <input className="input" placeholder="name@company.com" style={{ marginBottom: 14 }} />
            <label className="mono" style={{ display: "block", fontSize: 11, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>Role</label>
            <div style={{ display: "flex", gap: 6, marginBottom: 24 }}>
              {["admin", "reviewer"].map((r) => (
                <button key={r} className="chip" style={{ cursor: "pointer", border: "1px solid var(--border-strong)" }}>{r}</button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn btn-ghost btn-md" onClick={() => setShowInvite(false)}>Cancel</button>
              <button className="btn btn-primary btn-md">Send invite <Icon name="arrow" size={14} /></button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

window.AdminListScreen = AdminListScreen;
