// Z-32: build-time prerender of the /try document head. Pure function (no imports) so
// vite.config.ts can load it; it must live under src/ (the Docker build context copies src/).
export const TRY_URL = 'https://assessiq.in/try';
export const TRY_TITLE = 'Try a sample assessment | AssessIQ';
export const TRY_DESCRIPTION =
  'Take a short sample assessment and see how AssessIQ scores answers on evidence. No sign-up, nothing is stored.';
export const TRY_OG_IMAGE = 'https://assessiq.in/brand/social/try-og.png';

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/** Rewrite the shared SPA index.html head into the /try head. Throws if the template drifted. */
export function renderTryHtml(indexHtml: string): string {
  const swap = (html: string, re: RegExp, to: string): string => {
    if (!re.test(html)) throw new Error(`tryHead: template no longer matches ${String(re)}`);
    return html.replace(re, to);
  };
  let h = indexHtml;
  h = swap(h, /<title>[^<]*<\/title>/, `<title>${esc(TRY_TITLE)}</title>`);
  h = swap(
    h,
    /<meta name="description" content="[^"]*" \/>/,
    `<meta name="description" content="${esc(TRY_DESCRIPTION)}" />\n    <link rel="canonical" href="${TRY_URL}" />\n    <meta property="og:url" content="${TRY_URL}" />`,
  );
  h = swap(h, /<meta property="og:title" content="[^"]*" \/>/, `<meta property="og:title" content="${esc(TRY_TITLE)}" />`);
  h = swap(h, /<meta property="og:description" content="[^"]*" \/>/, `<meta property="og:description" content="${esc(TRY_DESCRIPTION)}" />`);
  h = swap(h, /(<meta property="og:image" content=")[^"]*(" \/>)/, `$1${TRY_OG_IMAGE}$2`);
  h = swap(h, /(<meta name="twitter:image" content=")[^"]*(" \/>)/, `$1${TRY_OG_IMAGE}$2`);
  return h;
}

/** Build-time gate: throws unless the html has the /try title, canonical, description and og tags. */
export function assertTryHead(html: string): void {
  const need = [
    `<title>${TRY_TITLE}</title>`,
    `<link rel="canonical" href="${TRY_URL}" />`,
    `<meta property="og:title" content="${TRY_TITLE}" />`,
    `<meta property="og:url" content="${TRY_URL}" />`,
    `<meta property="og:image" content="${TRY_OG_IMAGE}" />`,
    `name="description" content="${TRY_DESCRIPTION}"`,
  ];
  for (const n of need) if (!html.includes(n)) throw new Error(`/try head check failed, missing: ${n}`);
  if (TRY_DESCRIPTION.length < 50 || TRY_DESCRIPTION.length > 160) throw new Error('/try description length not 50-160');
}
