# Daemon restart runbook — getting pid 28676 onto fixed `v2` code

**Status**: ready to execute. **Blocked on two gates** (per conductor):
1. PR-B (query-collapse, 4× load cut) must land on `v2`.
2. Explicit user go — this is the user's call, not automatic.

Do not run any step past §3 (pre-flight) until both gates clear.

## 0. Why this isn't "just merge to v2 and it's fixed"

The live daemon (**pid 28676**, confirmed via `GET /v1/health`: `version:
"2.0.0-beta.2"`, `uptimeMs: 5584075` ≈ 93min at time of writing, `rss:
991862784` ≈ 992MB and climbing) runs the **npm-global install** at
`C:\Users\vince\AppData\Roaming\npm\node_modules\agent-tempo` — a real
npm-installed package directory (not a symlink), version `2.0.0-beta.2`,
installed 2026-06-25. **Merging PRs to `v2` changes nothing this process
executes.** It will keep running the pre-fix code (no PR-A budget raise, no
PR-F log rotation, no PR-C real `--foreground`) until something replaces
what's on disk at that path — or replaces what `agent-tempo` on `PATH`
resolves to.

Confirmed by direct inspection (`where agent-tempo`):
```
C:\Users\vince\AppData\Roaming\npm\agent-tempo
C:\Users\vince\AppData\Roaming\npm\agent-tempo.cmd
```
`~/.agent-tempo/bin` (the global-wrapper's own bin dir) is **not on PATH at
all** on this machine — confirmed by scanning `$PATH`. So the wrapper
mechanism (`src/cli/global-wrapper.ts`) is currently inert for this user:
whatever it points at is never what actually runs.

Also observed right now: `daemon.pid` is **missing** at `~/.agent-tempo/`
(only `daemon.port` = `8473` survives) — the daemon is discoverable only via
the #811 port-ownership fallback. This is consistent with, though not
conclusively caused by, the degraded state; worth noting in case it recurs
post-restart.

## 1. Option analysis

| Option | Verdict | Why |
|---|---|---|
| **(a) `npm link` from a built `v2` checkout** | **RECOMMENDED** | Directly replaces what `C:\...\npm\agent-tempo(.cmd)` resolves to — the actual PATH-resolved binary — with no dependency on the wrapper mechanism (confirmed inert above) and no npm registry publish (confirmed blocked below). |
| (b) publish `2.0.0-beta.3`, `npm install -g` the new version | **BLOCKED** | Memory note: a prior release (v1.3.1) is stuck — "Tagged + merged but blocked on invalid NPM_TOKEN." Until that's fixed, publishing beta.3 will fail the same way. Don't attempt without first verifying the `NPM_TOKEN` secret. |
| (c) point the global wrapper's entrypoint at a `v2` build | **REJECTED** | Two problems: (1) `~/.agent-tempo/bin` isn't on PATH, so pointing the wrapper anywhere is a no-op for what the user actually invokes; (2) even if PATH were fixed, `refreshEntrypoint()` runs on **every** successful CLI boot and writes `resolve(__dirname, '..', 'cli.js')` of *whichever binary is currently executing* — so the moment anything invokes the OLD npm-global binary again (e.g. a stale shell alias, a script hardcoding the npm path), it silently flips the pointer back. This is exactly the "could fight option c" risk the conductor flagged. |

**Decision: (a). `npm link` (Windows, user-level npm prefix, no admin needed since the global npm dir is per-user under `AppData\Roaming`).**

## 2. Build location — must NOT be an ephemeral worktree

`npm link` creates `C:\Users\vince\AppData\Roaming\npm\node_modules\agent-tempo`
as a **junction/symlink pointing at the checkout directory** — the checkout
must persist indefinitely after linking, not get cleaned up. Do **not** use
one of the `.claude/worktrees/` auto-managed worktrees (EnterWorktree/
ExitWorktree can remove those) or a throwaway `git worktree add` under
`C:\repos\claude-tempo-wt-*` (this session's convention for disposable PR
work). Use a **stable, explicitly-named** location:

```
C:\repos\claude-tempo-v2-live
```

If this path already exists from a prior link, reuse it (see §4 step 2 —
`git fetch` + `checkout` in place is fine; a fresh `npm link` re-run is
idempotent).

## 3. Pre-flight snapshot (safe to run anytime — read-only)

Capture a baseline to compare against post-restart, and to have on hand if
something goes wrong mid-sequence.

```bash
# Health + version + resource baseline
curl -s http://127.0.0.1:8473/v1/health

# Ensemble roster (should be 3 per the last health check — confirm nothing
# unexpected has joined/left since)
agent-tempo status   # or the `ensemble` MCP tool from any attached session

# Daemon process state
agent-tempo daemon status

# Log size (for context — PR-F rotation isn't active on this binary yet)
ls -la ~/.agent-tempo/daemon.log
```

Record: `uptimeMs`, `rss`, `ensembleCount`, `version`. These are the
"before" numbers for the 30-minute post-restart watch in §6.

## 4. Build the fixed binary (safe to run anytime — doesn't touch the live daemon)

```bash
# One-time setup, or re-sync if C:\repos\claude-tempo-v2-live already exists
cd C:/repos
git clone https://github.com/vinceblank/agent-tempo.git claude-tempo-v2-live   # first time only
cd claude-tempo-v2-live
git fetch origin v2
git checkout v2
git reset --hard origin/v2   # ensure exact v2 HEAD, no stray local commits

npm ci
npm run build          # full build: tsc + scripts + dashboard + workflow bundle

# Sanity: confirm the built CLI reports the right version + the PR-C
# --foreground flag exists (grep, not exec — don't invoke daemon start yet)
node dist/cli.js --version
grep -q "foreground" dist/cli/daemon-command.js && echo "PR-C code present"
```

Do this build step **as soon as PR-B lands** — no need to wait for the
user's go-ahead to build; only §5 onward touches the live daemon.

## 5. The restart sequence — ONE command block, run only after both gates clear

Ordering rationale inline. Total expected downtime: well under a minute
(daemon boot is fast; the `up` bootstrap sequence in `ensureInfra()` is
what's slow, and a plain `daemon start` skips it).

```bash
# 1. Link the built v2 checkout as the global package. This is what
#    actually flips `agent-tempo` on PATH over to the fixed code — do this
#    BEFORE stopping the daemon so there's no window where `agent-tempo` on
#    PATH resolves to neither a working old nor new binary.
cd C:/repos/claude-tempo-v2-live
npm link

# Verify the link took — should now print the v2 version and resolve to
# the linked path, not the old npm-global install directory.
where agent-tempo
agent-tempo --version

# 2. Stop the old daemon (pid 28676). `daemon stop` is ghost-aware (#758) —
#    it works via port-ownership even with daemon.pid missing (confirmed
#    missing in §0), so no manual pid hunting needed. This now also runs
#    the JUST-FIXED stop sequence (#934's PID-file-before-kill reorder) —
#    though that matters more for concurrent-invocation safety than this
#    single-operator sequence.
agent-tempo daemon stop

# Confirm it's actually gone before proceeding — don't race the next step.
agent-tempo daemon status   # should report "not running"
curl -sf http://127.0.0.1:8473/v1/health && echo "STILL UP — STOP, do not proceed" || echo "confirmed down"

# 3. Start the new daemon — now runs from the linked v2 build.
agent-tempo daemon start

# 4. Verify.
agent-tempo daemon status
curl -s http://127.0.0.1:8473/v1/health
```

**On pausing ensembles first**: NOT recommended. The daemon restart itself
is the outage — pausing schedules/cues beforehand adds a second window of
reduced service for no benefit (the daemon coming back up with the
existing workflow histories intact is the normal restart path this project
already relies on; nothing in `v2`'s changes requires a drain). Skip it
unless the user specifically wants to avoid any cue/schedule firing during
the ~seconds-to-low-minutes restart window — if so, `agent-tempo pause
--all` before step 2 and `agent-tempo play --all` after step 4 confirms
healthy.

## 6. Post-restart verification (30-minute watch)

This is where PR-A (query-starvation budget raise) and PR-B (4× query-load
cut) prove out — the whole point of this restart.

```bash
# Immediately after restart:
curl -s http://127.0.0.1:8473/v1/health   # version should now read the v2 build

# Watch memory + poll health over 30 minutes. rss climbing toward ~900MB+
# again within 30 min would indicate PR-A/PR-B didn't actually fix the
# starvation (the #433 in-flight-dedup-map leak folded into PR-B per the
# architect ruling should also show as flat rss, not the 180→919MB climb
# from the incident).
agent-tempo daemon stats   # repeat every ~5 min, or:
```
Use `Monitor`/`ScheduleWakeup` (session tooling) rather than a blocking
sleep loop to check back every 5 minutes across the 30-minute window;
compare each sample's `rss` and `uptimeMs`-implied poll cadence against the
pre-restart baseline from §3. Also grep `daemon.log` for `[agent-tempo:ALARM]`
lines (the #886 nondeterminism alarm) and `WFT timeout` / `sticky` — these
were the incident's fingerprint and should be silent or near-silent now.

**Pass criteria**: `rss` stays roughly flat (not the ~180MB→919MB+ climb
pattern from the incident) across the 30-minute window, no `ALARM` lines,
`ensembleCount` matches the pre-restart baseline (3), and normal cue/
schedule traffic (if any fired during the window) delivered without the
19s-poll-interval degradation noted in the architect ruling's incident
description.

## 7. Fold in the #935 supervision smoke test (this is the natural moment)

Since the daemon is being restarted anyway, this is the cheapest time to
also install and verify the fixed process supervision from PR-C (#935) —
validating the actual restart-on-crash behavior on THIS machine, which
CI cannot exercise (no real Task Scheduler in the sandbox — flagged as a
known gap in #935's PR description).

```bash
# After step 5's restart is confirmed healthy:
agent-tempo daemon install

# Verify BOTH scheduled tasks registered (PR-C splits AtLogOn+crash-restart
# from the 5-min periodic recheck into two tasks — see packaging/windows/
# install-task.ps1's doc comment for why they can't share one task):
schtasks /query /tn agent-tempo-daemon
schtasks /query /tn agent-tempo-daemon-recheck

# THE ACTUAL SMOKE TEST — kill the daemon process directly (not via
# `daemon stop`, which is a clean exit-0 shutdown the supervisor should
# NOT restart from) and confirm Task Scheduler brings it back within
# RestartInterval (1 min):
$daemonPid = (Get-Content "$env:USERPROFILE\.agent-tempo\daemon.pid")
Stop-Process -Id $daemonPid -Force
Start-Sleep -Seconds 90
agent-tempo daemon status   # should show a DIFFERENT pid, running

# Confirm daemon.log actually captured the restart (validates the
# --foreground log-redirect fix, not just that the process came back):
Get-Content "$env:USERPROFILE\.agent-tempo\daemon.log" -Tail 20
```

If the process does NOT come back within ~90s, this is a genuine PR-C
regression to report before considering the restart program complete —
do not silently move on.

## 8. Rollback

If anything in §5/§6/§7 goes wrong (daemon won't start, health check fails,
rss immediately spikes, supervision smoke test fails in a way that suggests
the new code is actively harmful):

```bash
# Revert the global link back to the npm-registry install.
npm unlink -g agent-tempo
npm install -g agent-tempo@2.0.0-beta.2

# Confirm reverted:
where agent-tempo
agent-tempo --version   # should read 2.0.0-beta.2 again, resolving to the
                          # npm-global path, not claude-tempo-v2-live

# Restart the daemon on the reverted binary:
agent-tempo daemon stop
agent-tempo daemon start
curl -s http://127.0.0.1:8473/v1/health
```

If PR-C's supervision was installed (§7) and is suspected of causing harm
(e.g. an unwanted restart loop), uninstall it as part of rollback:
```bash
agent-tempo daemon uninstall
```

`C:\repos\claude-tempo-v2-live` should be LEFT IN PLACE after a rollback —
don't delete it. It's cheap to keep around for the next restart attempt
once whatever broke is fixed, and deleting it while still `npm link`-ed
elsewhere would be actively harmful (dangling link).

## 9. Execution checklist (for the actual go-ahead moment)

- [ ] PR-B merged to `v2`
- [ ] User has explicitly said go
- [ ] §4 build already done (can be done ahead of time, doesn't touch live daemon)
- [ ] §3 pre-flight snapshot captured
- [ ] §5 restart sequence executed
- [ ] §6 30-minute watch clean
- [ ] §7 supervision installed + smoke-tested
- [ ] Report final state to conductor: before/after `rss`/`uptimeMs`, confirmation both scheduled tasks are registered and the kill-and-recover smoke test passed
