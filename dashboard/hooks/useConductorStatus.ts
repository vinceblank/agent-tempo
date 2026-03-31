'use client';

import { usePolling } from './usePolling';
import { POLL_INTERVALS } from '@/lib/constants';

export function useConductorStatus(ensemble: string) {
  return usePolling<{ active: boolean; conductorId: string | null }>(
    `/api/ensemble/${encodeURIComponent(ensemble)}/conductor/status`,
    POLL_INTERVALS.PLAYERS,
  );
}
