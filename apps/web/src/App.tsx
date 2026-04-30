import { useState } from "react";
import type { CSSProperties } from "react";
import {
  Button,
  Card,
  Field,
  Chip,
  Icon,
  Logo,
  Num,
  ThemeProvider,
  TENANT_FIXTURES,
} from "@assessiq/ui-system";
import type { IconName, ThemeMode, DensityMode } from "@assessiq/ui-system";

const ALL_ICONS: readonly IconName[] = [
  "search", "arrow", "arrowLeft", "check", "clock",
  "home", "grid", "chart", "user", "settings",
  "plus", "close", "play", "pause", "flag",
  "book", "code", "drag", "bell", "eye",
  "sparkle", "google",
];

const META_LABEL: CSSProperties = {
  fontFamily: "var(--aiq-font-mono)",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--aiq-color-fg-secondary)",
};

export function App() {
  const [theme, setTheme] = useState<ThemeMode>("system");
  const [density, setDensity] = useState<DensityMode>("cozy");
  const [tenantSlug, setTenantSlug] = useState<string>("wipro-soc");
  const tenant = TENANT_FIXTURES[tenantSlug];

  return (
    <ThemeProvider
      theme={theme}
      density={density}
      {...(tenant?.branding ? { branding: tenant.branding } : {})}
    >
      <div className="aiq-screen" style={{ minHeight: "100vh", padding: 32 }}>
        <header style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 32 }}>
          <Logo />
          <span style={{ flex: 1 }} />
          <Chip variant="accent" leftIcon="sparkle">Phase 0 · UI tokens</Chip>
        </header>

        <h1 className="aiq-serif" style={{ fontSize: 44, margin: 0, marginBottom: 8 }}>
          The library.
        </h1>
        <p style={{ ...META_LABEL, marginTop: 0, marginBottom: 32 }}>
          Token smoke · {theme} · density {density} · tenant {tenant?.name ?? "—"}
        </p>

        <Card padding="lg" style={{ marginBottom: 24 }}>
          <h2 className="aiq-serif" style={{ fontSize: 22, marginTop: 0 }}>Buttons</h2>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
            <Button>Primary</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button>
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <Button size="sm">Small</Button>
            <Button>Medium</Button>
            <Button size="lg">Large</Button>
            <Button leftIcon="sparkle">With icon</Button>
            <Button rightIcon="arrow">Continue</Button>
            <Button loading>Loading</Button>
          </div>
        </Card>

        <Card padding="lg" style={{ marginBottom: 24 }}>
          <h2 className="aiq-serif" style={{ fontSize: 22, marginTop: 0 }}>Chips & numbers</h2>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
            <Chip>Default</Chip>
            <Chip variant="accent">AI · matched</Chip>
            <Chip variant="success">Passed</Chip>
            <Chip variant="accent" leftIcon="clock">30 min</Chip>
          </div>
          <div style={{ display: "flex", gap: 32, alignItems: "baseline" }}>
            <div>
              <div style={META_LABEL}>Score</div>
              <Num value={132} animate style={{ fontSize: 64 }} />
            </div>
            <div>
              <div style={META_LABEL}>Percentile</div>
              <Num value={97} animate format={(n) => `${n}th`} style={{ fontSize: 64 }} />
            </div>
          </div>
        </Card>

        <Card padding="lg" style={{ marginBottom: 24 }}>
          <h2 className="aiq-serif" style={{ fontSize: 22, marginTop: 0 }}>Field</h2>
          <div style={{ display: "grid", gap: 16, maxWidth: 420 }}>
            <Field label="Email" placeholder="alex@example.com" help="We never spam." />
            <Field label="Password" type="password" error="Required." />
          </div>
        </Card>

        <Card padding="lg" style={{ marginBottom: 24 }}>
          <h2 className="aiq-serif" style={{ fontSize: 22, marginTop: 0 }}>Icons</h2>
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(80px, 1fr))",
            gap: 12,
          }}>
            {ALL_ICONS.map((name) => (
              <div
                key={name}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 8,
                  padding: 12,
                  border: "1px solid var(--aiq-color-border)",
                  borderRadius: 12,
                }}
              >
                <Icon name={name} size={20} aria-label={name} />
                <span className="aiq-mono" style={{ fontSize: 10, color: "var(--aiq-color-fg-muted)" }}>{name}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card padding="lg">
          <h2 className="aiq-serif" style={{ fontSize: 22, marginTop: 0 }}>Theme controls</h2>
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
            <div>
              <div style={{ ...META_LABEL, marginBottom: 8 }}>Theme</div>
              <div style={{ display: "flex", gap: 8 }}>
                {(["light", "dark", "system"] as const).map((t) => (
                  <Button
                    key={t}
                    size="sm"
                    variant={theme === t ? "primary" : "outline"}
                    onClick={() => setTheme(t)}
                  >
                    {t}
                  </Button>
                ))}
              </div>
            </div>
            <div>
              <div style={{ ...META_LABEL, marginBottom: 8 }}>Density</div>
              <div style={{ display: "flex", gap: 8 }}>
                {(["compact", "cozy", "comfortable"] as const).map((d) => (
                  <Button
                    key={d}
                    size="sm"
                    variant={density === d ? "primary" : "outline"}
                    onClick={() => setDensity(d)}
                  >
                    {d}
                  </Button>
                ))}
              </div>
            </div>
            <div>
              <div style={{ ...META_LABEL, marginBottom: 8 }}>Tenant</div>
              <div style={{ display: "flex", gap: 8 }}>
                {Object.keys(TENANT_FIXTURES).map((slug) => (
                  <Button
                    key={slug}
                    size="sm"
                    variant={tenantSlug === slug ? "primary" : "outline"}
                    onClick={() => setTenantSlug(slug)}
                  >
                    {TENANT_FIXTURES[slug]?.name ?? slug}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </Card>
      </div>
    </ThemeProvider>
  );
}
