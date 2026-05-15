/**
 * SSE event projection — PR-4 of #340.
 *
 * The `applyEvent(prev, event)` reducer is the dashboard analog of
 * the TUI's `tuiReducer`. It takes the current `EnsembleStateV1`
 * snapshot held in TanStack Query cache and produces the next state
 * for each `TempoEvent` kind. **Architect's risk #3 (PR-4 specific)**:
 * if `applyEvent` mishandles `player.added` with `isConductor: true`,
 * the dashboard repeats #358's mistake. The companion test
 * (`dashboard/tests/sse.test.ts`) walks every entry in
 * `SSE_EVENT_KINDS` and verifies the projection — comprehensive
 * coverage is mandatory.
 *
 * The {@link useSseSubscription} hook drives `applyEvent` from a live
 * `client.subscribe(ensemble)` AsyncIterable, calling
 * `queryClient.setQueryData(['ensemble', ensemble], ...)` on each
 * event so consumers re-render via TanStack Query cache invalidation.
 */
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type {
  EnsembleStateV1,
  TempoEvent,
  PlayerSummaryV1,
} from 'agent-tempo/http/event-types';
import type { EnsembleChatMessage } from 'agent-tempo/types';
import { logEvent } from './log';
import { ensembleQueryKey } from './queries';
import type { DashboardTempoClient } from './client';
import { getDashboardClient } from './client-singleton';

/**
 * Maximum chat messages held in the dashboard cache. The wire ships at
 * most 50 per snapshot (`SNAPSHOT_CHAT_LIMIT`); we accumulate a bit more
 * across events. PR-5+ might lift this for a virtualised chat panel.
 */
export const DASHBOARD_CHAT_LIMIT = 200;

/**
 * Apply a single `TempoEvent` to the previous snapshot. Returns the
 * same reference when the event has no projectable effect (heartbeat,
 * unknown kinds) so TanStack Query's structural-sharing skips a
 * re-render.
 *
 * **Don't add a `default` branch** — the `switch` is exhaustively
 * checked against `TempoEvent['type']` (see the `_exhaustive` line at
 * the bottom). Adding a new kind to `SSE_EVENT_KINDS` will break the
 * `tsc` build here, forcing a deliberate decision about how the
 * dashboard projects it.
 */
export function applyEvent(
  prev: EnsembleStateV1 | undefined,
  event: TempoEvent,
): EnsembleStateV1 | undefined {
  // Snapshot prelude reseeds the cache wholesale. Always wins, even when
  // we already had a value (a `gap` triggers a re-fetch + re-subscribe,
  // and the daemon-side replay opens with a fresh snapshot).
  if (event.type === 'snapshot') {
    return event.payload;
  }
  if (!prev) return prev; // No baseline yet — let the snapshot land first.

  switch (event.type) {
    case 'heartbeat':
    case 'throttled':
      // Connection-health events; no projection effect.
      return prev;

    case 'gap':
      // Caller should re-fetch `/v1/state/:ensemble` (handled in the hook
      // via `queryClient.invalidateQueries`). The cache stays as-is until
      // the new snapshot arrives — better stale than mis-projected.
      return prev;

    case 'ensemble.created':
      // Per `/v1/events/:ensemble` semantics, this would only fire for the
      // ensemble we're already subscribed to. No state change beyond
      // `hasConductor` which the snapshot already reflects.
      return prev;

    case 'ensemble.destroyed':
      // The ensemble itself is gone. Mirror by zeroing players + flagging
      // offline. UI then routes back to overview.
      return {
        ...prev,
        state: 'offline',
        hasConductor: false,
        players: [],
        chat: { messages: [], total: 0, hasMore: false },
      };

    case 'player.added': {
      const next: PlayerSummaryV1 = event.payload;
      // De-dupe defensively — a snapshot replay + a missed-then-replayed
      // event could double-add. Keying by `playerId`.
      const without = prev.players.filter((p) => p.playerId !== next.playerId);
      return {
        ...prev,
        players: [...without, next],
        hasConductor: prev.hasConductor || next.isConductor,
      };
    }

    case 'player.removed': {
      const { playerId } = event.payload;
      const removed = prev.players.find((p) => p.playerId === playerId);
      const players = prev.players.filter((p) => p.playerId !== playerId);
      // hasConductor must reflect whether ANY remaining player is the
      // conductor — not "was-removed-the-conductor". Guards against the
      // mismatched-state bug class #358 surfaced.
      const hasConductor = players.some((p) => p.isConductor);
      return {
        ...prev,
        players,
        hasConductor,
        // Mark visible if the removal was the conductor — UX banner
        // surfaces "conductor left" cleanly without an extra signal.
        ...(removed?.isConductor ? { state: prev.state } : {}),
      };
    }

    case 'player.phase_changed': {
      const { playerId, phase, lastHeartbeatAt, processingSince } = event.payload;
      const players = prev.players.map((p) => {
        if (p.playerId !== playerId) return p;
        return {
          ...p,
          phase,
          ...(lastHeartbeatAt !== undefined ? { lastHeartbeatAt } : {}),
          ...(processingSince !== undefined ? { processingSince } : {}),
        };
      });
      return { ...prev, players };
    }

    case 'chat.appended': {
      const msg: EnsembleChatMessage = event.payload;
      // Reconcile with any in-flight optimistic entry from
      // `useCueMutation` (PR-7b). Optimistic ids are prefixed
      // `optimistic-` (see `lib/mutations.ts#OPTIMISTIC_ID_PREFIX`);
      // when an SSE-arrived message matches one by `from` / `to` /
      // `text`, drop the optimistic so the chat doesn't render
      // duplicate rows. The first match wins — a user firing
      // identical cues twice will leave one optimistic in place
      // until the next SSE event lands, which is correct behaviour
      // (each canonical message replaces exactly one pending cue).
      const existing = prev.chat.messages;
      let withoutOptimistic: EnsembleChatMessage[] = existing;
      if (msg.role === 'maestro-out') {
        const optIdx = existing.findIndex(
          (m) =>
            m.id.startsWith('optimistic-') &&
            m.from === msg.from &&
            m.to === msg.to &&
            m.text === msg.text,
        );
        if (optIdx !== -1) {
          withoutOptimistic = [
            ...existing.slice(0, optIdx),
            ...existing.slice(optIdx + 1),
          ];
        }
      }

      const messages = [...withoutOptimistic, msg];
      // Drop oldest entries past the dashboard cap. The wire's `total`
      // tracks the maestro hub's count, not our window — just bump it.
      const trimmed = messages.length > DASHBOARD_CHAT_LIMIT
        ? messages.slice(messages.length - DASHBOARD_CHAT_LIMIT)
        : messages;
      // `total`: bump only if the SSE entry is genuinely new. When we
      // dropped a matching optimistic, the canonical message is a
      // replacement — net total stays the same as before the SSE
      // event (the optimistic had already incremented `total` in
      // `useCueMutation.onMutate`).
      const totalDelta = withoutOptimistic === existing ? 1 : 0;
      return {
        ...prev,
        chat: {
          messages: trimmed,
          total: prev.chat.total + totalDelta,
          hasMore: prev.chat.hasMore || trimmed.length < messages.length,
        },
      };
    }

    case 'chat.compressed': {
      // Soft gap on the chat slice only (§7.6). Drop our local window
      // and surface `hasMore: true` so the UI can offer a "load older"
      // affordance backed by `getEnsembleChat`.
      const { dropped } = event.payload;
      return {
        ...prev,
        chat: {
          messages: [],
          total: Math.max(0, prev.chat.total - dropped),
          hasMore: true,
        },
      };
    }

    case 'flags.changed': {
      const { paused, held } = event.payload;
      return {
        ...prev,
        flags: { paused, held },
        state: paused ? 'paused' : prev.state === 'paused' ? 'online' : prev.state,
      };
    }

    case 'schedules.changed': {
      return { ...prev, schedules: event.payload.schedules };
    }

    case 'host_profile.changed': {
      const profile = event.payload;
      return {
        ...prev,
        hostProfiles: { ...prev.hostProfiles, [profile.hostname]: profile },
      };
    }
  }

  // Exhaustiveness sentinel — adding a new SseEventKind without a case
  // here will fail the build with "Type 'SseEventKind' is not assignable
  // to type 'never'".
  const _exhaustive: never = event;
  return _exhaustive;
}

// ── React hook ───────────────────────────────────────────────────────────

export interface UseSseSubscriptionOptions {
  /** Override the client (tests). */
  client?: DashboardTempoClient;
  /** Disable the subscription — useful when no ensemble is selected. */
  enabled?: boolean;
}

/**
 * Subscribe to `/v1/events/:ensemble` and apply each event to the
 * TanStack Query cache for `['ensemble', ensemble]`. The hook owns the
 * `AbortController` and cancels on unmount or ensemble change.
 *
 * Resilience: on `gap`, the hook calls `invalidateQueries` so the
 * next render re-fetches the snapshot. The new snapshot's `lastEventId`
 * becomes the resume cursor for the daemon's transparent reconnect.
 */
export function useSseSubscription(
  ensemble: string | null,
  opts: UseSseSubscriptionOptions = {},
): void {
  const qc = useQueryClient();

  useEffect(() => {
    if (!ensemble || opts.enabled === false) return;
    const client = opts.client ?? getDashboardClient();
    const ctrl = new AbortController();
    const queryKey = ensembleQueryKey(ensemble);

    let cancelled = false;
    logEvent('sse.connected', { ensemble });

    (async () => {
      try {
        for await (const event of client.subscribe(ensemble, { signal: ctrl.signal })) {
          if (cancelled) break;
          if (event.type === 'gap') {
            logEvent('sse.gap', { ensemble, lastEventId: event.eventId });
            qc.invalidateQueries({ queryKey });
            continue;
          }
          qc.setQueryData<EnsembleStateV1>(queryKey, (prev) => applyEvent(prev, event));
          if (event.type === 'snapshot') {
            const snap = event.payload;
            logEvent('snapshot.applied', {
              ensemble,
              playerCount: snap.players.length,
              hasConductor: snap.hasConductor,
            });
          }
        }
        logEvent('sse.disconnected', { ensemble, reason: 'stream-end' });
      } catch (err) {
        if (!cancelled) {
          logEvent('sse.disconnected', {
            ensemble,
            reason: err instanceof Error ? err.message : String(err),
          }, 'warn');
        }
      }
    })();

    return () => {
      cancelled = true;
      ctrl.abort('unmount');
    };
  }, [ensemble, opts.client, opts.enabled, qc]);
}
