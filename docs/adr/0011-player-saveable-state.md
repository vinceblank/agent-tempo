# ADR 0011 — Player-saveable state primitive

- **Status**: Accepted (design — implementation deferred to scheduled engineer pickup)
- **Date**: 2026-04-26
- **Authors**: tempo-architect
- **Related**: [`docs/design/334-player-saveable-state.md`](../design/334-player-saveable-state.md), [`docs/research/334-player-saveable-state-alternatives.md`](../research/334-player-saveable-state-alternatives.md), issue #334 (supersedes closed #32 `context_reset`)

## Context

Issue #334 proposes a per-player saveable-state primitive: each session workflow gains a curated state slot the player itself writes to and which can seed the next session via `restart({ loadFromState: ... })`. The primitive subsumes #32 (`context_reset`) and unlocks five use cases — voluntary context refresh, shutdown handoff, mid-session bookmark, debugging snapshot, cross-restart continuity — without exploding the MCP tool surface.

#334's sketch left five open questions for the design spike:

1. **Multi-key vs single-slot** in v1
2. **Restart's interaction**: state ONLY, or state + existing transcript replay
3. **Storage shape**: opaque string vs structured `{ summary, taskState, decisions }`
4. **Authoring discipline**: enforced schema vs docstring nudge
5. **`fetch_state` permissions**: owner-only vs any-peer-in-ensemble

It also flagged a **load-bearing sizing concern**: the existing per-session p99 footprint (~650 KiB – 1.2 MiB, ~17–30 % of Temporal's 4 MiB CAN-payload ceiling) is already tight, and #334's sketched `~1 MiB aggregate cap` would push the session toward the limit at p99. Phase A research (`docs/research/334-player-saveable-state-alternatives.md`, PR #337) verified the audit, surveyed prior art (Anthropic harness-design blog, Aider, Cursor, OpenAI Assistants, Gastown), and produced directional leans on each open question.

The design spike was tasked with locking the five decisions, verifying or revising the sizing cap, and specifying the wire-protocol additions before engineer pickup.

## Decision

**Adopt the primitive as designed in [`docs/design/334-player-saveable-state.md`](../design/334-player-saveable-state.md).** The design lives there; this ADR records the decision.

Headline locked-in choices:

- **Storage**: per-session workflow state, `playerState: Record<string, { content, savedAt, savedBy }>`, carried via `continueAsNew`. Distinct scope from coat-check (#318 / ADR 0008) which is per-ensemble maestro state.
- **Sizing — tighter than #334's sketch**: **32 KiB per key, 4 keys, 128 KiB aggregate structural max**. Verified against the existing p99 footprint — adding 128 KiB to a 1.2 MiB p99 session = ~1.33 MiB (~33 % of 4 MiB ceiling), comfortably within all three Temporal payload constraints.
- **Wire surface — strictly additive**: 2 updates (`savePlayerState`, `clearPlayerState`), 2 queries (`playerState`, `playerStateKeys`); `RestartOutboxEntry` gains optional `loadFromState` + `transcript` fields. Old payloads omit the new fields and behave exactly as today. Names registered in `docs/WIRE-PROTOCOL.md`; drift detector enforces parity.
- **MCP tools**: `save_state`, `fetch_state`, `clear_state` — 3 tools, matching #334's surface sketch.
- **Saturation behaviour**: when a 5th distinct key is attempted with 4 slots full, `savePlayerState` rejects with `PlayerStateSlotsFull` (structured `ApplicationFailure.nonRetryable`) listing existing keys. **No LRU eviction** — explicit `clear_state` required. Reinforces authorial discipline (per Anthropic harness-design blog).
- **Permissions — structural at the tool layer**: `save_state` and `clear_state` have no `playerId` arg (writes go to self's workflow). `fetch_state` accepts an optional `playerId` (default self) — peers can read any other player's state, mirroring `recall`/`attachment_info` ergonomics. Audit via `savedBy`.
- **Restart integration**: `loadFromState: true | string` flag on `RestartOutboxEntry`; `true` resolves to default key `'main'`. When set, transcript replay is suppressed by default (`transcript: 'suppress'`); opt-in stacking via `transcript: 'replay'`. Saved-state delivery uses `from: 'self-restart'` as a stable system-emitted marker so the new session distinguishes curated state from prior chat.

Five open questions — locked answers:

| Q | Locked decision |
|---|---|
| Multi-key in v1? | **Yes**, default `'main'`, max 4 slots |
| Restart interaction? | `loadFromState` **suppresses** transcript replay by default; opt-in stacking via `transcript: 'replay'` |
| Storage shape? | **Opaque string** with markdown-template docstring nudge |
| Authoring discipline? | **Docstring nudge** only; no typed schema |
| `fetch_state` permissions? | **Read-by-any-peer**; write/clear self-only (structural — no `playerId` arg) |
| Saturation behaviour (research follow-up) | **Refuse + structured error**; no LRU |

## Consequences

- **Positive**:
  - **Single primitive, five use cases** — `save_state` + `restart({ loadFromState })` covers context refresh, shutdown handoff, bookmark, debugging snapshot, cross-restart continuity. Closes #32 with a generalisation, not a duplicate tool.
  - **Authorial control over context survival** — the player decides what's worth keeping, vs the current implicit "last 10 messages" replay. Solves the lossiness #334 cites for context-pressure cases.
  - **Strict additivity** — no breaking changes; old workflow runs without the field continue to work; tooling (TUI, dashboards) sees the new fields gradually.
  - **Sizing math is honest** — the 128 KiB structural max is verified against measured p99, not aspirational. No CAN-payload-headroom regression.
  - **Permissions are structural, not enforced** — write operations have no `playerId` arg; the workflow doesn't need an authorisation layer. Smaller code, fewer bugs.
  - **Refuse + structured error preserves authorial discipline** — silent LRU eviction would let the LLM sprawl across slots; explicit `clear_state` keeps the slot economy honest.
- **Negative**:
  - **Per-key 32 KiB binds tightly for huge handoffs** — a player attempting to dump >32 KiB of context falls back to the manual doc-PR pattern (`docs/research/<topic>.md`) until v2 storage swap warrants. Mirrors coat-check's same trade.
  - **Slot cap of 4 may surprise multi-task players** — the rejection error lists existing keys to make the LLM's next move obvious, but the experience is still louder than silent eviction. Telemetry will show whether 4 is right; raising the cap is a v2 lever.
  - **`fetch_state` peer reads are unaudited at read time** — the `savedBy` field captures who wrote, but no record exists of who read a peer's state. Acceptable for v1 (consistent with `recall`/`attachment_info`); revisit if privacy concerns emerge.
  - **`from: 'self-restart'` is a new system identity** — adds one more stable identity (alongside `'maestro'`) the TUI/log filters need to know about. Documented; minor surface growth.
  - **Workflow versioning marker required** — restart's `loadFromState` branch wraps in `patched('v0.27-loadFromState-on-restart')` so a rolling deploy stays safe. Standard practice.
- **Neutral**:
  - **3 MCP tools, 2 updates, 2 queries** — within precedent for the schedule (`schedule`, `unschedule`, `schedules`) and pause/play/shutdown/restore tool families.
  - **~450 LoC implementation cost** matches #334's own estimate. Single PR, additive, low risk.
  - **Independent of #318 (coat-check) and #319 (protobuf)** — none of the three sequence each other. Drops in any quiet slot.

## Alternatives considered

- **Single-slot only in v1, multi-key as v2** — rejected. Issue #334 enumerates four named slot use cases ('main', 'workInProgress', 'safetyCheckpoint', plus debugging). Adding multi-key later breaks `loadFromState: true` semantics (which key?) without a v1 reservation. Better to ship multi-key now with a 4-slot cap.
- **Aggregate cap = 1 MiB (per #334's sketch)** — rejected. With slots capped at 4 and per-key at 32 KiB, the structural max is 128 KiB; a 1 MiB ceiling is dead weight. Sizing is honest only at the slot/per-key level.
- **LRU eviction at slot saturation** — rejected. Anthropic harness-design blog argues explicit eviction beats silent — agents that get nudged toward authorial discipline outperform agents whose state sprawls under silent housekeeping. The convenience win isn't worth the discipline loss.
- **Storage on per-ensemble maestro state (coat-check style)** — rejected. Coat-check is ensemble-scoped (cross-player handoff); player-state is intra-player. Mixing scopes complicates maestro state, conflates ticket-issuance audit with self-write, and breaks the "the player owns its own state" framing. The two primitives are orthogonal in #334's own framing.
- **Filesystem `~/.claude-tempo/playerstate/<player>/<key>`** — rejected. Workflow-context FS reads are non-deterministic (forces an activity round-trip on every save/fetch). Loses CAN survival for free. Same v2 path as coat-check if size pressure binds.
- **Workflow signal (fire-and-forget) for save** — rejected. Save needs to confirm size validation + slot-cap enforcement; signal can't ack. Update is the natural fit (matches `submitOutbox`, `claimAttachment`, etc.).
- **Restart-only `loadFromMessage: string` (no save_state primitive at all)** — rejected. Discards the bookmark / shutdown-handoff / debugging-snapshot use cases. The whole point of #334 is decoupling save from restart.
- **Structured storage shape** (`{ summary, tasks, decisions }` schema) — rejected. Locks the schema; every consumer upgrades in lockstep. Adjacent tools (Aider, Cursor, Anthropic harness, OpenAI Assistants) all use opaque string. Markdown template via tool docstring is the cheap nudge.
- **Owner-only `fetch_state`** — rejected. Mirrors `recall` is the easier mental model; debugging is a stated use case; `savedBy` audit is sufficient. The conservative-default argument lost to ergonomic parity.
- **`fetch_state` returns metadata-only when `key` is omitted (slot enumeration mode)** — rejected. Overloaded return shape complicates types. The dedicated `playerStateKeysQuery` covers slot enumeration without surface bloat (operator/debugging tool only — not exposed as a separate MCP tool in v1; reachable via `temporal workflow query`).

## Forward-looking notes

- **Slot-cap raise above 4** is the natural v2 lever if telemetry shows >10 % `PlayerStateSlotsFull` rejection rate. Telemetry hook: log the rejection event with the calling player's name; aggregate across the daemon log.
- **`playerState.changed` SSE event** is an additive Phase 5+ extension on the SSE wire (#94/#95) — not v1 scope; no v1 SSE spec change needed.
- **Cross-player write delegation** ("operator pre-seeds a recruited player's state") is out of scope for v1. If it becomes a use case, add a `playerId` arg to `save_state` plus an explicit permission gate. Not breaking — additive.
- **Transcript-replay deprecation** — once `save_state` adoption is high enough that implicit replay becomes low-value, the existing replay path may shrink to a flag-on opt-in. Not v1; depends on usage data.
- **Wire-protocol additions post-v1.0** must register with the protobuf field-number plan in `protos/README.md` reservations log when #319 (protobuf migration) lands. Drift detector enforces.
- **A v2.0.0 protobuf-incompatible change** would carry `playerState`'s `.proto` definitions through the same operator-coordinated cutover #319 designs.

## References

- [`docs/design/334-player-saveable-state.md`](../design/334-player-saveable-state.md) — full design (11 sections, sizing math, interface skeletons, test strategy)
- [`docs/research/334-player-saveable-state-alternatives.md`](../research/334-player-saveable-state-alternatives.md) — Phase A research (PR #337) — prior art, codebase audit, evidence on the 5 questions
- Issue #334 — original proposal with motivation, 5 open questions, sequencing note
- Issue #32 — original `context_reset` framing (closed, superseded by #334)
- ADR 0007 (TempoClient Core/WithSpawn split), ADR 0008 (coat-check pattern), ADR 0009 (protobuf migration) — same design-spike template precedent
- `src/workflows/session.ts:1617-1638` — current CAN-input shape (the addition extends)
- `src/workflows/signals.ts` — current wire-protocol surface
- `src/activities/outbox.ts:687-709` — restart transcript-replay path (`loadFromState` extends)
- `docs/WIRE-PROTOCOL.md` — wire contract registry; drift detector enforces parity
- Anthropic harness-design blog — *"Context resets with structured artifacts work better than summarization for long-running agents."*
