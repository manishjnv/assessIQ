// EXP-10 part 1: question image upload and metadata (routes in modules/04-question-bank/src/assets/routes.ts).
import { adminApi } from "../api.js";

export interface QuestionAssetMeta {
  id: string;
  pack_id: string;
  sha256: string;
  mime: "image/png" | "image/jpeg";
  byte_size: number;
  width: number;
  height: number;
  alt_text: string;
  created_at: string;
}

/** The same-origin url that serves the bytes to an admin session (an <img src>). */
export const questionAssetUrl = (id: string): string => `/api/admin/question-assets/${encodeURIComponent(id)}`;

function readFileAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onload = () => {
      const r = typeof reader.result === "string" ? reader.result : "";
      resolve(r.slice(r.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

export async function uploadQuestionAssetApi(packId: string, file: Blob, altText: string): Promise<QuestionAssetMeta & { deduped: boolean }> {
  const content_base64 = await readFileAsBase64(file);
  return adminApi<QuestionAssetMeta & { deduped: boolean }>("/admin/question-assets", {
    method: "POST",
    body: JSON.stringify({ pack_id: packId, alt_text: altText, content_base64 }),
  });
}

export async function getQuestionAssetMetaApi(id: string): Promise<QuestionAssetMeta> {
  return adminApi<QuestionAssetMeta>(`/admin/question-assets/${encodeURIComponent(id)}/meta`);
}
