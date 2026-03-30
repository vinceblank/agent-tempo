'use client';

import { usePolling } from './usePolling';
import { POLL_INTERVALS } from '@/lib/constants';
import type { HistoryEntry } from '@/lib/tempo-types';

export function useConductorHistory(ensemble: string) {
  return usePolling<HistoryEntry[]>(
    `/api/ensemble/${encodeURIComponent(ensemble)}/conductor`,
    POLL_INTERVALS.CONDUCTOR_HISTORY,
  );
}
