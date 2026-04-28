# Fix path — dev-mode isolation (#423)

- **Status**: Spec — engineer pickup
- **Date**: 2026-04-28
- **Author**: tempo-architect
- **Related**: [#423](https://github.com/vinceblank/claude-tempo/issues/423), [ADR 0014](../adr/0014-dev-mode-mock-adapter.md)

## TL;DR

The user's mandate is **isolated E2E in local dev with zero impact on co-tenant prod and zero global-install dependency**. The four gaps in #423 are not equally critical:

| Gap | Severity | In MVP? |
|-----|----------|---------|
| 1. Namespace not isolated (config resolution leaks shell env vars) | **P0 — actively broken** | **Yes** |
| 3. `down` kills shared Temporal server | **P0 — destructive cross-profile** | **Yes** |
| 4. Global-install dependency | **P2 — already mostly works; docs gap** | **Yes (docs only)** |
| 2. Shared Temporal server (port 7233) | **P2 — operational coupling, not state** | **No — defer** |

**Verdict: Gap 1 + Gap 3 + Gap 4-docs is the smallest viable fix.** Gap 2 (own Temporal server per profile) adds significant complexity (spawn/monitor a second `temporal server start-dev` with isolated db, port-conflict detection, ramp-down sequencing) for marginal benefit once Gap 1 + Gap 3 land. Defer Gap 2 to a separate spec; revisit if cross-profile server-lifetime coupling causes pain after PR-B ships.

## Diagnosis

### Gap 1 — namespace leak

Two paths cause the banner-vs-actual mismatch:

**Cause 1.a — config resolution honors generic Temporal env vars in dev mode.**
`src/config.ts:483-496` (`getConfig` → `temporalNamespace`):
```ts
temporalNamespace: resolve(
  overrides.temporalNamespace,            // CLI flag wins
  ENV.TEMPORAL_NAMESPACE,                 // ⬅️ leaks: TEMPORAL_NAMESPACE=default in user shell
  configFile.temporalNamespace,           // ⬅️ leaks: ~/.claude-tempo-dev/config.json
  isDevMode() ? undefined : temporalCli.temporalNamespace,  // ✓ already dropped in dev
  isDevMode() ? DEV_TEMPORAL_NAMESPACE : PROD_TEMPORAL_NAMESPACE,
),
```
The `temporal-cli` yaml fallback was correctly identified as a leak vector and dropped in dev mode (line 494). But `process.env.TEMPORAL_NAMESPACE` is the same kind of leak — generic Temporal CLI users export it shell-wide as `default` for ad-hoc `temporal workflow list` work. It bleeds straight into the dev daemon's resolved config. Same pattern for `TEMPORAL_ADDRESS`.

The leak is amplified by `src/cli/daemon.ts:422-426`:
```ts
const env = {
  ...process.env,
  [ENV.TEMPORAL_NAMESPACE]: config.temporalNamespace,   // parent's leaked value → child env
  ...
};
```
Even if the user runs the CLI with the env unset for one invocation, the spawned daemon inherits `process.env` and re-resolves the same way.

**Cause 1.b — banner reads constants, not resolved config.**
`src/cli/dev-banner.ts:76-86` formats from `DEV_TEMPORAL_NAMESPACE` etc. directly. The banner cannot disagree with the actual resolved config because they don't share state — they're independent code paths. So the banner promises isolation that the connection does not deliver.

### Gap 3 — `down` is host-wide

`src/cli/commands.ts:1601-1614`:
```ts
if (process.platform === 'win32') {
  execFileSync('taskkill', ['/F', '/IM', 'temporal.exe'], ...);
} else {
  execFileSync('pkill', ['-f', 'temporal server start-dev'], ...);
}
```
Both branches kill **every** matching process on the host. No profile awareness, no PID tracking, no `isOtherProfileLikelyRunning()` guard — even though that helper already exists at `src/cli/daemon.ts:211` and `stopDaemon()` already uses it correctly (line 665). Same class of bug as the orphan-reaper bug fixed in PR-1 of ADR 0014, just in a different code path.

### Gap 4 — global install

The `claude-tempo` shell command is just a `package.json#bin` shim that invokes `dist/cli.js`. Every code path the user needs for dev-mode E2E already works through `node dist/cli.js --dev <verb>`. The user's experience of "needed global install to recover" was a downstream symptom of Gap 3: when shared Temporal got nuked, prod's auto-restart logic wanted to spawn a Temporal server itself, and that path goes through `claude-tempo` resolved on PATH. With Gap 3 fixed, that recovery path doesn't fire in the first place.

This gap is closed by **documentation** + a small assertion that `node dist/cli.js --dev <verb>` is a supported entry point.

### Gap 2 — shared Temporal server (deferred)

With Gap 1 fixed, both daemons connect to `localhost:7233` but use different namespaces (`claude-tempo-dev` vs `default`) and different task queues (`claude-tempo-dev` vs `claude-tempo`). Workers don't compete; visibility queries are namespace-scoped; activities don't cross. The only remaining coupling is operational: dev and prod share the Temporal server's lifetime. With Gap 3 fixed, neither profile can destroy that shared lifetime via its CLI.

A profile-owned Temporal server (Gap 2) would buy:
- True lifecycle independence (dev can `down` Temporal without affecting prod)
- Reproducible cold-start (dev's namespace + workflow history can be wiped by deleting dev's db file)

But it costs:
- Spawn-and-supervise a second `temporal server start-dev --port 7234 --db-filename <dev-home>/temporal.db`
- Track its PID, heartbeat it, reap it on shutdown
- Port-conflict detection (7234 might be taken)
- Ramp-down ordering (kill server only after dev daemon drains)
- Either: dev daemon owns the server (then `daemon stop` must stop both); or: server is its own subcommand (`claude-tempo --dev temporal start/stop`).

Skip for v1. Document the manual escape hatch (`temporal server start-dev --port 7234` in a separate terminal + `--temporal-address localhost:7234` CLI flag) for users who want full lifecycle isolation today.

## Fix path

Three small PRs, ordered for safe rollout. Each ships independently and adds value on its own.

### PR-A — Gap 1: drop generic Temporal env vars in dev mode (~120 LoC)

**Files**: `src/config.ts`, `src/cli/dev-banner.ts`, new test in `test/`.

**Changes**:

1. `src/config.ts` — in both `getConfig` and `getConfigWithSources`, gate `process.env.TEMPORAL_NAMESPACE` and `process.env.TEMPORAL_ADDRESS` on `!isDevMode()`. Mirrors the existing temporal-cli drop. CLI flag (`overrides.*`) and the per-profile `~/.claude-tempo-dev/config.json` continue to win, so users who genuinely want a non-default namespace in dev have explicit overrides.

   Concretely, replace the `resolve()` callsite signature where needed, OR lift env-var reads into a helper:
   ```ts
   const envOverride = (key: string) =>
     isDevMode() && (key === ENV.TEMPORAL_NAMESPACE || key === ENV.TEMPORAL_ADDRESS)
       ? undefined
       : process.env[key];
   ```
   …then the resolution chain becomes `cliVal || envOverride(key) || fileVal || temporalCliVal || defaultVal`. Same shape, one new gate.

2. `src/cli/dev-banner.ts` — re-render the banner from actual `getConfig()` instead of constants. Adds source annotations so banner becomes diagnostic-grade:
   ```
   [DEV MODE] using ~/.claude-tempo-dev · port 8474 · namespace claude-tempo-dev · queue claude-tempo-dev
   ```
   becomes (using `getConfigWithSources()`):
   ```
   [DEV MODE] using ~/.claude-tempo-dev · port 8474 · namespace claude-tempo-dev (default) · queue claude-tempo-dev (default)
   ```
   When the banner shows `namespace default (env)` an operator instantly sees a leak. Future drift is caught at runtime, not weeks later.

3. `src/daemon.ts` (after `getConfig()` in `main()`) — emit a soft assertion:
   ```ts
   if (isDevMode() && config.temporalNamespace !== DEV_TEMPORAL_NAMESPACE) {
     log(`[dev-mode] WARNING: resolved namespace "${config.temporalNamespace}" != dev default "${DEV_TEMPORAL_NAMESPACE}"`);
     log(`[dev-mode] check overrides: --temporal-namespace, ${ENV.TEMPORAL_NAMESPACE} env, ~/.claude-tempo-dev/config.json`);
   }
   ```
   Defense in depth: even if a future config-resolution refactor reintroduces the leak, the daemon log self-identifies the drift.

**Tests** (Mocha or Vitest, existing dirs both fine):
- `getConfig()` with `CLAUDE_TEMPO_DEV_MODE=1` + `TEMPORAL_NAMESPACE=default` in env → returns `claude-tempo-dev`. Same for `TEMPORAL_ADDRESS`.
- `getConfig()` with `CLAUDE_TEMPO_DEV_MODE=1` + `--temporal-namespace=foo` CLI override → returns `foo` (CLI flag still wins).
- `getConfig()` with `CLAUDE_TEMPO_DEV_MODE=1` + `~/.claude-tempo-dev/config.json` having `temporalNamespace: bar` → returns `bar` (per-profile config wins; this is the override path).
- Banner formatter renders the resolved namespace, not `DEV_TEMPORAL_NAMESPACE`, when they differ.

**Wire protocol impact**: none. No signal/query/update changes; namespace selection is client-side.

**Risk**: medium-low. Users who actively rely on shell-wide `TEMPORAL_NAMESPACE` to override claude-tempo's namespace in dev would need to switch to a CLI flag. Document this in the changelog as a small breaking change for dev mode only; prod behavior is unchanged.

### PR-B — Gap 3: profile-scope `down` (~80 LoC)

**Files**: `src/cli/commands.ts`, `src/cli/help-text.ts`, test.

**Changes**:

1. `down()` in `src/cli/commands.ts:1511` — replace the unconditional Temporal kill with a profile-aware variant:
   ```ts
   // Step 4: Stop Temporal dev server (profile-scoped per ADR 0014 §5.6).
   const otherProfileAlive = isOtherProfileLikelyRunning();
   const killTemporalAllowed = !otherProfileAlive || opts.killSharedTemporal;
   if (temporalUp && killTemporalAllowed) {
     // existing pkill / taskkill logic
   } else if (temporalUp && otherProfileAlive) {
     out.warn('Temporal server left running — shared with the other profile.');
     out.log(`  ${out.dim('Override (kills both profiles\' connection): claude-tempo down --kill-shared-temporal')}`);
   } else {
     out.log(`  ${out.dim('Temporal not running')}`);
   }
   ```

2. Add `killSharedTemporal: boolean` to `DownOpts`. Wire `--kill-shared-temporal` flag in `src/cli/help-text.ts` + the CLI parser.

3. Update `down` heading line — when in dev mode + prod daemon alive, say "Stopping dev daemon. Prod daemon and shared Temporal server left running." so the user sees the safety guarantee before the action.

**Tests**:
- `down()` with `--dev` and a faked prod-profile-alive → does NOT invoke pkill/taskkill (stub the executor, assert zero calls).
- `down()` with `--dev` + `--kill-shared-temporal` → DOES invoke the kill. (Explicit opt-in path.)
- `down()` in prod mode with no other profile alive → behaves as before (regression baseline).

**Wire protocol impact**: none.

**Risk**: low. The new behavior is strictly more conservative. The opt-in flag preserves the destructive path for users who genuinely need it (e.g. a single-user laptop with no co-tenant).

### PR-C — Gap 4: docs + supported entry point (~80 LoC docs)

**Files**: `docs/development.md`, `README.md` (small section), `docs/troubleshooting.md` (new troubleshooting entry).

**Changes**:

1. `docs/development.md` — add a "Running an isolated dev environment" section:
   ```bash
   git clone https://github.com/vinceblank/claude-tempo
   cd claude-tempo
   npm install
   npm run build

   # Start the dev profile — fully isolated from any prod claude-tempo install
   node dist/cli.js --dev daemon start

   # Run the all-mock E2E lineup (no real Claude sessions, no trust prompt)
   node dist/cli.js --dev up --lineup tempo-mock-jam

   # Tear down — leaves prod daemon + shared Temporal server alone
   node dist/cli.js --dev down
   ```
   Note explicitly:
   - `claude-tempo` shell command is convenience, not required. `node dist/cli.js` is the canonical entry.
   - Do NOT set `TEMPORAL_NAMESPACE` or `TEMPORAL_ADDRESS` shell-wide in dev mode. If you must override per-call, use `--temporal-namespace=...` / `--temporal-address=...` CLI flags. (PR-A makes this safe by ignoring shell vars; doc reinforces the supported path.)
   - Dev profile data lives in `~/.claude-tempo-dev/`; safe to `rm -rf` for a clean slate.

2. `docs/troubleshooting.md` — new section "Dev daemon connects to wrong namespace":
   - Symptoms: dev banner says `claude-tempo-dev` but daemon log says `Connecting to ... namespace: default`.
   - Diagnosis: run `node dist/cli.js --dev config show` to see resolved values + sources.
   - Common causes: stale shell `TEMPORAL_NAMESPACE` (PR-A blocks this in dev mode for new installs; older builds need to `unset` the var); `~/.claude-tempo-dev/config.json` carrying over prod values.

3. `README.md` — one-paragraph "Try the mock E2E demo" section that points at the development.md guide.

**Wire protocol impact**: none.

**Risk**: zero (docs only).

## Rollout sequence

1. **Land PR-A first.** Without it, PR-B's profile-aware `down` still leaves the user with the wrong namespace — half a fix is confusing. PR-A is the foundation.
2. **PR-B follows.** Defensive, additive — strict superset of current behavior.
3. **PR-C ships any time after PR-A.** Pure docs.

After all three ship, the acceptance criteria from #423 are met:
- ✅ Dev daemon connects to `claude-tempo-dev` regardless of shell env vars (PR-A).
- ✅ All dev workflows visible only on dev's namespace (PR-A — namespace isolation was the original ADR 0014 goal; the bug was the namespace leak, not the design).
- ✅ `--dev down` only affects dev resources (PR-B).
- ✅ Cross-profile coexistence: zero new code; the existing `isOtherProfileLikelyRunning()` already guards `daemon start` and `daemon stop`. PR-B extends to `down`.
- ✅ No global-install dependency for any dev workflow (PR-C — already true; docs make it explicit).

The only deferred item is "dev daemon starts its own Temporal server on a separate port" (Gap 2). It's not on the path to "isolated E2E works" — it's on the path to "dev's lifecycle is fully self-contained." Punt to a follow-up issue if and only if cross-profile Temporal-server lifetime coupling causes pain after PR-B lands.

## Out of scope

- Changing prod CLI behavior (`down` still kills Temporal in prod-mode-only invocations when no other profile is alive).
- Migrating dev mode off `temporal server start-dev`.
- Adding a `claude-tempo --dev temporal <start|stop>` subcommand (would be useful but is part of the deferred Gap 2 work).
- Multi-profile awareness beyond dev/prod (Phase 3 `staging` profile per ADR 0014).

## Open questions for engineer

1. **PR-A — env-var override semantics**: should we drop ALL `TEMPORAL_*` env vars in dev mode (including `TEMPORAL_API_KEY`, `TEMPORAL_TLS_*`)? Recommendation: yes for `TEMPORAL_NAMESPACE` and `TEMPORAL_ADDRESS` (they're the leaks); leave API key + TLS alone since those are per-credential and a user with Temporal Cloud auth probably wants the same auth in dev. Surface in `getConfigWithSources()` so `config show` makes it visible.
2. **PR-B — flag name**: `--kill-shared-temporal` is the architect-suggested name. Alternatives: `--force-temporal-kill`, `--down-temporal-too`. Engineer's call. The doc string matters more than the flag name.
3. **PR-A — banner format**: the source-annotated banner is suggested ("namespace claude-tempo-dev (default)"). Acceptable to ship PR-A without that polish if it adds friction; the assertion in `daemon.ts` is the load-bearing diagnostic. Banner change is a nice-to-have.

## References

- `src/config.ts:454-523` — `getConfig` resolution chain
- `src/config.ts:483-496` — `temporalNamespace` resolution (the leak)
- `src/cli/dev-banner.ts:76-86` — banner formatter (constants-based)
- `src/cli/daemon.ts:211-215` — `isOtherProfileLikelyRunning` (existing guard, reused by PR-B)
- `src/cli/daemon.ts:631-684` — `stopDaemon` (existing reference implementation of profile-aware kill)
- `src/cli/commands.ts:1511-1677` — `down` (PR-B target)
- `docs/adr/0014-dev-mode-mock-adapter.md` §5.6 — cross-profile coexistence design rule
- [#423](https://github.com/vinceblank/claude-tempo/issues/423) — original issue
