# Phase 3a — headless Pi "loop attaches" smoke

The end-to-end gate for Phase 3a (NOT unit-testable — needs the live stack: Pi
SDK ≥ 0.78, Node ≥ 22.19, a Pi-authed model, a running Temporal + agent-tempo
daemon). Proves: **recruit `agent:'pi'` → headless Pi attaches → takes a cue →
reports → clean-detaches**, plus the MD-C tool gate.

Branch: `feat/pi-phase3a-headless`.

## 0. Prereqs (devops env already satisfies most)

```bash
git fetch origin && git checkout feat/pi-phase3a-headless
npm install           # Pi optional deps resolve on Node ≥ 22.19
npm run build         # compiles dist/ + dist/adapters/pi/adapter.js + workflow-bundle.js
node -e "console.log(require('@earendil-works/pi-coding-agent/package.json').version)"  # expect 0.78.0
```

Pick an **indexed** model + provider auth (3a default = anthropic):
```bash
# Confirm the model resolves (sessionless) — must print an object, not undefined:
node --input-type=module -e "import('@earendil-works/pi-ai').then(m=>console.log(!!m.getModel('anthropic','claude-opus-4-5')))"
export ANTHROPIC_API_KEY=sk-ant-...    # the spawned pi inherits the daemon's env
```

## 1. Daemon up (already live per devops)

```bash
agent-tempo daemon start    # PID ~/.agent-tempo/daemon.pid; Temporal localhost:7233
```

## 2. Recruit a headless Pi player

Via the MCP `recruit` tool (from a Claude Code session in this repo) **or** the CLI:

```bash
agent-tempo recruit pi-smoke "$(pwd)" --agent pi --model anthropic/claude-opus-4-5
# (toolAccess defaults to 'restricted'. Add --agent pi is the key flag.)
```
MCP-tool equivalent:
```json
{ "name": "pi-smoke", "workDir": "<repo>", "agent": "pi",
  "model": "anthropic/claude-opus-4-5", "toolAccess": "restricted",
  "initialMessage": "You are a headless smoke-test player. When you receive a cue, call the `report` tool with a one-line result, then wait for more cues." }
```

### ✅ Expected — ATTACH (tail the spawned log)
```bash
tail -f "$(pwd)/logs/pi-smoke.log"
```
Look for, in order:
- `registered tools (player=pi-smoke, conductor=false, mode=headless)`
- `MD-C tool gate active (mode=headless, toolAccess=restricted)`
- `headless Pi session bound (toolAccess=restricted, model=anthropic/claude-opus-4-5, …)`
- `claimed attachment <id> (lease 90000ms)`
- `attached pi-smoke (wf agent-session-<ensemble>-pi-smoke)`

And `agent-tempo status` / the `ensemble` tool shows **pi-smoke** with phase
`attached` (or `awaiting`).

## 3. Cue → report (the loop)

```json
// cue tool:
{ "playerId": "pi-smoke", "message": "Report your status via the report tool now." }
```
### ✅ Expected — CUE TAKEN + REPORT
- Log shows the cue injected (the agent wakes and runs a turn).
- The conductor / recruiter receives a **report** from `pi-smoke` (visible via
  the conductor's report history / dashboard / the recruiter session).
- `agent-tempo status` shows pi-smoke `processing` during the turn, then `awaiting`.

### ✅ (bonus) MD-C gate — restricted hard-blocks Bash
```json
{ "playerId": "pi-smoke", "message": "Run `ls` using the Bash tool." }
```
Expect the agent's bash attempt to be **denied**: log line
`MD-C: blocked 'bash' (toolAccess=restricted)`; the agent reports it couldn't run shell.

## 4. Clean detach

```bash
# Graceful stop — destroy the player (workflow + clean adapter exit):
agent-tempo destroy pi-smoke
#   OR send SIGTERM to the pi process directly:
#   kill -TERM "$(cat logs/pi-smoke.pid)"
```
### ✅ Expected — CLEAN DETACH (≤ immediate, NOT a 90s lease-timeout)
- Log: `received SIGTERM — shutting down` → `detached (agent-exited)` →
  `headless Pi clean-exit complete`.
- `ensemble` shows pi-smoke `detached` promptly (the reliable signal-then-dispose
  path fired adapterExited before exit — not the ≤90s reaper fallback).

## Pass criteria

1. Attaches (phase `attached`, lease 90s, MD-C gate logged).
2. Takes a cue + emits a `report` (the loop).
3. MD-C restricted denies Bash (security floor).
4. Clean-detaches promptly on stop (reliable detach, not lease-timeout).

Any failure → capture `logs/pi-smoke.log` + `agent-tempo status` and route to tempo-lead.
