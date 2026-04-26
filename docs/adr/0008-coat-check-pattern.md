# ADR 0008 — Coat-check pattern for large cues

- **Status**: Accepted (design — implementation deferred to post-Phase-3-PR-4 + 48 h soak)
- **Date**: 2026-04-26
- **Authors**: tempo-architect
- **Related**: [`docs/design/coat-check-pattern.md`](../design/coat-check-pattern.md), issue #318

## Context

Cues today carry full text up to 100 KiB per `MESSAGE_MAX`. Three pain points pushed that ceiling in real ensemble work (per issue #318):

1. **Researcher report fan-out** — 3 K-word reports relayed to N players inflate everyone's context immediately.
2. **Cross-player relay distortion** — hand-summarising another player's content introduces drift risk.
3. **Conductor inbox economy** — every report grows conductor context; long-form output should be parked, not inlined.

The pattern: sender stores content under a ticket (`coat_check_put`); cues carry summary + optional structured `attachmentTicket`; receivers fetch only when they need the full thing.

Storage candidates evaluated:
- Per-ensemble maestro workflow state
- Per-conductor session workflow state
- Filesystem `~/.claude-tempo/coatcheck/`
- External blob store (S3 / sqlite / MinIO)

## Decision

**Per-ensemble maestro workflow state** as the storage backend, with:

- **Wire protocol** — 2 queries (`maestroCoatCheckEntry`, `maestroCoatCheckList`) + 2 updates (`maestroCoatCheckPut`, `maestroCoatCheckEvict`) on `claudeMaestroWorkflow`. Strictly additive.
- **MCP tool surface** — 4 separate tools matching the codebase's per-verb precedent: `coat_check_put`, `coat_check_get`, `coat_check_list`, `coat_check_evict`.
- **`CueOutboxEntry`** gains an additive optional `attachmentTicket?: string` field — old entries omit it; backward compatible by construction.
- **Defaults**: 7-day TTL (min 1h, max 30d), 100-entry LRU cap per ensemble, 1 MiB per-entry size cap.
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
  - Maestro state grows by up to 100 MiB worst case (100 entries × 1 MiB cap). Workflow event history capped at Temporal's 50 MB ceiling — relies on `continueAsNew` rolling history before that limit. Verified safe in design §3.2.
  - Idle-timeout bypass keeps maestro alive while entries exist (up to 30 days at max TTL). Acceptable trade-off — auto-evicting parked entries on idle would defeat the durability point.
  - 1 MiB per-entry cap may bind on very-large reports; v2 path is to swap storage to FS or external blob (the maestro-state choice doesn't lock that out — the SSE-style aggregate abstraction lets storage swap without API change).
- **Neutral**:
  - Adds 4 MCP tools, 2 queries, 2 updates to the surface. Within precedent for the schedule and pause/play/shutdown/restore tool families.
  - Estimated implementation cost ~600 LoC, matching issue #318's estimate. Single PR, low risk, additive.

## Alternatives considered

- **Per-conductor session state** — rejected. Conductor restart loses state. Coat-check is ensemble-scoped, not conductor-scoped.
- **Filesystem `~/.claude-tempo/coatcheck/`** — rejected. Workflow-context FS reads are non-deterministic; would require an activity wrapper. No cross-host benefit. Manual cleanup is operator-hostile.
- **External blob store (S3 / sqlite / MinIO)** — rejected for v1. Adds deployment dependency for a feature whose blob-size needs aren't proven. Reserved as v2 path if the 1 MiB cap binds.
- **Single `coat_check` tool with `verb` discriminator** — rejected. Violates the codebase's per-verb tool precedent; harder Zod schemas; lower discoverability.
- **Conductor-only `coat_check_put`** — rejected. Contradicts issue #318's own example (player parks their own review before cueing). Audit trail via `putBy` is sufficient deterrent.
- **Textual `attachmentTicket` convention** ("see ticket abc123" in message body) — rejected. Prevents typecheckable downstream tooling. Structured field is strictly better at the same wire cost.
- **Mutable tickets** — rejected. Issue #318 explicitly out-of-scope; updates create new tickets, keeping semantics predictable.

## Forward-looking notes

- The SSE event source (#94/#95) can absorb a `coatcheck.changed` event type as an additive Phase 5+ follow-up — no v1 SSE spec change needed.
- Cross-host coat-check sharing is explicitly out-of-scope for v1 per issue #318. If/when a distributed deployment surfaces, the maestro-state choice doesn't lock out a future "cross-host coat-check via global maestro" extension — global maestro already aggregates per-ensemble data and could carry shared entries.
- Per-ensemble policy override (e.g. operator-controlled TTL/LRU caps) is a follow-up; not in v1 scope.
- If usage shows the 1 MiB per-entry cap binds, swapping the storage backend is the v2 lever. The workflow-side API (`maestroCoatCheckPut` etc.) is the abstraction; the storage swap stays internal.

## References

- [`docs/design/coat-check-pattern.md`](../design/coat-check-pattern.md) — full design (catalog, state-size headroom, lifecycle scenarios, test strategy, alternatives).
- Issue #318 — original proposal with motivation, storage trade-off table, effort estimate, sequencing recommendation.
- `docs/research/094-095-sse-streaming.md` — referenced as an existing manual coat-check workaround (doc-PR-as-shared-reference).
- `src/workflows/maestro.ts`, `src/workflows/maestro-signals.ts` — current per-ensemble maestro state + wire-protocol contracts.
- `src/types.ts` (lines 380-440) — outbox-entry shapes that the `attachmentTicket` field extends.
- ADR 0007 (TempoClient Core / WithSpawn split) — same design-spike template precedent.
