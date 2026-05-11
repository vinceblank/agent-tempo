# Protobuf migration readiness check-in — 2026-05-11

> Time-boxed reassessment of #319 at HEAD `98ff78d4` (v0.28.0-beta.17).
> Original design: [`docs/design/protobuf-migration.md`](./protobuf-migration.md).
> ADR: [`docs/adr/0009-protobuf-migration-strategy.md`](../adr/0009-protobuf-migration-strategy.md).
>
> **Author**: tempo-architect
> **Question answered**: if we started PR-1 today, what's the residual scope vs the original design? Anything blocking? Anything obviated?

## Verdict

**Still ready to code. No blockers. One minor schema adjustment.**

## Recent main-branch deltas — impact on the plan

| PR | Subject | Impact on the protobuf plan |
|---|---|---|
| **#534** | npm canonical + lockfile tripwire | None. `ts-proto` devDep installs via existing `npm install`; PR-1's `scripts/generate-protos.ts` already keys off `npm run build`. The lockfile lint only fires on tracked non-npm lockfiles, which PR-1 won't introduce. |
| **#538** | copilot recruit pre-flight + host-profile probe | None on the Temporal wire. Pre-flight is local validation *before* the outbox push; outbox shapes unchanged. `HostProfile.availableAgentTypes` already in §2's shared-type surface. |
| **#540** | `agentType` union expanded on HTTP/SSE | Out of scope. ADR 0009 §69 explicitly carves SSE/HTTP off protobuf for v1 — `PlayerSummaryV1` stays JSON. The `AgentType` enum *itself* needs the same expansion in `shared.proto` (see adjustment below). |
| **#531** | aggregate prelude/poll logging | None. Pure observability addition; no payload shapes. |
| **#520 + #536/#539** | claude-code-headless adapter + cue-back fix | Additive. Adapter is in-process; no new Temporal payloads. Recruit args grew `permissionMode`, `dangerouslySkipPermissions`, `model` — all optional fields on the existing `RecruitOutboxEntry`. |

## Adjustment to §5 (shared.proto enums)

The original design enumerated `AttachmentPhase` (0-7). The companion `AgentType` enum was implicit; today `AGENT_TYPES` carries **6 values** that must be reserved in `shared.proto`:

```
UNSPECIFIED=0, CLAUDE=1, COPILOT=2, MOCK=3,
CLAUDE_API=4, OPENCODE=5, CLAUDE_CODE_HEADLESS=6
// reserved 7 to 15;  // future adapters
```

Three new optional `RecruitOutboxEntry` fields gained since the design get proto3 `optional` per §5 convention: `permissionMode` (enum string), `dangerouslySkipPermissions` (bool), `model` (string).

## Determinism audit

Count unchanged: **9 mandatory at-risk sites**, well under §1.2's 50-site rescope threshold. The 4 `agentType ?? 'claude'` sites in `session.ts` shifted line numbers (now 715/898/952/1523, were 600/779/833/1289) but the population is identical.

## Obviated work

None.

## Residual scope vs original design

Unchanged. **~2700 LoC across 3 PRs, 2-2.5 weeks, PR-1 in 3-4 days.** Post-#318 sequencing and v1.0.0 cutover decision both still apply. No new code paths require migration; no design assumptions broken.

---

*Authored by Claude (tempo-architect) under autonomous-backlog dispatch from tempo-conductor.*
