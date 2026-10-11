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
 * leading tab/CR, or on = + - @ after any run of leading characters that are not
 * letters or digits. Letters and digits cannot start a formula, so every other
 * leading character is skipped. Harmless values like "(=1)" also get the prefix.
 */
export function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (typeof v === "string" && (/[\t\r]/.test(s) || /^[^\p{L}\p{N}]*[=+\-@]/u.test(s))) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
