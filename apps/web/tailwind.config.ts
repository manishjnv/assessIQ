import type { Config } from "tailwindcss";

/**
 * Tailwind is used for layout/spacing utilities only. Editorial visual styling
 * (colors, type, components) lives in the @assessiq/ui-system tokens.css base
 * classes (.btn, .card, .chip, .num, .serif, .mono, etc.). Tailwind reads font
 * + radius tokens from --aiq-* CSS vars so utility classes compose with the
 * editorial system without divergence.
 */
const config: Config = {
  content: [
    "./index.html",
    "./src/**/*.{ts,tsx}",
    "../../modules/17-ui-system/src/**/*.{ts,tsx}",
  ],
  darkMode: ["class", '[data-theme="dark"]'],
  theme: {
    extend: {
      fontFamily: {
        serif: ["var(--aiq-font-serif)"],
        sans: ["var(--aiq-font-sans)"],
        mono: ["var(--aiq-font-mono)"],
      },
      borderRadius: {
        "aiq-sm": "var(--aiq-radius-sm)",
        "aiq-md": "var(--aiq-radius-md)",
        "aiq-lg": "var(--aiq-radius-lg)",
        "aiq-pill": "var(--aiq-radius-pill)",
      },
    },
  },
  plugins: [],
};

export default config;
