/* AssessIQ — Email Brand Guide
   ─────────────────────────────
   A single tall artboard. Functions like a printed mini-spec:
   tokens, structure, anatomy, voice, do/don'ts.
*/

const GuideSection = ({ eyebrow, title, children, last }) => (
  <section style={{
    padding: "48px 56px",
    borderBottom: last ? 0 : "1px solid var(--border)",
  }}>
    <div className="mono" style={{
      fontSize: 11, color: "var(--accent)",
      textTransform: "uppercase", letterSpacing: "0.1em",
      marginBottom: 10,
    }}>{eyebrow}</div>
    <h2 className="serif" style={{
      fontSize: 32, margin: "0 0 28px",
      letterSpacing: "-0.02em", fontWeight: 500,
    }}>{title}</h2>
    {children}
  </section>
);

const Swatch = ({ name, value, hex, role }) => (
  <div style={{
    border: "1px solid var(--border)", borderRadius: 10,
    overflow: "hidden",
  }}>
    <div style={{ height: 88, background: value }}></div>
    <div style={{ padding: "12px 14px" }}>
      <div className="mono" style={{
        fontSize: 10, color: "var(--text-faint)",
        textTransform: "uppercase", letterSpacing: "0.08em",
        marginBottom: 4,
      }}>{name}</div>
      <div className="mono" style={{ fontSize: 12, color: "var(--text)" }}>{hex}</div>
      <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>{role}</div>
    </div>
  </div>
);

const TypeRow = ({ label, family, sample, size, weight, lh = 1.2 }) => (
  <div style={{
    display: "grid", gridTemplateColumns: "180px 1fr",
    gap: 28, padding: "20px 0",
    borderTop: "1px solid var(--border)",
    alignItems: "baseline",
  }}>
    <div>
      <div className="mono" style={{
        fontSize: 10, color: "var(--text-faint)",
        textTransform: "uppercase", letterSpacing: "0.08em",
      }}>{label}</div>
      <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
        {family} · {size}/{weight}
      </div>
    </div>
    <div style={{
      fontFamily: family.includes("Newsreader") ? "var(--font-serif)" :
                  family.includes("JetBrains") ? "var(--font-mono)" : "var(--font-sans)",
      fontSize: size, fontWeight: weight,
      letterSpacing: family.includes("Newsreader") ? "-0.02em" :
                     family.includes("JetBrains") ? "0.04em" : "-0.005em",
      lineHeight: lh,
      textTransform: family.includes("JetBrains") && label.includes("META") ? "uppercase" : "none",
    }}>
      {sample}
    </div>
  </div>
);

const DoDont = ({ kind, text }) => (
  <div style={{
    display: "flex", gap: 12, alignItems: "flex-start",
    padding: "14px 16px",
    border: "1px solid var(--border)",
    borderRadius: 10,
    background: kind === "do" ? "oklch(0.97 0.03 150)" : "oklch(0.97 0.03 25)",
    borderColor: kind === "do" ? "oklch(0.85 0.07 150)" : "oklch(0.85 0.07 25)",
  }}>
    <span className="mono" style={{
      fontSize: 10, fontWeight: 500,
      color: kind === "do" ? "var(--success)" : "var(--danger)",
      textTransform: "uppercase", letterSpacing: "0.08em",
      marginTop: 2, minWidth: 28,
    }}>{kind === "do" ? "Do" : "Don't"}</span>
    <span style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.5 }}>{text}</span>
  </div>
);

const ButtonSample = ({ children, variant }) => {
  const base = {
    display: "inline-flex", alignItems: "center", gap: 8,
    padding: "13px 26px", borderRadius: 999,
    fontFamily: "var(--font-sans)", fontSize: 14, fontWeight: 500,
    border: "1px solid transparent", letterSpacing: "-0.005em",
    textDecoration: "none",
  };
  if (variant === "primary") return <a href="#" style={{ ...base, background: "var(--accent)", color: "#fff" }}>{children}</a>;
  if (variant === "outline") return <a href="#" style={{ ...base, background: "transparent", color: "var(--text)", borderColor: "var(--border-strong)" }}>{children}</a>;
  return <a href="#" style={{ ...base, color: "var(--accent)", padding: 0 }}>{children}</a>;
};

const EmailBrandGuide = () => (
  <div style={{
    width: 760, background: "var(--bg)",
    fontFamily: "var(--font-sans)", color: "var(--text)",
    fontSize: 14, lineHeight: 1.5,
    border: "1px solid var(--border)", borderRadius: 14,
    overflow: "hidden",
  }}>

    {/* ── Cover ────────────────────────────────────── */}
    <div style={{
      padding: "72px 56px 56px",
      borderBottom: "1px solid var(--border)",
      background: "var(--surface)", position: "relative",
    }}>
      <div className="grid-bg" style={{
        position: "absolute", inset: 0, opacity: 0.35,
        maskImage: "radial-gradient(ellipse at top, black, transparent 65%)",
        WebkitMaskImage: "radial-gradient(ellipse at top, black, transparent 65%)",
      }}></div>
      <div style={{ position: "relative" }}>
        <Logo size={20} />
        <div className="mono" style={{
          marginTop: 32, fontSize: 11, color: "var(--text-faint)",
          textTransform: "uppercase", letterSpacing: "0.1em",
        }}>Brand guide · v1.0 · May 2026</div>
        <h1 className="serif" style={{
          fontSize: 56, margin: "12px 0 16px",
          letterSpacing: "-0.025em", fontWeight: 500, lineHeight: 1.02,
          textWrap: "balance", maxWidth: 580,
        }}>Email system.</h1>
        <p style={{
          margin: 0, fontSize: 17, color: "var(--text-muted)",
          maxWidth: 520, lineHeight: 1.5,
        }}>
          How AssessIQ talks in the inbox — tokens, anatomy, voice, and the
          five canonical templates. Use this as a foundation when composing
          any new transactional or lifecycle email.
        </p>

        <div style={{ display: "flex", gap: 28, marginTop: 40 }}>
          <div>
            <div className="mono" style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Width</div>
            <span className="num" style={{ fontSize: 34, display: "block", marginTop: 4 }}>640<span style={{ fontSize: 14, color: "var(--text-muted)", fontFamily: "var(--font-sans)" }}> px</span></span>
          </div>
          <div>
            <div className="mono" style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Templates</div>
            <span className="num" style={{ fontSize: 34, display: "block", marginTop: 4 }}>5</span>
          </div>
          <div>
            <div className="mono" style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Accent</div>
            <span className="num" style={{ fontSize: 34, display: "block", marginTop: 4, color: "var(--accent)" }}>1</span>
          </div>
        </div>
      </div>
    </div>

    {/* ── 01 Principles ───────────────────────────── */}
    <GuideSection eyebrow="01 · Principles" title="Read it like a letter, not a banner.">
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        {[
          ["Editorial, not promotional.", "Headlines are statements ending in a period. No 'Hey there!', no all-caps shouting, no marquee CTAs."],
          ["One accent, one CTA.", "Blue appears once — on the primary button. Secondary actions are ghost links."],
          ["Borders, not shadows.", "Structure is drawn with 1px hairlines. Reserve shadow for the outer card if at all."],
          ["Whitespace > decoration.", "40px side padding, 36px vertical rhythm. Pad before you decorate."],
          ["Numbers in serif.", "Scores, percentiles, durations use the .num class. The editorial signature carries into the inbox."],
          ["Plain English.", "Short sentences. Specific numbers. Address the recipient directly."],
        ].map(([title, body], i) => (
          <div key={i} style={{ padding: "20px 0", borderTop: "1px solid var(--border)" }}>
            <div className="mono" style={{
              fontSize: 10, color: "var(--text-faint)",
              textTransform: "uppercase", letterSpacing: "0.08em",
              marginBottom: 8,
            }}>0{i + 1}</div>
            <div className="serif" style={{ fontSize: 18, fontWeight: 500, letterSpacing: "-0.01em", marginBottom: 6 }}>{title}</div>
            <div style={{ fontSize: 13, color: "var(--text-muted)" }}>{body}</div>
          </div>
        ))}
      </div>
    </GuideSection>

    {/* ── 02 Color ────────────────────────────────── */}
    <GuideSection eyebrow="02 · Color" title="White, gray, black, one blue.">
      <p style={{ margin: "0 0 24px", color: "var(--text-muted)", fontSize: 14, maxWidth: 540 }}>
        Email clients mangle color. Stick to the seven tokens below — they survive
        Outlook, Gmail dark mode, and the iOS Mail invert filter.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14 }}>
        <Swatch name="Accent" value="#1a73e8" hex="#1A73E8" role="Primary CTA · links" />
        <Swatch name="Accent soft" value="#eaf2fd" hex="#EAF2FD" role="CTA hover halo" />
        <Swatch name="Text" value="#0a0a0b" hex="#0A0A0B" role="Body copy · headlines" />
        <Swatch name="Text muted" value="#3f3f46" hex="#3F3F46" role="Lede · supporting" />
        <Swatch name="Text faint" value="#71717a" hex="#71717A" role="Mono metadata · footer" />
        <Swatch name="Surface" value="#fafafa" hex="#FAFAFA" role="Footer · recessed bands" />
        <Swatch name="Canvas" value="#f1efea" hex="#F1EFEA" role="Outer wrapper (warm gray)" />
        <Swatch name="Border" value="#e4e4e7" hex="#E4E4E7" role="1px hairlines" />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 24 }}>
        <DoDont kind="do" text="Use the accent exactly once per email — on the single primary CTA." />
        <DoDont kind="dont" text="Introduce new hues for status (purple/orange). Use mono chips on neutral backgrounds." />
      </div>
    </GuideSection>

    {/* ── 03 Typography ──────────────────────────── */}
    <GuideSection eyebrow="03 · Typography" title="Three families. One voice.">
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginBottom: 28 }}>
        {[
          ["Newsreader", "Serif", "Display · headlines · numerics"],
          ["Geist", "Sans", "Body · UI · buttons"],
          ["JetBrains Mono", "Mono", "Metadata · IDs · timestamps"],
        ].map(([name, kind, role]) => (
          <div key={name} style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 18 }}>
            <div className="mono" style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em" }}>{kind}</div>
            <div style={{
              fontFamily: name === "Newsreader" ? "var(--font-serif)" :
                          name === "Geist" ? "var(--font-sans)" : "var(--font-mono)",
              fontSize: 28, fontWeight: 500, letterSpacing: name === "Newsreader" ? "-0.02em" : "-0.005em",
              marginTop: 6, marginBottom: 8,
            }}>{name}</div>
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{role}</div>
          </div>
        ))}
      </div>

      <TypeRow label="DISPLAY" family="Newsreader" sample="You've been invited." size={36} weight={500} lh={1.1} />
      <TypeRow label="SUBHEAD" family="Newsreader" sample="The Pulse — May edition" size={22} weight={500} lh={1.25} />
      <TypeRow label="BODY" family="Geist" sample="Your assessment is ready to review. The window closes in 72 hours." size={15} weight={400} lh={1.55} />
      <TypeRow label="LABEL" family="Geist" sample="View report" size={13} weight={500} lh={1.4} />
      <TypeRow label="META" family="JetBrains Mono" sample="#A-2841 · APR 29 · 14:32 PT" size={11} weight={400} lh={1.4} />
      <TypeRow label="NUMERIC" family="Newsreader" sample="132 / 160" size={48} weight={500} lh={1} />

      <div style={{
        marginTop: 28, padding: "16px 20px",
        background: "var(--surface)", borderRadius: 10,
        border: "1px solid var(--border)",
      }}>
        <div className="mono" style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>Email-safe fallback stack</div>
        <code className="mono" style={{ fontSize: 12, color: "var(--text)" }}>
          "Newsreader", "Source Serif Pro", Georgia, serif <br />
          "Geist", -apple-system, "Helvetica Neue", Arial, sans-serif <br />
          "JetBrains Mono", "SF Mono", Menlo, monospace
        </code>
      </div>
    </GuideSection>

    {/* ── 04 Anatomy ──────────────────────────────── */}
    <GuideSection eyebrow="04 · Anatomy" title="The canonical envelope.">
      <p style={{ margin: "0 0 24px", color: "var(--text-muted)", maxWidth: 540 }}>
        Every AssessIQ email is the same five-zone structure. Drop content into
        the body; keep header, divider, footer untouched.
      </p>
      <div style={{
        border: "1px solid var(--border)", borderRadius: 12,
        overflow: "hidden", background: "var(--bg)",
        position: "relative",
      }}>
        {[
          { label: "01 · Preheader", hint: "Hidden preview text · ≤ 90 chars · plain sentence", h: 32, bg: "var(--surface-2)" },
          { label: "02 · Header", hint: "Wordmark left · optional mono eyebrow right · 1px bottom border", h: 56, bg: "var(--bg)" },
          { label: "03 · Body", hint: "40px side · 36px vertical rhythm · serif lede + sans copy + ONE pill CTA", h: 220, bg: "var(--bg)" },
          { label: "04 · Card / meta block (optional)", hint: "Mono key · value rows · stat tile · receipt-style", h: 72, bg: "var(--bg)" },
          { label: "05 · Footer", hint: "Surface background · wordmark · reason · links · mono colophon", h: 90, bg: "var(--surface)" },
        ].map((z, i) => (
          <div key={i} style={{
            height: z.h, background: z.bg,
            borderTop: i === 0 ? 0 : "1px dashed var(--border)",
            padding: "12px 20px",
            display: "flex", flexDirection: "column", justifyContent: "center",
          }}>
            <div className="mono" style={{ fontSize: 10, color: "var(--accent)", textTransform: "uppercase", letterSpacing: "0.08em" }}>{z.label}</div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>{z.hint}</div>
          </div>
        ))}
      </div>
    </GuideSection>

    {/* ── 05 Buttons + links ───────────────────────── */}
    <GuideSection eyebrow="05 · Action" title="One pill button. One ghost link.">
      <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", marginBottom: 24 }}>
        <ButtonSample variant="primary">Accept invitation</ButtonSample>
        <ButtonSample variant="outline">View details</ButtonSample>
        <ButtonSample variant="ghost">View full report →</ButtonSample>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <DoDont kind="do" text="Pair the primary pill with a ghost-link alternative below it ('Or copy the link')." />
        <DoDont kind="dont" text="Stack two filled pills. The recipient should never have to choose between two equal-weight CTAs." />
        <DoDont kind="do" text="Write the button label as an imperative verb in sentence case ('Review submission')." />
        <DoDont kind="dont" text="Use 'Click here.' Every label must say what happens on click." />
      </div>
    </GuideSection>

    {/* ── 06 Subject + voice ───────────────────────── */}
    <GuideSection eyebrow="06 · Voice" title="Subject lines are sentences too.">
      <div style={{
        border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden",
      }}>
        <div style={{
          display: "grid", gridTemplateColumns: "180px 1fr 1fr",
          padding: "12px 18px", background: "var(--surface)",
          borderBottom: "1px solid var(--border)",
        }} className="mono">
          {["Template", "Subject", "Preheader"].map(h => (
            <span key={h} style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em" }}>{h}</span>
          ))}
        </div>
        {[
          ["Newsletter", "The Pulse · 4 reads on assessment design", "What we shipped in May, and one piece worth your weekend."],
          ["Assessment invite", "You've been invited to Logical Reasoning III", "Acme Corp · 45 minutes · expires in 72 hours."],
          ["Company invite", "Acme Corp invited you to join AssessIQ", "Pick a username and you're in. Takes 30 seconds."],
          ["Result · candidate", "Your Logical Reasoning III score is ready", "You scored 132 — higher than 97% of test-takers."],
          ["New submission", "Jordan Avery just finished Logical Reasoning III", "Score 132 · 38m 14s · ready for review."],
        ].map(([k, s, p], i) => (
          <div key={i} style={{
            display: "grid", gridTemplateColumns: "180px 1fr 1fr",
            padding: "14px 18px", fontSize: 12,
            borderBottom: i === 4 ? 0 : "1px solid var(--border)",
            alignItems: "center", gap: 12,
          }}>
            <span className="mono" style={{ fontSize: 11, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{k}</span>
            <span style={{ color: "var(--text)" }}>{s}</span>
            <span style={{ color: "var(--text-muted)" }}>{p}</span>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 24, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <DoDont kind="do" text="Lead with specificity. 'Your score is 132.' beats 'Your results are in!'" />
        <DoDont kind="dont" text="Use exclamation marks, emoji, or marketing superlatives ('amazing', 'incredible')." />
        <DoDont kind="do" text="Keep subject lines under 55 characters so they don't truncate on mobile." />
        <DoDont kind="dont" text="Bury the action. The first 4 words must signal why this email exists." />
      </div>
    </GuideSection>

    {/* ── 07 Footer recipe ─────────────────────────── */}
    <GuideSection eyebrow="07 · Footer" title="The colophon." last>
      <p style={{ margin: "0 0 20px", color: "var(--text-muted)", maxWidth: 540 }}>
        Every email closes with the same four elements, in the same order.
        Treat it as the colophon — quiet, complete, unmistakably AssessIQ.
      </p>
      <div style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 12, padding: "28px 32px",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--accent)" }}></span>
          <span className="serif" style={{ fontSize: 14, fontWeight: 500 }}>AssessIQ</span>
        </div>
        <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", maxWidth: 440 }}>
          You're receiving this because you have an active AssessIQ account.
        </p>
        <div style={{ display: "flex", gap: 18, marginTop: 16, fontSize: 12 }}>
          {["Unsubscribe", "Email preferences", "Help center", "Privacy"].map(l => (
            <span key={l} style={{ color: "var(--text-muted)" }}>{l}</span>
          ))}
        </div>
        <hr style={{ height: 1, background: "var(--border)", border: 0, margin: "18px 0 14px" }} />
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

      <div style={{ marginTop: 24, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
        <DoDont kind="do" text="State why the recipient is getting this email in one short sentence." />
        <DoDont kind="do" text="Unsubscribe is the first link. Always. CAN-SPAM and respect both demand it." />
        <DoDont kind="dont" text="Hide the unsubscribe in 9px gray. Match the rest of the footer's contrast." />
      </div>
    </GuideSection>
  </div>
);

Object.assign(window, { EmailBrandGuide });
