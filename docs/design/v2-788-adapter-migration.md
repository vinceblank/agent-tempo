# #788 "Adapter Migration" sub-brief — CORRECTED: it's a pendingReset removal, not a 5-adapter migration

> **Author**: tempo-architect · 2026-06-20 · the §B intake-query coupling for #788.
> **Headline correction:** the census/sub-brief premise ("migrate the 5 SDK adapters to
> `pendingIntakeQuery`, then remove `pendingMessagesQuery`") is **wrong and would be wasted, riskier
> work.** The code shows the clean move is the opposite — **KEEP `pendingMessages`, remove only
> `pendingReset`.** Evidence + the actual plan below.

## What the code actually shows

**`pendingIntake` shape is a clean 1:1 superset** (`signals.ts:113-120`):
`{ messages: Message[] /* identical to pendingMessages */, pendingReset: PendingReset | null /* identical to pendingReset */ }`.

**Every SDK/interactive adapter queries `pendingMessages` ONLY — never `pendingReset`** (reset/clean-wipe
is a Pi-only D14 feature). Six independent call sites (NO shared base poll loop):

| Consumer | Site | Queries |
|---|---|---|
| claude-code (interactive) | `adapters/claude-code/adapter.ts:100` | `pendingMessages` |
| copilot | `adapters/copilot/adapter.ts:667` | `pendingMessages` |
| claude-code-headless | `adapters/claude-code-headless/adapter.ts:434` | `pendingMessages` |
| opencode | `adapters/opencode/adapter.ts:439` | `pendingMessages` |
| claude-api | `adapters/claude-api/adapter.ts:398` | `pendingMessages` |
| mock (dev-only) | `adapters/mock/adapter.ts:301` | `pendingMessages` |
| `listen` tool | `tools/listen.ts:14` | `pendingMessages` |
| client-core (recall fallback) | `client/core.ts:1509` | `pendingMessages` |

**`pendingReset`'s ONLY live consumer is the Pi client's pre-#750 fallback** (`pi/workflow-client.ts:405`,
called only from `fetchIntake`'s fallback arm :393-396). Pi's PRIMARY path already uses `pendingIntake`
(`workflow-client.ts:376`) — Pi is the reference, already migrated.

## Why the "migrate 5 adapters to pendingIntake" premise is wrong
The point of `pendingIntake` (#750) was to halve the **Pi pump's** cost: Pi queries BOTH messages AND
reset, so combining 2→1 query/tick is a real win. The SDK adapters query only ONE thing (messages), so
moving them to `pendingIntake` is **the same 1-query cost plus an ignored `pendingReset` field** — zero
benefit, 6 needless call-site changes, and it would force `pendingMessages` out for no reason. Note the
original scoping §C.3 9-item list named **`pendingReset` (#762)** for removal — NOT `pendingMessages`.
The census over-generalized "both superseded by pendingIntake"; this brief corrects it.

## The actual #788 plan on this axis (low-risk, ~3 edits)
1. **Delete the Pi client's pre-#750 fallback** (`workflow-client.ts`): drop the `combinedIntakeSupported`
   probe flag + the try/fallback in `fetchIntake` (:372-398) + the now-unused `fetchPending`/
   `fetchPendingReset` helpers (:339-342, :405). `fetchIntake` becomes a straight
   `return handle.query(pendingIntakeQuery)`. Safe because the A2 cutover means every 2.0 workflow has
   the `pendingIntake` handler — the pre-#750 fallback is dead code.
2. **Remove `pendingResetQuery`** (`signals.ts:99`) + its handler (`session.ts:592`). Zero consumers after step 1.
3. **KEEP `pendingMessagesQuery`** + its handler (`session.ts:649`) — 8 genuine single-purpose consumers
   (table above). Do NOT touch the SDK adapters; do NOT migrate them.
4. **KEEP `pendingIntakeQuery`** — Pi's combined query.

## The conductor's ordering question — answered
**No mid-deploy inbox-loss risk; it's a clean atomic swap.** Under A2, no pre-2.0 player is live when 2.0
boots (cutover destroyed them; #786 guard blocks any straggler), so the "migrate all consumers before
removing the old query" caution from rolling-deploys **does not apply.** The only ordering that matters is
**intra-code compile order within the single #788 commit**: remove the consumer (Pi fallback, step 1)
before/with the query definition + handler (step 2), so nothing references a deleted symbol. One
coordinated commit, not a phased migration.

## Clean-1:1 check / flags
- **No non-1:1 consumer remains** — because we are NOT migrating the SDK adapters (the only case that
  would have introduced an ignored-field mismatch). All retained consumers keep using `pendingMessages`
  unchanged; Pi keeps using `pendingIntake` unchanged.
- **`listen` (tools/listen.ts:14):** keeps `pendingMessages` (stays). NOTE: scoping §C.1 may deprecate
  `listen` post-T1.1 (doorbell makes the one-shot drain pointless) — if it's removed, that's a #793/§C.1
  decision, independent of this axis; either way `pendingMessages` stays for the adapters.

## Net for the #788 engineer
The "riskiest part of #788" collapses to ~3 mechanical edits: delete the Pi pre-#750 fallback, remove
`pendingResetQuery` + handler, leave `pendingMessages` and the adapters alone. No 5-adapter migration, no
shape-adaptation, no phased ordering. Update WIRE-PROTOCOL.md v2 (remove `pendingReset`; `pendingMessages`
+ `pendingIntake` stay) + drift-detector `SECTION_TO_KIND` same commit.
