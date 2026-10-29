// EXP-10 part 1: one question image in an admin screen. Fetches the metadata (alt text, size) first, then draws the
// image from the admin route. No metadata means no alt text, so nothing is drawn.
import React, { useEffect, useState } from "react";
import { QuestionImage } from "@assessiq/ui-system";
import { getQuestionAssetMetaApi, questionAssetUrl, type QuestionAssetMeta } from "../api/question-assets.js";

export function AdminAssetImage({ id, maxHeight, linked = true }: { id: string; maxHeight?: number; linked?: boolean }): React.ReactElement | null {
  const [meta, setMeta] = useState<QuestionAssetMeta | null>(null);
  useEffect(() => {
    let live = true;
    getQuestionAssetMetaApi(id).then((m) => { if (live) setMeta(m); }).catch(() => { if (live) setMeta(null); });
    return () => { live = false; };
  }, [id]);
  if (meta === null) return null;
  return (
    <QuestionImage
      src={questionAssetUrl(id)}
      alt={meta.alt_text}
      width={meta.width}
      height={meta.height}
      linked={linked}
      helpId="admin.question_editor.image"
      {...(maxHeight !== undefined ? { maxHeight } : {})}
    />
  );
}
