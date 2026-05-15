# Player-saveable state primitive

> **Status**: Design proposal (spike — no implementation in this branch)
> **Author**: tempo-architect
> **Branch**: `design/334-player-saveable-state`
> **Tracking**: issue #334 (approved for autonomous pickup; supersedes closed #32 `context_reset`)
> **Audience**: implementing engineer (when scheduled), conductor for review.

---

## 0. TL;DR

Add a per-player saveable-state slot on each session workflow. The player itself writes a curated artifact (`save_state`); peers read it (`fetch_state`); the owner can wipe slots (`clear_state`). `restart` gains a `loadFromState` flag that seeds the new session with the saved artifact in place of (or alongside) the existing transcript replay.

This single primitive subsumes #32 (`context_reset`) and unlocks several adjacent use cases (shutdown handoff, mid-session bookmark, debugging snapshot, cross-restart continuity) without inflating tool surface.

**Locked decisions**:

| Question | Decision |
|---|---|
| Multi-key slots in v1? | **Yes**, default key `'main'`, max **4 slots** per player |
| Restart interaction with transcript replay? | `loadFromState` **suppresses** transcript replay by default; opt-in stacking via `transcript: 'replay'` |
| Storage shape — string or structured? | **Opaque string** with markdown-template docstring nudge |
| Authoring discipline — enforced schema or neutral? | **Docstring nudge** only; no typed schema |
| `fetch_state` permissions? | **Read-by-any-ensemble-peer**; write/clear self-only (structural — no `playerId` arg) |
| Slot-cap behaviour at 4-slot saturation? | **Refuse + structured error**; no LRU eviction. Reinforces authorial discipline. |

**Storage placement**: per-session workflow state, carried across `continueAsNew`. Distinct scope from coat-check (#318 / ADR 0008), which is per-ensemble maestro state.

**Sizing**: **32 KiB per key, 4 keys, 128 KiB aggregate structural max**. Tighter than #334's `~1 MiB aggregate` sketch — verified against the existing session p99 footprint (§3) so the addition doesn't push the session toward Temporal's 4 MiB CAN-payload ceiling.

**Wire surface**: 1 update (`savePlayerState`), 1 update (`clearPlayerState`), 1 query (`playerState`), 1 query (`playerStateKeys`); restart's `restartUpdate` gains optional `loadFromState` + `transcript` fields. **Strictly additive** — old payloads omit the new fields and behave exactly as today.

**MCP surface**: 3 tools — `save_state`, `fetch_state`, `clear_state` (per #334's tool sketch).

**Estimated implementation cost**: ~450 LoC total (matches #334's own estimate). Single PR, additive, no breaking changes.

---

## 1. Why now

Issue #334 motivates the primitive on five use cases, all already painful with today's surface:

1. **Voluntary context refresh** — a player feels heavy, calls `save_state(my_compacted_summary)`, calls `restart({ loadFromState: true })`. Fresh process, curated context. Today's `restart` always replays the last 10 messages — works, but lossy under context pressure when the player itself knows what to keep. (#32's original use case.)
2. **Shutdown handoff** — daemon shutdown signal triggers `save_state(...)` on every player. Restart later picks up where they left off. Better than current "lose everything on shutdown."
3. **Mid-session bookmark** — checkpoint before risky operation; restart from the bookmark if needed.
4. **Debugging snapshot** — operator inspects what a player thinks the world is. `fetch_state(...)` returns it without disrupting the session.
5. **Cross-restart continuity** — saved state survives processes; lives on the workflow.

These are common enough that the absence of the primitive accumulates ad-hoc workarounds (long part strings, hand-summarised cues, manual doc PRs). The primitive composes with `restart` (via `loadFromState`) and is independent of #318 (coat-check) and #319 (protobuf migration) — implementable as a single additive PR per #334's own sequencing note.

Phase A research (`docs/research/334-player-saveable-state-alternatives.md`, PR #337) validated the design space, surveyed prior art (Anthropic harness-design blog, Aider, Cursor, OpenAI Assistants), audited existing-codebase footprint, and produced directional leans on the five open questions. This document locks decisions; the research doc records the evidence.

---

## 2. Catalog of existing partial coverage

Three existing primitives partially overlap with player-saveable state. The new primitive fills the remaining hole.

| Existing primitive | What it does | What it doesn't do |
|---|---|---|
| `setPart` / `getPart` | Player-writable, ensemble-visible 500-byte status string | Too small for context-handoff content; ensemble-public by intent |
| `restart`'s transcript replay | Automatic last-N message dump on revival | No authorial control over what's preserved; lossy under context pressure |
| `recruit`'s `initialMessage` | New session starts with arbitrary text | One-shot at recruit time; not durable; not composable with restart |

The new primitive is the durable, player-controlled, multi-purpose generalisation of "initial message for the next session" — and it doesn't require the player to also `restart` (the bookmark / debugging cases never restart).

---

## 3. Storage decision matrix

### 3.1 Storage candidates

| Backend | State survives | Determinism | Cross-host | Lifecycle binding | Verdict |
|---|---|---|---|---|---|
| **Per-session workflow state** | Across CAN; lost on workflow termination | ✅ (string content + `workflow.now()`) | N/A — bound to the session's workflow, not the host | Lives + dies with the player | **Selected** |
| Per-ensemble maestro state (coat-check style) | Across CAN | ✅ | N/A | Lives + dies with the ensemble | Rejected — wrong scope (intra-player, not inter-player) |
| Filesystem `~/.agent-tempo/playerstate/` | Across processes; host-bound | ❌ workflow-context FS reads non-deterministic | ❌ host-bound | Manual cleanup | Rejected — non-deterministic; loses CAN survival framing |
| External blob (S3 / sqlite) | Unbounded | ❌ | ✅ | Operator-managed | Rejected for v1 — adds deployment dep, activity round-trip per save |

**Verdict**: per-session workflow state. Same storage placement reasoning as the existing `messages` / `outbox` / `part` fields — those are also intra-player, durable, replay-safe, CAN-carried.

### 3.2 The CAN-payload constraint

Temporal imposes three independent payload constraints; the design must respect all three.

| Constraint | Default | What it bounds |
|---|---|---|
| Per-payload size | **4 MiB** | One serialized `Payload` (signal arg, update arg, query result, **CAN input**) |
| Per-workflow event history | 50 MB total | Sum of all events serialized into the workflow's history |
| Workflow memory | Node heap | In-memory state during execution |

The **CAN-input constraint is the load-bearing one** for `playerState` sizing — same lesson coat-check (#318 / ADR 0008) learned the hard way on PR #327. When `continueAsNew` fires, the session serialises its accumulated state into a single `SessionInput` payload bounded by 4 MiB.

Researcher's audit (Phase A §2) measured the existing per-session p99 footprint against `src/workflows/session.ts:1617-1638`:

| Bucket | p99 size |
|---|---|
| Metadata (`part`, `input.metadata`, conductor histories) | 10–80 KiB |
| `messages` (undelivered after CAN) | 50–500 KiB |
| `sentMessages` (last 50 after CAN) | 5–50 KiB |
| `outbox` (pending + processing after CAN) | 50–100 KiB |
| Phase / attachment / processing lifecycle | <2 KiB |
| **Aggregate p99 today** | **~650 KiB – 1.2 MiB** (~17–30 % of 4 MiB ceiling) |

Adding `playerState` competes with these buckets for the remaining headroom. The design must cap `playerState` aggregate at a level that can't push the session over 4 MiB even at p99 worst case.

### 3.3 Selected sizing — tighter than #334's sketch

| Parameter | Locked value | Rationale |
|---|---|---|
| Per-key content size | **32 KiB** max | Covers a ~5K-word markdown summary (canonical "context-refresh handoff" use case) with comfortable headroom for code blocks. Mirrors coat-check's per-entry cap for consistency. |
| Per-player slot count | **4** | Issue #334's explicit examples (`'main'`, `'workInProgress'`, `'safetyCheckpoint'`, plus debugging) fit in 4. More invites sprawl. |
| Aggregate (per-player) | **128 KiB** structural max (4 × 32 KiB) | Bounded by the slot cap × per-key cap. Adding 128 KiB to a 1.2 MiB p99 session = ~1.33 MiB (~33 % of 4 MiB ceiling). Headroom under all three Temporal constraints stays comfortable. |
| Saturation behaviour | **Refuse + structured error** | At 4-slot saturation, `save_state` rejects with `PlayerStateSlotsFull`; LLM must call `clear_state` to free a slot. Reinforces authorial discipline (Anthropic harness-design blog rationale: explicit eviction beats silent LRU). |

**Why aggregate cap = structural max, not a separate ceiling**: with 4 × 32 KiB = 128 KiB structural max, a redundant "1 MiB aggregate" cap (per #334's sketch) is dead — the slot/per-key caps bind first. Issue #334's 1 MiB sketch was set defensively against an open slot count; locking slot count at 4 makes the aggregate cap structural.

**Why 4 slots, not unlimited**: the `'main'` / bookmark / safety / debugging set captures the issue's stated use cases. Multi-key is preserved as a v2-extension hook — operators who need named taxonomies can later request a slot-cap raise if usage data justifies it. **Refuse + error is the right v1 behaviour** — see §3.4.

**Why per-key 32 KiB, not 64 KiB**: 32 KiB is the consistent "small structured artifact" sizing across the codebase (cf. coat-check's per-entry cap). The Anthropic harness-design pattern explicitly favours small, curated artifacts over large dumps. 64 KiB invites unstructured paste-everything content, which is the failure mode the primitive is trying to avoid.

### 3.4 Saturation: refuse + error vs LRU eviction

When a player calls `save_state` with a new key while 4 slots are already populated, two options exist:

| Option | Behaviour | Trade-off |
|---|---|---|
| **Refuse + structured error (selected)** | `savePlayerStateUpdate` rejects with `PlayerStateSlotsFull` enumerating current slot names | LLM is forced into explicit `clear_state` before retry. Authorial discipline preserved. |
| LRU evict | Silent eviction of the least-recently-saved slot | Convenience win; loses authorial intent ("I want THIS slot to persist") |

Anthropic harness-design blog: *"Tools that nudge agents toward explicit choices outperform silent ones in long-running sessions."* The same logic applies here. **Locked: refuse + structured error.**

Audit signal: telemetry can log `PlayerStateSlotsFull` rejection rate; if >10 % of `save_state` calls hit it, the v2 lever is to raise the slot cap (NOT switch to LRU — that bias should remain).

---

## 4. Wire-protocol additions

All additions are strictly additive on the existing `claudeSessionWorkflow` surface. No renames, no removals, no breaking changes.

### 4.1 New workflow updates (player-only writes)

```ts
// src/workflows/signals.ts — added after the v0.25 attachment lifecycle block

/**
 * Save curated state for the calling player into a named slot.
 *
 * Validation:
 *  - `key` matches PLAYER_STATE_KEY_REGEX (alphanumeric + underscore + hyphen, 1–32 chars).
 *  - `content` byte length ≤ PLAYER_STATE_CONTENT_MAX (32 * 1024 bytes).
 *  - When the key does not yet exist and slots already at PLAYER_STATE_SLOTS_MAX (4),
 *    rejects with `PlayerStateSlotsFull` and lists existing keys.
 *
 * On success, writes `{ content, savedAt: workflowNow().toISOString(), savedBy }`
 * to `playerState[key]`. Carried via continueAsNew.
 */
export const savePlayerStateUpdate = defineUpdate<
  { saved: true; savedAt: string },
  [{ key: string; content: string; savedBy: string }]
>('savePlayerState');

/**
 * Clear the named slot. `cleared: true` if the slot existed; `false` if no-op.
 * Validation: key matches PLAYER_STATE_KEY_REGEX.
 */
export const clearPlayerStateUpdate = defineUpdate<
  { cleared: boolean },
  [{ key: string }]
>('clearPlayerState');
```

### 4.2 New workflow queries (any-peer read)

```ts
// src/workflows/signals.ts — added near the existing query block

/**
 * Read the named slot. Returns `null` if the slot is empty.
 * `key` defaults to PLAYER_STATE_DEFAULT_KEY ('main').
 */
export const playerStateQuery = defineQuery<
  { content: string; savedAt: string; savedBy: string } | null,
  [{ key?: string }]
>('playerState');

/** List names of populated slots. Returns `[]` when no slots are saved. */
export const playerStateKeysQuery = defineQuery<string[]>('playerStateKeys');
```

### 4.3 `SessionInput` extension

```ts
// src/types.ts — additive optional field on SessionInput

export interface SessionInput {
  // ... existing fields ...
  /** Restored from continue-as-new. Empty/undefined when no state has been saved. */
  playerState?: Record<string, { content: string; savedAt: string; savedBy: string }>;
}
```

### 4.4 `restart` extension — `loadFromState` flag

The existing `restart` MCP tool (and the underlying `RestartOutboxEntry`) gain two additive fields:

```ts
// src/types.ts — additive on RestartOutboxEntry
export interface RestartOutboxEntry extends OutboxEntryBase {
  type: 'restart';
  // ... existing fields ...

  /**
   * If set, the new session is seeded with the saved state instead of (or alongside)
   * the existing transcript replay. `true` resolves to PLAYER_STATE_DEFAULT_KEY ('main').
   * A string names a specific slot. Absent = current behaviour (transcript replay only).
   */
  loadFromState?: boolean | string;

  /**
   * Controls transcript-replay interaction when `loadFromState` is set.
   *  - 'suppress' (default when `loadFromState` set): only the saved state seeds the new session.
   *  - 'replay': both saved state and transcript are seeded (saved state delivered first).
   *  - When `loadFromState` is absent: ignored — transcript replay always happens.
   */
  transcript?: 'suppress' | 'replay';
}
```

Restart activity flow change (`src/activities/outbox.ts:687-709`):

1. After Step 4 (`claimAttachment`), if `loadFromState` is set:
   - Resolve the requested key (`true` → `'main'`).
   - Query `playerStateQuery({ key })` on the **prior** session workflow (before continueAsNew).
   - If the slot is empty, fall through to current transcript-replay behaviour and emit a `loadFromState requested but slot empty` log.
   - Otherwise, signal `receiveMessageSignal` on the new session with `{ from: 'self-restart', text: stateContent, responseRequested: false }`.
2. If `transcript === 'replay'` (or `loadFromState` absent), additionally execute the existing transcript-replay path.
3. If `transcript === 'suppress'` (default when `loadFromState` set), skip the transcript-replay block.

Saved-state delivery is added as a *separate* `receiveMessage` so the new session can distinguish curated state from prior chat — `from: 'self-restart'` is a stable marker.

### 4.5 Wire-protocol drift detector

The names `savePlayerState`, `clearPlayerState`, `playerState`, `playerStateKeys` are added to `docs/WIRE-PROTOCOL.md` in the same commit that introduces them. The wire-protocol drift detector (`test/wire-protocol.test.ts`) enforces the doc/code parity.

---

## 5. MCP tool surface

Three tools — same count as #334's sketch.

### 5.1 `save_state`

```ts
// src/tools/save-state.ts (new file)

defineTool(
  server,
  'save_state',
  // Docstring nudge — Q4 lean (markdown template suggestion). Not enforced.
  `Save curated state for yourself into a named slot — the next session you spawn via \`restart({ loadFromState: true })\` can resume from this artifact.

Recommended structure (markdown):

  ## Current task
  ...
  ## Findings
  ...
  ## Next steps
  ...
  ## Open questions
  ...

Max 32 KiB per slot, 4 slots per player. Slot key defaults to "main". Returns \`{ saved, savedAt }\` on success.`,
  {
    content: z.string().min(1).max(PLAYER_STATE_CONTENT_MAX).describe('The state content to save — markdown encouraged, opaque to the system.'),
    key: z.string().regex(PLAYER_STATE_KEY_REGEX).max(PLAYER_STATE_KEY_MAX).optional().describe('Slot name (default "main"); alphanumeric + underscore + hyphen.'),
  },
  async ({ content, key }) => {
    const playerId = getPlayerId();
    try {
      const result = await handle.executeUpdate(savePlayerStateUpdate, {
        args: [{ key: key ?? PLAYER_STATE_DEFAULT_KEY, content, savedBy: playerId }],
      });
      return ok(`Saved to slot "${key ?? PLAYER_STATE_DEFAULT_KEY}" at ${result.savedAt}.`);
    } catch (err) {
      // PlayerStateSlotsFull surfaced with structured key list so the LLM can
      // pick which slot to clear.
      return fail(`Failed to save state: ${formatError(err)}`);
    }
  },
);
```

### 5.2 `fetch_state`

```ts
defineTool(
  server,
  'fetch_state',
  'Read a player\'s saved state. Defaults to your own "main" slot. Pass `playerId` to read a peer\'s state (any player can read any other player\'s state). Returns null if the slot is empty.',
  {
    key: z.string().regex(PLAYER_STATE_KEY_REGEX).max(PLAYER_STATE_KEY_MAX).optional().describe('Slot name (default "main").'),
    playerId: z.string().regex(PLAYER_NAME_REGEX).max(PLAYER_NAME_MAX).optional().describe('Target player name (default: self).'),
  },
  async ({ key, playerId }) => {
    const targetId = playerId ?? getPlayerId();
    const targetHandle = targetId === getPlayerId()
      ? handle
      : connection.workflow.getHandle(sessionWorkflowId(metadata.ensemble, targetId));
    try {
      const result = await targetHandle.query(playerStateQuery, { key: key ?? PLAYER_STATE_DEFAULT_KEY });
      if (!result) return ok(`(no state saved at slot "${key ?? PLAYER_STATE_DEFAULT_KEY}" for ${targetId})`);
      return ok(`Slot "${key ?? PLAYER_STATE_DEFAULT_KEY}" — saved by ${result.savedBy} at ${result.savedAt}\n\n${result.content}`);
    } catch (err) {
      return fail(`Failed to fetch state: ${formatError(err)}`);
    }
  },
);
```

### 5.3 `clear_state`

```ts
defineTool(
  server,
  'clear_state',
  'Clear one of your saved-state slots. Owner-only — you can only clear your own state. Returns whether the slot was non-empty before the clear.',
  {
    key: z.string().regex(PLAYER_STATE_KEY_REGEX).max(PLAYER_STATE_KEY_MAX).optional().describe('Slot name (default "main").'),
  },
  async ({ key }) => {
    try {
      const result = await handle.executeUpdate(clearPlayerStateUpdate, {
        args: [{ key: key ?? PLAYER_STATE_DEFAULT_KEY }],
      });
      return ok(result.cleared ? `Cleared slot "${key ?? PLAYER_STATE_DEFAULT_KEY}".` : `Slot "${key ?? PLAYER_STATE_DEFAULT_KEY}" was already empty.`);
    } catch (err) {
      return fail(`Failed to clear state: ${formatError(err)}`);
    }
  },
);
```

### 5.4 Permissions model — structural, not enforced

| Operation | Target | Enforcement |
|---|---|---|
| `save_state` | Self only | Structural — no `playerId` arg; the tool's `handle` is the calling player's own session workflow handle. |
| `clear_state` | Self only | Structural — same |
| `fetch_state` | Self or any peer | `playerId` arg with self-default; resolves a target workflow handle via the session-workflow-ID convention |

Because permissions are structural at the tool layer (write operations have no `playerId` arg), the workflow itself doesn't need authorisation logic — `savePlayerState` / `clearPlayerState` simply trust the calling tool. The `savedBy` field is the audit identity.

This mirrors the existing `recall` (self-only via tool wiring), `setPart` (self-only via signal-on-own-handle), and `attachment_info` (peer-readable via query). The pattern is consistent.

---

## 6. Workflow changes

Localised to `src/workflows/session.ts`. No new state machines, no new races.

### 6.1 State declaration

```ts
// At the top of the workflow body
let playerState: Record<string, { content: string; savedAt: string; savedBy: string }> =
  input.playerState ?? {};
```

### 6.2 Update handlers

```ts
setHandler(savePlayerStateUpdate, ({ key, content, savedBy }) => {
  // Validators run pre-handler (see §6.3); body assumes valid input.
  playerState[key] = { content, savedAt: workflowNow().toISOString(), savedBy };
  return { saved: true as const, savedAt: playerState[key].savedAt };
});

setHandler(clearPlayerStateUpdate, ({ key }) => {
  if (!(key in playerState)) return { cleared: false };
  delete playerState[key];
  return { cleared: true };
});

setHandler(playerStateQuery, ({ key }) => playerState[key ?? PLAYER_STATE_DEFAULT_KEY] ?? null);
setHandler(playerStateKeysQuery, () => Object.keys(playerState).sort());
```

### 6.3 Validators (pre-handler, replay-safe)

Update validators run before the handler and reject without committing history events. This is where the size/slot caps + `PlayerStateSlotsFull` rejection happen — keeps the handler body trivially deterministic.

```ts
setHandler(savePlayerStateUpdate, handler, {
  validator: ({ key, content, savedBy }) => {
    if (!PLAYER_STATE_KEY_REGEX.test(key) || key.length > PLAYER_STATE_KEY_MAX) {
      throw ApplicationFailure.nonRetryable(`Invalid playerState key "${key}"`, 'PlayerStateInvalidKey');
    }
    if (Buffer.byteLength(content, 'utf8') > PLAYER_STATE_CONTENT_MAX) {
      throw ApplicationFailure.nonRetryable(
        `playerState content exceeds ${PLAYER_STATE_CONTENT_MAX} bytes`,
        'PlayerStateContentTooLarge',
      );
    }
    if (!(key in playerState) && Object.keys(playerState).length >= PLAYER_STATE_SLOTS_MAX) {
      const existingKeys = Object.keys(playerState).sort().join(', ');
      throw ApplicationFailure.nonRetryable(
        `playerState slots full (${PLAYER_STATE_SLOTS_MAX}). Clear one before saving "${key}". Existing slots: ${existingKeys}`,
        'PlayerStateSlotsFull',
      );
    }
  },
});
```

`Buffer.byteLength` is replay-deterministic — pure string-byte counting, no clocks/randomness. Same pattern coat-check (#318) uses for its size validator.

### 6.4 `continueAsNew` carry

Add `playerState` to the carry set in the existing CAN block (`src/workflows/session.ts:1617-1638`):

```ts
await continueAsNew<typeof claudeSessionWorkflow>({
  ...input,
  // ... existing carry fields ...
  ...(Object.keys(playerState).length > 0 ? { playerState } : {}),
});
```

Empty `playerState` is omitted from the CAN payload — same idiom the existing carry uses for `currentAttachment` / `preferredHost` / `drainingSince`. Keeps the wire small for the common no-state case.

### 6.5 Validation constants (`src/utils/validation.ts`)

```ts
// Added after the existing MESSAGE_MAX block
export const PLAYER_STATE_DEFAULT_KEY = 'main';
export const PLAYER_STATE_KEY_REGEX = /^[a-zA-Z0-9_-]+$/;
export const PLAYER_STATE_KEY_MAX = 32;
export const PLAYER_STATE_CONTENT_MAX = 32 * 1024;  // 32 KiB
export const PLAYER_STATE_SLOTS_MAX = 4;
```

Mirrors the `PLAYER_NAME_REGEX` / `PLAYER_NAME_MAX` / `MESSAGE_MAX` style. Tools and the workflow both import these constants — single source of truth.

---

## 7. Restart integration

### 7.1 Tool-side change (`src/tools/restart.ts`)

Add optional `loadFromState` and `transcript` to the Zod schema; pass through to the outbox entry. No other tool changes.

### 7.2 Activity-side change (`src/activities/outbox.ts:687-709`)

Replace the existing replay block with a branch on `loadFromState`. Note `saved` is hoisted to the outer scope so the fall-through condition can reference it:

```ts
// Step 5 — context seed (saved state and/or transcript replay).
const wantsState = entry.loadFromState !== undefined;
const wantsTranscriptByFlag = entry.transcript === 'replay';
let saved: { content: string; savedAt: string; savedBy: string } | null = null;

if (wantsState) {
  const stateKey = typeof entry.loadFromState === 'string'
    ? entry.loadFromState
    : PLAYER_STATE_DEFAULT_KEY;
  saved = await priorHandle.query(playerStateQuery, { key: stateKey });
  if (saved) {
    await newHandle.signal(receiveMessageSignal, {
      from: 'self-restart',
      text: `🎵 **Restored state — "${stateKey}"** (saved ${saved.savedAt} by ${saved.savedBy})\n\n${saved.content}`,
      responseRequested: false,
    });
  } else {
    log(`Restart loadFromState requested for slot "${stateKey}" but slot is empty — falling back to transcript replay`);
    // UX-friendly fallback — alternative is to fail the restart, but that's
    // surprising when the slot just wasn't populated. Falls through to the
    // transcript-replay block below via the `!saved` clause.
  }
}

// Replay the transcript when (a) loadFromState was not requested, or
// (b) caller opted into stacking via `transcript: 'replay'`, or
// (c) loadFromState was requested but the slot was empty (fallback).
const wantsTranscript = !wantsState || wantsTranscriptByFlag || (wantsState && !saved);
if (wantsTranscript) {
  // Existing transcript-replay block from src/activities/outbox.ts:687-709
}
```

The `from: 'self-restart'` marker is a new constant identity (alongside existing `'maestro'` etc.). Players see it as a system-emitted message and treat it accordingly.

### 7.3 `RestartOutboxEntry` is the version boundary — structural compatibility

Old workflow runs that pre-date this PR will see entries without `loadFromState` / `transcript`. Backward compatibility is **structural**, not patched():

- Old `restart` outbox entries omit `loadFromState`, so `wantsState` evaluates to `false` for them.
- The new conditional branch is skipped entirely; execution falls through to the existing transcript-replay block — bit-for-bit identical to today's behaviour.
- No `patched()` marker is needed (this is **activity** code, not workflow code; `workflow.patched()` requires the workflow context and would throw at runtime here anyway).

The workflow-side additions (`savePlayerStateUpdate` / `clearPlayerStateUpdate` handlers, `playerStateQuery`, the `playerState` field on `SessionInput`) are likewise additive: an old workflow run won't have any saved state in its `playerState` map (the field is `undefined` after CAN until the first save), and `setHandler` registrations for the new updates/queries don't affect prior history events. No `patched()` marker needed on the workflow side either — there's no behavioural divergence in any pre-existing code path.

---

## 8. Test strategy

Mirrors the test discipline established by #318 / #319 spikes.

### 8.1 Unit (Vitest, `tests/`)

- `tests/tools/save-state.test.ts` — validates `save_state` tool: success, content too large, key invalid, slots full error message includes existing keys.
- `tests/tools/fetch-state.test.ts` — self vs peer reads, missing slot returns null, default key resolution.
- `tests/tools/clear-state.test.ts` — clears existing, clears non-existing returns `cleared: false`.

### 8.2 Workflow integration (Mocha, `test/`)

- `test/workflows/playerState.test.ts` — round-trip save → query → restart with `loadFromState: true` → new session sees saved content as initial message.
- Slot-saturation: 4 saves succeed, 5th rejects with `PlayerStateSlotsFull`, post-clear retry succeeds.
- Multi-key: save 'main', 'bookmark', 'safety', 'debug'; query each independently; clear 'safety'; `playerStateKeysQuery` returns sorted remaining 3.
- CAN survival: force CAN via `testForceContinueAsNewSignal`; verify `playerState` carries through and queries return same values.

### 8.3 Wire-protocol drift detector

`docs/WIRE-PROTOCOL.md` gets new rows for `savePlayerState`, `clearPlayerState`, `playerState`, `playerStateKeys`. The existing `test/wire-protocol.test.ts` parser auto-validates code/doc parity.

### 8.4 Determinism check

Restart's branch on `entry.loadFromState` is in activity code (not workflow code) — already non-deterministic-safe by construction. The only workflow-side replay risk is `Buffer.byteLength` in the validator; that's pure-function / replay-safe.

---

## 9. Sequencing

### 9.1 Independence from other in-flight work

- **#318 coat-check** — different scope (ensemble vs intra-player); different storage (maestro vs session); orthogonal. Either can ship first.
- **#319 protobuf migration** — additive on the JSON wire; when protobuf migration lands, `playerState` types get `.proto` definitions added to PR-1's surface inventory. The implementation order is `#319` lockstep with whatever ships under JSON.
- **#94/#95 SSE event source** — none of `playerState` is observed by SSE in v1. Future v2 lever: emit `playerState.changed` events on save/clear; not in v1 scope.

### 9.2 Recommended drop point

Single PR, ~450 LoC. Estimated 1.5–2 days for engineer pickup. Scheduling-wise, fits in any quiet slot — no inter-team coordination required.

### 9.3 v2 future-work hooks (deliberately out-of-scope here)

- **Slot-cap raise above 4** — re-evaluate if telemetry shows >10 % `PlayerStateSlotsFull` rejection rate.
- **Cross-player write delegation** — if "operator pre-seeds a player's state before recruit" becomes a use case, add a `playerId` arg to `save_state` with a permission gate. Not v1.
- **`playerState.changed` SSE event** — additive on the SSE wire; not v1.
- **Transcript-replay deprecation** — once `save_state` is used widely, the implicit replay may become low-value. Not v1; depends on usage data.

---

## 10. Decision log — answers to issue #334's open questions

| Q | Issue text | Locked decision | Rationale |
|---|---|---|---|
| Q1 | Multi-key support: yes or no? | **Yes**, default `'main'`, max 4 slots | Issue's own use cases (bookmark + safety + debug + main) want named slots. Adding multi-key later breaks `loadFromState: true` semantics. 4-slot cap prevents sprawl. |
| Q2 | Restart interaction — replay + state, or state only? | **Suppress transcript by default**; `transcript: 'replay'` opts in to stacking | Saved state is the player's authoritative curated context. Stacking by default defeats the "clean slate" use case (#32's original framing). |
| Q3 | Storage shape — string or structured? | **Opaque string** | Structured locks schema; every consumer must upgrade in lockstep. Adjacent tools (Aider, Cursor, Anthropic harness blog) all use string. |
| Q4 | Authoring discipline — template or neutral? | **Docstring nudge** (markdown template), no enforcement | Tool description is the right surface — LLMs read it on every call. Forcing schema is brittle. |
| Q5 | `fetch_state` permissions — owner-only or any-peer? | **Read-by-any-peer; write/clear self-only** (structural) | Mirrors `recall` ergonomics (self-only writes, peer-readable reads via query). Audit via `savedBy`. |
| Open follow-up (researcher) | 4-slot saturation: refuse vs LRU evict? | **Refuse + structured error** | Anthropic harness blog: explicit eviction reinforces authorial discipline. Loud failure beats silent loss. |

---

## 11. References

- **Issue #334** — original sketch with 5 open questions; supersedes closed #32 `context_reset`
- **Phase A research** — [`docs/research/334-player-saveable-state-alternatives.md`](../research/334-player-saveable-state-alternatives.md) (PR #337)
- **ADR 0007** — TempoClient Core/WithSpawn split (design-spike template precedent)
- **ADR 0008** — Coat-check pattern (per-entry/aggregate sizing reasoning; CAN-payload constraint analysis)
- **ADR 0009** — Protobuf migration strategy (wire-protocol additive-discipline framing)
- **ADR 0011** — `0011-player-saveable-state.md` — decision record for this design
- `src/workflows/session.ts:1617-1638` — existing CAN-input shape; `playerState` extends
- `src/workflows/signals.ts` — wire-protocol surface; new updates/queries land here
- `src/activities/outbox.ts:687-709` — restart transcript-replay path; `loadFromState` extends
- `docs/WIRE-PROTOCOL.md` — wire contract registry; drift detector enforced via `test/wire-protocol.test.ts`
- Anthropic harness-design blog — *Context resets with structured artifacts work better than summarization for long-running agents.*
