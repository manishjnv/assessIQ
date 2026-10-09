# AssessIQ — Email Branding Kit

Everything you need to build, ship, or evolve AssessIQ emails.

## What's inside

```
AssessIQ-Email-Kit/
├── README.md                          ← you are here
├── AssessIQ-Emails-standalone.html    ← open this. one file, works offline.
├── Email System.html                  ← editable source (loads from /emails)
├── styles.css                         ← tokens + base atoms (CSS source of truth)
├── design-canvas.jsx                  ← canvas shell (pan, zoom, reorder)
├── screens/
│   └── atoms.jsx                      ← Logo, Icon, Placeholder primitives
├── emails/
│   ├── email-atoms.jsx                ← EmailShell, Header, Body, CTA, Footer…
│   ├── brand-guide.jsx                ← the brand-guide artboard
│   ├── templates-1.jsx                ← Newsletter, Invite, Team invite
│   └── templates-2.jsx                ← Result, New submission
└── design-system/                     ← upstream AssessIQ design system docs
    ├── README.md
    ├── tokens.md
    ├── components.md
    ├── patterns.md
    └── copy-and-voice.md
```

## Quick start

**Just want to look?** Open `AssessIQ-Emails-standalone.html` in any browser.
No server, no build, works offline.

**Want to edit?** Open `Email System.html` from a local server (any will do —
the file loads sibling JSX files which `file://` won't allow). Edit the JSX
in `emails/`, refresh.

```bash
cd AssessIQ-Email-Kit
npx serve .
# open http://localhost:3000/Email%20System.html
```

## The 5 templates

| # | Template | When to send |
| --- | --- | --- |
| 01 | **The Pulse** newsletter | Monthly, editorial cadence |
| 02 | **Assessment invite** | Candidate asked to take a test |
| 03 | **Team invitation** | New teammate joining a workspace |
| 04 | **Result delivered** | Candidate's score is ready |
| 05 | **New submission** | Reviewer notification |

Each is 640px wide, composed entirely from the atoms in `emails/email-atoms.jsx`.
They share one header, one footer, one button style, one accent color.

## Building a new template

1. **Read the brand guide artboard first.** It's the source of truth for
   color, type, anatomy, voice. The five existing templates illustrate it.
2. **Compose from `email-atoms.jsx`.** Don't reach for new primitives until
   you've proved the existing ones won't work.
3. **Drop it into `Email System.html`** as a new `<DCArtboard>` inside the
   Templates `<DCSection>`. The canvas handles layout.

Skeleton:

```jsx
const MyNewEmail = () => (
  <EmailShell preheader="≤ 90 chars · plain sentence">
    <EmailHeader eyebrow="Eyebrow" />
    <EmailBody>
      <EmailLede
        eyebrow="Optional kicker"
        title="The headline. A sentence with a period."
        body="One paragraph of context. Plain English. Specific."
      />
      <EmailMetaCard rows={[
        { k: "Label", v: "Value" },
      ]} />
      <EmailCTA label="Imperative verb" />
    </EmailBody>
    <EmailFooter reason="Why this person is receiving this email." />
  </EmailShell>
);
```

## Shipping to production

These files are **design mocks** — pixel-faithful to what your customers
should see, but rendered with the web app's React + CSS stack. To actually
send mail:

1. **Rebuild the layout as nested `<table>` tags.** Email clients (especially
   Outlook) ignore flex and grid. Every `EmailShell`, `EmailBody`,
   `EmailMetaCard` becomes a table.
2. **Inline every style.** Tools like [Maizzle](https://maizzle.com),
   [MJML](https://mjml.io), or [Premailer](https://premailer.io) do this
   automatically. The brand-guide artboard documents the email-safe font
   fallback stack.
3. **Add MSO/VML for buttons.** Outlook on Windows renders pill buttons as
   square boxes unless you wrap each in conditional VML. Every transactional
   email service includes a starter template — copy theirs.
4. **Send a preheader.** The hidden preview-text trick: white-on-white text
   immediately after `<body>`. The brand guide lists the canonical
   preheader for each template.
5. **Test in Litmus or Email on Acid** before shipping. Gmail dark mode,
   iOS Mail invert, and Outlook 2016 all break things in unique ways.

## Tokens at a glance

| Token | Hex | Use |
| --- | --- | --- |
| `--accent` | `#1a73e8` | THE one blue. Primary CTAs only. |
| `--text` | `#0a0a0b` | Body copy, headlines |
| `--text-muted` | `#3f3f46` | Lede, supporting |
| `--text-faint` | `#71717a` | Mono metadata, footer |
| `--bg` | `#ffffff` | Email card background |
| `--surface` | `#fafafa` | Footer, recessed bands |
| `--canvas` (kit-only) | `#f1efea` | Outer wrapper outside the email card |
| `--border` | `#e4e4e7` | 1px hairlines |

Full token reference: `design-system/tokens.md`.

## License

Internal AssessIQ design asset. Don't ship outside the company without review.

— *AssessIQ Design · v1.0 · May 2026*
