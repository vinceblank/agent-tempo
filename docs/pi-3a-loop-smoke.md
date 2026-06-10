# Phase 3a — headless Pi "loop attaches" smoke

The end-to-end gate for Phase 3a (NOT unit-testable — needs the live stack: Pi
SDK ≥ 0.78, Node ≥ 22.19, a Pi-authed model, a running Temporal + agent-tempo
daemon). Proves: **recruit `agent:'pi'` → headless Pi attaches → takes a cue →
reports → clean-detaches**.

Branch: `feat/pi-phase3a-headless`.

> **Historical note (2026-06):** the MD-C `toolAccess` gate this smoke
> originally also exercised was REMOVED with the Pi permission layers
> (`docs/design/pi-streamline-gate-removal-cc.md`) — headless Pi players now
> run the full tool surface. The MD-C log lines and bash-block steps below
> were updated accordingly.

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
# (--agent pi is the key flag.)
```
MCP-tool equivalent:
```json
{ "name": "pi-smoke", "workDir": "<repo>", "agent": "pi",
  "model": "anthropic/claude-opus-4-5",
  "initialMessage": "You are a headless smoke-test player. When you receive a cue, call the `report` tool with a one-line result, then wait for more cues." }
```

### ✅ Expected — ATTACH (tail the spawned log)
```bash
tail -f "$(pwd)/logs/pi-smoke.log"
```
Look for, in order:
- `registered tools (player=pi-smoke, conductor=false, mode=headless)`
- `headless Pi session bound (model=anthropic/claude-opus-4-5, …)`
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

## Variant B — self-contained, DEV namespace, no recruit tool

The `recruit` CLI verb was removed (#285/#288) and there is no `--dev recruit`
wrapper. Run ISOLATED on `agent-tempo-dev` (NOT the prod daemon). The headless
adapter SELF-CREATES its session workflow (`runHeadlessPi` →
`ensureSessionWorkflow` USE_EXISTING) + claims, so it needs no recruit tool.

**Terminal 1 — attach (direct adapter, dev namespace):**
```bash
AGENT_TEMPO_DEV_MODE=1 \
AGENT_TEMPO_ENSEMBLE=pi-smoke AGENT_TEMPO_PLAYER_NAME=pi-smoke \
AGENT_TEMPO_PI_MODEL=anthropic/<indexed-model> \
ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
node dist/adapters/pi/adapter.js
# DEV_MODE=1 → getConfig() resolves the agent-tempo-dev namespace + queue (the dev
# daemon's workers run the Phase 3a build). Attach logs as in §2.
```

**Terminal 2 — cue via the dev verb:**
```bash
node dist/cli.js --dev cue pi-smoke "Reply by calling the report tool: report({text:'alive'})"
```

**Report observation (no conductor) — query the workflow outbox:**
```bash
node -e "const {Connection,Client}=require('@temporalio/client');const {getConfig,sessionWorkflowId}=require('./dist/config');const {outboxQuery,attachmentInfoQuery}=require('./dist/workflows/signals');(async()=>{process.env.AGENT_TEMPO_DEV_MODE='1';const cfg=getConfig();const c=await Connection.connect({address:'localhost:7233'});const cl=new Client({connection:c,namespace:cfg.temporalNamespace});const h=cl.workflow.getHandle(sessionWorkflowId('pi-smoke','pi-smoke'));console.log('OUTBOX:',JSON.stringify((await h.query(outboxQuery)).map(e=>({type:e.type,text:e.text}))));console.log('PHASE:',(await h.query(attachmentInfoQuery)).phase);await c.close();})()"
# ~15s after the cue → expect a {type:'report',text:'alive'} entry = cue→report loop.
```

Detach: Ctrl-C Terminal 1 →
`received SIGTERM` → `detached (agent-exited)` → re-query `attachmentInfo` → phase
`detached` promptly (reliable detach, not the 90s reaper).

> Variant B exercises the RUNTIME (adapter → extension → singleton → claim →
> reliable detach). The recruit→entry→workflow→spawn plumbing (A4) is
> unit-covered (compile + recruit validation/preflight tests); the live run
> validates the runtime loop.

## Pass criteria

1. Attaches (phase `attached`, lease 90s).
2. Takes a cue + emits a `report` (the loop).
3. Clean-detaches promptly on stop (reliable detach, not lease-timeout).

Any failure → capture `logs/pi-smoke.log` + `agent-tempo status` and route to tempo-lead.
