# ADR 0008 — Coat-check pattern for large cues

- **Status**: **Implemented in v0.29** (#318) — see the implementation-time divergences in the "Divergences from the original decision" section below.
- **Date**: 2026-04-26 (decision) / 2026-05-13 (implementation)
- **Authors**: tempo-architect
- **Related**: [`docs/design/coat-check-pattern.md`](../design/coat-check-pattern.md), issue #318, [#318 architect verdict](https://github.com/vinceblank/agent-tempo/issues/318#issuecomment-4437033250)

## Divergences from the original decision

The implementation shipped four deliberate divergences from this ADR, each ratified in the #318 architect verdict. Captured here so future readers don't need to cross-reference the issue thread:

1. **`coatCheckGet` is an Update, not a Query.** The fetch-audit triple (`lastFetchedAt` / `lastFetchedBy` / `fetchCount` — added per the issue review) mutates entry state; Temporal queries cannot mutate. `coatCheckList` stays a Query.
2. **Wire-protocol names normalized to `coatCheckPut/Get/List/Evict`** (dropping the `maestro` prefix the ADR proposed). Consistent with the MCP tool names; no other prefixed pattern exists in `maestro-signals.ts`.
3. **Slot count: 20, not 50.** Verdict §"Sizing": fewer slots surface operational pressure sooner under the refuse-and-error policy. Raising 20 → 50 is a non-breaking change on the strength of breadcrumb data.
4. **Saturation policy: refuse-and-error, not LRU.** Verdict §Q3: cross-host scope means LRU silently evicts peer hosts' entries — a sharper footgun than the rejection's diagnostic UX. Matches #334's `PlayerStateSlotsFull` semantics.
5. **Evict scope: owner-or-conductor.** Original ADR said "conductor-only"; vinceblank's locked decision broadened to owners-too, so a player who notices they over-stashed can clean up without conductor mediation.
6. **Fetch-audit fields added.** `lastFetchedAt`, `lastFetchedBy`, `fetchCount` on `CoatCheckEntry`. Owners can inspect "did anyone redeem my ticket?" via `coat_check_list`. Pure-additive on top of the original entry shape.

## Context

Cues today carry full text up to 100 KiB per `MESSAGE_MAX`. Three pain points pushed that ceiling in real ensemble work (per issue #318):

1. **Researcher report fan-out** — 3 K-word reports relayed to N players inflate everyone's context immediately.
2. **Cross-player relay distortion** — hand-summarising another player's content introduces drift risk.
3. **Conductor inbox economy** — every report grows conductor context; long-form output should be parked, not inlined.

The pattern: sender stores content under a ticket (`coat_check_put`); cues carry summary + optional structured `attachmentTicket`; receivers fetch only when they need the full thing.

Storage candidates evaluated:
- Per-ensemble maestro workflow state
- Per-conductor session workflow state
- Filesystem `~/.agent-tempo/coatcheck/`
- External blob store (S3 / sqlite / MinIO)

## Decision

**Per-ensemble maestro workflow state** as the storage backend, with:

- **Wire protocol** — 2 queries (`maestroCoatCheckEntry`, `maestroCoatCheckList`) + 2 updates (`maestroCoatCheckPut`, `maestroCoatCheckEvict`) on `claudeMaestroWorkflow`. Strictly additive.
- **MCP tool surface** — 4 separate tools matching the codebase's per-verb precedent: `coat_check_put`, `coat_check_get`, `coat_check_list`, `coat_check_evict`.
- **`CueOutboxEntry`** gains an additive optional `attachmentTicket?: string` field — old entries omit it; backward compatible by construction.
- **Defaults**: 7-day TTL (min 1h, max 30d), **50-entry LRU cap per ensemble, 32 KiB per-entry size cap, 1.6 MiB aggregate state ceiling** (sized to survive Temporal's 4 MiB CAN-payload limit, not the 50 MB history limit — see design §3.3 for the constraint analysis).
- **Permissions**: any player can `put`/`get`/`list`; `evict` is conductor-only (audit trail via `putBy` / `evictedBy` records the player identity from the calling MCP context).
- **Lifecycle**: entries carry through `continueAsNew`; idle-timeout bypass extended so maestro doesn't terminate while non-expired entries exist.

The full design — storage analysis with state-size headroom, decision matrix, interface skeletons, lifecycle scenarios, test strategy — lives at [`docs/design/coat-check-pattern.md`](../design/coat-check-pattern.md). This ADR records the decision; that doc records the design.

## Consequences

- **Positive**:
  - Receivers no longer pay the context cost of long-form content they may not need.
  - Cross-player relay is reference-based, not summary-based — distortion risk drops to zero for the relayed payload.
  - Conductor inbox economy improves: long-form reports park under tickets; the conductor reads summaries.
  - The `attachmentTicket` field is structured, so future tooling (TUI ticket indicators, SSE event payloads) gets typecheckable hooks instead of regex parsing.
  - The pattern unifies three existing partial coverages (`recall`, `attachment_info`, manual doc-PR convention) into a first-class primitive.
  - Per-ensemble scoping aligns with where the maestro already owns ensemble-aggregate state.
- **Negative**:
  - Per-entry size cap of **32 KiB binds tightly** — covers a ~5K-word markdown report (the canonical "researcher Phase 1 report" use case at ~18 KiB) but is too small for very-large blobs. Reports beyond 32 KiB fall back to the manual doc-PR pattern (issue #318 §"Existing partial coverage" row 3) until v2 storage swap warrants. Smaller per-entry cap is a deliberate trade for replay determinism + simpler v1.
  - Aggregate cap **1.6 MiB across 50 entries** is bounded by Temporal's 4 MiB per-payload limit on `continueAsNew` input, not the 50 MB history limit. Original v0 design (100 × 1 MiB) would have exceeded the CAN payload ceiling — qa-2 surfaced the gap on PR #327; sizes corrected. See design §3.3 for the three-constraint analysis.
  - Idle-timeout bypass keeps maestro alive while entries exist (up to 30 days at max TTL). Acceptable trade-off — auto-evicting parked entries on idle would defeat the durability point.
  - When reports >32 KiB become common, the v2 path is to swap storage to FS or activity-mediated blob — the `maestroCoatCheckPut` API stays stable; storage is workflow-internal.
- **Neutral**:
  - Adds 4 MCP tools, 2 queries, 2 updates to the surface. Within precedent for the schedule and pause/play/shutdown/restore tool families.
  - Estimated implementation cost ~600 LoC, matching issue #318's estimate. Single PR, low risk, additive.

## Alternatives considered

- **Per-conductor session state** — rejected. Conductor restart loses state. Coat-check is ensemble-scoped, not conductor-scoped.
- **Filesystem `~/.agent-tempo/coatcheck/`** — rejected. Workflow-context FS reads are non-deterministic; would require an activity wrapper. No cross-host benefit. Manual cleanup is operator-hostile.
- **External blob store (S3 / sqlite / MinIO) or filesystem-via-activity** — rejected for v1. Adds deployment dependency, requires an activity round-trip on every put/get, host-bound on FS path (breaks the future cross-host-coat-check use case the issue flagged as v2 scope). Reserved as the v2 storage swap if the 32 KiB per-entry cap binds in practice.
- **Single `coat_check` tool with `verb` discriminator** — rejected. Violates the codebase's per-verb tool precedent; harder Zod schemas; lower discoverability.
- **Conductor-only `coat_check_put`** — rejected. Contradicts issue #318's own example (player parks their own review before cueing). Audit trail via `putBy` is sufficient deterrent.
- **Textual `attachmentTicket` convention** ("see ticket abc123" in message body) — rejected. Prevents typecheckable downstream tooling. Structured field is strictly better at the same wire cost.
- **Mutable tickets** — rejected. Issue #318 explicitly out-of-scope; updates create new tickets, keeping semantics predictable.

## Forward-looking notes

- The SSE event source (#94/#95) can absorb a `coatcheck.changed` event type as an additive Phase 5+ follow-up — no v1 SSE spec change needed.
- Cross-host coat-check sharing is explicitly out-of-scope for v1 per issue #318. If/when a distributed deployment surfaces, the maestro-state choice doesn't lock out a future "cross-host coat-check via global maestro" extension — global maestro already aggregates per-ensemble data and could carry shared entries.
- Per-ensemble policy override (e.g. operator-controlled TTL/LRU caps) is a follow-up; not in v1 scope.
- If usage shows the 32 KiB per-entry cap binds (e.g. >10 % of put attempts hit the size validator), swapping the storage backend to activity-mediated FS or an external blob is the v2 lever. The workflow-side API (`maestroCoatCheckPut` etc.) stays stable; the storage swap is workflow-internal.

## References

- [`docs/design/coat-check-pattern.md`](../design/coat-check-pattern.md) — full design (catalog, state-size headroom, lifecycle scenarios, test strategy, alternatives).
- Issue #318 — original proposal with motivation, storage trade-off table, effort estimate, sequencing recommendation.
- `docs/research/094-095-sse-streaming.md` — referenced as an existing manual coat-check workaround (doc-PR-as-shared-reference).
- `src/workflows/maestro.ts`, `src/workflows/maestro-signals.ts` — current per-ensemble maestro state + wire-protocol contracts.
- `src/types.ts` (lines 380-440) — outbox-entry shapes that the `attachmentTicket` field extends.
- ADR 0007 (TempoClient Core / WithSpawn split) — same design-spike template precedent.
