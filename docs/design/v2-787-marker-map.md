# #787 Marker → Branch Map — mechanical removal guide

> **Author**: tempo-architect · 2026-06-20 · the §A spike for the #787 engineer.
> Lets #787 execute with zero "is this branch safe to delete?" guesswork.
> Fresh code read 2026-06-20 (supersedes the 2026-06-12 count: it's **11 eager + 9 conditional = 20**,
> not "11 + 6" — the v0.27 ×2 and v1.8-t06 markers postdate that census).

## Overarching safety invariant

**Every marker collapses to its NEW (patched-true) path.** The marker existed ONLY for rolling-deploy
replay safety; the cutover eliminates that need. **Hard precondition: #786's boot guard must be live
before #787 lands** — that guarantees no pre-2.0 run is ever handed to a 2.0 worker, which is the one
and only thing that made the markers necessary. With the guard in, removing all 20 is safe.

**No marker is load-bearing beyond replay-compat** — every conditional's new path IS the current-correct
behavior (verified site by site below). **Zero §E-style "keep" cases in §A.**

## Class 1 — Eager no-ops (11): one-line deletes, guard NOTHING

Bare `patched('x');` calls that record a history marker but branch on nothing. Just delete the line.

| Marker | File:line |
|---|---|
| v0.10-initial, v0.11-check-and-set-status, v0.13-quality-gates, v0.14-worktrees, v0.15-blocked-detection, v0.18-stages, v0.23-hold-release, v0.25-attachment-lifecycle, v0.26-pending-startup-context | `session.ts:198-212` |
| v0.17-initial | `maestro.ts:159` |
| v0.18-global-maestro | `maestro.ts:903` |

## Class 2 — Conditional branch-collapses (9): keep NEW path, delete OLD

| Marker | File:line | OLD path (DELETE) | NEW path (KEEP) | Collapse |
|---|---|---|---|---|
| **v1.8-sa-diet** | `session.ts:230` | write legacy SAs (gitRoot/playerType/isConductor/attachmentId) | write to MEMO (`metaMemo()`, setPart mirror :547) | Drop `saDiet` var; always write memo, delete the `!saDiet` legacy-SA upsert branch (the SA-write fork near :257). **§B-COUPLED — see below.** |
| **v1.8-memo-observation-fields** | `session.ts:237` | omit workDir/agentType/gitBranch from memo | include them (`metaMemo` :250-254) | Drop the var; always include the observation memo. |
| **v0.20-response-requested-blocked** | `session.ts:536` | skip RR-time tracking | track `lastInboundRRTime` when `responseRequested!==false` | Drop `patched(…) &&`. |
| **v0.27-force-detach-recheck** | `session.ts:1071` | clobber on stale attachment | recheck `attachmentId`, don't clobber a fresh claim → `{reaped:false}` | Drop `patched(…) &&`. Correctness guard (#798) — keep new. |
| **v0.27-stage-reconcile-reports** | `session.ts:1583` | skip stage reconciliation | reconcile player status from recent reports | Drop `if (patched(…))`, keep the block. |
| **v0.26-can-lease-from-attachment** | `session.ts:2139` | `HEARTBEAT_INTERVAL_MS` constant | `currentAttachment.leaseMs` (required field) | Drop `usePatchedLease`; pass `leaseMs` directly; delete the `?? HEARTBEAT_INTERVAL_MS` arm (#255 cleanup). |
| **v0.12-cron-schedule** | `scheduler.ts:179` | cron entries not rescheduled (fire-once) | reschedule via `computeNextCronFire` | Drop `patched(…) &&`. **Required for cron to function** — keep new. |
| **v1.8-t06-chat-gate** | `maestro.ts:168` | always fetch chat | skip chat on unwatched cloud ticks (`skipChatThisTick` :736) | Drop `chatGateEnabled` var → `skipChatThisTick = cloudProfile && !observersPresent`. |
| **v0.19-ensemble-chat** | `maestro.ts:734` | skip the whole chat-fetch block | fetch + cache ensemble chat | Drop `if (patched(…))`, keep the block. |

## §A ↔ §B coupling map (which #787 deletion frees which #788 removal)

1. **v1.8-sa-diet (§A) → legacy-SA removal (§B).** Collapsing `saDiet` deletes the last WRITERS of the 4
   legacy SAs. Only then can #788 safely drop them from registration + `LEGACY_SEARCH_ATTRIBUTES`
   (`sa-preflight.ts:70-78`) and simplify the dual-read (`search-attributes.ts:145-166`) to memo-only.
   **Ordering: collapse v1.8-sa-diet (#787) before/with the legacy-SA drop (#788)** — don't drop a
   registration a live write branch still references. (Same beta, so a single coordinated PR pair is fine.)
2. **v1.8-memo-observation-fields (§A) → observation memo (§B/§E).** Collapsing = always write the obs
   memo. §B keeps the memo fields (they're §E-KEEP); only the SA-fallback READ arm goes. Low coupling.
3. **v0.26-pending-startup-context (§A) → already-removed wire (§B).** Pure no-op delete; the
   `setPendingStartupContext`/`pendingStartupContext` constructs are already gone. No live coupling.
4. **NOT a §A coupling — `refreshEnsembleState` V1 (§B) is INPUT-driven, not patched.** The V1/V2 switch
   is `input.costProfile === 'cloud'` (`maestro.ts:164, 907`), NOT a `patched()` marker. So removing the
   V1 activity is a standalone #788 task (always-V2), independent of #787. Flagging so the engineer
   doesn't hunt for a nonexistent marker.

## Cross-marker ordering / nesting
- **v0.19-ensemble-chat (`maestro.ts:734`) and v1.8-t06-chat-gate (`maestro.ts:168/736`) are nested** —
  the chat-gate skip lives INSIDE the ensemble-chat block. Collapse both together; they compose cleanly
  (block kept + gate-true → `if (!(cloudProfile && !observersPresent)) { fetch }`). No conflict.
- Otherwise the markers are independent; order within #787 doesn't matter beyond the §B-coupling note (1).

## Bottom line
All 20 are **mechanically removable** by collapsing to the new path, gated only on #786's guard being
live. The single cross-stream dependency is **#1 (v1.8-sa-diet ↔ legacy-SA drop)** — coordinate that
collapse with #788. No marker hides current-correctness logic that must be preserved as a branch.
