# Heartbeat Burn-In Verification

> **Purpose**: Validates AC #7 from [#249](https://github.com/vinceblank/claude-tempo/issues/249):
> a conductor session left idle for 10+ minutes maintains `Phase: attached` (does not degrade
> to `detached`). Run after any change that touches adapter heartbeat/phase-watcher loops or
> CAN-boundary lease math (`src/adapters/base.ts`, `src/workflows/attachment-math.ts`,
> `src/workflows/session.ts`).

---

## Prerequisites

- `claude-tempo` binary is the version under test
- Temporal dev server running (`claude-tempo server` or `temporal server start-dev`)
- Working directory is a valid git repo (any repo where `claude-tempo up` succeeds)
- Temporal UI accessible at `http://localhost:8233`

---

## Procedure

```bash
# 1. Full teardown to start clean
claude-tempo down --all

# 2. If validating a fresh build, reinstall now
npm install -g claude-tempo@<version-under-test>

# 3. Spin up a full ensemble
claude-tempo up --lineup tempo-dev-team
# (or any lineup — the conductor is what's being validated)

# 4. Leave all sessions completely idle for 12-15 minutes
#    Do not send any messages or interact with any session window.

# 5. Check the conductor's attachment phase via the who_am_i tool
#    (run inside the conductor's Claude Code session)
#    Expect: Phase: attached OR Phase: awaiting
#    (a healthy idle session that has not been cued recently sits in `awaiting`;
#     `attached` and `awaiting` both satisfy AC #7 — the fail state is `detached`)

# 6. Open Temporal UI → Workflows → filter by claudeSessionWorkflow
#    Select the conductor's workflow. In Event History:
#    - heartbeat signal events should appear roughly every 60s
#    - no adapterExited or forceDetach events

# 7. From a second Claude Code session in the same ensemble, inspect the
#    conductor's attachment with the `attachment_info` MCP tool:
#    attachment_info({ playerId: "<conductor-name>" })
#    Expect:
#      - phase: `attached` or `awaiting`
#      - `lease expires` timestamp in the future (should advance by ~60s each
#        time the adapter heartbeats — run twice 60s apart to confirm progression)
#      - `in-flight messages: 0`
#    The adapter breadcrumbs (`heartbeats-delivered=N`) land on the per-session
#    Claude Code stderr stream, NOT `~/.claude-tempo/daemon.log` (the daemon
#    logs only carry daemon-side worker logs). Lease progression is the
#    authoritative durable signal that the adapter loop is live.
```

---

## Pass criteria

- `who_am_i` reports **`Phase: attached`** or **`Phase: awaiting`** (not `detached`, `draining`, or `disconnected` — both `attached` and `awaiting` satisfy AC #7 from #249)
- Temporal UI shows `heartbeat` signal events at the expected cadence (~1/60s for `claude-code`)
- No `adapterExited` or `forceDetach` events in the conductor's workflow history
- `attachment_info` shows `lease expires` advancing between samples taken ~60s apart — the durable proof that the adapter heartbeat loop is extending the lease on each tick

---

## Fail symptoms and what they mean

| Symptom | What it means |
|---------|---------------|
| `Phase: detached` + **no** `heartbeat guard tripped` in per-session Claude Code stderr | A tick-orphan path the #249 fix didn't cover — or a new latent bug. Escalate to research. |
| `Phase: detached` + `heartbeat guard tripped` in per-session Claude Code stderr | A guard path triggered that the fix should have handled; the rescheduling logic missed a case. Reopen #249. |
| `Phase: attached` or `awaiting` but `attachment_info` lease expiry not advancing between samples | Heartbeat signal is not reaching the workflow (push-path bug); separate from #249's tick-orphan fix. |
| `adapterExited` event in workflow history | The adapter process died — check the per-session Claude Code terminal for a crash or OS kill near the timestamp. |
| `WARNING: heartbeat staleness` in per-session Claude Code stderr | Phase-watcher fired before lease reap — heartbeat loop is alive but running late. Investigate scheduler pressure or system sleep. |

---

## Related

- Issue [#249](https://github.com/vinceblank/claude-tempo/issues/249) — message-delivery trilogy fix
- [`docs/concepts.md` § "Heartbeat invariant"](../concepts.md) — cadence contract and log-line reference
- [`src/adapters/base.ts`](../../src/adapters/base.ts) — `tickHeartbeat` / `tickPhaseWatcher` implementation
- [`docs/ops/v0.26-migration.md`](v0.26-migration.md) — companion ops guide
