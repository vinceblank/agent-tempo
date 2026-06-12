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

## T0.1 — the `costProfile` axis (#748)

T0.1 (same release) adds `costProfile: 'local' | 'cloud'`
(`AGENT_TEMPO_COST_PROFILE` env > `config.json` > default `'local'`).
Set it persistently with `agent-tempo config set costProfile cloud` (#765);
verify what a running daemon actually resolved via the boot log line
`aggregate: costProfile=<x>, demand-gate <armed|off>` in `daemon.log` —
do not infer the profile from maestro inputs (those can come from a
different process's environment):

- **`local`** (default): byte-identical to pre-T0.1 behavior — 5s maestro
  refresh, legacy scan, no confirm-on-change. Right for dev servers where
  actions are free and snappy refresh is a feature.
- **`cloud`**: maestro refresh uses the SA/memo scan (ensemble-scoped, zero
  per-player queries for v1.8+ runs except the BPM `getActivityState`
  read), cadence stretches 5s → 20s (60s when the daemon has zero SSE
  subscribers), and the daemon aggregate confirms SA-sourced phase
  transitions with one direct query before emitting SSE events.
  **#751/#763 additionally**: the aggregate's 750ms poll demand-gates on
  SSE subscribers — zero subscribers stretches it to a 30s slow reconcile
  (the first board to connect wakes it immediately); per-tick duplications
  are deduped (the snapshot's `listEnsembles` existence gate and `listHosts`
  reuse the tick's prelude, the chat window is fetched once, and
  `isAnySessionHeld` uses an ensemble-scoped scan instead of a third full
  cluster scan + per-player metadata fan-out). Per-tick visibility-list
  budget drops 3 → 2 and raw queries roughly halve; an unwatched daemon's
  aggregate cost drops ~40× on top.
  Note: when an observer connects to an idle cloud maestro, the cadence
  snap-back (60s → 20s) takes effect on the **next refresh completion** —
  the board can feel stale for up to ~60s after opening a dashboard.
  Expected behavior, not a bug.

**⚠ Flipping `costProfile=cloud` does not move the bill until maestros
restart.** Maestro workflows inherit their start-time input across
continue-as-new, so an already-running (per-ensemble or global) maestro
stays on the old 5s/V1 path until it is destroyed/recreated — or until its
natural 5-minute idle exit lets the next `ensure` restart it with the new
input. To apply immediately: `agent-tempo shutdown` + `restore` the
ensemble (or terminate the `agent-maestro-*` workflows; the next CLI/daemon
touch recreates them). The same applies in reverse when flipping back to
`local`. T0.1 also extends the workflow memo with
`AgentTempoWorkDir`/`AgentTempoAgentType`/`AgentTempoGitBranch` — written
by v1.8+ runs regardless of profile (zero extra actions; same single
`upsertMemo` call).

## Rollback

Downgrading the daemon/CLI to a pre-v1.8 build is safe: pre-v1.8 code never
reads memos, and v1.8-started runs keep working (their `patched` marker is
in history; pre-v1.8 workers will fail replay of v1.8 histories though —
standard rule: do not downgrade workers below the newest patch marker your
runs have recorded. Restart affected sessions if you must downgrade).
