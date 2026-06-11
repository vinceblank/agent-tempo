# v1.8 SA-diet migration (T0.5, #747)

## TL;DR

v1.8 trims agent-tempo's custom Temporal search attributes from **9 to 5** —
only the attributes that appear in visibility *query expressions* stay SAs.
The read-only fields moved to the **workflow memo** (no cap cost, returned in
the same list results); the write-only `AgentTempoAttachmentId` was dropped
outright. Nothing breaks on upgrade; this note covers what changes
operationally and the optional cleanup.

## What changed

| Field | Before | After (v1.8+) |
|---|---|---|
| `AgentTempoEnsemble`, `AgentTempoPlayerId`, `AgentTempoHostname`, `AgentTempoAttachedHost`, `AgentTempoAttachmentState` | search attribute | **unchanged** (filter SAs) |
| `AgentTempoGitRoot`, `AgentTempoPlayerType`, `AgentTempoIsConductor` | search attribute | workflow **memo** (same key names) |
| `AgentTempoPart` | — (workflow state only) | workflow **memo** (new) |
| `AgentTempoAttachmentId` | search attribute | **removed** — zero readers existed |

- Runs started on v1.8+ stop writing the deprecated attributes
  (workflow-side removal is gated behind `patched('v1.8-sa-diet')`, so
  in-flight pre-v1.8 histories replay unchanged).
- All agent-tempo readers dual-read: memo preferred, legacy SA fallback for
  runs started before the upgrade (`src/utils/search-attributes.ts`). The
  fallback is scheduled for removal at the next major.

## Why

Temporal namespaces default to a ~10-custom-Keyword search-attribute cap.
agent-tempo used 9, leaving one slot — recurring operator pain when legacy
`ClaudeTempo*` leftovers tipped the cap and blocked `agent-tempo up`
("Failed to start Workflow"). Post-diet headroom is 5 slots. It also removes
9 billable SA-upsert action sites per session lifecycle on Temporal Cloud
(part of the #747 cost epic).

## Operator impact

1. **Hand-written visibility queries** on `AgentTempoPlayerType`,
   `AgentTempoIsConductor`, or `AgentTempoGitRoot` (Temporal UI, `temporal
   workflow list --query ...`) **silently match nothing for v1.8+ runs** —
   the attributes are simply absent. Read the fields from the workflow memo
   in list output instead, or use agent-tempo's own surfaces (TempoClient ≥
   v1.8, `ensemble` tool, dashboard).
2. **Fresh namespaces** (new installs, new dev-mode profiles) register only
   the 5 filter attributes — nothing to do.
3. **Existing namespaces** keep the 4 legacy attributes registered. That is
   harmless — they just occupy cap slots. agent-tempo never auto-unregisters
   search attributes (privileged operator action).

## Optional cleanup (existing namespaces)

Reclaim the 4 cap slots once you no longer need to *filter* on legacy runs
(the attributes' values remain readable on old runs' visibility records
regardless):

```bash
# Self-hosted
temporal operator search-attribute remove --name AgentTempoGitRoot --namespace default
temporal operator search-attribute remove --name AgentTempoPlayerType --namespace default
temporal operator search-attribute remove --name AgentTempoIsConductor --namespace default
temporal operator search-attribute remove --name AgentTempoAttachmentId --namespace default

# Temporal Cloud
tcld namespace search-attributes remove --namespace <ns> --name AgentTempoGitRoot \
  --name AgentTempoPlayerType --name AgentTempoIsConductor --name AgentTempoAttachmentId
```

Dev server users: the bundled fixture (`temporal server start-dev`) is
ephemeral — restart with the new build and only the 5 attributes are
registered.

## Server floor

The memo write path uses `upsertMemo` (ModifyWorkflowProperties), available
since Temporal server **v1.18.0** and capability-gated by the SDK. The
bundled dev CLI and Temporal Cloud both clear it. Note: on 1.18-era
standard (SQL) visibility, memo *upserts* did not propagate into list
results (start-time memos always do; agent-tempo seeds the memo at
`workflow.start`). Modern dev-CLI versions are unaffected — the T0.5
integration suite asserts list-result memo behavior against the bundled
test server.

## Rollback

Downgrading the daemon/CLI to a pre-v1.8 build is safe: pre-v1.8 code never
reads memos, and v1.8-started runs keep working (their `patched` marker is
in history; pre-v1.8 workers will fail replay of v1.8 histories though —
standard rule: do not downgrade workers below the newest patch marker your
runs have recorded. Restart affected sessions if you must downgrade).
