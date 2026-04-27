# ADR 0014 — Dev mode + mock adapter + isolated daemon stack

- **Status**: Accepted (design — implementation deferred to scheduled engineer pickup; tempo-lead named per conductor)
- **Date**: 2026-04-27
- **Authors**: tempo-architect
- **Related**: [`docs/design/dev-mode-mock-adapter.md`](../design/dev-mode-mock-adapter.md), conductor brief 2026-04-27

## Context

Today the AI conductor running `claude-tempo` has a hard ceiling on what it can validate end-to-end:

1. **Real player sessions need a human-in-the-loop.** Claude Code's "trust this folder" prompt blocks autonomous recruit.
2. **There is one daemon per machine.** Any test traffic the conductor generates pollutes vinceblank's production ensemble (same `~/.claude-tempo/`, same `default` Temporal namespace, same port 8473, same Maestro workflow).
3. **Last night's dashboard testing proved the value of autonomous validation** (#375, #376 found via `mcp__claude-in-chrome__*`) — but every click hit prod.

vinceblank's stated goal: an isolated dev environment with its own daemon, its own Temporal namespace, and a mock adapter that doesn't require the trust prompt. Three pieces, designed together so the conductor can spin up a sealed stack, drive multi-player scenarios, validate the dashboard end-to-end, and tear down with **zero blast radius** on production.

The design spike was tasked with locking 12 open questions across three problem areas (mock adapter shape + control surface + safety, daemon process model + state isolation + CLI ergonomics, Temporal namespace strategy + provisioning + conflict avoidance) before engineer pickup, with PR phasing each <500 LoC.

## Decision

**Adopt the dev-mode + mock adapter + isolated daemon stack as designed in [`docs/design/dev-mode-mock-adapter.md`](../design/dev-mode-mock-adapter.md).** The design lives there; this ADR records the locked decisions.

Headline locked-in choices:

- **One profile, four isolation axes.** A single top-level `--dev` CLI flag (or `CLAUDE_TEMPO_DEV_MODE=1` env) flips four defaults together: home dir (`~/.claude-tempo-dev/`), HTTP port (`8474`), Temporal namespace (`claude-tempo-dev`), task queue (`claude-tempo-dev`). One switch, four axes. No knob soup.
- **Single source of truth gate.** New `isDevMode()` helper in `src/config.ts`; every other layer (config defaults, registry registration, recruit pre-flight, banner) consults that one helper. Future divergence requires explicit code that checks it, not implicit drift.
- **Mock = single class, four modes.** `MockAttachment extends SdkAttachment` (pull-delivery + `processingStart/End` pairing → dashboard renders mock sessions identically to real ones). Modes: `echo` / `scripted` (YAML) / `silent` / `chaos`. Selected at boot via `CLAUDE_TEMPO_MOCK_MODE`; no mid-session switching.
- **Zero new wire-protocol surface.** Mock uses the same `claimAttachment` / `heartbeat` / `markDelivered` / `pendingMessages` / outbox surface as Claude Code and Copilot. No new signals, queries, or updates on `claudeSessionWorkflow`. `docs/WIRE-PROTOCOL.md` is unchanged.
- **Test-only control via existing surface.** Scripted YAML for replayable scenarios; `__MOCK__:` cue prefix for interactive driving from any other player. **Inert in production**: real adapters don't inspect message bodies for the prefix, so an accidental cross-pollination is plain text. **No new IPC surface in v1** — HTTP control endpoint deferred to Phase 2.
- **Defense-in-depth on production safety, four independent layers.** All four must fail for the mock adapter to talk to a prod ensemble:
  1. Build-time exclusion of `src/adapters/mock/` from the npm tarball (production tsconfig drops the source; `package.json#files` whitelists exclude `dist/adapters/mock/`)
  2. Import-time registration gate (`registry.register(mockDescriptor)` only inside `if (isDevMode())`, with dynamic import so prod builds without the file don't fault)
  3. Recruit-time rejection (`agent: 'mock'` rejected at the tool pre-flight if `!isDevMode()`)
  4. Runtime banner (`[DEV MODE]` line on every CLI invocation + daemon startup log; dashboard ribbon Phase 2)
- **Separate dev daemon process, long-lived.** Same lifecycle as prod daemon — start once, runs until stopped. Different home dir + port + namespace mean dev and prod daemons coexist naturally. Existing `tryAcquireLockFile` machinery prevents two dev daemons on the same machine; `CLAUDE_TEMPO_HOME_OVERRIDE` env is the v1 escape hatch for fully custom isolation.
- **Temporal namespace isolation, not workflow tagging.** `claude-tempo-dev` namespace, auto-created by the dev daemon on boot (idempotent on `ALREADY_EXISTS`, non-fatal on `PERMISSION_DENIED`). Production daemons never auto-create. Even a complete failure of all four production safety gates still leaves prod's `default` namespace unable to see dev workflows via visibility queries.
- **Scenario library lives at `scenarios/` repo root**, parallel to `examples/ensembles/`. Shipped via `package.json#files`. Discoverable via `claude-tempo --dev scenarios list` / `scenarios show <name>`. Resolution rules: bare name → `<package-root>/scenarios/<name>.yaml`, absolute path → verbatim, relative path → cwd-relative.
- **Three PRs, each <500 LoC. Conductor unblocked after PR 2.**
  - PR 1 (~350 LoC): dev-mode helper, profile-aware paths, `--dev` flag, banner, dev-daemon namespace auto-create
  - PR 2 (~450 LoC): mock adapter (`echo` + `scripted` modes), recruit gate, build-time exclusion, three reference scenarios at repo root
  - PR 3 (~300 LoC): `silent` + `chaos` modes, expanded scenario library, `--dev up --lineup tempo-mock-jam` integration

12 open questions — locked answers:

| Q                                                                                          | Locked decision                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mock adapter style — scripted / stub / echo / programmable?                                | **One adapter, four modes** (`echo` / `scripted` / `silent` / `chaos`)                                                                                                                          |
| Test-only control — new `mockReply` signal?                                                | **No.** `__MOCK__:` cue prefix; zero wire-protocol surface added                                                                                                                                |
| Failure injection                                                                          | **Yes**, in `chaos` mode (probabilistic) + `delayMs` action in `scripted`                                                                                                                       |
| Dev-mode gate                                                                              | **All four** (build-time exclusion + import-time gate + recruit-time rejection + runtime banner)                                                                                                |
| Daemon approach                                                                            | **Separate daemon process** with its own home dir, PID file, port, namespace, task queue                                                                                                        |
| State isolation                                                                            | **Separate home dir + separate Temporal namespace.** No tagged-workflow approach                                                                                                                 |
| CLI ergonomics                                                                             | **Top-level `--dev` flag** parsed before verb dispatch; every existing verb works in dev mode without per-command plumbing                                                                       |
| Lifetime                                                                                   | **Long-lived** dev daemon; same lifecycle as prod                                                                                                                                                |
| Namespace name                                                                             | **`claude-tempo-dev`** (explicit, matches home-dir naming, leaves room for `claude-tempo-staging` etc.)                                                                                          |
| Provisioning                                                                               | **Auto-create on dev daemon boot** (idempotent); production never auto-creates                                                                                                                  |
| Conflict avoidance (two dev daemons on same machine)                                       | **Existing lock-file machinery prevents it**; v1 doesn't support parallel dev daemons; `CLAUDE_TEMPO_HOME_OVERRIDE` is the escape hatch                                                          |
| Mock adapter base class                                                                    | **`SdkAttachment`** — pull-delivery + `processingStart/End` pairing matches what dashboard renders for real sessions                                                                            |
| Scenario library location                                                                  | **`scenarios/` at repo root**, parallel to `examples/ensembles/`; first-class artifacts, not illustrative samples                                                                                |
| `__MOCK__:` directive safety in production                                                 | **Inert** — real adapters never inspect message bodies for the prefix; only the mock adapter (which can't exist in prod) interprets it                                                            |
| **PR-1 implementation discovery**: dev + prod daemon zombie-reaper coexistence              | **`selectOrphans` extended with cross-profile known-PIDs set + weak-evidence suppression** on partial-state (port file present, PID file missing). Original design wrongly assumed "natural coexistence" at the host-process layer — the orphan detector matched the opposite profile's daemon as a zombie. Without the fix, `--dev daemon stop` would have SIGTERMed the user's prod daemon. Lesson folded into design doc §5.7 with explicit acceptance criteria. |

## Consequences

- **Positive**:
  - **Conductor can begin autonomous bug-hunting after PR 2.** Recruit mock players without trust prompts, drive cues, validate dashboard end-to-end via Chrome MCP — all against an isolated stack with zero blast radius on prod. PR 3 collapses the recruit chain into a single `--dev up --lineup` command.
  - **Zero new Temporal signals/queries/updates.** Mock adapter uses only the existing wire surface; no `WIRE-PROTOCOL.md` change; no workflow versioning concern; no ripple to existing adapters.
  - **Strict additivity to `AgentType`.** The `'mock'` value joins `'claude' | 'copilot' | 'claude-api'` (#131); registry's `resolveFromAgentType` extends one line; no breaking changes.
  - **Dashboard validation has visual fidelity to real sessions.** Mock extends `SdkAttachment`, so phase transitions, processing windows, heartbeat cadence, and outbox activity look identical to real Claude / Copilot sessions. Bugs caught here repro in prod.
  - **Profile-not-flag-soup means low cognitive load.** A developer or AI conductor remembers one switch (`--dev`) instead of four env vars; defaults handle the rest. Future contributors can't accidentally configure dev mode incorrectly.
  - **Defense-in-depth makes production leakage combinatorically unlikely.** Four independent gates; even a complete failure leaves namespace isolation as the last line of defense (dev workflows simply aren't visible to prod's namespace).
  - **Generalizes beyond the dashboard use case.** CI Playwright e2e gets scripted scenarios instead of read-only smoke; future TUI work validates against deterministic player traces; wire-protocol changes verify end-to-end without manual ensemble setup; bug repros become replayable scenarios.
  - **Scenario library is discoverable.** `--dev scenarios list` makes the test surface explicit; new conductor sessions don't have to grep source to find what's available. Same UX pattern as `examples/ensembles/` lineups.

- **Negative**:
  - **Mock adapter is opt-in dev-only — not a production-installed test surface.** Users running `npm install -g claude-tempo` cannot recruit mock players to validate their own setups. Acceptable for v1; the target audience is the conductor + claude-tempo developers, not end users. If end-user testing demand emerges, a Phase 2 follow-up can ship a separate `@claude-tempo/dev-tools` package.
  - **No HTTP control surface in v1.** The `__MOCK__:` cue prefix covers the conductor's main use case but requires the conductor to have a player that can send cues. Direct out-of-band injection (e.g. from a Playwright test runner) waits for Phase 2.
  - **Single dev daemon per machine.** Two parallel dev environments require `CLAUDE_TEMPO_HOME_OVERRIDE` per environment. No automatic enumeration of dev environments; user must remember which override goes with which.
  - **Auto-create namespace adds a Temporal admin call to dev daemon boot.** Adds ~100ms to dev daemon startup; bounded by the `ALREADY_EXISTS` happy path being fast. Not in the prod path.
  - **+1 adapter to maintain in the registry / conformance suite.** When the conformance suite (per `docs/design/session-lifecycle-rebuild-v2.md` §4.5) lands, mock adapter must pass the same nine cases as real adapters. Acceptable cost — and ensures the mock stays in lockstep with real adapters' lifecycle semantics.
  - **Scripted YAML may grow into a configuration language.** Mitigated by closed action set (cue / report / recruit / release / delayMs / crash); anything fancier requires a Phase 2 design decision, not silent feature creep.
  - **Mode selection is per-spawn, not per-message.** A test that needs mid-session mode switching has to restart the player. Acceptable v1 simplification; cuts state explosion in the mock.

- **Neutral**:
  - **~1,100 LoC total implementation cost** across three PRs. Single engineer (tempo-lead) can ship the trilogy over a few days; tempo-qa reviews each PR independently.
  - **Dev profile is a precedent.** Future "profile" concepts (staging, ci, demo, …) can follow the same `isDevMode()` → `isStagingMode()` pattern. Worth being intentional about the helper naming so the precedent is generalisable.
  - **The `__MOCK__:` prefix is unconventional.** Conspicuous string conventions in user-visible message bodies are a small UX wart; mitigated by the prefix only being relevant to mock adapters that don't exist in prod. Operators interacting with dev environments may see the prefix in their cue history; that's the cost of zero-IPC-surface in v1.

## Alternatives considered

- **Mock adapter as a build-time test fixture only (under `test/`)** — rejected. Defeats the goal: the conductor wants to drive end-to-end scenarios in the same daemon a developer would use, including via the dashboard. Test-only fixtures don't get exercised by real CLI / dashboard / TUI surfaces.
- **Mock adapter as a separate npm package (`@claude-tempo/mock-adapter`)** — rejected for v1. Adds publish-pipeline complexity; mock + main package would need lockstep version coordination. Build-time exclusion gives 90% of the safety with 10% of the operational cost.
- **Mock as a flag on `claude-code` adapter** (`InteractiveAttachment` with `MOCK_MODE=1`) — rejected. Conflates real adapter and test fixture; production code paths would need `if (isMock)` branches everywhere. Separate `MockAttachment` class keeps the production adapters pristine.
- **Mock adapter extends `BaseAttachment` (interactive class)** — rejected. SDK class is the right fit because the mock blocks on "compute response" the same way Copilot blocks on the LLM turn. SDK class also gets `processingStart/End` pairing for free, which dashboards rely on for phase rendering.
- **New `mockReply` signal on `claudeSessionWorkflow`** — rejected. Wire-protocol surface inflation for a feature the existing cue surface covers via the `__MOCK__:` prefix. Adding signals is a one-way ratchet; we can always add later if friction emerges.
- **HTTP control endpoint in v1** — rejected. `__MOCK__:` prefix + scripted YAML cover the conductor's primary use case; HTTP control adds ~150 LoC + auth surface + Phase 2 dashboard wiring for ergonomic improvement, not capability.
- **Namespace-tag isolation (`ClaudeTempoEnv=dev` search attribute on workflows in the same namespace)** — rejected. Operators have to remember to filter by tag in every CLI/UI session; Maestro is namespace-wide so a shared namespace means dev pollutes prod's Maestro state; Temporal CLI / UI default to a namespace not a tag. Namespace isolation is the natural Temporal idiom.
- **Single multi-tenant daemon serving multiple namespaces / profiles** — rejected for v1. Significant complexity (per-request namespace routing, per-profile config, per-profile event bus). Separate daemon process is conceptually clean and reuses 100% of the existing daemon machinery.
- **Spin-up-per-validation lifecycle** (dev daemon starts/stops per scenario) — rejected. Cold-start latency (Temporal connection, namespace check, worker bootstrap, HTTP server, reconcile-on-boot) makes iterative validation painful. Long-lived dev daemon mirrors prod.
- **`claude-tempo dev <verb>` subcommand routing** vs **`--dev` top-level flag** — rejected the subcommand form. Would require duplicating every existing verb under the `dev` namespace, or building a generic "dispatch any verb under a profile" mechanism. Top-level flag is one parser change in `src/cli.ts`.
- **`claude-tempo <verb> --dev`** (per-verb flag) — rejected. Forces every verb to wire `--dev` independently; high churn surface. Top-level flag is parsed once before verb dispatch.
- **Profile name `dev` for the namespace** vs `claude-tempo-dev` — rejected the bare `dev`. Risk of collision with another product on the same Temporal cluster. Explicit prefix matches the home-dir convention.
- **Manual namespace setup** (operator runs `temporal operator namespace create -n claude-tempo-dev` once) — rejected as v1 default. Friction for the conductor; auto-create is idempotent and bounded. Operators on managed Temporal Cloud who lack `RegisterNamespace` permission see the same fall-through path (namespace registration logs + lets workers fail with a clear error).
- **Per-recruit mock seed for chaos mode** — rejected as required surface. Chaos seed is optional via `CLAUDE_TEMPO_MOCK_CHAOS_SEED`; default is `Date.now()`. Tests that need reproducibility set the env var; ad-hoc chaos uses a fresh seed each spawn.
- **Scenarios under `examples/mock-scenarios/`** — rejected per conductor input. Scenarios are first-class library artifacts (referenced by name, used by validation harness, shipped to users), not illustrative samples. Repo-root `scenarios/` mirrors how `examples/ensembles/` is *for examples*, not for the validation library.
- **Scenarios as TypeScript files** instead of YAML — rejected. YAML is human-editable, deterministic to load, no compilation step, can be checked in as black-box test fixtures. TS scenarios would couple the test surface to the build pipeline and tempt action-set extension via raw code.
- **Mock adapter exposes its own MCP tools** (so test code can drive it directly) — rejected for v1. Significant scope; not on critical path. Conductor drives via cues like any other player.
- **Always-spawn mock players visible in `--dev ensemble`** vs **hide them by default** — accepted the visible default. Mock players are real workflows in the dev namespace; hiding them would mean two ensemble views (with-mocks / without-mocks) and divergent dashboard rendering. Visibility makes the dev environment self-documenting.

## Forward-looking notes

- **Phase 2 — HTTP control endpoint** (`POST /v1/mock/inject` on the dev daemon). Composes with v1: scenarios YAML stays as the replayable surface; HTTP endpoint adds ad-hoc injection from out-of-band drivers (Playwright, manual curl). ~150 LoC.
- **Phase 2 — Dashboard `[DEV MODE]` ribbon** rendered from `/v1/health.devMode`. Polish; the daemon log already self-identifies. ~50 LoC dashboard side.
- **Phase 2 — Mock adapter as Copilot-class double** (mock variant that emulates Copilot's `processingStart/End` cadence specifically, for SDK-adapter regression tests). Defer until SDK adapter test coverage demand surfaces.
- **Phase 2 — Multi-tenant dev environments** (multiple parallel dev profiles on one machine). v1 escape hatch is `CLAUDE_TEMPO_HOME_OVERRIDE`; if heavy use emerges, a `claude-tempo profiles` CLI surface becomes warranted.
- **Phase 2 — Mock adapter conformance suite participation.** When the adapter conformance suite lands per `docs/design/session-lifecycle-rebuild-v2.md` §4.5, mock adapter participates in the parameterized test set. This catches drift between mock and real adapters' lifecycle semantics.
- **Phase 2 — Auto-discovery of `scenarios/` in user workspaces.** Currently bare-name resolution looks in the package's shipped `scenarios/` dir. A future `--scenario-path` flag could let users layer their own scenarios alongside shipped ones, with project-then-package precedence (mirrors player-types lookup).
- **Phase 3 — `staging` profile** following the same template (`isStagingMode()`, `~/.claude-tempo-staging/`, port `8475`, namespace `claude-tempo-staging`). The dev profile design intentionally generalises.
- **Wire-protocol additions post-v1.0** must register with the protobuf field-number plan in `protos/README.md` reservations log when #319 (protobuf migration) lands. **This design adds zero wire-protocol surface**, so the protobuf migration is unaffected by it.
- **Generalised lesson from PR-1 — host-process-layer enumeration must be cross-profile-aware.** The orphan-detector bug §5.7 documents isn't a one-off — it's a structural concern any time a utility enumerates host-wide state and filters by "is mine". Future host-scoped utilities (log rotation across profiles, port-conflict detection, daemon health aggregation, multi-profile `claude-tempo daemons` listing) must consult the same cross-profile PID/port-file set or risk the same class of bug. When the Phase 3 `staging` profile lands, this generalises further to N-profile awareness.

## References

- [`docs/design/dev-mode-mock-adapter.md`](../design/dev-mode-mock-adapter.md) — full design (13 sections, architecture diagram, mode descriptions, scenario format, four production safety gates, three-PR phasing, decision log)
- `src/adapters/README.md` — adapter contract; `BaseAttachment` / `SdkAttachment` lifecycle
- `src/adapters/base.ts` — `AdapterRegistry`, `resolveFromAgentType`, lifecycle skeleton (mock adapter inherits unchanged)
- `src/adapters/sdk/base.ts` — `SdkAttachment` (mock's parent class)
- `src/adapters/copilot/adapter.ts` — closest existing precedent for an SDK-class adapter with subprocess entry point (mock follows the same dual-purpose `require.main === module` pattern)
- `src/daemon.ts` — daemon entry, namespace registration callsite for dev profile
- `src/cli/daemon.ts` — daemon start/stop/lock-file machinery (reused unchanged for dev daemon)
- `src/connection.ts` — Temporal connection factory (no changes; namespace passes through `Config`)
- `src/config.ts` — config resolution chain (extended with `isDevMode()` + profile-aware defaults)
- `src/tools/recruit.ts` — recruit pre-flight (gate 3 added here)
- `src/spawn.ts` — process spawning (mock branch added — headless subprocess, no terminal window)
- `docs/design/session-lifecycle-rebuild-v2.md` §4 (adapter extensibility), §4.3 (lifecycle guarantees), §4.5 (conformance suite — mock will participate), §4.6 (worked example: SDK adapter)
- `docs/WIRE-PROTOCOL.md` — confirms zero protocol changes required by this design
- ADR 0007 (TempoClient Core/WithSpawn split), 0008 (coat-check), 0009 (protobuf), 0011 (saveable-state), 0012 (claude-api adapter), 0013 (web dashboard) — design-spike template precedent
- Issue / conductor brief 2026-04-27 — vinceblank's stated vision: "fully run the dashboard and test it in an isolated dev environment"
