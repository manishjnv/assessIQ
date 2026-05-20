// Display formatters for admin surfaces.
// Per docs/10-branding-guideline.md §2.4: mid-dot separator (·), no seconds
// in list contexts, 24h time. Locale-aware month abbreviation, hour-cycle
// pinned to h23 so we don't get "13:05 PM" or "1:05 PM" inconsistencies
// across operator locales.

const DATE_FMT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

const TIME_FMT = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** "21 May 2026 · 23:17" — for list rows. */
export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${DATE_FMT.format(d)} · ${TIME_FMT.format(d)}`;
}

/** "21 May 2026" — for created-at / date-only contexts. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return DATE_FMT.format(d);
}
