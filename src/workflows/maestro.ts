import {
  setHandler,
  condition,
  continueAsNew,
  workflowInfo,
  allHandlersFinished,
  proxyActivities,
  patched,
  uuid4,
} from '@temporalio/workflow';

/**
 * Workflow-deterministic clock — mirrors the helper in `src/workflows/session.ts`.
 *
 * The Temporal TS SDK intercepts `new Date()` at the sandbox level so it
 * returns replay-consistent time. `Date.now()`, however, is NOT intercepted
 * by default — calling it from workflow code reads the host clock and breaks
 * replay determinism. The architect's #318 review flagged the per-ensemble
 * maestro's idle-timeout check (`Date.now() - lastActiveSessionTime > IDLE_TIMEOUT_MS`)
 * as a pre-existing instance of this bug; this commit replaces every
 * `Date.now()` site in `claudeMaestroWorkflow` with `workflowNow().getTime()`
 * so the determinism guarantee holds end-to-end. See CLAUDE.md
 * ("no `Date.now()` in workflow code, use `workflow.now()` instead") and
 * `src/workflows/session.ts:21-23` for the convention.
 *
 * Naming matches the session-workflow helper so a grep for `workflowNow`
 * finds both implementations.
 */
function workflowNow(): Date {
  return new Date();
}

import type { MaestroActivities } from '../activities/maestro';

import {
  MaestroPlayerInfo,
  MaestroEvent,
  MaestroPendingCommand,
  MaestroInput,
  MaestroRelayMessage,
  GlobalMaestroInput,
  EnsembleChatMessage,
  ChatHighWater,
  ZERO_CHAT_HIGH_WATER,
  maestroShutdownSignal,
  maestroPlayersQuery,
  maestroEventsQuery,
  maestroPendingCommandsQuery,
  maestroEnsembleChatQuery,
  maestroSendCommandUpdate,
  maestroSetPausedSignal,
  maestroPausedQuery,
  // #399 W1 — Q5.1 description + Q5.3a uptime + Q5.6 tempo
  setEnsembleDescriptionSignal,
  getEnsembleDescriptionQuery,
  getEnsembleStartTimeQuery,
  getCurrentBpmQuery,
  getTempoSeriesQuery,
  // #318 coat-check
  coatCheckPutUpdate,
  coatCheckGetUpdate,
  coatCheckListQuery,
  coatCheckEvictUpdate,
  // Global Maestro signals/queries/updates
  maestroNotifyMessageSignal,
  maestroEnsemblesQuery,
  maestroPlayersByEnsembleQuery,
  maestroRecentMessagesQuery,
  maestroSendMessageUpdate,
  maestroFetchPlayerMessagesUpdate,
  maestroFetchConductorHistoryUpdate,
  maestroGlobalSendCommandUpdate,
  // #274 — host discovery
  hostProfileSignal,
  hostProfilesQuery,
  // #280 — combined existence + profiles query
  hostProfilesWithExistenceQuery,
} from './maestro-signals';
import { ApplicationFailure } from '@temporalio/workflow';
import type { HostProfile, CoatCheckEntry, CoatCheckEntryHeader } from '../types';
import {
  COAT_CHECK_CONTENT_MAX,
  COAT_CHECK_SUMMARY_MAX,
  COAT_CHECK_CONTENT_TYPE_MAX,
  COAT_CHECK_SLOTS_MAX,
  COAT_CHECK_TICKET_MAX,
  COAT_CHECK_TICKET_REGEX,
  COAT_CHECK_TTL_MIN_MS,
  COAT_CHECK_TTL_MAX_MS,
  COAT_CHECK_TTL_DEFAULT_MS,
} from '../utils/validation';

// ── Activity Proxies ──
// Only proxy activities actually used in the workflow.
// fetchConductorHistory is available in the activities but reserved for Phase 2 (TUI).

const { refreshEnsembleState, relayCommandToConductor, fetchEnsembleChat } =
  proxyActivities<Pick<MaestroActivities, 'refreshEnsembleState' | 'relayCommandToConductor' | 'fetchEnsembleChat'>>({
    startToCloseTimeout: '30 seconds',
    retry: { maximumAttempts: 3 },
  });

const DEFAULT_REFRESH_INTERVAL_MS = 5_000; // 5 seconds
const MAX_EVENTS = 200;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes with no running sessions

// #399 W1 (Q5.6 Flavor B) — tempo bucket sizing.
const TEMPO_BUCKET_MS = 30_000; // 30s windows
const TEMPO_HISTORY_MAX = 60;   // 60 buckets × 30s = 30-minute sparkline
// BPM is "messages per minute" — derived from the most recent window
// so the dashboard reads a stable number even between bucket rollovers.
const TEMPO_BPM_WINDOW_MS = 60_000;

// ══════════════════════════════════════════════════════════════════════════════
// Per-Ensemble Maestro (existing — unchanged)
// ══════════════════════════════════════════════════════════════════════════════

export async function claudeMaestroWorkflow(input: MaestroInput): Promise<void> {
  patched('v0.17-initial');

  const refreshIntervalMs = input.pollIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;

  let players: MaestroPlayerInfo[] = input.players ?? [];
  const events: MaestroEvent[] = input.events ?? [];
  const pendingCommands: MaestroPendingCommand[] = input.pendingCommands ?? [];
  let cachedChat: EnsembleChatMessage[] = input.cachedChat ?? [];
  let cachedChatMeta = input.cachedChatMeta ?? { hasConductor: false };
  let chatHighWater: ChatHighWater = input.chatHighWater ?? ZERO_CHAT_HIGH_WATER;
  let shutdownRequested = false;
  let commandQueued = false;
  let lastActiveSessionTime = workflowNow().getTime();
  let ensemblePaused = input.paused ?? false;

  // #399 W1 (Q5.1) — ensemble description, restored across CAN.
  let description: string = input.description ?? '';

  // #399 W1 (Q5.3a) — first-ever start time, frozen across CAN.
  // Use the input value if we're a continueAsNew successor; otherwise
  // adopt the current execution's startTime as the canonical first start.
  const startTimeIso: string =
    input.startTimeIso ?? workflowInfo().startTime.toISOString();

  // #399 W1 (Q5.6 Flavor B) — activity-bucket state machine.
  // `historyBuckets` is the sparkline (oldest first, max 60). The
  // `currentBucket` accumulates until 30 s elapse, then rolls.
  const tempoHistoryBuckets: number[] = input.tempoHistoryBuckets
    ? input.tempoHistoryBuckets.slice(-TEMPO_HISTORY_MAX)
    : [];
  let tempoCurrentBucket: { startMs: number; count: number } =
    input.tempoCurrentBucket ?? { startMs: workflowNow().getTime(), count: 0 };

  // ── Coat-check (#318, ADR 0008) ─────────────────────────────────────
  //
  // Per-ensemble ticket-keyed stash. Restored across CAN; mutated by the
  // four `coatCheck*` handlers below. Inline-sweep eviction runs at the
  // start of every handler entry so an idle ensemble doesn't need a
  // dedicated timer to GC expired entries (the 5s refresh tick below
  // also touches it opportunistically).
  //
  // `putByIndex` is a reverse index of `putBy → Set<ticket>` rebuilt from
  // the stored entries on CAN restore. It's cheap to maintain at admission
  // time and supports the future per-host quota (researcher's flagged v1
  // mitigation, intentionally not enforced in v1).
  const coatCheck: Record<string, CoatCheckEntry> = { ...(input.coatCheck ?? {}) };
  const putByIndex = new Map<string, Set<string>>();
  for (const [ticket, entry] of Object.entries(coatCheck)) {
    const bucket = putByIndex.get(entry.putBy) ?? new Set<string>();
    bucket.add(ticket);
    putByIndex.set(entry.putBy, bucket);
  }

  /**
   * Drop entries whose `expiresAt` is in the past. Pure, deterministic —
   * uses `workflowNow()`. Called at the head of every coat-check handler
   * and opportunistically inside the main 5s refresh tick so idle ensembles
   * still trim. Mutates `coatCheck` + `putByIndex` in place.
   */
  function sweepExpiredCoatCheck(): void {
    const nowMs = workflowNow().getTime();
    for (const [ticket, entry] of Object.entries(coatCheck)) {
      if (Date.parse(entry.expiresAt) <= nowMs) {
        delete coatCheck[ticket];
        const bucket = putByIndex.get(entry.putBy);
        if (bucket) {
          bucket.delete(ticket);
          if (bucket.size === 0) putByIndex.delete(entry.putBy);
        }
      }
    }
  }

  // ── Signal Handlers ──

  setHandler(maestroShutdownSignal, () => {
    shutdownRequested = true;
  });

  setHandler(maestroSetPausedSignal, (value: boolean) => {
    ensemblePaused = value;
  });

  // #399 W1 (Q5.1) — store the description as-supplied. Length is
  // enforced at the MCP tool boundary (`set_ensemble_description` Zod
  // schema clamps to ENSEMBLE_DESCRIPTION_MAX from utils/validation).
  setHandler(setEnsembleDescriptionSignal, (next: string) => {
    description = next;
  });

  // ── Query Handlers ──

  setHandler(maestroPlayersQuery, () => players);
  setHandler(maestroEventsQuery, () => events);
  setHandler(maestroPendingCommandsQuery, () => pendingCommands);
  setHandler(maestroPausedQuery, () => ensemblePaused);
  setHandler(maestroEnsembleChatQuery, ({ offset = 0, limit = 50 } = {}) => {
    const clampedLimit = Math.min(limit, 200);
    const total = cachedChat.length;
    const end = Math.max(0, total - offset);
    const start = Math.max(0, end - clampedLimit);
    return {
      messages: cachedChat.slice(start, end),
      total,
      hasMore: start > 0,
      hasConductor: cachedChatMeta.hasConductor,
    };
  });

  // #399 W1 (Q5.1 / Q5.3a / Q5.6) — new W1 query handlers.
  setHandler(getEnsembleDescriptionQuery, () => description);
  setHandler(getEnsembleStartTimeQuery, () => startTimeIso);
  setHandler(getCurrentBpmQuery, () => computeCurrentBpm(
    tempoHistoryBuckets,
    tempoCurrentBucket,
  ));
  setHandler(getTempoSeriesQuery, () => [...tempoHistoryBuckets]);

  // ── Update Handler ──

  setHandler(maestroSendCommandUpdate, (cmd) => {
    const entry: MaestroPendingCommand = {
      id: uuid4(),
      text: cmd.text,
      source: cmd.source,
      replyTo: cmd.replyTo,
      createdAt: new Date().toISOString(),
      status: 'pending',
    };
    pendingCommands.push(entry);
    commandQueued = true;
    return entry.id;
  }, {
    validator: (cmd) => {
      if (!cmd.text || cmd.text.trim().length === 0) {
        throw new Error('Command text must not be empty');
      }
    },
  });

  // ── Coat-check Handlers (#318, ADR 0008) ─────────────────────────────

  setHandler(coatCheckPutUpdate, (input) => {
    // Sweep first so a saturation rejection reflects fresh state — a
    // caller who fills the cap but waits past TTL of older entries should
    // succeed on retry.
    sweepExpiredCoatCheck();

    const ticket = uuid4();
    const nowDate = workflowNow();
    const ttlMs = input.ttlMs ?? COAT_CHECK_TTL_DEFAULT_MS;
    const expiresAtMs = nowDate.getTime() + ttlMs;
    const size = new TextEncoder().encode(input.content).length;
    const entry: CoatCheckEntry = {
      summary: input.summary,
      content: input.content,
      ...(input.contentType !== undefined ? { contentType: input.contentType } : {}),
      putBy: input.putBy,
      putAt: nowDate.toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      size,
      fetchCount: 0,
    };
    coatCheck[ticket] = entry;
    const bucket = putByIndex.get(input.putBy) ?? new Set<string>();
    bucket.add(ticket);
    putByIndex.set(input.putBy, bucket);

    const slotsUsed = Object.keys(coatCheck).length;
    return {
      ticket,
      expiresAt: entry.expiresAt,
      slotsUsed,
      slotsTotal: COAT_CHECK_SLOTS_MAX,
    };
  }, {
    validator: (input) => {
      if (typeof input.summary !== 'string' || input.summary.length === 0) {
        throw ApplicationFailure.nonRetryable(
          'coat-check summary must be a non-empty string',
          'CoatCheckInvalidSummary',
        );
      }
      if (input.summary.length > COAT_CHECK_SUMMARY_MAX) {
        throw ApplicationFailure.nonRetryable(
          `coat-check summary exceeds ${COAT_CHECK_SUMMARY_MAX} chars`,
          'CoatCheckSummaryTooLarge',
        );
      }
      if (typeof input.content !== 'string') {
        throw ApplicationFailure.nonRetryable(
          'coat-check content must be a string',
          'CoatCheckInvalidContent',
        );
      }
      // `TextEncoder` is replay-safe (pure string→bytes); `Buffer` is Node-
      // only and not available in the workflow sandbox. Same idiom as #334.
      if (new TextEncoder().encode(input.content).length > COAT_CHECK_CONTENT_MAX) {
        throw ApplicationFailure.nonRetryable(
          `coat-check content exceeds ${COAT_CHECK_CONTENT_MAX} bytes`,
          'CoatCheckEntryTooLarge',
        );
      }
      if (input.contentType !== undefined) {
        if (typeof input.contentType !== 'string' || input.contentType.length > COAT_CHECK_CONTENT_TYPE_MAX) {
          throw ApplicationFailure.nonRetryable(
            `coat-check contentType must be a string ≤ ${COAT_CHECK_CONTENT_TYPE_MAX} chars`,
            'CoatCheckInvalidContentType',
          );
        }
      }
      if (input.ttlMs !== undefined) {
        if (typeof input.ttlMs !== 'number' || !Number.isFinite(input.ttlMs)
          || input.ttlMs < COAT_CHECK_TTL_MIN_MS || input.ttlMs > COAT_CHECK_TTL_MAX_MS) {
          throw ApplicationFailure.nonRetryable(
            `coat-check ttlMs must be a number in [${COAT_CHECK_TTL_MIN_MS}, ${COAT_CHECK_TTL_MAX_MS}]`,
            'CoatCheckInvalidTtl',
          );
        }
      }
      if (typeof input.putBy !== 'string' || input.putBy.length === 0) {
        throw ApplicationFailure.nonRetryable(
          'coat-check putBy must be a non-empty string',
          'CoatCheckInvalidPutBy',
        );
      }
      // Saturation check runs LAST + on a post-sweep view so a caller who
      // hit saturation at T=0 but whose entries have since TTL-expired can
      // succeed on retry. Sweep is idempotent inside the validator scope —
      // it runs again in the handler body before admitting.
      const probe = { ...coatCheck };
      const nowMs = workflowNow().getTime();
      for (const [t, e] of Object.entries(probe)) {
        if (Date.parse(e.expiresAt) <= nowMs) delete probe[t];
      }
      if (Object.keys(probe).length >= COAT_CHECK_SLOTS_MAX) {
        const oldest = Object.entries(probe)
          .sort((a, b) => Date.parse(a[1].putAt) - Date.parse(b[1].putAt))
          .slice(0, 3)
          .map(([t, e]) => `${t} (putBy=${e.putBy}, putAt=${e.putAt})`)
          .join('; ');
        throw ApplicationFailure.nonRetryable(
          `coat-check slots full (${COAT_CHECK_SLOTS_MAX}). Evict one via \`coat_check_evict\` (owner-or-conductor) or wait for TTL. Oldest 3: ${oldest}`,
          'CoatCheckSlotsFull',
        );
      }
    },
  });

  setHandler(coatCheckGetUpdate, ({ ticket, fetchedBy }) => {
    sweepExpiredCoatCheck();
    const entry = coatCheck[ticket];
    if (!entry) return null;
    // Successful fetch — bump audit. The bump only fires on the happy path
    // so failed lookups don't pollute the counter.
    entry.lastFetchedAt = workflowNow().toISOString();
    entry.lastFetchedBy = fetchedBy;
    entry.fetchCount += 1;
    return entry;
  });

  setHandler(coatCheckListQuery, (input) => {
    // Queries cannot mutate state, but inline filtering against a post-
    // sweep VIEW gives consistent results — expired entries shouldn't
    // appear in the listing even if they haven't been physically swept.
    const nowMs = workflowNow().getTime();
    const headers: CoatCheckEntryHeader[] = [];
    for (const [ticket, entry] of Object.entries(coatCheck)) {
      if (Date.parse(entry.expiresAt) <= nowMs) continue;
      if (input?.putBy && entry.putBy !== input.putBy) continue;
      if (input?.prefix && !entry.summary.startsWith(input.prefix)) continue;
      if (input?.unfetchedOnly && entry.fetchCount > 0) continue;
      headers.push({
        ticket,
        summary: entry.summary,
        ...(entry.contentType !== undefined ? { contentType: entry.contentType } : {}),
        putBy: entry.putBy,
        putAt: entry.putAt,
        expiresAt: entry.expiresAt,
        size: entry.size,
        ...(entry.lastFetchedAt !== undefined ? { lastFetchedAt: entry.lastFetchedAt } : {}),
        ...(entry.lastFetchedBy !== undefined ? { lastFetchedBy: entry.lastFetchedBy } : {}),
        fetchCount: entry.fetchCount,
      });
    }
    // Newest-first so the operator sees recent activity at the top.
    headers.sort((a, b) => Date.parse(b.putAt) - Date.parse(a.putAt));
    return headers;
  });

  setHandler(coatCheckEvictUpdate, ({ ticket, evictedBy }) => {
    sweepExpiredCoatCheck();
    const entry = coatCheck[ticket];
    if (!entry) return { evicted: false };

    // Owner-or-conductor permission gate. `players` is the closure-captured
    // snapshot, refreshed every 5s by the main loop — good enough for an
    // identity check (conductor identity is stable across the ensemble's
    // lifetime). A non-owner / non-conductor evict throws structurally so
    // the caller's MCP tool surfaces it as a permission error.
    const isOwner = entry.putBy === evictedBy;
    const isConductor = players.some((p) => p.isConductor && p.playerId === evictedBy);
    if (!isOwner && !isConductor) {
      throw ApplicationFailure.nonRetryable(
        `coat-check evict denied: "${evictedBy}" is neither the owner ("${entry.putBy}") nor the ensemble conductor`,
        'CoatCheckEvictPermissionDenied',
      );
    }

    delete coatCheck[ticket];
    const bucket = putByIndex.get(entry.putBy);
    if (bucket) {
      bucket.delete(ticket);
      if (bucket.size === 0) putByIndex.delete(entry.putBy);
    }
    return { evicted: true };
  }, {
    validator: ({ ticket, evictedBy }) => {
      if (typeof ticket !== 'string' || ticket.length === 0 || ticket.length > COAT_CHECK_TICKET_MAX
        || !COAT_CHECK_TICKET_REGEX.test(ticket)) {
        throw ApplicationFailure.nonRetryable(
          `coat-check ticket must match ${COAT_CHECK_TICKET_REGEX} and be ≤ ${COAT_CHECK_TICKET_MAX} chars`,
          'CoatCheckInvalidTicket',
        );
      }
      if (typeof evictedBy !== 'string' || evictedBy.length === 0) {
        throw ApplicationFailure.nonRetryable(
          'coat-check evictedBy must be a non-empty string',
          'CoatCheckInvalidEvictedBy',
        );
      }
    },
  });

  // ── Main Loop ──

  while (!shutdownRequested) {
    // Wait for either the refresh interval or a queued command
    commandQueued = false;
    await condition(() => shutdownRequested || commandQueued, `${refreshIntervalMs} milliseconds`);

    if (shutdownRequested) break;

    // ── Refresh Ensemble State ──
    try {
      const newPlayers = await refreshEnsembleState(input.ensemble);
      const nowDate = workflowNow();
      const now = nowDate.toISOString();
      const nowMs = nowDate.getTime();

      // #399 W1 (Q5.6 Flavor B) — accumulate per-player activity deltas
      // into the current bucket BEFORE replacing `players`. We diff the
      // monotonic counter from each session's `getActivityState` query
      // (forwarded via `MaestroPlayerInfo.activityCount`); a positive
      // delta means the player emitted N messages since the last refresh.
      const oldActivity = new Map(
        players
          .filter((p) => p.activityCount !== undefined)
          .map((p) => [p.playerId, p.activityCount as number]),
      );
      let bucketDelta = 0;
      for (const np of newPlayers) {
        if (np.activityCount === undefined) continue;
        const prev = oldActivity.get(np.playerId);
        if (prev === undefined) {
          // First sighting — adopt the counter as the baseline; don't
          // back-fill the bucket with a "delta" against zero, otherwise
          // a long-running session that just joined would spike the
          // sparkline by its lifetime activity.
          continue;
        }
        const d = np.activityCount - prev;
        if (d > 0) bucketDelta += d;
      }
      if (bucketDelta > 0 || nowMs - tempoCurrentBucket.startMs >= TEMPO_BUCKET_MS) {
        tempoCurrentBucket = rollTempoBucket(
          tempoCurrentBucket,
          bucketDelta,
          tempoHistoryBuckets,
          nowMs,
        );
      }

      // Diff snapshots to generate events
      const oldMap = new Map(players.map((p) => [p.playerId, p]));
      const newMap = new Map(newPlayers.map((p) => [p.playerId, p]));

      // Player joined
      for (const [id, player] of newMap) {
        if (!oldMap.has(id)) {
          events.push({ type: 'player_joined', playerId: id, timestamp: now });
        } else {
          const old = oldMap.get(id)!;
          // `status_changed` events fire on attachment-phase transitions; the
          // event name is kept for dashboard stability (MaestroEvent wire shape).
          if (old.phase !== player.phase) {
            events.push({
              type: 'status_changed',
              playerId: id,
              timestamp: now,
              oldValue: old.phase,
              newValue: player.phase,
            });
          }
          // Part changed
          if (old.part !== player.part) {
            events.push({
              type: 'part_changed',
              playerId: id,
              timestamp: now,
              oldValue: old.part,
              newValue: player.part,
            });
          }
        }
      }

      // Player left
      for (const [id] of oldMap) {
        if (!newMap.has(id)) {
          events.push({ type: 'player_left', playerId: id, timestamp: now });
        }
      }

      const eventsExcess = events.length - MAX_EVENTS;
      if (eventsExcess > 0) events.splice(0, eventsExcess);

      players = newPlayers;

      // Track last time we saw running sessions — phases the ensemble can
      // meaningfully coordinate with (attached/processing/awaiting/booting).
      const COORDINATABLE_PHASES: readonly string[] = ['attached', 'processing', 'awaiting', 'booting'];
      const hasRunningSessions = players.some(
        (p) => p.phase !== undefined && COORDINATABLE_PHASES.includes(p.phase),
      );
      if (hasRunningSessions) {
        lastActiveSessionTime = workflowNow().getTime();
      }
    } catch {
      // Activity failure after retries — skip this cycle, try again next loop
    }

    // ── Refresh Ensemble Chat ──
    if (patched('v0.19-ensemble-chat')) {
      try {
        const chatResult = await fetchEnsembleChat({
          ensemble: input.ensemble,
          knownCounts: chatHighWater,
        });
        if (chatResult.success) {
          cachedChat.push(...chatResult.newMessages);
          const MAX_CACHED_CHAT = 500;
          const chatExcess = cachedChat.length - MAX_CACHED_CHAT;
          if (chatExcess > 0) cachedChat.splice(0, chatExcess);
          chatHighWater = chatResult.currentCounts;
          cachedChatMeta = { hasConductor: chatResult.hasConductor };
        }
      } catch {
        // Chat refresh failed — keep stale cache, retry next cycle
      }
    }

    // ── Dispatch Pending Commands ──
    const pending = pendingCommands.filter((c) => c.status === 'pending');
    for (const cmd of pending) {
      cmd.status = 'delivered'; // optimistic — revert on failure
      try {
        const result = await relayCommandToConductor({
          ensemble: input.ensemble,
          text: cmd.text,
          source: cmd.source,
          replyTo: cmd.replyTo,
        });
        if (!result.success) {
          cmd.status = 'failed';
          cmd.error = result.error;
        }
      } catch (err) {
        cmd.status = 'failed';
        cmd.error = String(err);
      }
    }

    // ── Coat-check opportunistic TTL sweep (#318) ──
    // Idle ensembles still trim expired entries even when no caller is
    // exercising the handlers. The sweep is also cheap (Object.entries scan)
    // and idempotent, so it's safe to call on every refresh tick.
    sweepExpiredCoatCheck();

    // ── Auto-terminate if idle ──
    // #318: was `Date.now() - lastActiveSessionTime` — non-deterministic on
    // replay. `workflowNow()` reads the SDK-intercepted clock; idle decision
    // is now replay-stable.
    if (workflowNow().getTime() - lastActiveSessionTime > IDLE_TIMEOUT_MS) {
      break;
    }

    // ── ContinueAsNew if suggested ──
    const info = workflowInfo();
    if (info.continueAsNewSuggested) {
      await condition(allHandlersFinished);
      // #318: only carry coat-check across CAN when non-empty. Matches the
      // `playerState` carry idiom in `src/workflows/session.ts:1617-1638`
      // — keeps the wire small for the common no-coat-check case.
      const carryCoatCheck = Object.keys(coatCheck).length > 0;
      await continueAsNew<typeof claudeMaestroWorkflow>({
        ensemble: input.ensemble,
        players,
        events,
        // Only carry pending commands; delivered/failed are historical
        pendingCommands: pendingCommands.filter((c) => c.status === 'pending'),
        pollIntervalMs: input.pollIntervalMs,
        cachedChat,
        cachedChatMeta,
        chatHighWater,
        paused: ensemblePaused,
        // #399 W1 — forward description, original start time, and tempo
        // state across CAN so dashboard signals stay continuous.
        description,
        startTimeIso,
        tempoHistoryBuckets,
        tempoCurrentBucket,
        // #318 — carry the coat-check map only when populated.
        ...(carryCoatCheck ? { coatCheck } : {}),
      });
    }
  }

  // Graceful shutdown — wait for in-flight handlers
  await condition(allHandlersFinished);
}

// ──────────────────────────────────────────────────────────────────────
// #399 W1 (Q5.6 Flavor B) — tempo bucket helpers.
//
// `rollTempoBucket` runs in workflow context and is therefore
// deterministic — `nowMs` is supplied by the caller via `Date.now()`
// during the (workflow-time) refresh tick, never sampled inside the
// helper. The current bucket finalises (gets pushed onto the history
// ring) once it covers a full `TEMPO_BUCKET_MS` window OR when the next
// refresh sees activity that should land in a fresh bucket — either way
// we never lose a window.
// ──────────────────────────────────────────────────────────────────────

function rollTempoBucket(
  current: { startMs: number; count: number },
  pendingDelta: number,
  history: number[],
  nowMs: number,
): { startMs: number; count: number } {
  const elapsed = nowMs - current.startMs;
  if (elapsed >= TEMPO_BUCKET_MS) {
    history.push(current.count);
    while (history.length > TEMPO_HISTORY_MAX) history.shift();
    return { startMs: nowMs, count: pendingDelta };
  }
  return { startMs: current.startMs, count: current.count + pendingDelta };
}

function computeCurrentBpm(
  history: number[],
  current: { startMs: number; count: number },
): number {
  // Sum activity in the last `TEMPO_BPM_WINDOW_MS` (1 minute):
  //   - the in-progress bucket always counts
  //   - prior history buckets count proportionally to how recent they are
  // We approximate by taking the last two finished buckets (60s of
  // history at 30s/bucket) plus the current. That over-counts slightly
  // when the current bucket is fresh — acceptable for a heads-up display.
  const tail = history.slice(-2);
  const sum = tail.reduce((a, b) => a + b, 0) + current.count;
  return sum;
}

// ══════════════════════════════════════════════════════════════════════════════
// Global Maestro — single instance handling ALL ensembles
// ══════════════════════════════════════════════════════════════════════════════

const GLOBAL_MAX_MESSAGES = 500;
const GLOBAL_MAX_EVENTS = 500;

const globalActivities = proxyActivities<
  Pick<MaestroActivities,
    | 'discoverEnsembles'
    | 'refreshEnsembleState'
    | 'relayCommandToConductor'
    | 'deliverMaestroMessage'
    | 'fetchPlayerMessages'
    | 'fetchConductorHistory'
  >
>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 3 },
});

export async function claudeGlobalMaestroWorkflow(input: GlobalMaestroInput): Promise<void> {
  patched('v0.18-global-maestro');

  const refreshIntervalMs = input.pollIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;

  let knownEnsembles: string[] = input.knownEnsembles ?? [];
  let playersByEnsemble: Record<string, MaestroPlayerInfo[]> = input.playersByEnsemble ?? {};
  const recentMessages: MaestroRelayMessage[] = input.recentMessages ?? [];
  const events: MaestroEvent[] = input.events ?? [];
  const pendingCommands: MaestroPendingCommand[] = input.pendingCommands ?? [];
  // #274 — host capability ledger. Plain `Record<hostname, HostProfile>`
  // so CAN serialization is the default-converter happy path (Maps require
  // a codec tweak). Lazy GC of stale hosts happens at the `listHosts` join
  // site; the workflow itself just stores forever (or until CAN).
  const hostProfiles: Record<string, HostProfile> = { ...(input.hostProfiles ?? {}) };
  let shutdownRequested = false;
  let actionQueued = false;

  // ── Signal Handlers ──

  setHandler(maestroShutdownSignal, () => {
    shutdownRequested = true;
  });

  setHandler(maestroNotifyMessageSignal, (msg) => {
    recentMessages.push(msg);
    const msgExcess = recentMessages.length - GLOBAL_MAX_MESSAGES;
    if (msgExcess > 0) recentMessages.splice(0, msgExcess);
  });

  /**
   * #274 — daemon boot signal carrying the host's capability profile.
   *
   * Validation policy per architect delta AC3c (M9): ONLY `hostname` is
   * validated here (required, ≤64 chars, alphanumeric + `_-`). All other
   * fields are stored opaquely — the per-field Zod guard lives at the
   * `listHosts` join site in `src/utils/hosts.ts`, never at this
   * handler. This keeps the workflow additive-compatible across daemon
   * versions: a newer daemon can signal new fields and older maestros
   * will still accept the payload; an older daemon's payload is accepted
   * by a newer maestro without special-casing.
   *
   * The hostname regex is inlined (rather than importing from
   * `src/utils/validation.ts`) to keep the workflow bundle's import
   * surface narrow — it's pure constants either way.
   */
  setHandler(hostProfileSignal, (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const hostname = (payload as { hostname?: unknown }).hostname;
    if (typeof hostname !== 'string') return;
    if (hostname.length === 0 || hostname.length > 64) return;
    if (!/^[a-zA-Z0-9_-]+$/.test(hostname)) return;
    // Cast is deliberate: `HostProfile` has an open `[extraField]: unknown`
    // index signature, so the spread is semantically safe. TypeScript can't
    // prove narrower optional fields from the spread alone.
    hostProfiles[hostname] = { ...payload, hostname } as HostProfile;
  });

  // ── Query Handlers ──

  setHandler(maestroEnsemblesQuery, () => knownEnsembles);
  setHandler(maestroPlayersByEnsembleQuery, () => ({ ...playersByEnsemble }));
  setHandler(maestroRecentMessagesQuery, () => recentMessages);
  setHandler(maestroEventsQuery, () => events);
  setHandler(maestroPendingCommandsQuery, () => pendingCommands);
  // Return a defensive copy so callers can't mutate workflow state.
  setHandler(hostProfilesQuery, () => ({ ...hostProfiles }));
  // #280 — combined query: reaching this handler proves the workflow is
  // running, so `exists` is always `true` here. Callers infer "missing"
  // by catching transport-level errors (workflow not found, etc.).
  setHandler(hostProfilesWithExistenceQuery, () => ({
    exists: true,
    profiles: { ...hostProfiles },
  }));

  // ── Update Handlers (can await activities) ──

  setHandler(maestroSendMessageUpdate, async (req) => {
    const msgId = uuid4();
    const result = await globalActivities.deliverMaestroMessage({
      ensemble: req.ensemble,
      to: req.to,
      text: req.text,
      source: req.source,
    });
    if (!result.success) {
      throw new Error(result.error ?? 'Failed to deliver message');
    }
    // Record in ring buffer
    const relayMsg: MaestroRelayMessage = {
      id: msgId,
      ensemble: req.ensemble,
      from: req.source,
      to: req.to,
      text: req.text,
      timestamp: new Date().toISOString(),
      direction: 'outbound',
    };
    recentMessages.push(relayMsg);
    const relayExcess = recentMessages.length - GLOBAL_MAX_MESSAGES;
    if (relayExcess > 0) recentMessages.splice(0, relayExcess);
    return msgId;
  }, {
    validator: (req) => {
      if (!req.ensemble || !req.ensemble.trim()) throw new Error('Ensemble must not be empty');
      if (!req.to || !req.to.trim()) throw new Error('Target player must not be empty');
      if (!req.text || !req.text.trim()) throw new Error('Message text must not be empty');
    },
  });

  setHandler(maestroFetchPlayerMessagesUpdate, async (req) => {
    const result = await globalActivities.fetchPlayerMessages({
      ensemble: req.ensemble,
      playerId: req.playerId,
    });
    if (!result.success) {
      throw new Error(result.error ?? 'Failed to fetch player messages');
    }
    return result.messages;
  }, {
    validator: (req) => {
      if (!req.ensemble || !req.ensemble.trim()) throw new Error('Ensemble must not be empty');
      if (!req.playerId || !req.playerId.trim()) throw new Error('Player ID must not be empty');
    },
  });

  setHandler(maestroFetchConductorHistoryUpdate, async (req) => {
    const result = await globalActivities.fetchConductorHistory({
      ensemble: req.ensemble,
    });
    return result;
  }, {
    validator: (req) => {
      if (!req.ensemble || !req.ensemble.trim()) throw new Error('Ensemble must not be empty');
    },
  });

  setHandler(maestroGlobalSendCommandUpdate, (cmd) => {
    const entry: MaestroPendingCommand = {
      id: uuid4(),
      text: cmd.text,
      source: cmd.source,
      replyTo: cmd.replyTo,
      createdAt: new Date().toISOString(),
      status: 'pending',
    };
    entry.ensemble = cmd.ensemble;
    pendingCommands.push(entry);
    actionQueued = true;
    return entry.id;
  }, {
    validator: (cmd) => {
      if (!cmd.ensemble || !cmd.ensemble.trim()) throw new Error('Ensemble must not be empty');
      if (!cmd.text || !cmd.text.trim()) throw new Error('Command text must not be empty');
    },
  });

  // ── Main Loop ──

  while (!shutdownRequested) {
    actionQueued = false;
    await condition(() => shutdownRequested || actionQueued, `${refreshIntervalMs} milliseconds`);

    if (shutdownRequested) break;

    // ── Discover ensembles ──
    try {
      knownEnsembles = await globalActivities.discoverEnsembles();
    } catch {
      // Discovery failed — use last known ensembles
    }

    // ── Refresh players per ensemble ──
    for (const ensemble of knownEnsembles) {
      try {
        const newPlayers = await globalActivities.refreshEnsembleState(ensemble);
        const oldPlayers = playersByEnsemble[ensemble] ?? [];
        const now = new Date().toISOString();

        // Diff snapshots to generate events
        const oldMap = new Map(oldPlayers.map((p) => [p.playerId, p]));
        const newMap = new Map(newPlayers.map((p) => [p.playerId, p]));

        for (const [id, player] of newMap) {
          if (!oldMap.has(id)) {
            events.push({ type: 'player_joined', playerId: id, timestamp: now });
          } else {
            const old = oldMap.get(id)!;
            // Diffs attachment-phase values (see per-ensemble Maestro comment).
            if (old.phase !== player.phase) {
              events.push({ type: 'status_changed', playerId: id, timestamp: now, oldValue: old.phase, newValue: player.phase });
            }
            if (old.part !== player.part) {
              events.push({ type: 'part_changed', playerId: id, timestamp: now, oldValue: old.part, newValue: player.part });
            }
          }
        }
        for (const [id] of oldMap) {
          if (!newMap.has(id)) {
            events.push({ type: 'player_left', playerId: id, timestamp: now });
          }
        }

        playersByEnsemble[ensemble] = newPlayers;
      } catch {
        // Activity failure — keep last known state for this ensemble
      }
    }

    // Remove stale ensembles (no longer discovered)
    for (const key of Object.keys(playersByEnsemble)) {
      if (!knownEnsembles.includes(key)) {
        delete playersByEnsemble[key];
      }
    }

    const globalEventsExcess = events.length - GLOBAL_MAX_EVENTS;
    if (globalEventsExcess > 0) events.splice(0, globalEventsExcess);

    // ── Dispatch Pending Commands ──
    const pending = pendingCommands.filter((c) => c.status === 'pending');
    for (const cmd of pending) {
      const ensemble = cmd.ensemble;
      if (!ensemble) {
        cmd.status = 'failed';
        cmd.error = 'Missing ensemble';
        continue;
      }
      cmd.status = 'delivered';
      try {
        const result = await globalActivities.relayCommandToConductor({
          ensemble,
          text: cmd.text,
          source: cmd.source,
          replyTo: cmd.replyTo,
        });
        if (!result.success) {
          cmd.status = 'failed';
          cmd.error = result.error;
        }
      } catch (err) {
        cmd.status = 'failed';
        cmd.error = String(err);
      }
    }

    // ── ContinueAsNew if suggested ──
    const info = workflowInfo();
    if (info.continueAsNewSuggested) {
      await condition(allHandlersFinished);
      await continueAsNew<typeof claudeGlobalMaestroWorkflow>({
        knownEnsembles,
        playersByEnsemble,
        recentMessages,
        events,
        pendingCommands: pendingCommands.filter((c) => c.status === 'pending'),
        pollIntervalMs: input.pollIntervalMs,
        // #274 — carry the capability ledger across the CAN boundary so
        // hosts that signaled their profile in a prior execution don't
        // disappear on the next one (they won't re-signal until the next
        // daemon boot).
        hostProfiles,
      });
    }
  }

  // Graceful shutdown
  await condition(allHandlersFinished);
}
