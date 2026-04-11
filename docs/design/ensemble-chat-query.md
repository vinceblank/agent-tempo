# Design: `maestroEnsembleChat` — Aggregated Ensemble Chat Feed

**Author**: tempo-architect  
**Date**: 2026-04-09  
**Status**: Ready for implementation  
**Branch**: `feat/58-tui-redesign`  
**Related**: #58 TUI redesign, maestro default chat UX

---

## Problem

The TUI's default ensemble view needs to show the **conductor's full inbound/outbound traffic** with all players, merged with maestro's own messages, as a single chronological stream. Without this, the TUI would need multiple round-trips per poll cycle and client-side merging — wasteful and fragile.

## Solution

A new **query** (`maestroEnsembleChat`) on the per-ensemble Maestro workflow that serves paginated, deduplicated, chronologically sorted chat from a **pre-built cache**. The cache is refreshed every ~10s in the Maestro's existing refresh loop via a new `fetchEnsembleChat` activity that returns **deltas only** (incremental append).

## Temporal Best Practice Alignment

| Concern | Risk | Mitigation |
|---|---|---|
| **Payload size** (max 2MB) | Conductor messages up to 100KB each | Truncate text to 500 chars in activity |
| **History growth** (aim <10MB) | Activity result stored every refresh cycle | Delta returns: ~100 bytes in steady state, only new messages on change |
| **continueAsNew state** (max 2MB) | Cached chat carried across continueAsNew | Cap at 500 entries x ~350 bytes = ~175KB |
| **Query determinism** | Must be read-only, non-blocking | Handler only slices a cached array |
| **Versioning** | New activity call changes command sequence | `patched('v0.19-ensemble-chat')` guard |
| **Adding query handler** | Must not break replay | Additive — safe, no patch needed |

---

## 1. Type Definitions (`src/types.ts`)

```typescript
/** A single message in the aggregated ensemble chat feed. */
export interface EnsembleChatMessage {
  id: string;
  from: string;
  to: string;
  /** Truncated to 500 chars max. Full text available via getPlayerMessages. */
  text: string;
  timestamp: string;
  /**
   * Message perspective:
   * - 'maestro-out': maestro (you) sent to a player
   * - 'maestro-in': a player sent to maestro (you)
   * - 'conductor-out': conductor sent to a non-maestro player
   * - 'conductor-in': a non-maestro player sent to conductor
   */
  role: 'maestro-out' | 'maestro-in' | 'conductor-out' | 'conductor-in';
}

/** Input for the maestroEnsembleChat query. */
export interface EnsembleChatQuery {
  /** Messages to skip from the tail (default 0). */
  offset?: number;
  /** Max messages to return (default 50, max 200). */
  limit?: number;
}

/** Result from the maestroEnsembleChat query. */
export interface EnsembleChatResult {
  messages: EnsembleChatMessage[];
  /** Total message count in cache. */
  total: number;
  /** True if messages exist beyond offset+limit. */
  hasMore: boolean;
  /** Whether a conductor was found during last refresh. */
  hasConductor: boolean;
}
```

Extend `MaestroInput` to carry cache across continueAsNew:

```typescript
export interface MaestroInput {
  ensemble: string;
  players?: MaestroPlayerInfo[];
  events?: MaestroEvent[];
  pendingCommands?: MaestroPendingCommand[];
  pollIntervalMs?: number;
  /** Restored from continue-as-new (ring buffer, max 500). */
  cachedChat?: EnsembleChatMessage[];
  /** Metadata about last chat refresh. */
  cachedChatMeta?: { hasConductor: boolean };
  /** High-water marks for incremental chat fetch. */
  chatHighWater?: ChatHighWater;
}

export interface ChatHighWater {
  maestroRecv: number;
  maestroSent: number;
  conductorRecv: number;
  conductorSent: number;
}
```

---

## 2. Wire Protocol Addition (`docs/WIRE-PROTOCOL.md`)

New query on the **per-ensemble Maestro** (additive, non-breaking):

| Query Name | Input | Return | Description |
|---|---|---|---|
| `maestroEnsembleChat` | `EnsembleChatQuery` | `EnsembleChatResult` | Paginated aggregated chat feed from cached state. Merges maestro session + conductor traffic, deduplicated. Cache refreshed every ~10s alongside player snapshot. |

---

## 3. Query Definition (`src/workflows/maestro-signals.ts`)

```typescript
import type { EnsembleChatResult, EnsembleChatQuery } from '../types';

/** Paginated ensemble chat from cached state (maestro + conductor traffic). */
export const maestroEnsembleChatQuery = defineQuery<
  EnsembleChatResult,
  [EnsembleChatQuery]
>('maestroEnsembleChat');
```

---

## 4. Activity (`src/activities/maestro.ts`)

### Interface

```typescript
export interface FetchEnsembleChatInput {
  ensemble: string;
  /** Known message counts to enable delta returns. */
  knownCounts?: ChatHighWater;
}

export interface FetchEnsembleChatResult {
  success: boolean;
  /** Only NEW messages since the known counts. */
  newMessages: EnsembleChatMessage[];
  /** Updated counts for next call. */
  currentCounts: ChatHighWater;
  hasConductor: boolean;
  error?: string;
}
```

Add to `MaestroActivities` interface:
```typescript
fetchEnsembleChat(input: FetchEnsembleChatInput): Promise<FetchEnsembleChatResult>;
```

### Implementation Logic

1. **Find conductor** via `scanEnsembleSessions` (already called in refresh loop — can pass as param to avoid double-scan)
2. **Find maestro session** via `sessionWorkflowId(ensemble, 'maestro')`
3. **Fetch in parallel** (`Promise.allSettled`):
   - Maestro's `allMessages` + `allSentMessages`
   - Conductor's `allMessages` + `allSentMessages` (if conductor exists)
4. **Normalize** each message to `EnsembleChatMessage` with role:
   - Maestro received -> `maestro-in` (from = msg.from, to = 'maestro')
   - Maestro sent -> `maestro-out` (from = 'maestro', to = msg.to)
   - Conductor received from non-maestro -> `conductor-in`
   - Conductor sent to non-maestro -> `conductor-out`
   - **Skip** conductor<->maestro messages (already covered by maestro's side)
5. **Text truncation**: `text.length > 500 ? text.slice(0, 499) + '...' : text`
6. **Delta filter**: Compare list lengths against `knownCounts`, return only entries beyond high-water marks
7. **Sort** new messages by timestamp ascending
8. **Return** `{ newMessages, currentCounts, hasConductor }`

---

## 5. Workflow Changes (`src/workflows/maestro.ts`)

### New State

```typescript
let cachedChat: EnsembleChatMessage[] = input.cachedChat ?? [];
let cachedChatMeta = input.cachedChatMeta ?? { hasConductor: false };
let chatHighWater: ChatHighWater = input.chatHighWater ?? {
  maestroRecv: 0, maestroSent: 0, conductorRecv: 0, conductorSent: 0,
};
```

### Query Handler (additive — no patch needed)

```typescript
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
```

### Main Loop Addition (patched)

```typescript
// Inside the main loop, AFTER refreshEnsembleState succeeds:
if (patched('v0.19-ensemble-chat')) {
  try {
    const chatResult = await fetchEnsembleChat({
      ensemble: input.ensemble,
      knownCounts: chatHighWater,
    });
    if (chatResult.success) {
      cachedChat.push(...chatResult.newMessages);
      const MAX_CACHED_CHAT = 500;
      while (cachedChat.length > MAX_CACHED_CHAT) {
        cachedChat.shift();
      }
      chatHighWater = chatResult.currentCounts;
      cachedChatMeta = { hasConductor: chatResult.hasConductor };
    }
  } catch {
    // Chat refresh failed — keep stale cache, retry next cycle
  }
}
```

### Activity Proxy

Add `fetchEnsembleChat` to the proxyActivities Pick type:

```typescript
const { refreshEnsembleState, relayCommandToConductor, fetchEnsembleChat } =
  proxyActivities<Pick<MaestroActivities,
    'refreshEnsembleState' | 'relayCommandToConductor' | 'fetchEnsembleChat'
  >>({
    startToCloseTimeout: '30 seconds',
    retry: { maximumAttempts: 3 },
  });
```

### continueAsNew

```typescript
await continueAsNew<typeof claudeMaestroWorkflow>({
  ensemble: input.ensemble,
  players,
  events,
  pendingCommands: pendingCommands.filter((c) => c.status === 'pending'),
  pollIntervalMs: input.pollIntervalMs,
  cachedChat,        // NEW
  cachedChatMeta,    // NEW
  chatHighWater,     // NEW
});
```

---

## 6. TempoClient Addition (`src/tui/client.ts`)

```typescript
// Add to TempoClient interface:
getEnsembleChat(ensemble: string, offset?: number, limit?: number): Promise<EnsembleChatResult>;

// Implementation:
async getEnsembleChat(
  ensemble: string,
  offset?: number,
  limit?: number,
): Promise<EnsembleChatResult> {
  try {
    const h = handle(maestroWorkflowId(ensemble));
    return await h.query('maestroEnsembleChat', { offset, limit });
  } catch {
    return { messages: [], total: 0, hasMore: false, hasConductor: false };
  }
}
```

---

## 7. TUI Changes (App.tsx + ConversationStream)

### Polling (App.tsx)

Replace `getMaestroMessages` call in the ensemble-view polling path with:

```typescript
const chatResult = await tempoClient.getEnsembleChat(activeEnsemble, 0, 50);
dispatch({ type: 'SET_ENSEMBLE_CHAT', chat: chatResult });
```

### Submit Handler — `@player` Routing (App.tsx)

When user types bare text in ensemble view:

1. **No `@` prefix** -> routes to conductor via `sendCommand()` (existing)
2. **`@player message`** -> routes to that player via `sendAsMaestro(ensemble, player, message)`
3. **No conductor + no `@` prefix** -> show error: "No conductor. Use @player to message directly, or /recruit a conductor."

Parse with: `/^@(\S+)\s+(.+)$/s`

### ConversationStream Rendering

Map `EnsembleChatMessage` -> `ConversationMessage`:

| Role | direction | Rendering |
|---|---|---|
| `maestro-out` | `'out'` | `[music note] @player: text` (outbound highlight) |
| `maestro-in` | `'in'` | `<- player  HH:MM` + body (standard inbound) |
| `conductor-out` | `'in'` | `<- conductor -> player  HH:MM` + body (dimmed) |
| `conductor-in` | `'in'` | `<- player -> conductor  HH:MM` + body (dimmed) |

The `conductor-*` messages use existing layout with a dimmed color variant. Add a `thirdParty?: boolean` flag to `ConversationMessage` to trigger the dim treatment.

### No-Conductor Prompt

When `hasConductor === false`, show above conversation area:

```
  ! No conductor in this ensemble
  Type /recruit to start one, or send messages directly with @player
```

Disappears when `hasConductor` becomes true on next poll.

---

## 8. Size Budget

| State component | Per entry | Max entries | Total |
|---|---|---|---|
| `players` | ~300B | ~50 | ~15KB |
| `events` | ~100B | 200 | ~20KB |
| `pendingCommands` | ~200B | ~20 | ~4KB |
| **`cachedChat`** | ~350B | 500 | ~175KB |
| `cachedChatMeta` | ~20B | 1 | ~20B |
| `chatHighWater` | ~50B | 1 | ~50B |

**Total continueAsNew payload: ~214KB** (well within 2MB limit)

**History per cycle (steady state)**: ~100 bytes (empty delta). Heavy traffic: proportional to new messages only.

---

## 9. File Changes Summary

| File | Change |
|---|---|
| `src/types.ts` | Add `EnsembleChatMessage`, `EnsembleChatQuery`, `EnsembleChatResult`, `ChatHighWater`; extend `MaestroInput` |
| `src/workflows/maestro-signals.ts` | Add `maestroEnsembleChatQuery` |
| `src/workflows/maestro.ts` | Add query handler, patched refresh, carry cache in continueAsNew |
| `src/activities/maestro.ts` | Add `fetchEnsembleChat` activity |
| `src/tui/client.ts` | Add `getEnsembleChat()` |
| `src/tui/App.tsx` | Replace poll call, add `@player` routing in submit |
| `src/tui/store.ts` | Add `SET_ENSEMBLE_CHAT` action + state |
| `src/tui/components/ConversationStream.tsx` | Add `role`/`thirdParty` rendering |
| `docs/WIRE-PROTOCOL.md` | Document `maestroEnsembleChat` query |

## 10. What This Does NOT Change

- Existing queries (`maestroPlayers`, `maestroEvents`, `maestroRecentMessages`)
- Existing updates (`maestroFetchPlayerMessages`, `maestroFetchConductorHistory`)
- Outbox pattern
- Global Maestro workflow
- Wire protocol stability (purely additive)
