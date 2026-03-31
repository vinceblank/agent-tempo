'use client';

import { usePolling } from './usePolling';
import { POLL_INTERVALS } from '@/lib/constants';
import type { SessionMetadata } from '@/lib/tempo-types';

export function useMaestroMetadata(ensemble: string) {
  return usePolling<SessionMetadata | null>(
    `/api/ensemble/${encodeURIComponent(ensemble)}/maestro/metadata`,
    POLL_INTERVALS.PLAYERS,
  );
}
