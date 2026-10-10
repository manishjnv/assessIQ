/** HTML-escape & < > " ' . */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * CSV cell: formula-injection guard then RFC-4180 quoting. The guard fires on a
 * leading tab/CR, or on = + - @ after any leading whitespace (" =1+1" is caught).
 */
export function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (typeof v === "string" && /^(?:[\t\r]|[\s\u200B-\u200D\u2060\uFEFF]*[=+\-@])/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
