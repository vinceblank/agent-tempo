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
| Filesystem `~/.agent-tempo/coatcheck/` | Unbounded | No (single-host v1) | ❌ non-deterministic in workflow context | Manual cleanup | Rejected |
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

### Three Temporal payload constraints, not just one

Each constraint binds independently — the design must survive all three:

| Constraint | Default | What it bounds |
|---|---|---|
| Per-payload size | 4 MiB | One serialized `Payload` (signal arg, update arg, query result, **CAN input**, etc.) |
| Per-workflow event history | 50 MB total | Sum of all events serialized into the workflow's history |
| Workflow memory | Node heap | In-memory state during execution |

The **CAN-input constraint is the load-bearing one** for coat-check sizing. When `continueAsNewSuggested` fires (v0 spec said "rely on it"), the maestro serialises its accumulated state — including all live coat-check entries — into a single `MaestroInput` payload. That payload is bounded by 4 MiB, **not** 50 MB. If the aggregate of coat-check content + existing maestro state (`players`, `events`, `pendingCommands`, `cachedChat` ≈ 316 KiB) exceeds 4 MiB, CAN serialization fails, the workflow can't roll history, and the workflow eventually wedges at the 50 MB history ceiling. The original §3.2 missed this and proposed 100 × 1 MiB = up to 100 MiB aggregate — would have wedged in production.

### Selected approach: aggregate state cap (Option 1)

> **qa-2 reviewer credit**: surfaced this gap on PR #327 review. The two options below frame qa-2's analysis; Option 1 selected for the reasons in §3.4.

**Caps**:

| Parameter | Value | Calculation |
|---|---|---|
| Aggregate coat-check state ceiling | **1.6 MiB** | Comfortable margin under 4 MiB CAN-payload limit, leaving ≥2 MiB of headroom for the rest of `MaestroInput` (~316 KiB existing state + future growth) |
| Per-entry content size | **32 KiB max** | Covers a ~5K-word markdown report (canonical "researcher Phase 1 report" use case at ~18 KiB) with comfortable headroom for code blocks |
| Per-ensemble entry count | **50** | 50 × 32 KiB = 1.6 MiB exactly. Generous slot count — issue #318's motivating examples suggest dozens of items per ensemble in practice |
| Eviction trigger | Composite TTL OR LRU(50), whichever fires first | Same composite policy; counts adjust to the new cap |

**Why these specific numbers**:

- **Aggregate ≤ 1.6 MiB, not 2 MiB or 3 MiB**: CAN input serialises the *entire* MaestroInput. Existing fields are ~316 KiB; future maestro state may grow (e.g. `hostProfiles` map already added in v0.27). 1.6 MiB coat-check + 316 KiB existing + 1 MiB future-growth budget = 2.9 MiB, well under 4 MiB. 2 MiB cap would leave only ~1.7 MiB headroom — too tight.
- **Per-entry 32 KiB, not 64 KiB**: 50 × 64 KiB = 3.2 MiB exceeds the 1.6 MiB aggregate. Could allow 25 × 64 KiB = 1.6 MiB, but smaller slot counts increase noisy-player crowd-out risk (see §7 footnote). 32 KiB / 50 slots is the better ratio.
- **50 slots, not 100**: doubling the slot count would double aggregate state at fixed per-entry cap, breaking the 1.6 MiB ceiling. 50 is the natural slot count given the per-entry choice.

### Why not Option 2 (external storage) for v1

External storage (filesystem `~/.agent-tempo/coatcheck/<ensemble>/<ticket>` or activity-mediated blob store) gives unbounded per-entry size at the cost of:

- **Replay determinism** — workflow state must NOT contain the content; activities read/write it. Workflow only carries metadata. Adds an activity round-trip on every put/get.
- **Cross-machine fragility** — host-bound FS doesn't survive the future cross-host-coat-check use case the issue flagged as v2 scope. Forces storage to migrate again later.
- **Operator-managed cleanup** — TTL eviction must run as a background activity, not in the maestro main loop.
- **Larger v1 surface area** — new activity, new lifecycle hook, more code paths for the audit-and-test grid.

For motivating use cases (5-10K word reports = ~18-60 KiB each), the 32 KiB per-entry cap covers the canonical "researcher Phase 1 report" comfortably. **Reports beyond 32 KiB are rare enough to fall back to the existing manual doc-PR pattern (§2 row 3) until a v2 signal warrants the storage swap.**

The v2 upgrade path stays graceful: `maestroCoatCheckPut` validates the entry then writes — swapping in-memory storage for activity-mediated FS storage is a workflow-internal change, not an API change. Callers don't see the difference.

### Conclusion

Maestro workflow state with the **1.6 MiB aggregate / 32 KiB per-entry / 50-slot** caps survives all three Temporal payload constraints. v2 path to external storage stays open via the existing `maestroCoatCheckPut` API; v1 caps are the binding decision.

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
    content: string;        // ≤ 32 KiB (per §3 caps; aggregate ≤ 1.6 MiB across all live entries)
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
| Per-entry content size | n/a | max **32 KiB** (per §3.3 — covers a ~5K-word markdown report; reports beyond this fall back to manual doc-PR pattern) | No |
| Per-ensemble entry count | n/a | max **50** (LRU on overflow; combined with per-entry cap = 1.6 MiB aggregate state ceiling, safely under the 4 MiB CAN-payload limit) | Future env var if v2 storage swap warrants |
| Aggregate coat-check state ceiling | n/a | **1.6 MiB** (50 × 32 KiB) — bounds the slice of `MaestroInput` that CAN serialises | No |
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

**Noisy-player edge case**: any-player put combined with LRU-oldest-first eviction means a single noisy player can crowd out older legitimate entries. Mitigations layered into v1:

- 50-slot ceiling caps the worst-case crowd-out at 50 entries deep — older items beyond that are gone anyway
- 32 KiB per-entry cap means a noisy player must spam many entries to fill the buffer, not one giant blob
- Conductor-only evict gives the operator a manual hammer for genuinely abusive patterns
- Audit trail (`putBy` per entry) makes the noisy player visible in `coat_check_list` output

For v1 these protections are sufficient. If observed abuse warrants stronger guarantees (per-player slot quotas, write-rate limits), they're additive without changing the wire protocol — flagged in §11 forward-looking.

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

> **Pre-existing bug to address opportunistically when implementing**: `Date.now()` is non-deterministic in workflow context — should be `workflow.now()`. Not introduced by this design but the implementer touches this exact line, so swap the call as a free fix in the same PR. Track separately if scope balloons, but it's a one-line correction.

For coat-check purposes, extend the bypass: do NOT terminate if any non-expired coat-check entries exist. New condition:

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

### 11.2 Storage: filesystem `~/.agent-tempo/coatcheck/`

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
