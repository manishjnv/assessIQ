/**
 * useEmbedMode
 *
 * Returns true when the current URL contains `?embed=true`, indicating the
 * candidate UI is rendering inside a host-app iframe via the embed flow.
 *
 * The hook reads once at mount time (no reactive subscription needed —
 * the embed flag is static for the lifetime of the attempt).
 */
import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

export function useEmbedMode(): boolean {
  const [searchParams] = useSearchParams();
  return useMemo(() => searchParams.get('embed') === 'true', [searchParams]);
}
