'use client';

import { usePolling } from './usePolling';
import { POLL_INTERVALS } from '@/lib/constants';
import type { Message, SentMessage } from '@/lib/tempo-types';

export interface MaestroMessages {
  messages: Message[];
  sentMessages: SentMessage[];
}

export function useMaestroMessages(ensemble: string) {
  return usePolling<MaestroMessages>(
    `/api/ensemble/${encodeURIComponent(ensemble)}/maestro`,
    POLL_INTERVALS.PLAYER_DETAIL,
  );
}
