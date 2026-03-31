'use client';

import { usePolling } from './usePolling';
import { POLL_INTERVALS } from '@/lib/constants';
import type { SessionMetadata, Message, SentMessage } from '@/lib/tempo-types';

export interface PlayerDetail {
  metadata: SessionMetadata;
  part: string;
  messages: Message[];
  sentMessages: SentMessage[];
}

export function usePlayerDetail(ensemble: string, playerId: string) {
  return usePolling<PlayerDetail>(
    `/api/ensemble/${encodeURIComponent(ensemble)}/player/${encodeURIComponent(playerId)}`,
    POLL_INTERVALS.PLAYER_DETAIL,
  );
}
