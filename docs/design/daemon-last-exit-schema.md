# `daemon.last-exit.json` — crash-marker schema (devops-owned)

**Status**: implemented (CLI half — this PR). Schema locked by architect
ruling (`docs/research/daemon-resilience-architect-ruling.md` §2 Q3, §4.4,
plus the follow-up ruling routed via cue on 2026-07-14). This file is the
**required companion of the daemon-supervision program (PR-C)** — without
it, a periodic supervisor re-trigger + a give-up `exit(1)` hides a permanent
crash-loop behind a green PID file.

Ownership split: **devops owns the schema** — the canonical type + read/write
helpers live in `src/utils/last-exit.ts` — plus the CLI-side write (stale-PID
detection) and the CLI-side read/display/clear. **Eng adds the daemon-side
write call sites** (worker-give-up, boot-guard-refused, unhandled-fatal,
drain-timeout) in PR-D, importing from `src/utils/last-exit.ts` — they don't
touch the module itself.

## 1. File location and lifecycle

Path: `path.join(AGENT_TEMPO_HOME, 'daemon.last-exit.json')` — derives from
`AGENT_TEMPO_HOME`, never hardcoded, so dev mode (`~/.agent-tempo-dev/`) is
automatically isolated from prod.

- **Written** by whichever process observes the daemon's death first:
  - the daemon itself (PR-D, eng), just before a give-up/refusal/timeout exit
  - the CLI (`src/cli/daemon.ts::getDaemonStatus()`, shipped in this PR),
    when it finds a stale/dead PID that no marker already explains — covers
    crash classes the daemon can't self-report: OOM-kill, `taskkill`, power
    loss, an unhandled fatal that skips its own write
- **FIRST-writer-wins** (not last) — see §3 rationale below. Enforced inside
  `writeLastExitSync()` itself; callers don't need their own existence check.
- **Read + surfaced** once by the next CLI invocation that reaches
  `ensureInfra()` (shipped in this PR), then **deleted** — a one-shot notice,
  not a persistent log.
- **Never** written on a clean shutdown (exit 0). Absence of the file IS the
  "shut down cleanly" signal.

## 2. Schema (as implemented — `src/utils/last-exit.ts`)

```ts
export interface DaemonLastExit {
  schemaVersion: 1;
  reason:
    | 'worker-give-up'
    | 'boot-guard-refused'
    | 'unhandled-fatal'
    | 'drain-timeout'          // the 15s hardExit safety-net timer
    | 'stale-pid-unexplained'; // CLI-detected dead PID, no self-written marker
  worker?: 'shared' | 'host';  // single value — FIRST-to-die wins, see §3
  restarts: number;
  at: string;                  // ISO-8601 UTC
  pid: number;                 // pid of the process that died
  lastFatalMessage?: string;   // truncated to 2KB by the writer
  lastHeartbeatAt?: string;    // ISO-8601 — see the load-bearing note below
  bootedAt?: string;           // ISO-8601
  version?: string;            // agent-tempo package version
}
```

`schemaVersion` bumps ONLY on a removed/renamed/retyped REQUIRED field
(same convention as `src/upgrade/snapshot-v1.ts`); additive optional fields
never bump it.

**`lastHeartbeatAt` is what makes "daemon was down for ~Xh" computable at
all** — `bootedAt` alone gives uptime-before-death, not downtime-after.
Load-bearing write-site constraint: the daemon truncates its own
`daemon.heartbeat` file on its NEXT boot, destroying the mtime — so the
CLI's `stale-pid-unexplained` writer captures it inside
`getDaemonStatus()`, at stale-PID-detection time, before `startDaemon()`
boots the replacement. (Eng's give-up-path writer, pre-exit, reads it fresh
— no such race there.)

## 3. Write semantics — FIRST-writer-wins, and why

A genuine "both workers gave up in the same shutdown" is NOT a shared-outage
scenario: connect/create failures never give up (they reconnect indefinitely
per the architect's Q1 ruling on the worker-resilience design), so a real
dual give-up is two INDEPENDENT poison workloads. The first is causal; a
second write during teardown is likely collateral (worker B's supervisor
reporting a spurious fatal on the way out once the process is already
tearing down). Single `worker` field, no array — first writer keeps its
value, second write is a silent no-op.

This same mechanism is what prevents the **two-writer race** that would
otherwise be a real bug: the daemon writes `'worker-give-up'` (or another
self-diagnosed reason) at exit; the CLI writes `'stale-pid-unexplained'` at
stale-PID detection on a LATER invocation. If the CLI's write could clobber
the daemon's, it would destroy the only forensic evidence of *why* the
daemon died, replacing a specific cause with "unexplained." First-writer-wins
makes this impossible by construction — the CLI's write is a no-op whenever
the daemon already explained itself.

## 4. Read + display (implemented — `src/cli/ensure-infra.ts`)

`printLastExitNoticeIfAny()` runs as step 5 of `ensureInfra()`, after the
daemon step resolves (whether the daemon was already healthy or freshly
started this invocation — a marker can predate this CLI call, e.g. left by
the periodic Windows-Task re-trigger from PR-C). `formatLastExitNotice()`
renders the reason, restart count, worker (if any), first line of
`lastFatalMessage` (if any), and a computed downtime (`now - lastHeartbeatAt`)
when available. Both functions are exported and unit tested independent of
the filesystem.

## 5. Redundancy with `/v1/health.workers`

Deliberate, not accidental: `/v1/health.workers` (per-worker `state`/
`restarts`/`lastFatalAt`/`lastFatalMessage`) is **ante-mortem** — it dies
with the daemon process. `daemon.last-exit.json` is the **post-mortem**
surface for when there's no live daemon left to query. No byte-for-byte sync
obligation between the two, but eng's supervisor should render both from the
same in-memory state object (one source, two renderers) so they can't drift
semantically. The enums are deliberately different vocabularies
(`state: 'gave-up'` vs `reason: 'worker-give-up'`) — do not unify them.
