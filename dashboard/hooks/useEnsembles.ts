'use client';

import { usePolling } from './usePolling';
import { POLL_INTERVALS } from '@/lib/constants';

export function useEnsembles() {
  return usePolling<{ ensembles: string[] }>(
    '/api/ensembles',
    POLL_INTERVALS.PLAYERS,
  );
}
