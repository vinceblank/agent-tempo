# Coat-check pattern for large cues

> **Status**: Design proposal (spike — no implementation in this branch)
> **Author**: tempo-architect
> **Branch**: `design/318-coat-check-pattern`
> **Tracking**: issue #318 (approved for autonomous pickup)
> **Audience**: implementing engineer (when scheduled, post-Phase-3-PR-4 + 48 h soak), conductor for review.

---

## 0. TL;DR

Cues today carry full text up to 100 KiB per `MESSAGE_MAX`. Three observed pain points (per #318) push that ceiling:

1. **Researcher reports** — a 3 K-word Phase 1 report fan-outs to multiple downstream players inflate everyone's context immediately.
2. **Cross-player relay distortion** — when the conductor relays one player's review items to another, hand-summarising introduces drift.
3. **Conductor inbox economy** — every report grows conductor context. Long-form output should be parked, not inlined.

**The pattern**: sender stores content under a ticket (`coat_check_put`); cues carry summary + optional structured `attachmentTicket`; receivers fetch only when they need the full thing. Lock the design now; implement after Phase 3 PR-4 + 48 h soak per #318's recommended sequencing.

**Storage decision**: per-ensemble maestro workflow state. Wire-protocol additions are 2 queries + 2 updates + 1 additive field on `CueOutboxEntry`. MCP surface is 4 tools (`coat_check_put`, `coat_check_get`, `coat_check_list`, `coat_check_evict`). Defaults: 7-day TTL, 100-entry LRU cap, 1 MiB per-entry size cap, any-player put, conductor-only evict.

**Estimated implementation cost**: ~600 LoC (matches #318's estimate).

---

## 1. Why now

#318's three motivating moments are all from a recent multi-player session:

1. **Researcher's Phase 1 report fan-out** — landed in conductor transcript only; sharing it 3× (architect, eng-3, eng-4) meant either re-cueing 3× or hand-summarising. Persisting as a doc PR worked but cost a manual commit cycle.
2. **Cross-player review relay** — conductor needed to relay eng-3's 5 implementer items to architect; manual summarisation in the cue introduced distortion risk.
3. **Conductor inbox economy** — every player report flows through the conductor. Each grows conductor context. Parking long-form output under tickets extends the practical context-pressure threshold.

The pattern composes naturally with #94/#95's SSE event source (the daemon already streams ensemble state to consumers; coat-check entries become another field on the ensemble snapshot) — but the design here is independent and can ship before SSE Phase 3 PR-4.

---

## 2. Catalog of existing partial coverage

Three primitives partially overlap; coat-check unifies them as a first-class store.

| Primitive | Scope | What it does | What it doesn't do |
|---|---|---|---|
| `recall` MCP tool | Per-player | Reads sender's own message history (received + sent) from session workflow's `allMessages`/`allSentMessages` | Doesn't share content cross-player by reference; doesn't allow an opaque non-message blob |
| `attachment_info` MCP tool | Per-player adapter lifecycle | Reports adapter phase, lease, heartbeat | Lifecycle state, not blob storage |
| Manual doc-PR pattern | Cross-player, durable | Park report at `docs/research/<issue>-<topic>.md`; cue collaborators its path | Requires git commit + review cycle; not in-band; ephemeral storage not appropriate (e.g. one-off review summaries) |

**Coat-check fills the remaining hole**: ensemble-scoped, in-band, immutable-by-ticket, time-bounded blob storage with cross-player retrieval.

---

## 3. Storage decision matrix

### 3.1 Candidates and trade-offs (extending issue #318's table)

| Backend | State size | Cross-machine | Replay determinism | Lifecycle binding | Verdict |
|---|---|---|---|---|---|
| **Per-ensemble maestro state** | Bounded by maestro state ceiling (see §3.2) | No (single-host v1) | ✅ deterministic | Lives + dies with ensemble | **Selected** |
| Per-conductor session state | Same | No | ✅ deterministic | Lives + dies with conductor (lost on conductor restart — bad) | Rejected |
| Filesystem `~/.claude-tempo/coatcheck/` | Unbounded | No (single-host v1) | ❌ non-deterministic in workflow context | Manual cleanup | Rejected |
| External blob (S3/sqlite/MinIO) | Unbounded | ✅ Yes | ❌ non-deterministic | Operator-managed | Rejected for v1 |

### 3.2 Maestro state size headroom

Current per-ensemble maestro state (measured against `src/workflows/maestro.ts:67-81`):

| Field | Bound | Worst-case bytes |
|---|---|---|
| `players` | typically ≤20 | ~10 KiB |
| `events` | max 200 | ~50 KiB |
| `pendingCommands` | typically ≤10 | ~5 KiB |
| `cachedChat` | max 500 × ~500 B | ~250 KiB |
| `cachedChatMeta` + `chatHighWater` | constant | ~1 KiB |
| **Existing total** | | **~316 KiB** |

Adding coat-check entries with the proposed caps (100 entries × 1 MiB max each = 100 MiB worst case) is the dominant new state contributor. Headroom analysis:

- **Workflow state in memory** — bounded by Node heap, not Temporal. 100 MiB is fine for daemon process.
- **Per-event payload size on signals/updates** — Temporal default cap is 4 MiB per payload. The `coatCheckPut` update args carry the content, so the **per-entry size cap MUST be set below 4 MiB**. Recommend **1 MiB** for safety margin.
- **Per-workflow event history** — Temporal default cap is 50 MB total. Each `coatCheckPut` update generates ~2 history events (input + output). With 100 entries × 1 MiB writes ~200 MiB to history → exceeds 50 MB ceiling **before CAN**. Mitigation: trigger CAN aggressively when history approaches the limit, OR restrict per-entry size further. **Selected mitigation**: keep 1 MiB per-entry cap; rely on `continueAsNewSuggested` (already wired in `maestro.ts:252-267`) to roll history before the 50 MB limit. Coat-check state carries through CAN like every other field.

**Conclusion**: maestro state is sized correctly for v1. If usage patterns force >1 MiB per entry, that's a v2 signal to switch to FS or external blob — graceful future path, doesn't block this design.

---

## 4. Wire-protocol additions

All additions land on the **per-ensemble maestro workflow** (`claudeMaestroWorkflow`). Strictly additive — no rename or removal of existing names.

### 4.1 Queries

```ts
/** Get a single coat-check entry by ticket. Returns null if not found / evicted / expired. */
export const maestroCoatCheckEntryQuery = defineQuery<
  CoatCheckEntry | null,
  [{ ticket: string }]
>('maestroCoatCheckEntry');

/**
 * List coat-check entries (metadata only — no content) for the ensemble.
 * Newest-first, optionally narrowed by `putBy` player or `since` ISO timestamp.
 */
export const maestroCoatCheckListQuery = defineQuery<
  CoatCheckMetadata[],
  [{ putBy?: string; since?: string; limit?: number }?]
>('maestroCoatCheckList');
```

### 4.2 Updates

```ts
/**
 * Store a coat-check entry. Returns the generated ticket and absolute expiry.
 * Update (not signal) so the caller gets the ticket back transactionally.
 */
export const maestroCoatCheckPutUpdate = defineUpdate<
  { ticket: string; expiresAt: string },
  [{
    summary: string;
    content: string;        // ≤ 1 MiB
    ttl?: string;           // duration string (e.g. "7d"); default 7d, min 1h, max 30d
    putBy: string;          // caller identity (player name); maestro records for audit
    contentType?: string;   // e.g. "text/markdown"; opaque hint, not validated
  }]
>('maestroCoatCheckPut');

/**
 * Manually evict an entry. Conductor-only by default (validator checks
 * `evictedBy === ensemble's conductor playerId`). No-op if ticket missing.
 */
export const maestroCoatCheckEvictUpdate = defineUpdate<
  { evicted: boolean },
  [{ ticket: string; evictedBy: string }]
>('maestroCoatCheckEvict');
```

### 4.3 Type definitions (`src/types.ts`)

```ts
export interface CoatCheckMetadata {
  ticket: string;            // generated UUID
  summary: string;
  putBy: string;
  putAt: string;             // ISO timestamp
  expiresAt: string;         // ISO timestamp
  contentType?: string;
  size: number;              // bytes — caller can decide whether to fetch
}

export interface CoatCheckEntry extends CoatCheckMetadata {
  content: string;
}
```

### 4.4 Outbox-entry extension

`CueOutboxEntry` gains an additive optional field:

```ts
export interface CueOutboxEntry extends OutboxEntryBase {
  type: 'cue';
  targetPlayerId: string;
  message: string;
  /** Optional ticket reference — receivers can fetch full content via `coat_check_get`. */
  attachmentTicket?: string;
}
```

**Backward compatibility**: old workflows / old cues simply omit the field. The dispatch loop's `deliverCue` activity (`src/activities/outbox.ts`) forwards the field unchanged on `receiveMessage` signal. The session workflow's `Message` type gains the same optional field for inbox display. Strictly additive — no version bump required.

---

## 5. MCP tool surface

Four separate tools (matches the established pattern: `schedule`/`unschedule`/`schedules`; `pause`/`play`/`shutdown`/`restore`):

| Tool | Verb | Args | Permissions |
|---|---|---|---|
| `coat_check_put` | put | `{ summary, content, ttl?, contentType? }` | Any player (audit trail via `putBy`) |
| `coat_check_get` | get | `{ ticket }` | Any player |
| `coat_check_list` | list | `{ putBy?, since?, limit? }` | Any player |
| `coat_check_evict` | evict | `{ ticket }` | **Conductor only** (validator rejects non-conductor) |

`getPlayerId()` (from the MCP server's session context) is the audit identity for `putBy` / `evictedBy`. Caller cannot spoof — the playerId comes from the workflow that's running the MCP server, not the args.

### 5.1 Why four tools, not one with verbs

Considered: a single `coat_check` tool with a `verb: 'put' | 'get' | 'list' | 'evict'` discriminator.

Rejected because:
- Each verb has a different arg schema. A single tool's Zod schema would be a discriminated union — harder to read in tool listings.
- Discoverability — `claude` listing tools would show one entry; users browsing for "is there a get?" don't immediately see it.
- The codebase precedent (5 schedule-family + 4 pause/play/shutdown/restore) has settled on per-verb tools. Following that consistency is a small win for cognitive load.

### 5.2 The `attachmentTicket` cue extension

`cue` MCP tool gains an optional `attachmentTicket` parameter — passed straight through to `CueOutboxEntry`:

```ts
{
  playerId: z.string().max(PLAYER_NAME_MAX),
  message: z.string().max(MESSAGE_MAX),
  attachmentTicket: z.string().uuid().optional(),  // NEW
}
```

The receiver's session sees the ticket on the `Message` payload and can call `coat_check_get` from its own MCP context. The TUI surfaces it as a clickable indicator on the message (Phase 3 follow-up; not in scope here).

---

## 6. Default policies

| Policy | Default | Bounds | Configurable |
|---|---|---|---|
| TTL on `coat_check_put` (when caller omits) | 7 days | min 1 hour, max 30 days | Per-call via `ttl` arg |
| Per-entry content size | n/a | max 1 MiB (Temporal payload safety margin against 4 MiB ceiling) | No |
| Per-ensemble entry count | n/a | max 100 (LRU on overflow) | Future env var if needed |
| Eviction trigger | Composite: TTL expiry **OR** LRU evict on count overflow, whichever fires first | n/a | n/a |
| TTL refresh on `coat_check_get`? | **No** — tickets are immutable; `get` does not extend TTL | n/a | Future option if abuse patterns warrant |

The maestro's existing 5-second poll loop (`maestro.ts:137`) is a natural place to run the TTL eviction sweep. Pseudocode (in workflow context, deterministic — uses `workflow.now()` not `Date.now()`):

```ts
// inside the main loop, before refreshEnsembleState
const now = workflow.now();
for (const [ticket, entry] of coatCheck) {
  if (Date.parse(entry.expiresAt) <= now) {
    coatCheck.delete(ticket);
    coatCheckEvictedCount++;  // for telemetry
  }
}
```

LRU eviction runs on `coatCheckPut` admission: if `coatCheck.size === 100`, evict the entry with the oldest `putAt`.

---

## 7. Permissions model

| Operation | Who can call | Enforcement layer |
|---|---|---|
| `coat_check_put` | Any player | None — audit trail via `putBy` (the calling player's `getPlayerId()`) |
| `coat_check_get` | Any player | None — read-only, low risk |
| `coat_check_list` | Any player | None — metadata only |
| `coat_check_evict` | **Conductor only** | Update validator on the maestro: rejects if `evictedBy` doesn't match `players.find(p => p.isConductor)?.playerId` |

**Why any-player put** (overriding issue #318's open question 4): the issue's own example shows eng-3 putting their own review content. Conductor-only put would prevent the most natural use case (player parks their own long-form output before cueing the conductor with a summary).

**Why conductor-only evict**: prevents one player from clobbering another's parked content. The conductor is the natural arbiter for cleanup. Audit trail (`putBy` + `evictedBy`) makes either side accountable.

**Future extension** — per-ensemble policy override (e.g. `getCoatCheckPolicyQuery` reading from a config flag). Not in v1 scope; flagged in §11.

---

## 8. Lifecycle integration

| Scenario | Outcome | Mitigation needed? |
|---|---|---|
| Ensemble destroyed (`destroy` MCP tool, ensemble-scope) | Maestro workflow terminates → all coat-check state goes with it | Acceptable per #318 §"Lifecycle integration" |
| Conductor restart | Conductor is a player; maestro state independent. **Coat-check entries persist.** | None |
| Conductor `destroy` (single-target) | Conductor session terminates; maestro continues. Coat-check entries persist. | None |
| Maestro `continueAsNew` (suggested at history-size threshold) | All coat-check state carries through input arg at `maestro.ts:252-267` | Add `coatCheck` field to `MaestroInput` shape |
| Maestro idle timeout (5 min no running sessions, `IDLE_TIMEOUT_MS`) | Maestro terminates → coat-check state lost | **Yes** — see §8.1 |
| TTL expiry mid-flight | Eviction sweep removes entry on next poll tick (≤ 5 s lag) | None |
| `coat_check_get` on expired/evicted ticket | Returns null | Caller handles gracefully |

### 8.1 Idle-timeout mitigation

Currently `maestro.ts:247-249`:

```ts
if (Date.now() - lastActiveSessionTime > IDLE_TIMEOUT_MS) {
  break;
}
```

Bug here is `Date.now()` in a workflow (should be `workflow.now()`) — already a follow-up. For coat-check purposes, extend the bypass: do NOT terminate if any non-expired coat-check entries exist. New condition:

```ts
const hasLiveCoatCheck = [...coatCheck.values()]
  .some((e) => Date.parse(e.expiresAt) > workflow.now());
if (!hasLiveCoatCheck && workflow.now() - lastActiveSessionTime > IDLE_TIMEOUT_MS) {
  break;
}
```

Trade-off: a parked entry with 7-day TTL keeps the maestro alive for up to 7 days even with zero running sessions. This is the right behavior — the entire point of coat-check is durable cross-player content; auto-evicting it because no one's online would defeat the design.

**Operator escape hatch**: `coat_check_evict` (conductor-only) allows manual cleanup. If conductor is also gone, ensemble-scope `destroy` tears down maestro and coat-check together.

---

## 9. Test strategy

| File | Suite | Coverage |
|---|---|---|
| `test/coat-check.test.ts` (Mocha) | Real maestro workflow against Temporal dev server | put/get/list/evict happy path, TTL expiry sweep, LRU overflow, size-cap validation, conductor-only evict enforcement, CAN carry-through |
| `tests/tools/coat-check-put.test.ts` (Vitest) | MCP tool unit | Validates Zod schema, TTL parsing, size limits |
| `tests/tools/coat-check-get.test.ts` (Vitest) | MCP tool unit | Returns null on missing ticket, returns full entry on hit |
| `tests/tools/coat-check-list.test.ts` (Vitest) | MCP tool unit | Filters by putBy / since / limit |
| `tests/tools/coat-check-evict.test.ts` (Vitest) | MCP tool unit | Conductor-only enforcement, no-op on missing ticket |
| `test/coat-check-fanout.test.ts` (Mocha) | E2E | Player A puts → cues player B with `attachmentTicket` → B's session calls `coat_check_get` → recovers content |
| `test/wire-protocol.test.ts` (Mocha, existing) | Drift detector | Auto-picks up new section header in WIRE-PROTOCOL.md |

The existing Mocha drift detector at `test/wire-protocol.test.ts` enforces that every section header in `docs/WIRE-PROTOCOL.md` maps to a known kind — adding the four new entries (`maestroCoatCheckEntry`, `maestroCoatCheckList`, `maestroCoatCheckPut`, `maestroCoatCheckEvict`) under the existing "Per-Ensemble Maestro Queries / Updates" sections requires no new section headers. Drift detector passes by construction.

---

## 10. Implementation footprint (when scheduled)

| File | Δ LoC |
|---|---|
| `src/workflows/maestro-signals.ts` | +35 (4 new defineQuery/defineUpdate exports) |
| `src/workflows/maestro.ts` | +90 (state map, handlers, eviction sweep, CAN carry, idle bypass) |
| `src/types.ts` | +25 (`CoatCheckMetadata`, `CoatCheckEntry`, `CueOutboxEntry.attachmentTicket`) |
| `src/tools/coat-check-put.ts` | new ~75 |
| `src/tools/coat-check-get.ts` | new ~50 |
| `src/tools/coat-check-list.ts` | new ~55 |
| `src/tools/coat-check-evict.ts` | new ~55 |
| `src/tools/cue.ts` | +5 (forward optional `attachmentTicket`) |
| `src/server.ts` | +6 (4 register calls) |
| `docs/WIRE-PROTOCOL.md` | +12 (4 query/update rows) |
| `docs/tools.md` | +8 (4 tool rows) |
| `docs/concepts.md` | +20 (Coat Check + Attachment Ticket glossary entries) |
| `CLAUDE.md` | +5 (concept link) |
| Tests | ~250 (per §9) |

**Net**: ~600 LoC, matches issue #318's estimate. Single PR, low risk, additive.

---

## 11. Alternatives considered

### 11.1 Storage: per-conductor session state

Store coat-check entries on the conductor's `claudeSessionWorkflow` instead of the per-ensemble maestro.

**Rejected**: conductor restart loses state. Ensemble-scope coordination is the maestro's job; sticking the store there matches the architecture.

### 11.2 Storage: filesystem `~/.claude-tempo/coatcheck/`

**Rejected**: workflow-context filesystem reads are non-deterministic and would require funnelling through an activity. Extra moving parts; no cross-host sharing benefit. Manual cleanup is operator-hostile.

### 11.3 Storage: external blob (S3 / sqlite / MinIO)

**Rejected for v1**: adds a deployment dependency for a feature that hasn't proved blob sizes warrant it. Tracked as v2 path if 1 MiB cap proves binding.

### 11.4 API surface: single `coat_check` tool with `verb` discriminator

**Rejected**: violates the codebase's per-verb tool precedent (`schedule`/`unschedule`/`schedules`); harder Zod schemas; lower discoverability in tool listings.

### 11.5 Permissions: conductor-only `coat_check_put`

**Rejected**: contradicts issue #318's own example (player parks their review before cueing). Audit trail via `putBy` is sufficient. `coat_check_evict` stays conductor-only for cleanup arbitration.

### 11.6 `attachmentTicket` as text convention only ("see ticket abc123" in message body)

**Rejected**: prevents typecheckable downstream tooling. The TUI can't render a ticket indicator without parsing message bodies; SSE event payloads can't surface a structured `attachmentTicket` field. Structured field = strictly better for the same wire cost (one optional string).

### 11.7 Mutable tickets (allow updating content under existing ticket)

**Rejected**: tickets are immutable per #318 explicit out-of-scope. Updates create new tickets; old tickets evict on TTL or LRU. Keeps semantics predictable.

---

## 12. Open questions resolved

Issue #318 listed four. My recommendations:

1. **Native `attachmentTicket` field on cue vs textual convention** → **Native**. Reasoning in §11.6.
2. **TTL default** → **7 days**. Min 1h, max 30d. §6.
3. **Eviction policy** → **Composite TTL OR LRU(100)**, whichever fires first. §6.
4. **Conductor-only `coat_check_put`?** → **No** — any player can put; conductor-only `coat_check_evict`. §7 + §11.5.

---

## 13. Sequencing (per #318)

> "Recommend after the SSE/streaming work (#94, #95) lands to avoid diluting focus."

Sequencing checkpoint: implementation should start **after Phase 3 PR-4 + 48 h soak** completes. That:

- Gives the team a clean attention window (no SSE context-switching)
- Lets the SSE event source absorb a `coatcheck.changed` event type as an additive follow-up (Phase 5+) without scrambling its v1 spec
- Aligns with this design's §3.2 prediction that the maestro state ceiling stays comfortable in steady state

This design unblocks engineers to start any time after that soak; until then, it's parked under `docs/design/` for review and reference.

---

## 14. Sources

- Issue #318 — full motivation, storage trade-off table, effort estimate, sequencing recommendation
- `docs/research/094-095-sse-streaming.md` — manual coat-check pattern (doc-PR-as-shared-reference) cited as the existing-but-painful workaround
- `src/workflows/maestro.ts` (lines 60-272) — per-ensemble maestro state shape, CAN carry, idle timeout
- `src/workflows/maestro-signals.ts` — existing wire-protocol contracts the new queries/updates extend
- `src/types.ts:380-440` — outbox-entry shapes that `attachmentTicket` extends
- `src/tools/cue.ts`, `src/tools/recall.ts` — existing per-verb tool conventions
- PR #326 (TempoClient Core/WithSpawn split) — same design-spike template; this doc follows that structure
