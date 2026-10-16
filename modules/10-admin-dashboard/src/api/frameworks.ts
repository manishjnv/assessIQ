// RW-57 part 2: curriculum framework seed helpers (super admin). Kept out of src/api.ts.
import { adminApi } from "../api.js";

export interface FrameworkSeedItem {
  code: string;
  name: string;
  board: string;
  version: string;
  nodeCount: number;
  /** null = not loaded yet */
  loadedVersion: string | null;
}

export interface FrameworkSeedLoadResult {
  frameworks: number;
  nodesCreated: number;
  nodesUpdated: number;
  nodesUnchanged: number;
}

export async function listFrameworkSeedsApi(): Promise<{ items: FrameworkSeedItem[] }> {
  return adminApi<{ items: FrameworkSeedItem[] }>("/admin/super/frameworks/seeds");
}

export async function loadFrameworkSeedApi(code: string): Promise<FrameworkSeedLoadResult> {
  return adminApi<FrameworkSeedLoadResult>(`/admin/super/frameworks/seeds/${encodeURIComponent(code)}/load`, {
    method: "POST",
  });
}

// RW-61: framework tree picker + question taxonomy helpers.
export interface FrameworkItem {
  id: string;
  slug: string;
  name: string;
  source: string;
  status: string;
  tenant_id: string | null;
}

export type FrameworkNodeKind = "board" | "stage" | "grade" | "subject" | "unit" | "outcome" | "criterion";

export interface FrameworkNode {
  id: string;
  parent_id: string | null;
  kind: FrameworkNodeKind;
  code: string | null;
  label: string;
  position: number;
  status: string;
}

export async function listFrameworksApi(): Promise<{ items: FrameworkItem[] }> {
  return adminApi<{ items: FrameworkItem[] }>("/admin/frameworks");
}

export async function listFrameworkNodesApi(id: string): Promise<{ items: FrameworkNode[] }> {
  return adminApi<{ items: FrameworkNode[] }>(`/admin/frameworks/${encodeURIComponent(id)}/nodes`);
}

export async function getQuestionTaxonomyApi(
  questionId: string,
): Promise<{ node_ids: string[]; nodes: Pick<FrameworkNode, "id" | "parent_id" | "kind" | "code" | "label">[] }> {
  return adminApi(`/admin/questions/${encodeURIComponent(questionId)}/taxonomy`);
}

export async function putQuestionTaxonomyApi(questionId: string, nodeIds: string[]): Promise<{ node_ids: string[] }> {
  return adminApi<{ node_ids: string[] }>(`/admin/questions/${encodeURIComponent(questionId)}/taxonomy`, {
    method: "PUT",
    body: JSON.stringify({ node_ids: nodeIds }),
  });
}

/** With nodeId: only links under that node or a descendant. */
export async function getPackTaxonomyApi(packId: string, nodeId?: string): Promise<{ items: { question_id: string; node_id: string }[] }> {
  return adminApi(`/admin/packs/${encodeURIComponent(packId)}/taxonomy${nodeId ? `?node_id=${encodeURIComponent(nodeId)}` : ""}`);
}
