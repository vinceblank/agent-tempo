# Fork-Scoping Manifest: a Pi-only fork of agent-tempo

> **Status:** Design spike / scoping manifest. UNTRACKED draft — not committed. For vinceblank's review.
> **Author:** greenfield-architect (my-tempo-architect), tempo-impl ensemble.
> **Companion to:** `greenfield-pi-native.md` (the vision). This is the *file-by-file* execution map.
>
> **Scope, as ruled by vinceblank:**
> - It's a **fork** (new tree), not an in-place rebuild. agent-tempo-classic stays alive for multi-agent users.
> - **Multi-host stays.** Per-host task queues + cross-machine recruiting are kept.
> - **All workflow features stay** (quality gates, worktrees, stages, coat-check, saveable state, schedules) — they're Pi-agnostic and port for free.
> - The fork amputates **exactly one thing: the multi-runtime adapter abstraction** (+ its two delivery mechanisms, MCP and Ink).
>
> **Working name used below:** `tempo-pi` (rename at will).

---

## 0. The one-paragraph shape of the work

This is **~70% deletion, ~25% verbatim port, ~5% rewrite.** You delete the adapter layer, the MCP
server, and the Ink TUI; you port the entire durable core (workflows, activities, outbox, maestro,
http, tools, ensemble, utils) almost untouched; you rewrite a short list of *seams* where those two
worlds met — chiefly `spawnProcess`, `computeHostProfile`, the CLI launch path, and the `types.ts`
enums. No workflow-core logic is rewritten (that's where the hard-won correctness lives — port it
verbatim).

---

## 1. File-by-file manifest

Legend: **DELETE** · **PORT** (copy ~verbatim, recompile against slimmer types) · **SLIM** (port then
trim a seam) · **PROMOTE** (was one-of-many, becomes the whole thing).

### DELETE — the adapter/MCP/TUI scaffolding (the entire point of the fork)

| Path | Why it goes |
|---|---|
| `src/adapters/claude-code/` `copilot/` `claude-api/` `opencode/` `claude-code-headless/` `mock/` `sdk/` | Six non-Pi runtimes + the SDK base. None exist in a Pi-only world. |
| `src/adapters/base.ts` (`BaseAttachment`, `AdapterRegistry`) | The attachment-driver + registry abstraction. Pi's extension *is* the driver; there's nothing to register. |
| `src/adapters/index.ts` | Registry bootstrap. Gone with the registry. |
| `src/server.ts` | The MCP stdio server entry. Pi registers tools natively (`renderToPi`); no MCP child, no stdio bridge. |
| `src/cli/mcp.ts` | MCP server registration helpers (project vs global). Replaced by Pi-extension wiring. |
| `src/tui/**` (App.tsx, store.ts, commands.ts, sse-handler.ts, components/, utils/, ink-loader.ts, bootstrap-types.ts, removed-commands.ts) | The Ink/React TUI. Pi's own TUI + the mission-control extension replace it wholesale. |
| `src/daemon-adapter-versions.ts` | Per-adapter upstream-version probe fan-out. Collapses to "Pi version" (see §3). |
| `src/cli/scenarios-command.ts`, `src/cli/dev-verbs.ts` (mock bits), `src/adapters/mock/**` | Mock-adapter dev surface. Pi's own dev/headless path replaces it. |
| `renderToMcp` (in `src/tools/descriptor.ts`) | The MCP front-end renderer. Keep the descriptor + `renderToPi`; drop this one function. |
| `registerAllTempoTools(McpServer, …)` path (in `src/server-tools.ts`) | The MCP registration call. Keep `buildAllTempoTools` (the neutral descriptors); drop the McpServer wiring. |

> **One relocation, not a delete:** `src/adapters/pi/` (the Pi registry descriptor) and
> `src/adapters/terminal-error.ts` (the shared signal/query terminal-error classifier, reused by
> `PiWorkflowClient`) fold **into `src/pi/`** rather than dying with the adapter dir.

### PORT — the durable core (copy ~verbatim; this is the value, don't touch the logic)

| Path | Note |
|---|---|
| `src/workflows/**` (session, scheduler, maestro, *-signals, attachment-math, index) | **The crown jewels.** Port verbatim. Most of session.ts's volume is scar tissue from the #249 delivery trilogy, the CAN handle-staleness fix, and the lease-across-CAN math — rewriting it re-introduces those bugs. Only the wire *surface* slims (§2), not the lifecycle logic. |
| `src/activities/**` (outbox, maestro, hard-terminate, resolve, schedule-fire) | Port. `outbox.ts`'s `spawnProcess` is the one SLIM (§3); the rest is verbatim. |
| `src/http/**` (server, event-bus, sse-handler, ring-buffer, snapshot, aggregate, inner-loop, ingest-registry, gate-*, auth, dashboard, …) | Port verbatim. **More load-bearing here than in classic** — with multi-host + the full feature set + the observer console, SSE is the operator-visibility backbone. |
| `src/ensemble/**` (schema, loader, saver, agent-types) | Port. `agent-types.ts` 3-tier resolution stays — "player type" becomes a Pi persona/system-prompt, not an adapter selector. |
| `src/tools/**` (all tool handlers + `descriptor.ts` minus `renderToMcp`) | Port. Handlers are transport-neutral and already route through `executeUpdate(submitOutbox)`. They feed `renderToPi` unchanged. |
| `src/client/**` (TempoClient + subscribe + spawn helpers) | Port. The programmatic surface is runtime-neutral. |
| `src/reconcile/orphans.ts` | Port. Orphan restore is multi-host plumbing — kept. |
| `src/utils/**` | Port. (Drop only `attachment-format.ts`'s adapter-label bits if any; trivial.) |
| `src/config.ts`, `connection.ts`, `worker.ts`, `git-info.ts`, `constants.ts` | Port. `worker.ts`'s dual-queue model is unchanged; only the activities it registers shed the adapter-specific ones. |

### PROMOTE — `src/pi/` becomes the whole runtime

| Path | Note |
|---|---|
| `src/pi/**` (extension, headless, phase-driver, workflow-client, cue-pump, reset-pump, render-tools, zod-to-typebox, lazy-proxy, inner-loop-*, gate-client, tool-capability, mission-control/, probe, pi-types) | Already shipping. Stops being "one adapter," becomes the sole client bridge + the three modes. Absorbs the relocated `pi/` descriptor + `terminal-error.ts`. |

### SLIM/REWRITE — the seams where the two worlds met (the only real new work)

| Path | What changes |
|---|---|
| `src/types.ts` | Collapse the enums + slim the outbox entries (§2). The biggest single edit, but mechanical. |
| `src/spawn.ts` | One spawn path: launch `pi` (interactive terminal) / `runHeadlessPi` (headless). The cross-platform terminal-quoting matrix stays; the "which binary + env shape per adapter" fan-out goes (§3). |
| `src/daemon.ts` | Drop the adapter-version probes in `computeHostProfile`; host-profile capability collapses to "Pi present? + Pi version" (§3). Everything else (reconcile, cleanup, http, workers) is verbatim. |
| `src/cli/commands.ts` | `up` / `recruit` / `conduct` launch Pi directly, no adapter resolution. `--agent` flag effectively disappears (always Pi). |
| `src/server-tools.ts` | Keep `buildAllTempoTools` + `buildServerInstructions`; drop the `registerAllTempoTools(McpServer)` path. |
| `src/tools/descriptor.ts` | Keep `TempoToolDescriptor` + per-tool factories; drop `renderToMcp`. |

---

## 2. Wire-protocol diff (what comes off the wire)

The feature signals all **stay** (quality gates, worktrees, stages, coat-check, saveable state,
schedules, the full attachment lifecycle). What slims is the *adapter-discriminator* surface. Because
this is a fork with a fresh `v0.x` protocol, these are clean removals, not deprecations.

### Enums (`types.ts`)

```diff
- export const AGENT_TYPES = ['claude','copilot','mock','claude-api','opencode','claude-code-headless','pi'];
- export type AgentType = typeof AGENT_TYPES[number];
+ // No AgentType discriminator. Every player is Pi. (Drop the field, or pin it to a const 'pi'
+ //   only if a downstream surface still wants a literal — prefer dropping.)

- export const MOCK_MODES = [...];  export type MockMode = ...;      // DELETE (mock adapter gone)

- export type AdapterClass = 'interactive' | 'sdk';                 // DELETE
- export interface AdapterDescriptor { adapterId; adapterClass; blocksOnLLMTurn; heartbeatMs; }  // DELETE
+ // Pi is a single runtime profile. Heartbeat cadence is owned by PiWorkflowClient
+ //   (90s lease / 30s beat). The workflow no longer sizes timers from an adapter descriptor.
```

### `SessionMetadata`

```diff
  playerId; ensemble; hostname; workDir; gitRoot?; gitBranch?; isConductor;
- agentType?: AgentType;     // drop (always Pi)
- adapterId?: string;        // drop (always 'pi')
  playerType?; playerTypeDescription?; recruitedBy?; worktreePath?;
  sessionId?;                // KEEP — Pi conversation id for resume
  model?;                    // KEEP — now a Pi `provider/model` selector, not claude-api-only
```

### `RecruitOutboxEntry` — drop the per-adapter knobs, keep the Pi ones

```diff
  type:'recruit'; targetName; workDir; isConductor; initialMessage?;
- agent: AgentType;          // drop (implicit Pi)  — or pin 'pi' if the dispatcher wants a literal
  systemPrompt?; targetHostname?; agentDefinition?; agentDefinitionPath?;
  agentDefinitionDescription?; nativeResolvable?; allowedTools?; held?;
- claudeBin?;                          // claude-code only — DELETE
- mockMode?; mockScenario?;            // mock only — DELETE
- permissionMode?; dangerouslySkipPermissions?;  // claude-code-headless only — DELETE
  model?;                    // KEEP — Pi provider/model selector
  toolAccess?: 'restricted'|'standard'|'full';   // KEEP — Pi MD-C policy
```

### `SpawnOutboxEntry` — the cross-host spawn payload collapses

```diff
  type:'spawn'; targetName; workDir; isConductor; targetHostname;
- agent: AgentType;          // drop (implicit Pi)
- adapterId: string;         // drop (always 'pi')
  attachmentId; attachmentRunId;
- resumeAttachment: boolean; // KEEP but rename intent: "resume Pi session into prior sessionId"
+ resumeAttachment: boolean;
  sessionId?;                // KEEP — Pi sessionId for resume continuity
  agentDefinition?; agentDefinitionPath?; nativeResolvable?;
  model?;                    // KEEP — Pi provider/model carried across restart/migrate
+ toolAccess?: 'restricted'|'standard'|'full';   // ADD — carry the MD-C policy across restart/encore
```

### Signals/queries/updates — **no removals from the lifecycle or feature surface**

Everything in `src/workflows/signals.ts` that drives lifecycle (`claimAttachment`, `adapterExited`,
`forceDetach`, `requestDetach`, `heartbeat`, `enqueueSpawn`, `attachmentInfo`, phase queries) **stays** —
Pi already drives all of it via `PiWorkflowClient`. The feature signals (quality gates, worktrees,
stages, coat-check, saveable state, reset/pendingReset, inner-loop) **stay**. The only conceptual
rename worth making: `adapterExited` reads oddly with no adapters — consider `runtimeExited` in the
fork's fresh protocol (pure cosmetics; the semantics are identical).

> **Net wire impact:** ~3 enums deleted, ~6 metadata/outbox fields dropped, 0 lifecycle/feature
> signals removed. Low blast radius — exactly because you kept the features and the workflow core.

---

## 3. The two seam collapses, concretely

### `spawnProcess` (in `src/activities/outbox.ts` + `src/spawn.ts`)

Today `spawnProcess` resolves an adapter descriptor, then branches across six spawn strategies
(visible terminal vs headless subprocess vs in-process bridge), each with its own binary, env shape,
and OS quoting. In the fork it collapses to **two** branches, both Pi:

```
spawnProcess(entry):
  if entry.isConductor || entry.interactive:
      spawnInTerminal('pi', ['-e', <tempo-extension.js>], { env: AGENT_TEMPO_* + provider auth })
      # cross-platform terminal matrix (macOS/Windows/Linux) STAYS — same code, one program
  else:
      runHeadlessPi({ toolAccess: entry.toolAccess, model: entry.model,
                      continueSessionId: entry.sessionId })   # createAgentSession + inline extension
```

The macOS/iTerm/Ghostty · Windows-Terminal-via-`cmd /c start` · Linux-emulator detection logic in
`src/spawn.ts` is **kept verbatim** — it's still needed for the interactive terminal launch. What dies
is the per-adapter binary/env/bridge fan-out around it.

### `computeHostProfile` (in `src/daemon.ts`) — multi-host stays, the probe shrinks

```diff
  return {
    hostname, version, platform, capabilities, daemonStartedAt,
    availablePlayerTypes: listAgentTypes().map(a => a.name),   // KEEP (Pi personas)
-   defaultAgent: config.defaultAgent,
-   availableAgentTypes: [config.defaultAgent, ...probe(claude-code-headless), ...probe(copilot)],
-   claudeBin: config.claudeBin,
-   adapterVersions: await probeAdapterVersions(),   // 6-adapter fan-out
+   piAvailable: probePiInstalled() && checkPiNodeFloor().ok,   // single structural check
+   piVersion: resolvePiSdkVersion(),                           // one version string
  }
```

Cross-machine recruiting is **unchanged**: the per-host task queue, the `hostProfile` signal, the
global maestro's `hostProfiles` map, the `hosts` tool/CLI, and the recruit pre-flight all stay — the
pre-flight just asks "does target host have Pi?" instead of "does it support agent type X?".

---

## 4. What the daemon looks like after (multi-host preserved)

```
daemon (slimmed, NOT removed):
  ├─ shared-queue worker:   workflows + delivery activities (deliverCue/Report/Detach/Destroy/Restart,
  │                          terminateSession, startRecruitedSession, releasePlayer) + schedule activities
  ├─ per-host-queue worker:  spawnProcess (→ spawn Pi) + hardTerminateAttachment    ← multi-host kept
  ├─ HTTP/SSE server:        snapshot + events + inner-loop + gate + dashboard       ← operator backbone
  ├─ global-maestro ensure + host-profile advertise (Pi-availability)
  └─ reconcile-on-boot + cleanup loop + memory reporter                              ← unchanged
```

The MCP server process and the Ink TUI process are **gone**. The daemon stays (durable workflow code
*must* run in a long-lived V8-sandbox worker — it can't live in an ephemeral Pi process), but it sheds
the adapter probes and serves a single runtime.

---

## 5. Suggested execution order (port-first, lowest-risk-first)

1. **Scaffold the fork** — copy the tree, drop `src/adapters/` `src/server.ts` `src/tui/`
   `src/cli/mcp.ts` `src/daemon-adapter-versions.ts`. Get it to *not compile* (that's the to-do list).
2. **Slim `types.ts`** — collapse the enums + outbox entries (§2). Most compile errors trace here.
3. **Fix the seams** — `spawnProcess`/`spawn.ts`, `computeHostProfile`, `cli/commands.ts`,
   `server-tools.ts`, `descriptor.ts`. Compile green.
4. **Port the workflow test suites verbatim** — the `test/` Mocha integration suites + the
   wire-protocol drift detector are your safety net that the verbatim port didn't regress the core.
   **Do not rewrite these — they encode the bug fixes.**
5. **Smoke the three modes** — interactive `up`, headless `recruit`, mission-control observer — single
   host first, then a second host for cross-machine recruit.
6. **Re-baseline docs** — fresh `WIRE-PROTOCOL.md` (now Pi-only, `v0.x` unstable), trimmed CLAUDE.md.

---

## 6. The one ongoing cost to design for: divergence

Two trees means workflow-core fixes may need porting both ways. Mitigation: **keep
`src/workflows/**` and `src/activities/**` structurally identical to classic** for the first phase, so
a real correctness fix in either tree is a cheap `git cherry-pick` or a 5-minute manual port. Set an
explicit "cord-cutting" milestone after which the cores are allowed to diverge freely. The feature
surface (tools, http, ensemble) can diverge immediately — it's the lifecycle core that's worth keeping
mergeable while it's still young.

---

## 7. Bottom line

The fork is a **subtraction**, not a redesign. You keep everything that was hard to build (the durable
core, every feature, multi-host) and delete the one thing that made the tree feel bloated: the
seven-runtime abstraction and its two delivery models. The risky cuts (rewriting the workflow,
dropping features, dropping cross-host) are explicitly **off the table** per your scope — which is what
makes this a low-risk, high-clarity fork rather than a rewrite gamble. The net deliverable is a tree
that does exactly what agent-tempo does, for exactly one runtime, with roughly one fewer abstraction
layer to hold in your head.
