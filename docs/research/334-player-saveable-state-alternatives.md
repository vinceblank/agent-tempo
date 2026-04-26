# Player-Saveable-State Primitive — Issue #334 Phase A research

- **Author**: tempo-researcher (claude-tempo[bot] ensemble)
- **Date**: 2026-04-26
- **Status**: Phase A (research) — feeds tempo-architect's Phase B (design + ADR)
- **Tracking issue**: #334 (supersedes the closed #32 `context_reset`)
- **Phase B output (when available)**: ADR + design doc authored by tempo-architect

---

## 1. Prior art

- **Anthropic harness-design blog** — *"Context resets with structured artifacts work better than summarization for maintaining coherence in long-running sessions."* The core pattern: rather than letting the agent silently summarize context, give it an **explicit primitive to commit a curated artifact, then start fresh from that artifact.** The agent's authorial intent — what's worth keeping — is preserved; the model isn't asked to do summarization implicitly under context pressure.
- **Adjacent agentic patterns**:
  - **Aider's `/clear` + `/save`/`/load`** — manual artifact-then-restart, file-based.
  - **Cursor's "Memories"** — single-key per workspace, IDE-mediated, persists across sessions.
  - **OpenAI Assistants `thread.metadata`** — small string blob attached to a thread (16 KB cap, no transcript role).
  - **Gastown's "handoff bundle"** (per prior memory analysis) — transcript fragment + structured handoff dict; no replay primitive.
- **Common shape across all of these**: small structured artifact + opt-in restart-with-artifact. None expose multi-key in v1; multi-key shows up only in editor-class tools (Cursor) and even there it's bounded.
- **Authorial discipline observation**: the blog calls out that *unstructured* save-state degrades fast — the agent puts everything in. Tools that succeed nudge toward a template (Aider's commit-message style; Cursor's "what should I remember?" prompt).

## 2. Existing-codebase audit

**Session workflow state inventory** (per `src/workflows/session.ts`, all carried across `continueAsNew`):
| Bucket | Approx p99 size |
|---|---|
| Metadata (`part`, `input.metadata`, conductor histories) | 10–80 KB |
| `messages` (undelivered only after CAN) | 50–500 KB |
| `sentMessages` (last 50 after CAN) | 5–50 KB |
| `outbox` (pending + processing only after CAN) | 50–100 KB |
| Phase / attachment / processing lifecycle | <2 KB |
| **Aggregate p99** | **~650 KB – 1.2 MiB** per session |

**Why this matters for #334 sizing**: Temporal's CAN-payload ceiling is 4 MiB. The session is already at ~30 % of that ceiling at p99. Adding `playerState` competes with messages, outbox, and conductor histories for the remaining headroom. **The 1 MiB aggregate / 32 KiB per-key caps in #334's sketch are reasonable** — but `playerState` should count toward the **same per-CAN budget the messages buffer already pressures**, not be additive.

**Existing string-payload paths the design can lean on**:
- `recruit`'s `initialMessage` (max ~10 KB, the existing `MESSAGE_MAX`) flows: tool → `RecruitOutboxEntry.initialMessage` → `deliverStartRecruitedSession` activity → embedded in `SessionInput.messages[0].text` OR `heldMessage` (warm-hold case).
- `restart`'s transcript replay (`src/activities/outbox.ts:687–709`, post-#306 commit `17a7858`): query `allMessagesQuery`, slice last `contextMessages` (default 10, max 50), assemble `[from] text.slice(0, PREVIEW_MAX)` summary, signal `receiveMessageSignal` with `responseRequested: false` so the new spawn sees it as its first user message. No `--resume` — fresh UUID always.
- `setPartSignal` / `getPartQuery` — already a player-writable, queryable string slot (1–2 KB), but ensemble-visible and intentionally tiny.

**Coat check (#318 / ADR 0008)**: per-ensemble maestro state, ticket-keyed, **32 KiB per entry, 1.6 MiB aggregate, 50-entry LRU, 7-day TTL, conductor-only evict, audit fields `putBy`/`evictedBy`**. Implementation deferred to post-PR-4 + 48 h soak. Lives on `claudeMaestroWorkflow`, NOT on session.

**Determinism**: adding `playerState: Record<string, {content, savedAt, savedBy}>` to session state is straightforward — `content` is opaque, `savedAt` uses `workflowNow().toISOString()` (SDK-intercepted, replay-safe), `savedBy` is the calling player id from the signal arg. No new external clock or activity round-trip required.

## 3. Evidence on the 5 open questions

**Q1 — Multi-key support: yes/no in v1?**
- **Evidence for "no, single slot"**: Cursor and OpenAI Assistants ship single-key. Authoring discipline (Q4) is harder when there are multiple slots — agents sprawl. Wire surface is smaller. Restart's `loadFromState: true` is unambiguous.
- **Evidence for "yes, multi-key"**: bookmark + checkpoint + handoff are all named in the issue's use cases. Adding multi-key later breaks `restart({loadFromState: true})` semantics (which key?) unless reserved up-front via `loadFromState: true | string`.
- **Lean**: ship multi-key but **default to a canonical `'main'` slot** when `key` is omitted; map `loadFromState: true` to `'main'`. Cheap to limit to N=4 slots in v1.

**Q2 — Restart's interaction (saved state ONLY vs saved-state + transcript replay)**:
- **Evidence**: the existing transcript replay (~10 messages, `responseRequested: false`) is implicit context. Stacking saved state ON TOP of that defeats the "clean slate" use case from #32. The Anthropic blog's "structured artifact" pattern explicitly replaces the transcript.
- **Lean**: when `loadFromState` is set, **suppress transcript replay entirely** by default. Add `restart({ loadFromState: true, transcript: 'replay' | 'suppress' = 'suppress' })` for opt-in stacking.

**Q3 — Storage shape (`string` vs structured)**:
- **Evidence**: the blog and adjacent tools all use opaque string. Structured (e.g. `{summary, tasks, decisions}`) sounds nicer but locks the schema and forces every consumer to upgrade. The `CueOutboxEntry.attachmentTicket` (#318) precedent uses opaque ticket-string — works fine.
- **Lean**: opaque string. If structure is desired, ship a recommended **markdown template in the tool's docstring** (Q4) rather than a typed schema.

**Q4 — Authoring discipline (template vs neutral)**:
- **Evidence**: unstructured save-state degrades. The cheapest nudge is a docstring suggestion: *"Recommend a markdown structure: `## Current task / ## Findings / ## Next steps / ## Open questions`."* The MCP tool description is the right surface (LLMs read it on every call).
- **Lean**: ship the suggested template in the tool description; do not enforce.

**Q5 — `fetch_state` permissions**:
- **Evidence for owner-only**: matches `recall` (any player but scoped to a target session ID — no global enumeration). Matches the issue's "conservative default."
- **Evidence for any-player-in-ensemble**: parity with `recall` (which is ensemble-wide) and `attachment_info`. Cross-player debugging is a stated use case.
- **Lean**: **any player in ensemble can `fetch_state`; only owner can `save_state` / `clear_state`**. Mirrors the existing `recall` / `setPartSignal` asymmetry. Audit via `savedBy` is sufficient.

## 4. Alternatives considered

| Alternative | Verdict | Why |
|---|---|---|
| **Extend coat-check to include "self-tickets"** | Reject | Coat check is ensemble-scoped (maestro state); player-saveable-state is intra-player. Mixing scopes complicates the maestro state shape and conflates ticket-issuance audit (`putBy`/`evictedBy`) with self-write. The two primitives are orthogonal in the issue's own framing. |
| **External storage (FS / blob) instead of workflow state** | Reject for v1 | Workflow-context FS reads are non-deterministic (forces an activity round-trip on every save/fetch). Loses CAN-survival guarantee for free. Same v2 path as coat-check if size pressure binds. |
| **Workflow `update` instead of `signal` for save** | **Lean: update** | Save needs to confirm success (size validation, key-cap enforcement). `signal` is fire-and-forget. `update` matches the existing `submitOutbox` / `claimAttachment` precedent for "tool needs an answer." |
| **Restart-only `loadFromMessage: string` (no save_state primitive)** | Reject | Discards the bookmark / shutdown-handoff use cases. The whole point of #334 is decoupling save from restart. |
| **Workflow query for fetch** | Confirm — query | Read-only by definition; queries are the natural fit; matches `attachmentInfo`/`recallQuery` precedent. |
| **Hard size cap at the signal/update boundary** | Adopt | Match coat-check's 32 KiB per entry / 1 MiB aggregate (#334's sketch). Reject at signal handler; emit a structured error so the LLM can re-try smaller. |

## 5. Recommendations to architect (Phase B input — directional, not decision-locking)

1. **Surface**: 3 MCP tools (`save_state`, `fetch_state`, `clear_state`), 1 workflow update (`savePlayerState`), 1 query (`playerStateQuery`), 1 signal (`clearPlayerStateSignal` — fire-and-forget is acceptable for clear). Restart gains `loadFromState: true | string` flag; default suppresses transcript replay (Q2 lean).
2. **Storage**: `playerState: Record<string, { content: string; savedAt: string; savedBy: string }>` on the session workflow, carried via `continueAsNew`. Same CAN-payload budget as messages — at the **32 KiB / key, 1 MiB aggregate, 4-key cap** levels. Multi-key supported (Q1 lean) with `'main'` as the default slot.
3. **Authoring nudge**: ship the markdown template suggestion in the `save_state` tool docstring (Q4 lean); do not enforce a typed schema.
4. **Permissions**: read-by-any-ensemble-peer / write-and-clear-by-owner-only (Q5 lean). Audit via `savedBy`.
5. **Restart interaction**: `loadFromState` suppresses transcript replay by default; opt-in via `restart({ loadFromState: true, transcript: 'replay' })`.
6. **Sequencing**: independent of #318 (coat-check) and #319 (protobuf migration). Implementable as a single ~450 LoC additive PR per the issue's own estimate. Worth confirming the per-CAN payload headroom under p99 message+outbox load before locking the 1 MiB aggregate cap.
7. **Open follow-up for Phase B**: should `save_state` automatically prune older slots when the 4-key cap is reached (LRU) or refuse with an error and force the LLM to call `clear_state`? The Anthropic blog implies the latter — explicit eviction reinforces authorial discipline. Lean **refuse + error**.

## Sources

- Issue #334 — full design sketch + 5 open questions
- Issue #32 — original `context_reset` framing (closed, superseded by #334)
- [Anthropic harness-design blog — "context resets with structured artifacts"](https://www.anthropic.com/engineering/harness-design-long-running-apps)
- ADR 0008 (`docs/adr/0008-coat-check-pattern.md`) — coat-check sizing + storage trade-offs
- `src/workflows/session.ts` — session state inventory + CAN argument shape (lines 1617–1638)
- `src/activities/outbox.ts:687–709` — restart transcript-replay path (post-#306 commit `17a7858`)
- `src/activities/outbox.ts:331–411` — `deliverStartRecruitedSession` flow for `initialMessage`
- `src/tools/recruit.ts` — `initialMessage` MCP-side handling
- Existing primitives: `recall`, `attachment_info`, `setPartSignal`/`getPartQuery`
