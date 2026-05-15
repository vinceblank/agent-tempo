# #131 Headless Claude API Adapter — Verification Spike

- **Author**: tempo-researcher
- **Date**: 2026-04-28
- **Branch**: `research/131-claude-api-adapter`
- **Status**: Verification only — assesses whether the merged Phase A + Phase B docs are ready for Phase C dispatch
- **Tracking**: issue #131 (Phase 1, no advisor)
- **Predecessors**:
  - [`docs/research/131-claude-api-adapter-alternatives.md`](131-claude-api-adapter-alternatives.md) (Phase A — PR #339, merged 2026-04-26)
  - [`docs/design/131-claude-api-adapter.md`](../design/131-claude-api-adapter.md) (Phase B design — PR #344, merged 2026-04-26)
  - [`docs/adr/0012-claude-api-adapter.md`](../adr/0012-claude-api-adapter.md) (Phase B ADR — PR #344, merged 2026-04-26)

## TL;DR

The existing three-doc bundle (research + design + ADR, 949 lines total) covers ~90% of the Phase C dispatch surface. **Recommendation: dispatch Phase C now**, with a five-bullet engineer-facing addendum (§4 of this doc) capturing the API drift since 2026-04-26 and three thin documentation gaps. No new spike, no new design pass.

The "Phase-3-PR-4 + #334 implementation" gate from #131's body is **partially resolved**:
- Phase-3-PR-4 was probably v0.25 lifecycle PR-C (merged #133, 2026-04-13) or one of the dashboard #340-followup PRs (PR-3 = #385, merged 2026-04-27). Adapter-layer-touch concerns are no longer in flight.
- #334 design merged (PR #338, 2026-04-26) but implementation is OPEN. **Not a real gate** — the merged design (§1, §12.1) explicitly says #131 doesn't depend on #334 for v1; the two implementations can land in parallel and rebase at merge.

---

## 1. Coverage matrix — what's already in the merged docs

Original spike-brief sections (mapped against existing coverage):

| Brief section | Coverage | Where | Verdict |
|---|---|---|---|
| **1. Anthropic Messages API surface** | | | **80% — gaps in §2** |
| ↳ Streaming SSE event types | Partial — order listed, types not enumerated | research §1 | Gap: no full event-type table; engineer reads Anthropic docs |
| ↳ `content_block_delta` delta kinds | Mentioned (text_delta, input_json_delta) | research §1 | Gap: thinking_delta + signature_delta not called out (relevant for adaptive thinking) |
| ↳ Tool-use loop | Strong — full loop sketch | design §5.3, §8 | OK |
| ↳ System prompt handling | Implicit; covered via cached prefix discussion | design §5.2, §10 | OK |
| ↳ Multi-turn caching | Strong — ephemeral default, 1h available, 4096-token min | research §1, design §5.2 | Gap: max breakpoints (4) not stated; Sonnet 4.6 has 2048-token min not 4096 |
| ↳ Extended thinking | **Not covered** | — | **Real gap — see §2.1** |
| ↳ Error model | Partial — error class hierarchy | research §1 | Gap: 529 overloaded, retry-after, mid-stream error events |
| **2. `@anthropic-ai/sdk` library surface** | | | **75% — version drift in §3** |
| ↳ Current version | Yes — `~0.91.1`, weekly Stainless cadence | research §1, design §3.5 | OK at write time; verify currency in §3 |
| ↳ Streaming helpers | Yes — AsyncIterable preferred over `.on()` | research §1 | OK |
| ↳ Token telemetry | Yes — `usage.{input,output,cache_*}` enumerated | research §1, design §5.6 | OK |
| ↳ SDK vs raw fetch | Yes — alternatives table | research §6 | OK |
| ↳ Beta features | Partial — only `toolRunner` (rejected) called out | research §6 | Gap: advisor tool (Phase 2 dependency) added in 0.87.0 — worth noting |
| ↳ Bundle size / module format | Not covered | — | Minor gap — Node 18+ dual ESM/CJS; engineer-level |
| **3. Bridging MCP tools** | | | **100%** |
| ↳ Tool schema transform | Strong — 10-LoC mapper sketched | design §4.2 | OK |
| ↳ `tool_use` dispatch | Strong | design §4.3 | OK |
| ↳ In-process MCP via `InMemoryTransport` | Locked + sketched | design §4.1, §8 | OK |
| ↳ v1 scope (MCP-only, file ops out) | Locked | design §4.4, ADR | OK |
| **4. Lifecycle alignment with `SdkAttachment`** | | | **100%** |
| ↳ `SdkAttachment` contract walk-through | Strong | design §2 | OK |
| ↳ Copilot as reference | Yes | design §2 | OK |
| ↳ AbortController + `onSuperseded` | Locked + sketched | design §6.1, §8 | OK |
| ↳ No reconnect opt-in | Locked | design §6.2, ADR | OK |
| **5. Cost / telemetry surface** | | | **95%** |
| ↳ Per-turn token accounting | Stderr-log shape locked | design §5.6, ADR | OK |
| ↳ Wire-protocol signal deferred | Locked | design §5.6 | OK |
| ↳ Search-attribute candidates | Not enumerated | — | Defer to Phase 2 (no consumer in v1) |
| **6. Sequencing / dependency analysis** | | | **Needs 2026-04-28 update** |
| ↳ Phase-3-PR-4 status | Open at write time | design §12 | **§3.4 below — likely resolved** |
| ↳ #334 status | Design just landed at write time | design §12 | **§3.4 below — design merged, impl pending, NOT a gate** |
| ↳ `recruit.adapter` collisions | Yes — additive on enum | design §3.1 | OK |
| **7. Open design decisions for architect** | | | **100% — all locked** |
| ↳ 8 questions enumerated by research | All locked in design §0 + ADR | design §0, §13; ADR | No open questions |

**Summary**: Phase A + Phase B together fully discharge the spike brief except for: extended thinking + tool use interaction (§2.1), API drift since 2026-04-26 (§3), and the dependency gate update (§3.4). Two are documentation-class gaps; one is sequencing.

---

## 2. Genuine gaps — what an implementing engineer would still need

These are the items I'd flag in PR review if Phase C arrived without them. Each is small (≤30 LoC of design or 1–2 paragraphs of doc), but missing them risks a 400 error or subtle misbehavior on first run.

### 2.1 Adaptive thinking + tool use interleaving

**Severity: Real — could cause 400 on the second turn.**

The merged design's tool-use loop skeleton (§5.3 and §8) handles `tool_use` and `text` content blocks but says nothing about `thinking` content blocks. As of mid-2026, Anthropic's adaptive-thinking models (Opus 4.7, Sonnet 4.6 default) **automatically interleave thinking between tool calls** — what was previously gated behind `interleaved-thinking-2025-05-14` is now baseline.

Concretely, a tool-use turn returns content blocks like:

```
[ thinking_block, tool_use_block ]
```

After dispatching the tool and pushing the assistant message back into `messages` for the next turn, the engineer **must include the `thinking` block (with its `signature`) verbatim** alongside the `tool_use` block. The Anthropic API uses the signature to validate reasoning continuity; stripping thinking blocks breaks coherence and *may return 400* per Anthropic's docs.

**What the design says** (§8 skeleton, line ~559):
```ts
messages.push({ role: 'assistant', content: /* tool_use blocks */ });
messages.push({ role: 'user', content: toolResults });
```

**What it should say**:
```ts
// Push the FULL assistant content array — thinking + tool_use blocks together.
// Stripping `thinking` (or its `signature`) breaks reasoning continuity and may 400.
messages.push({ role: 'assistant', content: assistantMessage.content });
messages.push({ role: 'user', content: toolResults });
```

Forward-compat angle: when Phase 2 advisor strategy lands, this becomes more important — advisor consultations rely on thinking-block continuity.

### 2.2 Opus 4.7 parameter rejections

**Severity: Real — wrong constructor sets 400 on every call.**

Opus 4.7 (GA 2026-04-16, ten days before the design was written) **rejects** the following Messages API parameters with 400 `invalid_request_error`:

- `temperature`
- `top_p`
- `top_k`
- `budget_tokens` on the `thinking` block (Opus 4.7 is **adaptive-only**: `thinking: { type: 'adaptive' }`, NOT `thinking: { type: 'enabled', budget_tokens: N }`)

The merged design's worked skeleton (§8) doesn't reference any of these — so the design itself is fine. The risk is an engineer cargo-culting from older Anthropic samples (which routinely include `temperature: 0.7`) or from claude-code's CLI flags. **Worth a one-line warning in the engineer-facing addendum** (§4 below).

Default `thinking.display` on Opus 4.7 is `'omitted'` — empty `thinking_delta` events will stream. If the adapter wants reasoning visible in logs/telemetry, set `thinking: { type: 'adaptive', display: 'summarized' }`. (Optional. The design's stderr-log telemetry doesn't currently surface reasoning, so this is a future-friendliness note rather than a blocker.)

### 2.3 Cache breakpoint count + Sonnet 4.6 minimum

**Severity: Minor — performance, not correctness.**

Two prompt-caching facts the merged docs omit:

1. **Maximum 4 `cache_control` breakpoints per request.** With ~30 tempo MCP tools, the design's "system + tools head" caching strategy uses 1 breakpoint, leaving 3. The conversation-history walking-prefix pattern (§5.2) needs at most 1 more per turn. We're well under budget — but a future Phase 2 that adds more cache discipline (e.g., per-player conversation-segment caching) needs to know the limit.
2. **Minimum cacheable prefix is 2048 tokens on Sonnet 4.6** (vs 4096 on Opus 4.7 / Haiku 4.5). The merged research doc claims "4096 tokens on Opus 4.7" — accurate for Opus, but a Sonnet-tier player would cache earlier. Since the design pins `claude-opus-4-7` as default (§3.5), the 4096 number is operationally correct for v1. Update for completeness only.

### 2.4 Streaming `input_json_delta` partial parse

**Severity: Minor — the design's prose is correct but skeletal.**

The design (§5.3) says "on input_json_delta → accumulate input json" — accurate. What it omits: **don't `JSON.parse` until `content_block_stop` fires**. The model streams tool-call arguments as fragmentary string chunks (e.g., `{"loc`, `ation":"Pa`, `ris"}`) and intermediate states are not parseable JSON. The Anthropic SDK's `MessageStream` helper accumulates and emits parsed objects via `inputJsonStream` events; if the engineer uses raw async-iteration over `MessageStreamEvent`, they need to do this themselves. One-line code-comment fix at implementation time.

### 2.5 Mid-stream error events

**Severity: Minor — design doesn't break, but error-recovery is undocumented.**

A 200 OK that opens an SSE stream and then emits an `error` SSE event mid-flight is a real failure mode (typically `overloaded_error` mid-generation during a long tool-use turn). The merged design (§6.1) wires `AbortController` for lease revocation but doesn't address this. The Anthropic SDK throws from the async iterator; the engineer needs to wrap stream consumption in `try { ... } catch { ... }` and either retry the whole turn or surface the error to the workflow.

This is engineer-level, not design-level — but worth a sentence in the addendum.

---

## 3. Verification deltas — facts in the existing docs that need correction

Light validation against current Anthropic docs / npm / TypeScript SDK CHANGELOG (verified 2026-04-28).

### 3.1 Model identifier — design uses old date-suffix convention

| Where | Existing claim | Current truth |
|---|---|---|
| Design §3.5, §8, ADR | `claude-opus-4-7-20250115` | **`claude-opus-4-7`** (no date suffix; Anthropic dropped date-suffix convention by 2026 for non-Bedrock model ids on the direct API) |

Anthropic's GA announcement for Opus 4.7 (2026-04-16) ships the model with id `claude-opus-4-7`. The `-20250115` suffix in the design appears to have been speculative / pattern-matched from older `claude-3-haiku-20240307`-style ids.

**Impact**: cosmetic at design level, real at impl. Engineer must use `claude-opus-4-7` in the constants-pinned default and `^claude-[a-z0-9-]+$` regex in the `recruit.model` pre-flight check (which already permits both forms).

### 3.2 SDK version — currency check

| Where | Existing claim | Current truth |
|---|---|---|
| Research §1, design §3.5, ADR | `@anthropic-ai/sdk@~0.91.1` (2026-04-24) | **0.91.1 still current as of 2026-04-28** (4 days old). Cadence has been weekly through April. |

A 0.92.0 may land before Phase C engineer pickup; the **tilde, not caret** discipline (design §3.5) handles this correctly. No change needed.

Note for engineer: the SDK 0.87.0 added an advisor-tool beta surface (relevant for Phase 2). 0.91.0 added "CMA Memory" public beta. Neither affects Phase 1.

### 3.3 Cache discipline — minor language correction

| Where | Existing claim | Current truth |
|---|---|---|
| Design §5.2 | "place under `cache_control: { type: 'ephemeral' }` on the system prompt + tools head" | Cache `cache_control` on the **last tool** in the `tools` array (caches the entire array as a single prefix prefix block) and on the **last system content block** — not "head" (which would cache nothing useful) |

The design's prose is slightly inverted relative to how `cache_control` actually works (cache_control marks where the cached prefix *ends*, so the breakpoint goes at the *end* of what you want to cache, not the head). The merged docs are 90% correct in intent but engineer-level reading of Anthropic's caching docs would correct this on its own.

### 3.4 Sequencing gate — 2026-04-28 status

This is the gate question the conductor flagged explicitly.

**The gate from #131's body** (and inherited into design §12.2): "drop after current Phase-3-PR-4 + #334 implementation finishes (so we don't have multiple adapter-layer-touching PRs in flight)."

**As of 2026-04-28:**

| Concern | Status | Action |
|---|---|---|
| **"Phase-3-PR-4"** — exact reference unclear | No PR with that literal title; v0.25 lifecycle PR-C (#133, merged 2026-04-13) and the dashboard #340-followup PR-3 (#385, merged 2026-04-27) are the most plausible referents. | Treat as **resolved**. The dashboard wave (PRs 379/382/384/385) has progressed; remaining PRs in that epic touch dashboard/TUI, not the adapter layer. |
| **#334 implementation** | Design merged (PR #338, 2026-04-26). Implementation OPEN. | **Not a real adapter-layer-touch concern.** The merged design (§1, §12.1) explicitly states #131 "doesn't depend on #334 for v1" and "composes naturally with #334 in v2 (auto-compact on context overflow)." The two implementations touch entirely separate code paths (#334 = workflow state shape; #131 = new adapter directory). They can land in parallel; rebase discipline at merge handles any overlap. |

**Real adapter-layer concurrency concern check:** the only currently in-flight adapter-touching work is the mock-adapter PR-3 (#385, merged 2026-04-27 — done) and the followup PR-1 (#382, merged) for #340-followup. No open adapter-layer PRs. **Phase C dispatch is clear.**

### 3.5 Adapter conformance suite — already noted in design §9.2

The design's §9.2 already corrects the original Phase A claim about a single `adapter-conformance.test.ts` file. As of 2026-04-28 the conformance cases live distributed across `test/adapter-{id}-lifecycle-v2.test.ts` and targeted suites; the design tells the engineer to add `test/adapter-claude-api-lifecycle.test.ts` alongside. Verified — the design is correct on current test layout. No action.

---

## 4. Recommendation — Phase C dispatch with engineer-facing addendum

**Move directly to Phase C dispatch.** Conductor option (a).

The merged research + design + ADR are sound. The 8 open questions are locked with defensible rationales. The locked decisions match the research's directional leans, with crisp tightenings (in-process MCP transport via `InMemoryTransport`; stderr-only telemetry deferring the wire signal). The ~825–1,125 LoC estimate is calibrated.

The five gaps and three deltas in §2–§3 above are documentation-grade or correctness-at-impl-time, not design-grade. They don't change any of the locked decisions. An engineer reading the design + Anthropic docs in tandem would catch most on their own; the ones that could bite (thinking-block round-trip in §2.1, model id in §3.1) are best addressed via a brief engineer-facing addendum that lives at the top of the design doc rather than as a separate spike.

### 4.1 Engineer-facing addendum I'd inline at the top of `docs/design/131-claude-api-adapter.md`

A 30-50-line "Verification addendum (2026-04-28)" block (file owner: Phase C engineer at impl time; this verification doc supplies the content), pre-pending the design with:

1. **Model id** — use `'claude-opus-4-7'` (no date suffix) as the constants-pinned default; the design's `'claude-opus-4-7-20250115'` is incorrect.
2. **Opus 4.7 parameter rejections** — do NOT pass `temperature`, `top_p`, `top_k`, or `thinking.budget_tokens` to `messages.create()` on Opus 4.7; they 400. Use `thinking: { type: 'adaptive' }` only. Default `thinking.display` is `'omitted'`; set to `'summarized'` if surfacing reasoning to logs.
3. **Adaptive thinking + tool use** — when pushing the assistant turn back into `messages` for the next iteration of the tool-use loop, include `thinking` content blocks (with their `signature`) verbatim alongside `tool_use`. Stripping them breaks reasoning continuity and may 400.
4. **`input_json_delta` partials** — accumulate `partial_json` strings; do NOT `JSON.parse` until `content_block_stop` fires for the tool_use block.
5. **Mid-stream error events** — wrap the streaming for-await loop in try/catch; the SDK throws on `error` SSE events (529 overloaded mid-generation, 500 api_error). On throw, fail the turn cleanly — `processingEnd` fires in the inherited `finally` and the workflow's outbox retries on next deliver.

That addendum + the existing design + ADR is sufficient for engineer pickup. **No further spike needed.**

### 4.2 What I'd skip

- ❌ A separate gap-spike doc (this verification doc covers the gaps inline; engineer reads two docs not three).
- ❌ Re-running Phase A — full SDK + Messages API research forks landed during this verification and confirm the existing docs are 80–90% accurate.
- ❌ Waiting on #334 implementation — the design proves they're independent.

### 4.3 Pre-dispatch ask — done in this PR

✅ **Done in this PR.** The 5-bullet addendum from §4.1 above is inlined as a `## Verification addendum (2026-04-28)` section in `docs/design/131-claude-api-adapter.md`, immediately preceding `§1. Why now`. Engineer pickup proceeds against the design as-written.

---

## 5. Sources

- Existing agent-tempo docs (read 2026-04-28):
  - `docs/research/131-claude-api-adapter-alternatives.md` (PR #339)
  - `docs/design/131-claude-api-adapter.md` (PR #344)
  - `docs/adr/0012-claude-api-adapter.md` (PR #344)
- Verification fork: Anthropic Messages API surface (mid-2026) — covers SSE event types, tool use loop, prompt caching limits, adaptive thinking + tool use interaction, error model, current model identifiers
- Verification fork: `@anthropic-ai/sdk` library surface (April 2026) — covers v0.91.1 (2026-04-24) currency, beta surface, retry semantics, type exports
- Anthropic public docs:
  - [Streaming](https://platform.claude.com/docs/en/build-with-claude/streaming.md)
  - [Tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview.md)
  - [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching.md)
  - [Errors](https://platform.claude.com/docs/en/api/errors.md)
  - [Models overview](https://platform.claude.com/docs/en/about-claude/models/overview.md)
  - [What's new in Claude Opus 4.7](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-7) (GA 2026-04-16)
- [`@anthropic-ai/sdk` CHANGELOG](https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/main/CHANGELOG.md)
- GitHub: `gh issue list/view`, `gh pr list/view` — verified PR #133 (v0.25 PR-C), #338 (#334 design), #379/#382/#385 (dashboard followup), #339/#344 (#131 phase A/B) merged states as of 2026-04-28.
