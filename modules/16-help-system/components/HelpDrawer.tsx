/**
 * HelpDrawer — right-side panel that renders sanitized markdown for a help_id.
 *
 * Mounted ONCE per page (typically inside <HelpProvider>). When drawerOpenKey
 * is null the component returns null — no DOM at all when closed.
 *
 * Markdown rendering uses the unified/remark-parse/remark-rehype/rehype-sanitize
 * /rehype-react pipeline. dangerouslySetInnerHTML is explicitly NOT used.
 */

import React, {
  useEffect,
  useRef,
  useState,
  Fragment,
  type CSSProperties,
} from "react";
import { jsx, jsxs } from "react/jsx-runtime";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeReact from "rehype-react";
import { Icon } from "@assessiq/ui-system";
import { useHelpContext } from "./HelpContext.js";

// ---------------------------------------------------------------------------
// The stable unified processor — created once outside the component so the
// heavy plugin chain is not re-instantiated on every render.
// ---------------------------------------------------------------------------
const mdProcessor = unified()
  .use(remarkParse)
  .use(remarkRehype)
  .use(rehypeSanitize, defaultSchema)
  .use(rehypeReact, {
    // Required by rehype-react v8 / hast-util-to-jsx-runtime
    jsx,
    jsxs,
    Fragment,
    elementAttributeNameCase: "react" as const,
    stylePropertyNameCase: "dom" as const,
  });

// ---------------------------------------------------------------------------
// Shared id used by HelpDrawerTrigger's aria-controls and this element's id.
// ---------------------------------------------------------------------------
export const HELP_DRAWER_ID = "aiq-help-drawer";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
export interface HelpDrawerProps {
  width?: number; // default 480 (px)
  testId?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export function HelpDrawer({ width = 480, testId }: HelpDrawerProps) {
  const ctx = useHelpContext();
  const { drawerOpenKey, closeDrawer, recordFeedback, entries } = ctx;

  // Slide-in animation state. We defer the transform so the CSS transition
  // fires: null → closed, false → entering (translateX(100%)), true → open.
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track whether feedback has been given for the current open session.
  const [feedbackGiven, setFeedbackGiven] = useState(false);

  // Render the markdown once when drawerOpenKey changes.
  const [renderedContent, setRenderedContent] = useState<React.ReactNode>(null);

  // Reset feedback state whenever a new key is opened.
  useEffect(() => {
    if (drawerOpenKey !== null) {
      setFeedbackGiven(false);
    }
  }, [drawerOpenKey]);

  // Slide-in: set visible=true one tick after the panel mounts so the CSS
  // transition from translateX(100%) → translateX(0) fires.
  useEffect(() => {
    if (drawerOpenKey !== null) {
      // Mount at translateX(100%) then flip to 0 on next tick.
      setVisible(false);
      timerRef.current = setTimeout(() => setVisible(true), 16);
    } else {
      setVisible(false);
    }
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, [drawerOpenKey]);

  // Render markdown from the entry whenever the key changes.
  useEffect(() => {
    if (drawerOpenKey === null) {
      setRenderedContent(null);
      return;
    }
    const entry = entries.get(drawerOpenKey);
    const md = entry?.longMd ?? entry?.shortText ?? "";
    if (!md) {
      setRenderedContent(null);
      return;
    }
    // .processSync returns a VFile; the JSX element is at .result
    const file = mdProcessor.processSync(md);
    setRenderedContent(file.result as React.ReactNode);
  }, [drawerOpenKey, entries]);

  // Esc key closes the drawer.
  useEffect(() => {
    if (drawerOpenKey === null) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        closeDrawer();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [drawerOpenKey, closeDrawer]);

  // Nothing in the DOM when closed.
  if (drawerOpenKey === null) return null;

  const entry = entries.get(drawerOpenKey);

  // ---------------------------------------------------------------------------
  // Inline styles — token-driven, no external CSS file needed.
  // The slide-in animation uses CSS transition on transform.
  // prefers-reduced-motion is handled globally by tokens.css; no JS check.
  // ---------------------------------------------------------------------------
  const panelStyle: CSSProperties = {
    position: "fixed",
    top: 0,
    right: 0,
    width: `${width}px`,
    height: "100vh",
    background: "var(--aiq-color-bg-elevated)",
    color: "var(--aiq-color-text)",
    // TODO(token): --aiq-z-drawer
    zIndex: 1100,
    boxShadow: "-4px 0 24px var(--aiq-shadow-lg, rgba(0,0,0,0.18))",
    display: "flex",
    flexDirection: "column",
    transform: visible ? "translateX(0)" : "translateX(100%)",
    transition: "transform 220ms cubic-bezier(0.4, 0, 0.2, 1)",
  };

  const headerStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "var(--aiq-space-md, 12px) var(--aiq-space-lg, 20px)",
    borderBottom: "1px solid var(--aiq-color-border, rgba(0,0,0,0.1))",
    flexShrink: 0,
  };

  const keyLabelStyle: CSSProperties = {
    fontFamily: "var(--aiq-font-mono, monospace)",
    fontSize: "var(--aiq-font-size-sm, 12px)",
    color: "var(--aiq-color-text-muted, currentColor)",
    opacity: 0.7,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  };

  const closeButtonStyle: CSSProperties = {
    background: "none",
    border: "none",
    cursor: "pointer",
    color: "var(--aiq-color-text, currentColor)",
    padding: "var(--aiq-space-xs, 4px)",
    display: "flex",
    alignItems: "center",
    borderRadius: "var(--aiq-radius-sm, 4px)",
    flexShrink: 0,
    lineHeight: 0,
  };

  const bodyStyle: CSSProperties = {
    flex: 1,
    overflowY: "auto",
    padding: "var(--aiq-space-lg, 20px)",
  };

  const footerStyle: CSSProperties = {
    borderTop: "1px solid var(--aiq-color-border, rgba(0,0,0,0.1))",
    padding: "var(--aiq-space-md, 12px) var(--aiq-space-lg, 20px)",
    display: "flex",
    alignItems: "center",
    gap: "var(--aiq-space-sm, 8px)",
    flexShrink: 0,
    fontSize: "var(--aiq-font-size-sm, 13px)",
  };

  const feedbackButtonStyle: CSSProperties = {
    background: "none",
    border: "1px solid var(--aiq-color-border, rgba(0,0,0,0.15))",
    borderRadius: "var(--aiq-radius-sm, 4px)",
    cursor: "pointer",
    padding: "2px 8px",
    fontSize: "16px",
    lineHeight: 1.4,
    color: "var(--aiq-color-text, currentColor)",
  };

  function handleFeedback(thumbsUp: boolean) {
    if (drawerOpenKey !== null) {
      recordFeedback(drawerOpenKey, thumbsUp);
      setFeedbackGiven(true);
    }
  }

  return (
    <div
      id={HELP_DRAWER_ID}
      role="dialog"
      aria-modal="false"
      aria-label={`Help: ${drawerOpenKey}`}
      style={panelStyle}
      data-test-id={testId ?? "help-drawer"}
    >
      {/* Header */}
      <div style={headerStyle}>
        <span style={keyLabelStyle} title={drawerOpenKey}>
          {drawerOpenKey}
        </span>
        <button
          type="button"
          style={closeButtonStyle}
          onClick={closeDrawer}
          aria-label="Close help"
        >
          <Icon name="close" size={18} />
        </button>
      </div>

      {/* Body — scrollable markdown area */}
      <div style={bodyStyle}>
        {ctx.loading && (
          <p style={{ color: "var(--aiq-color-text-muted, currentColor)", opacity: 0.6 }}>
            Loading…
          </p>
        )}
        {ctx.error !== null && (
          <p style={{ color: "var(--aiq-color-error, #c00)" }}>
            Failed to load help content.
          </p>
        )}
        {!ctx.loading && ctx.error === null && entry === undefined && (
          <p style={{ color: "var(--aiq-color-text-muted, currentColor)", opacity: 0.6 }}>
            No help content available for{" "}
            <code style={{ fontFamily: "var(--aiq-font-mono, monospace)" }}>
              {drawerOpenKey}
            </code>
            .
          </p>
        )}
        {renderedContent}
        {/*
         * Phase 1 note: anchor-scrolling (scroll body to a heading matching
         * drawerOpenKey) is deferred to Phase 2. The rehype-slug plugin would
         * need to be added to the processor chain, and the heading id lookup
         * requires a ref on the body element plus a post-render scroll call.
         * Skipped here to keep the unified pipeline strictly the minimum safe
         * set for Phase 1.
         */}
      </div>

      {/* Footer — feedback */}
      <div style={footerStyle}>
        {feedbackGiven ? (
          <span style={{ color: "var(--aiq-color-text-muted, currentColor)" }}>
            Thanks!
          </span>
        ) : (
          <>
            <span>Was this helpful?</span>
            <button
              type="button"
              style={feedbackButtonStyle}
              onClick={() => handleFeedback(true)}
              aria-label="Helpful"
            >
              👍
            </button>
            <button
              type="button"
              style={feedbackButtonStyle}
              onClick={() => handleFeedback(false)}
              aria-label="Not helpful"
            >
              👎
            </button>
          </>
        )}
      </div>
    </div>
  );
}

HelpDrawer.displayName = "HelpDrawer";
