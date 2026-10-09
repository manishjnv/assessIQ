// Shared helpers/types for the platform page tab components (split from platform.tsx, E9).

import { type CSSProperties } from "react";

export type LifecycleAction = "suspend" | "resume" | "archive" | "unarchive";

export const META_LABEL: CSSProperties = {
  fontFamily: "var(--aiq-font-mono)",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "var(--aiq-color-fg-muted)",
};

export const ROW_PADDING = "16px 20px";

// ── Date formatter ────────────────────────────────────────────────────────────

export { formatDate } from "@assessiq/ui-system";

export type ModalState = "form" | "mfa";