// EXP-10 part 1: one question image. The bytes come from a same-origin route that checks who may read them;
// this component only draws an <img> with the stored alt text and size. If the image cannot load (blocked cookie
// in an embed, network, removed file), the alt text is shown in a box with a short note, so the question stays usable.
import React, { useState } from "react";

export interface QuestionImageProps {
  src: string;
  /** Required. Alt text stored with the image. */
  alt: string;
  width?: number | undefined;
  height?: number | undefined;
  /** Stem images open full size in a new tab. Option images are not links (they sit inside the option's label). */
  linked?: boolean | undefined;
  /** Cap the drawn height in pixels (option images). */
  maxHeight?: number | undefined;
  /** Help id of the link; the candidate page keeps the default. */
  helpId?: string | undefined;
}

export function QuestionImage({ src, alt, width, height, linked = true, maxHeight, helpId = "candidate.take.image" }: QuestionImageProps): React.ReactElement {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span
        data-testid="question-image-fallback"
        style={{
          display: "block", padding: "var(--aiq-space-sm, 8px)", border: "1px dashed var(--aiq-color-border, #ccc)",
          borderRadius: 6, fontSize: "var(--aiq-text-sm, 13px)", color: "var(--aiq-color-fg-secondary, #444)",
        }}
      >
        {alt} <em>(Image did not load.)</em>
      </span>
    );
  }
  const img = (
    <img
      src={src}
      alt={alt}
      {...(width !== undefined ? { width } : {})}
      {...(height !== undefined ? { height } : {})}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      style={{
        display: "block", maxWidth: "100%", height: "auto", ...(maxHeight !== undefined ? { maxHeight } : {}),
        objectFit: "contain", background: "#fff", border: "1px solid var(--aiq-color-border, #ddd)", borderRadius: 6,
      }}
    />
  );
  if (!linked) return img;
  return (
    <a href={src} target="_blank" rel="noopener noreferrer" aria-label={`Open image in a new tab: ${alt}`} data-help-id={helpId} style={{ display: "inline-block", maxWidth: "100%" }}>
      {img}
    </a>
  );
}
