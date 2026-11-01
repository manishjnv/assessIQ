/** @type {import('tailwindcss').Config} */
// Brand tokens copied by VALUE from:
//   modules/17-ui-system/src/styles/tokens.css
//   modules/17-ui-system/AssessIQ_UI_Template/design-system/tokens.md
// Do NOT import @assessiq/ui-system — this site is intentionally decoupled.
export default {
  content: ['./src/**/*.{astro,html,js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Surfaces (light mode — canonical; dark mode not yet adopted per branding guideline §1.1)
        'aiq-bg-base':     '#ffffff',
        'aiq-bg-raised':   '#fafafa',
        'aiq-bg-sunken':   '#f3f3f4',

        // Text
        'aiq-fg-primary':   '#0a0a0b',
        'aiq-fg-secondary': '#3f3f46',
        'aiq-fg-muted':     '#666670',   // S93 (X8 S2): was #71717a (4.36:1 on bg-sunken); 5.1:1 now

        // Borders
        'aiq-border':        '#e4e4e7',
        'aiq-border-strong': '#cdcdd1',

        // Accent — indigo-violet hue 258
        // S93 (X8 S2): darkened to match tokens.css for WCAG 1.4.3; was #3177dc (4.37:1)
        'aiq-accent':       '#1364ce',   // oklch(0.52 0.18 258), same as tokens.css (AA 5.4:1 on #fafafa, white text 5.6:1)
        'aiq-accent-soft':  '#eef3fd',   // oklch(0.96 0.03 258) approximated
        'aiq-accent-hover': '#004fbf',   // oklch(0.46 0.19 258), same as tokens.css

        // Status — used sparingly
        'aiq-success':      '#22c55e',   // oklch(0.65 0.15 150) approx
        'aiq-success-soft': '#f0fdf4',   // oklch(0.97 0.03 150) approx
        'aiq-warning':      '#eab308',   // oklch(0.72 0.15 70)  approx
        'aiq-danger':       '#ef4444',   // oklch(0.62 0.20 25)  approx
      },
      fontFamily: {
        // Editorial trio — copied from tokens.css --aiq-font-* values
        serif: ['"Newsreader"', '"Source Serif Pro"', 'Georgia', 'serif'],
        sans:  ['"Geist"', '-apple-system', '"Helvetica Neue"', 'Helvetica', 'Arial', 'sans-serif'],
        mono:  ['"JetBrains Mono"', '"SF Mono"', 'Menlo', 'Consolas', 'monospace'],
      },
      fontSize: {
        // Token scale from tokens.css --aiq-text-* (px values)
        'aiq-xs':   ['11px', { lineHeight: '1.4' }],
        'aiq-sm':   ['13px', { lineHeight: '1.4' }],
        'aiq-md':   ['14px', { lineHeight: '1.5' }],
        'aiq-lg':   ['16px', { lineHeight: '1.5' }],
        'aiq-xl':   ['22px', { lineHeight: '1.2' }],
        'aiq-2xl':  ['30px', { lineHeight: '1.15' }],
        'aiq-3xl':  ['36px', { lineHeight: '1.1' }],
        'aiq-hero': ['52px', { lineHeight: '1.05' }],
      },
      borderRadius: {
        // Token radii from tokens.css / branding guideline §5
        'aiq-sm':   '6px',
        'aiq-md':   '10px',
        'aiq-lg':   '16px',
        'aiq-pill': '999px',
      },
      boxShadow: {
        // Token shadows from tokens.css
        'aiq-sm': '0 1px 2px rgba(0,0,0,0.04)',
        'aiq-md': '0 1px 3px rgba(0,0,0,0.06), 0 4px 12px rgba(0,0,0,0.04)',
        'aiq-lg': '0 8px 32px rgba(0,0,0,0.08)',
      },
      spacing: {
        // Spacing tokens at cozy density (--u: 4px)
        'aiq-2xs': '2px',
        'aiq-xs':  '4px',
        'aiq-sm':  '8px',
        'aiq-md':  '12px',
        'aiq-lg':  '16px',
        'aiq-xl':  '24px',
        'aiq-2xl': '32px',
        'aiq-3xl': '48px',
        'aiq-4xl': '64px',
      },
      letterSpacing: {
        'aiq-tight':  '-0.02em',
        'aiq-tighter': '-0.025em',
        'aiq-mono':   '0.08em',
      },
    },
  },
  plugins: [],
};
