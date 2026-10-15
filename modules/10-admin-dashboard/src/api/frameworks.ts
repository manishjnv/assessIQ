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
