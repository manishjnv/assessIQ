import { useApi as baseUseApi } from '@assessiq/ui-system';
import type { UseApiOptions, UseApiResult } from '@assessiq/ui-system';

const API_BASE = import.meta.env.VITE_API_BASE ?? '/api';

/** Single import point for apps/web; defaults the base to VITE_API_BASE like `api`. */
export function useApi<T = unknown>(path: string | null, opts: UseApiOptions = {}): UseApiResult<T> {
  return baseUseApi<T>(path, { base: API_BASE, ...opts });
}
