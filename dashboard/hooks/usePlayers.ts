'use client';

import { usePolling } from './usePolling';
import { POLL_INTERVALS } from '@/lib/constants';
import type { SessionMetadata } from '@/lib/tempo-types';

export interface PlayerEntry {
  metadata: SessionMetadata;
  part: string;
}

export function usePlayers(ensemble: string) {
  return usePolling<PlayerEntry[]>(
    `/api/ensemble/${encodeURIComponent(ensemble)}/players`,
    POLL_INTERVALS.PLAYERS,
  );
}
