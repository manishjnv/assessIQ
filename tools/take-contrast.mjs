#!/usr/bin/env node
// Z-167/Z-168 take-page contrast report (WCAG 2.x relative luminance).
// Reads take-theme.css and tokens.css (read-only), resolves each theme's
// token values, and prints a table per theme. It is a report: exit code is always 0.
// Usage: node tools/take-contrast.mjs
// ponytail: regex CSS parser, handles only top-level blocks and hex/rgb()/oklch() values.
// Anything else (color-mix, named colours, var() with no value) is listed as unresolved.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TAKE_CSS = resolve(ROOT, 'apps/web/src/pages/take/take-theme.css');
const TOKENS_CSS = resolve(ROOT, 'modules/17-ui-system/src/styles/tokens.css');

const BASE = '.aiq-take-root';
const THEMES = [
  { name: 'mid (default)', selectors: [BASE, `${BASE}[data-take-theme="mid"]`] },
  { name: 'light', selectors: [BASE, `${BASE}[data-take-theme="light"]`] },
  { name: 'dark', selectors: [BASE, `${BASE}[data-take-theme="dark"]`] },
];

// Pair = [label, fg token, bg token, required ratio, kind]
// Token keys: "color-*" names get the --aiq-color- prefix; "take-*" get --aiq-.
const PAIRS = [
  ['Body text on page', 'color-fg-primary', 'color-bg-base', 4.5, 'text'],
  ['Secondary text on page', 'color-fg-secondary', 'color-bg-base', 4.5, 'text'],
  ['Muted text / eyebrow on page', 'color-fg-muted', 'color-bg-base', 4.5, 'text'],
  ['Passage text on raised surface', 'color-fg-primary', 'color-bg-raised', 4.5, 'text'],
  ['Muted text on raised surface', 'color-fg-muted', 'color-bg-raised', 4.5, 'text'],
  ['Segment button text on sunken', 'color-fg-secondary', 'color-bg-sunken', 4.5, 'text'],
  ['Type chip accent text on accent-soft', 'color-accent', 'color-accent-soft', 4.5, 'text'],
  ['Accent text on raised surface', 'color-accent', 'color-bg-raised', 4.5, 'text'],
  ['Accent button ink on accent', 'take-accent-ink', 'color-accent', 4.5, 'text'],
  ['Selected option text on accent-soft', 'color-fg-primary', 'color-accent-soft', 4.5, 'text'],
  ['Timer low state text on danger-soft', 'color-danger', 'color-danger-soft', 4.5, 'text'],
  ['Danger text on page (field error)', 'color-danger', 'color-bg-base', 4.5, 'text'],
  ['Flag pressed ink on warning-soft', 'take-warn-ink', 'color-warning-soft', 4.5, 'text'],
  ['Success text on success-soft', 'color-success', 'color-success-soft', 4.5, 'text'],
  ['Timer normal text on sunken pill', 'color-fg-primary', 'color-bg-sunken', 4.5, 'text'],
  ['Focus ring vs page (UI)', 'color-accent', 'color-bg-base', 3, 'ui'],
  ['Field border vs page (UI)', 'color-border-strong', 'color-bg-base', 3, 'ui'],
  ['Card border vs page (report only)', 'color-border', 'color-bg-base', 3, 'ui'],
];

// Not measured: no CSS rule sets the placeholder colour on .aiq-take-field.
const STATIC_UNRESOLVED = [
  'Placeholder text on field: no ::placeholder rule for .aiq-take-field in take-theme.css (only .aiq-input::placeholder in tokens.css). Browser default colour, not measured.',
  'Timer normal text colour: take-theme.css sets only the timer background. Text colour assumed to inherit fg-primary from the html/body rule; inline style of AttemptTimer not checked.',
];

function parseBlocks(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(clean))) {
    const selectors = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    const decls = {};
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i < 0) continue;
      const name = d.slice(0, i).trim();
      if (name.startsWith('--')) decls[name] = d.slice(i + 1).trim();
    }
    blocks.push({ selectors, decls });
  }
  return blocks;
}

// Merge, in file order, every block whose selector list contains one of `selectors`.
function themeMap(blocks, selectors) {
  const map = {};
  for (const b of blocks) {
    if (b.selectors.some((s) => selectors.includes(s))) Object.assign(map, b.decls);
  }
  return map;
}

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const encodeSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function parseColor(v) {
  let m = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = [...h].map((c) => c + c).join('');
    const n = parseInt(h, 16);
    return { srgb: [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255], a: 1 };
  }
  m = v.match(/^rgba?\((.+)\)$/i);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    const ch = parts.slice(0, 3).map((p) => (p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p) / 255));
    const a = parts[3] === undefined ? 1 : parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
    if (ch.length !== 3 || ch.some(Number.isNaN)) return { err: `bad rgb: ${v}` };
    return { srgb: ch.map(clamp01), a };
  }
  m = v.match(/^oklch\((.+)\)$/i);
  if (m) {
    const [main, alphaPart] = m[1].split('/').map((s) => s.trim());
    const p = main.split(/\s+/);
    const L = p[0].endsWith('%') ? parseFloat(p[0]) / 100 : parseFloat(p[0]);
    const C = parseFloat(p[1]);
    const H = parseFloat(p[2]);
    if ([L, C, H].some(Number.isNaN)) return { err: `bad oklch: ${v}` };
    const h = (H * Math.PI) / 180;
    const a = C * Math.cos(h);
    const b = C * Math.sin(h);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const lin = [
      4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s,
    ].map(clamp01);
    let alpha = 1;
    if (alphaPart !== undefined) alpha = alphaPart.endsWith('%') ? parseFloat(alphaPart) / 100 : parseFloat(alphaPart);
    return { srgb: lin.map(encodeSrgb), a: alpha };
  }
  return { err: `unsupported value: ${v}` };
}

// Resolve a token name to a colour, following var() aliases recursively.
function resolveVar(name, map, fallback, depth = 0) {
  if (depth > 12) return { err: `alias loop at ${name}` };
  const raw = name in map ? map[name] : fallback[name];
  if (raw === undefined) return { err: `${name} is not defined` };
  const m = raw.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/);
  if (m) {
    const r = resolveVar(m[1], map, fallback, depth + 1);
    if (!r.err || m[2] === undefined) return r;
    return parseColor(m[2].trim());
  }
  return parseColor(raw.trim());
}

// Blend a semi-transparent colour over an opaque background.
function flatten(c, under) {
  if (c.a >= 1) return c;
  return { srgb: c.srgb.map((x, i) => c.a * x + (1 - c.a) * under.srgb[i]), a: 1 };
}

const linearize = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (srgb) => {
  const [r, g, b] = srgb.map(linearize);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (x, y) => {
  const l1 = luminance(x.srgb);
  const l2 = luminance(y.srgb);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};
const toHex = (c) => '#' + c.srgb.map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
const tokenName = (key) => (key.startsWith('take-') ? `--aiq-${key}` : `--aiq-${key}`);

const takeBlocks = parseBlocks(readFileSync(TAKE_CSS, 'utf8'));
const tokenBlocks = parseBlocks(readFileSync(TOKENS_CSS, 'utf8'));
const fallback = themeMap(tokenBlocks, [':root']);

const failRows = [];
const unresolvedRows = [];

for (const theme of THEMES) {
  const map = themeMap(takeBlocks, theme.selectors);
  const page = resolveVar(tokenName('color-bg-base'), map, fallback);
  console.log(`\n== Theme: ${theme.name} ==`);
  console.log(
    ['Pair'.padEnd(38), 'fg'.padEnd(9), 'bg'.padEnd(9), 'Ratio'.padStart(6), 'Needed'.padEnd(7), 'Result'].join('  '),
  );
  for (const [label, fgKey, bgKey, need] of PAIRS) {
    const fgName = tokenName(fgKey);
    const bgName = tokenName(bgKey);
    const fgR = resolveVar(fgName, map, fallback);
    const bgR = resolveVar(bgName, map, fallback);
    const errs = [fgR, bgR].filter((r) => r.err).map((r) => r.err);
    if (errs.length) {
      unresolvedRows.push(`${theme.name}: ${label} (${fgName} on ${bgName}): ${errs.join('; ')}`);
      console.log([label.padEnd(38), '-'.padEnd(9), '-'.padEnd(9), 'n/a'.padStart(6), `${need}:1`.padEnd(7), 'UNRESOLVED'].join('  '));
      continue;
    }
    if (page.err) {
      unresolvedRows.push(`${theme.name}: page background ${tokenName('color-bg-base')}: ${page.err}`);
    }
    const bg = flatten(bgR, page.err ? { srgb: [1, 1, 1], a: 1 } : page);
    const fg = flatten(fgR, bg);
    const ratio = contrast(fg, bg);
    const pass = ratio >= need;
    const fgHex = toHex(fg);
    const bgHex = toHex(bg);
    console.log(
      [
        label.padEnd(38),
        fgHex.padEnd(9),
        bgHex.padEnd(9),
        ratio.toFixed(2).padStart(6),
        `${need}:1`.padEnd(7),
        pass ? 'PASS' : 'FAIL',
      ].join('  '),
    );
    if (!pass) failRows.push(`${theme.name}: ${label}: ${fgName} on ${bgName} = ${ratio.toFixed(2)}:1 (needs ${need}:1)`);
  }
}

console.log('\n== FAIL rows ==');
if (failRows.length === 0) console.log('none');
for (const r of failRows) console.log(`- ${r}`);

console.log('\n== Unresolved ==');
const unresolvedAll = [...STATIC_UNRESOLVED, ...unresolvedRows];
if (unresolvedAll.length === 0) console.log('none');
for (const r of unresolvedAll) console.log(`- ${r}`);

console.log(`\nSummary: ${failRows.length} FAIL, ${unresolvedRows.length} unresolved pair row(s). Exit 0 (report only).`);
process.exit(0);
