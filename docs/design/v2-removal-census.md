# v2.0 Removal Census — every back-compat construct, mapped to its owning P-item

> **Author**: tempo-architect · 2026-06-20 · fulfils @vinceblank's directive *"get rid of ALL the
> old code that avoided breaking changes."* Grounded in a fresh code sweep (supersedes the
> 2026-06-12 scoping census, which predated the v0.27 + v1.8-t06 markers).
> **The A2 reframe (applies to EVERY row):** under the ratified A2 clean cutover, *no pre-2.0 run
> survives* — so every "keep until pre-vX workflows age out / replay-safety" blocker is **VOID in
> 2.0**. The boot guard (#786) guarantees a 2.0 worker never replays a 1.x history. The only real
> remaining coupling is *intra-2.0* (a removed wire query needs its 2.0 callers already migrated).

---

## §A — #787 Workflow `patched()` markers — STRIP ALL (20 call sites)

Delete every `patched()` call and collapse each guarded branch to its post-patch path. Safe because
#786's guard + the cutover mean no 1.x history is ever replayed by a 2.0 worker.

| Marker | File:line |
|---|---|
| v0.10-initial, v0.11-check-and-set-status, v0.13-quality-gates, v0.14-worktrees, v0.15-blocked-detection, v0.18-stages, v0.23-hold-release, v0.25-attachment-lifecycle, v0.26-pending-startup-context | `session.ts:198-212` |
| v1.8-sa-diet, v1.8-memo-observation-fields | `session.ts:230, 237` |
| v0.20-response-requested-blocked | `session.ts:536` |
| v0.27-force-detach-recheck | `session.ts:1071` |
| v0.27-stage-reconcile-reports | `session.ts:1583` |
| v0.26-can-lease-from-attachment | `session.ts:2139` |
| v0.12-cron-schedule | `scheduler.ts:179` |
| v0.17-initial, v1.8-t06-chat-gate, v0.19-ensemble-chat, v0.18-global-maestro | `maestro.ts:159, 168, 734, 903` |

> ⚠ **v0.27 + v1.8-t06-chat-gate are NEW since the 2026-06-12 census** — proof the fresh grep
> mattered. Pre-#787 spike: map each marker → the branch it guards (½-day, census exists).

## §B — #788 Wire-protocol back-compat — STRIP (with intra-2.0 coupling noted)

| Construct | File:line | Removal in 2.0 |
|---|---|---|
| `pendingMessagesQuery` + handler | `signals.ts:88`, `session.ts:649` | Remove. **COUPLED**: first migrate the 5 SDK adapters (claude-api, copilot, opencode, claude-code-headless, mock) + `listen` tool + client-subscribe to `pendingIntakeQuery`. The "reconnect race" caveat is intra-2.0 adapter design, not a 1.x blocker. |
| `pendingResetQuery` + handler | `signals.ts:99`, `session.ts:592` | Remove. Pre-#750 Pi extensions don't exist post-cutover. Pi `workflow-client.ts` fallback drops too. |
| SA dual-read `getWorkflowMetaString/Bool` | `search-attributes.ts:145-166, 206-228` | Simplify to **memo-only** (delete the SA-fallback arm + the TODO at :149). |
| 4 legacy SAs: `AgentTempoGitRoot/PlayerType/IsConductor/AttachmentId` | `sa-preflight.ts:70-78` (`LEGACY_SEARCH_ATTRIBUTES`) | Drop from registration + the list. `AttachmentId` already zero-readers (`session.ts:222-226`). + operator drop runbook. |
| `refreshEnsembleState` V1 activity + 2 fallback branches | `maestro.ts:110-118` (def), `maestro.ts:623, 1090` (branches) | Remove; keep `refreshEnsembleStateV2` only. Pre-#748 maestros gone. |
| legacy `hostProfilesQuery` (superseded by `hostProfilesWithExistenceQuery`) | maestro signals | Drop the superseded two-call form. |
| `guardrailPolicy?` on `enqueueSpawn`; `setPendingStartupContext`/`pendingStartupContext`; `AgentTempoStatus` SA | WIRE-PROTOCOL.md + comments | Already removed from code — **doc/comment cleanup only**. |
| **Drift detector** | `SECTION_TO_KIND` | Update in the SAME commit (process rule). |

## §C — #794 Back-compat shims — STRIP

| # | Shim | File:line |
|---|---|---|
| 1 | `~/.claude-tempo/`→`~/.agent-tempo/` migration + `.migrated-from-claude-tempo` marker | `cli/legacy-migration.ts` (full, ~346) |
| 2 | removed-verb redirect table | `cli/removed-verbs.ts` (full) — *replace with TUI-era hints for ONE release per §C.3, then delete; coordinate with #789* |
| 3 | `httpToken` single-token shim | `http/auth.ts:115-185`, `http/server.ts:206-240`, `config.ts:305-308` → readToken/adminToken only |
| 4 | dual-format poller-identity parser | `utils/hosts.ts:100-120` → `agent-tempo:` prefix only |
| 5 | legacy systemd/launchd service-file cleanup | `cli/daemon-command.ts:414-458` |
| 6 | `CLAUDE_TEMPO_DEBUG` | `utils/grpc-shutdown-guard.ts:59` (**also the #792 residual**) |
| 7 | copilot legacy `./logs` PID fallback | `activities/hard-terminate.ts:76-83` + `cli/commands.ts:2098-2175` |
| 8 | pre-rebrand `claude-tempo:` matcher (#775) | `cli/sa-preflight.ts:100-101` |
| 9 | removed-TUI-commands table | `tui/removed-commands.ts` — **dies with #789; single-owned by #789, not #794** |

## §D — #792 Env unification — NEAR-COMPLETE (fold into #794)

The rebrand already landed: canonical `ENV` constants are all `AGENT_TEMPO_*`. Residual:
- `CLAUDE_TEMPO_DEBUG` (the one live legacy literal) — §C row 6.
- `~/.claude-tempo` dir handling = `legacy-migration.ts` — §C row 1.
- `AGENT_TEMPO_LIFECYCLE_V2` escape hatch already removed — `config.ts:236-238` is comment-only.
- 6 rebrand string leftovers (§C.3) — verify + clean.

→ **Recommendation: fold #792 into #794** — it is not an independent rename effort, just this residual.

## §E — KEEP (explorer false-positives — NOT back-compat; stripping = regressions) ⚠

These were flagged but are **legitimate optional/defensive code**, not "kept-to-avoid-a-break." @vinceblank's
directive targets compat hacks, NOT all optional fields. Stripping these introduces bugs:

| Flagged item | Why it STAYS |
|---|---|
| `SessionMetadata` optional `gitRoot/gitBranch/playerType/worktreePath/sessionId` | Optional by DOMAIN (a player in a non-git dir has no gitRoot; a non-worktree player has no path) — not old-workflow compat. Forcing required = breaks live players. *The pre-v0.25 `adapterId` FALLBACK CHAIN can simplify, but the field stays optional.* |
| `cue` `attachmentTicket?` | Current #318 coat-check feature; optional by design (not every cue has a ticket). |
| `deliverability.ts` phase-undefined handling | Live post-start race-window guard (phase not yet set in the first ms) — current-correctness, NOT back-compat. |
| `broadcast` `includeStale` param | A current API param-name choice; at most a #793 tool-API concern, not a #794 shim. |
| `MEMO_KEYS` optional observation fields | The dual-READ simplifies (§B), but the memo fields stay optional. |

---

## Ownership summary
- **#787** ← §A (20 patched markers). **#788** ← §B (wire + SAs + V1 activity + drift detector).
- **#794** ← §C (9 shims). **#792** ← §D (fold into #794). **KEEP** ← §E.
- **Pre-#787 dependency:** the ½-day marker→branch map spike (§A note).
- **Pre-#788 coupling:** migrate 2.0 SDK adapters to `pendingIntakeQuery` before pruning the legacy query pair (§B row 1).
