#!/usr/bin/env node
/**
 * Daemon entry point — runs Temporal workers in a detached background process.
 *
 * Started by `startDaemon()` in `src/cli/daemon.ts`.
 * Config is passed via environment variables set by the parent.
 *
 * Writes its PID to ~/.agent-tempo/daemon.pid on startup and removes it
 * on graceful shutdown (SIGTERM/SIGINT).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setTimeout as sleep } from 'timers/promises';
import { Client, Connection } from '@temporalio/client';
import { WorkflowIdConflictPolicy } from '@temporalio/client';
import {
  getConfig,
  type Config,
  AGENT_TEMPO_HOME,
  DEV_TEMPORAL_NAMESPACE,
  GLOBAL_MAESTRO_WORKFLOW_ID,
  isDevMode,
  loadDaemonConfig,
  type DaemonConfig,
} from './config';
import { emitDevBannerIfActive } from './cli/dev-banner';
import { createWorkers } from './worker';
import { createTemporalConnection } from './connection';
import { InnerLoopRegistry } from './http/inner-loop';
import { IngestTokenRegistry } from './http/ingest-registry';
import { installGrpcShutdownGuard } from './utils/grpc-shutdown-guard';
import { DAEMON_PID_PATH, DAEMON_LOG_PATH, DAEMON_HEARTBEAT_PATH, HEARTBEAT_INTERVAL_MS } from './cli/daemon';
import { createTempoClient } from './client';
import { queryOrphanedSessions, restoreOrphansOnce, type OrphanCandidate } from './reconcile/orphans';
import { listAgentTypes } from './ensemble/agent-types';
import { probeClaudeBinary, probeClaudeAuth } from './adapters/claude-code-headless/pre-flight';
import {
  probeAdapterVersions,
  resolveCopilotSdkVersionSync,
} from './daemon-adapter-versions';
import type { GlobalMaestroInput, HostProfile } from './types';

const log = (...args: unknown[]) => console.error(`[agent-tempo:daemon ${new Date().toISOString()}]`, ...args);

/**
 * Daemon process start time, captured at module load. Issue #399 Q5.3b
 * advertises this on every `hostProfile` signal as
 * {@link HostProfile.daemonStartedAt} so the dashboard's Hosts table
 * can render `now - daemonStartedAt` as the daemon-process uptime.
 *
 * Captured here (top-of-module) rather than inside `computeHostProfile`
 * so a refresh-host-profile invocation later in the daemon's lifetime
 * still advertises the original boot time. Module load happens once
 * per daemon process; the value is effectively the daemon's birth time.
 */
const DAEMON_STARTED_AT = Date.now();

/**
 * Atomically write the daemon PID file via `writeFile(tmp) + rename(tmp, final)`.
 *
 * A racing reader (a CLI invocation that happens to poll during startup) will
 * either see the previous file or the new one — never a half-written one.
 *
 * Windows sometimes fails the rename with EPERM/EBUSY/EACCES if an antivirus
 * scanner or the previous handle is still active. We retry with short backoffs
 * before giving up so a transient scanner doesn't crash startup.
 *
 * Exported for unit testing.
 */
export async function writePidFileAtomic(pidFilePath: string, pid: number): Promise<void> {
  const tmp = `${pidFilePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, String(pid));

  const retryCodes = new Set(['EPERM', 'EBUSY', 'EACCES']);
  const backoffs = [50, 100, 200, 400]; // ms — total ≤ 750ms, bounded for startup
  let lastErr: unknown;

  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    try {
      fs.renameSync(tmp, pidFilePath);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (!code || !retryCodes.has(code) || attempt === backoffs.length) {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        throw err;
      }
      await sleep(backoffs[attempt]);
    }
  }
  // Unreachable — loop either returns or throws.
  throw lastErr;
}

// ── Dev profile (ADR 0014 §6.2) ──

/**
 * Runtime drift detector — #423 PR-A Fix 3. When dev mode is active but
 * the resolved namespace is NOT the dev default, an explicit override is
 * in play (CLI `--namespace`, `~/.agent-tempo-dev/config.json`, or — if
 * the env-var carve-out from Fix 1 ever regressed — a leaked shell var).
 * Either way, the operator deserves a load-bearing diagnostic so the
 * "banner says X, daemon connects to Y" drift doesn't recur silently.
 *
 * Pure function over the resolved Config + an injected log sink so the
 * unit test can capture the message without a live daemon process.
 * Returns whether a warning fired so callers (and tests) can assert on
 * the branch directly.
 *
 * The check is intentionally loose: any namespace mismatch in dev mode
 * triggers the warning, even for intentional overrides. We can't tell
 * a typo'd `config.json` entry from a deliberate one — the warning is
 * cheap, and an operator who overrode the namespace on purpose can
 * grep-skip a single line.
 */
export function warnIfDevNamespaceDrift(
  config: Pick<Config, 'temporalNamespace'>,
  logFn: (...args: unknown[]) => void = log,
): boolean {
  if (!isDevMode()) return false;
  if (config.temporalNamespace === DEV_TEMPORAL_NAMESPACE) return false;
  logFn(
    `[dev-mode] WARNING: namespace drift — connecting to "${config.temporalNamespace}" ` +
    `instead of dev default "${DEV_TEMPORAL_NAMESPACE}". An explicit override is in ` +
    `play (CLI flag, dev config.json). Drop the override to restore dev profile isolation ` +
    `(ADR 0014 §5.1).`,
  );
  return true;
}

/**
 * Outcome of {@link ensureDevNamespace} — exposed so unit tests can assert
 * on which branch fired without having to inspect log output.
 *
 *   - `created`: registerNamespace succeeded (first dev daemon boot)
 *   - `already-exists`: namespace already registered (every subsequent boot)
 *   - `permission-denied`: server rejected; daemon continues, worker may fail
 *   - `error`: any other failure
 *
 * @internal
 */
export interface EnsureDevNamespaceResult {
  ok: boolean;
  status: 'created' | 'already-exists' | 'permission-denied' | 'error';
  message?: string;
}

/**
 * Auto-create the dev profile's Temporal namespace on dev daemon boot
 * (ADR 0014 §6.2). Idempotent — calling it on every boot is correct and
 * cheap.
 *
 *   - `ALREADY_EXISTS`: the steady state after the first boot. Happy path.
 *   - `PERMISSION_DENIED`: e.g. managed Temporal Cloud where `RegisterNamespace`
 *     isn't granted. Log + return; the subsequent worker bootstrap fails
 *     loudly with `Namespace not found` and the operator can run
 *     `temporal operator namespace create -n agent-tempo-dev` themselves.
 *   - any other error: same fall-through; daemon stays alive without
 *     mutating state.
 *
 * Production daemons never call this — guarded by `isDevMode()` at the
 * single callsite in `main()` below. Exported for direct unit testing
 * with an injected stub workflow service.
 */
export async function ensureDevNamespace(
  connection: Pick<Connection, 'workflowService'>,
  namespace: string,
  logFn: (...args: unknown[]) => void = log,
): Promise<EnsureDevNamespaceResult> {
  const wfService = connection.workflowService;
  try {
    await wfService.registerNamespace({
      namespace,
      // 1-day retention is generous for dev scratch state and keeps the
      // namespace tidy without aggressive cleanup pressure. The proto's
      // `seconds` field is typed as `Long` (int64), but the gRPC layer
      // accepts a plain number and coerces internally — same shape used
      // by Temporal's own examples. Cast keeps the call site readable
      // without dragging `long.js` into our direct dep graph.
      workflowExecutionRetentionPeriod: { seconds: 86_400 as unknown as import('long') },
      description: 'agent-tempo dev profile — auto-created. Safe to drop.',
    });
    logFn(`[dev-mode] registered Temporal namespace "${namespace}"`);
    return { ok: true, status: 'created' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: number | string; details?: { code?: number | string } })?.code
      ?? (err as { details?: { code?: number | string } })?.details?.code;
    // ALREADY_EXISTS — happy path on every boot after the first. The
    // gRPC code is 6; the Temporal SDK also surfaces it as a string in
    // some transports, so check both shapes plus a substring fallback.
    if (code === 'ALREADY_EXISTS' || code === 6 || /already.?exists/i.test(message)) {
      logFn(`[dev-mode] Temporal namespace "${namespace}" already registered`);
      return { ok: true, status: 'already-exists' };
    }
    // PERMISSION_DENIED — e.g. managed Temporal Cloud without RegisterNamespace.
    // Log a hint so operators know what to do.
    if (code === 'PERMISSION_DENIED' || code === 7 || /permission/i.test(message)) {
      logFn(
        `[dev-mode] could not register namespace "${namespace}" — permission denied. ` +
        `Run \`temporal operator namespace create -n ${namespace}\` (or grant RegisterNamespace) once.`,
      );
      return { ok: false, status: 'permission-denied', message };
    }
    logFn(
      `[dev-mode] could not register namespace "${namespace}" (continuing; worker may fail with a clearer error):`,
      message,
    );
    return { ok: false, status: 'error', message };
  }
}

/**
 * Ensure the global Maestro workflow is running.
 * Uses USE_EXISTING conflict policy so it's safe to call on every daemon start.
 */
async function ensureGlobalMaestro(config: ReturnType<typeof getConfig>): Promise<void> {
  try {
    const connection = await createTemporalConnection(config);
    const client = new Client({ connection, namespace: config.temporalNamespace });

    const input: GlobalMaestroInput = {};
    await client.workflow.start('agentGlobalMaestroWorkflow', {
      workflowId: GLOBAL_MAESTRO_WORKFLOW_ID,
      taskQueue: config.taskQueue,
      args: [input],
      workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
    });
    log(`Global Maestro ensured (id: ${GLOBAL_MAESTRO_WORKFLOW_ID})`);
  } catch (err) {
    // Non-fatal — the global maestro is optional for basic operation
    log('Failed to ensure global Maestro (non-fatal):', err instanceof Error ? err.message : String(err));
  }
}

// ────────────────────────────────────────────────────────────────────────
// #274 — host capability profile: compute → scrub → signal
// ────────────────────────────────────────────────────────────────────────

/**
 * Daemon package version, lazily read from `package.json` so the test
 * build (which compiles daemon.ts into `dist-test/src/` where
 * `../package.json` doesn't resolve) can exercise daemon-boot logic
 * without MODULE_NOT_FOUND. Tests that exercise `computeHostProfile`
 * pass a stubbed version via `HostProfile.version` on the input.
 */
function daemonVersion(): string {
  try {
    const { version } = require('../package.json') as { version: string };
    return version;
  } catch {
    return 'unknown';
  }
}

/**
 * Test-only dependency-injection seam for {@link computeHostProfile}.
 *
 * Production callers omit `deps` entirely; the defaults resolve to the
 * real probes in `daemon-adapter-versions.ts`. Tests inject stubs to
 * exercise installed-vs-not-installed scenarios deterministically
 * without touching the host filesystem. Mirrors the
 * `ProbeAdapterVersionsDeps` shape from `daemon-adapter-versions.ts`,
 * but only includes synchronous probes — `computeHostProfile` is sync
 * by contract.
 *
 * Added in #532 PR-2 for the copilot host-profile probe.
 */
export interface ComputeHostProfileDeps {
  /**
   * Synchronous Copilot SDK version probe. Default:
   * {@link resolveCopilotSdkVersionSync} from `daemon-adapter-versions.ts`.
   * Returns the SDK's `package.json#version` when installed, or
   * `undefined` when missing or unresolvable.
   */
  resolveCopilotSdkVersionSync?: () => string | undefined;
}

/**
 * Build the daemon's capability profile from its config + runtime env.
 * Result is NOT scrubbed — call `scrubHostProfile` before signaling.
 *
 * Exported for testability; production callers go through
 * `runDaemonBoot(client, deps)` which provides this as the default
 * `computeHostProfile` dep.
 */
export function computeHostProfile(
  config: Config,
  deps: ComputeHostProfileDeps = {},
): HostProfile {
  const resolveCopilotSync =
    deps.resolveCopilotSdkVersionSync ?? resolveCopilotSdkVersionSync;
  const agentTypes = (() => {
    try {
      return listAgentTypes().map((a) => a.name);
    } catch {
      // listAgentTypes reads the filesystem; treat any failure as "no
      // discoverable types" rather than crashing boot.
      return [];
    }
  })();

  // Build the available-agents array. Always includes the configured
  // default. #520 — additionally probe whether `claude` is installed AND
  // logged in; if both pass, advertise `'claude-code-headless'` so
  // cross-host recruit pre-flight can reject early on hosts without the
  // CLI configured. Bounded by the probe timeouts (3s + 5s = ≤8s worst
  // case) — acceptable boot cost for a one-shot probe.
  const availableAgentTypes: string[] = [config.defaultAgent];
  try {
    const binProbe = probeClaudeBinary(config.claudeBin ?? 'claude');
    if (binProbe.ok) {
      const authProbe = probeClaudeAuth(config.claudeBin ?? 'claude');
      if (authProbe.loggedIn && !availableAgentTypes.includes('claude-code-headless')) {
        availableAgentTypes.push('claude-code-headless');
      }
    }
  } catch {
    // Probe machinery should never throw, but guard anyway — host-profile
    // computation is on the critical boot path.
  }
  // #532 PR-2 — copilot probe. Reuses the same sync require-source-of-
  // truth as `defaultResolveCopilotSdkVersion` (which it delegates to);
  // resolves to a version string when `@github/copilot-sdk` is
  // installed, or `undefined` when missing. Closes the gap where
  // cross-host recruit of `agent: 'copilot'` was rejected with a
  // misleading "host cannot run copilot" message even on hosts where
  // the SDK was installed and Copilot was logged in. Pattern mirrors
  // the claude-code-headless block above.
  try {
    const copilotVersion = resolveCopilotSync();
    if (copilotVersion && !availableAgentTypes.includes('copilot')) {
      availableAgentTypes.push('copilot');
    }
  } catch {
    // Defensive — `resolveCopilotSdkVersionSync` already swallows
    // require failures, but the boot path must not crash on any
    // surprise here.
  }

  return {
    hostname: os.hostname(),
    version: daemonVersion(),
    defaultAgent: config.defaultAgent,
    // #520 + #532 PR-2 — was: `[config.defaultAgent]`. Now grows when
    // the optional probes pass: `claude-code-headless` (when `claude`
    // is on PATH AND logged in), `copilot` (when `@github/copilot-sdk`
    // is installed). Future PRs can extend the same pattern for
    // `claude-api` (probe `@anthropic-ai/sdk` install +
    // ANTHROPIC_API_KEY env) and `opencode` (probe `@opencode-ai/sdk`
    // install + `opencode` binary on PATH). Recording as an array
    // keeps the wire shape forward-compatible.
    availableAgentTypes,
    availablePlayerTypes: agentTypes,
    claudeBin: config.claudeBin,
    platform: process.platform,
    capabilities: [],
    daemonStartedAt: DAEMON_STARTED_AT,
    // adapterVersions is populated at runDaemonBoot time after the
    // parallel probe (see runDaemonBoot below). computeHostProfile
    // intentionally returns the immediate fields only.
  };
}

/**
 * #274 AC5c / M10 — HARD REQUIREMENT privacy scrub.
 *
 * Strips absolute paths and file extensions from every `HostProfile` field
 * before the payload crosses the signal boundary. The global maestro is
 * namespace-wide; a multi-tenant or multi-ensemble corporate setup would
 * leak username-containing paths across ensembles if this is ever
 * violated. Unit-tested in `test/daemon-boot.test.ts` with a dedicated
 * "no `/` or `\\` in any string" invariant assertion against pathological
 * inputs.
 *
 * Contract per architect AC5c:
 * - `claudeBin` — basename only (e.g. `claude`), never absolute
 * - `availableAgentTypes` — names only, never paths
 * - `availablePlayerTypes` — names only, never paths
 * - No env var values, no `workDir`, no user directories in any field
 *
 * The scrub is defense-in-depth: production callers (`computeHostProfile`)
 * already produce clean inputs from `listAgentTypes().map(a => a.name)`.
 * If a future code path accidentally passes a path, this function catches
 * it before the workflow handler ever sees it.
 */
export function scrubHostProfile(raw: HostProfile): HostProfile {
  const stripPath = (s: string): string => {
    // Platform-independent basename: `path.basename` is runtime-bound —
    // on POSIX it doesn't recognise `\` as a separator, so a Windows
    // daemon's signal leaking `'C:\Users\alice\bin\claude.exe'` into
    // a Linux-hosted global maestro would bypass the scrub entirely
    // (CI caught exactly this on Ubuntu shard-2). Normalize first,
    // then use `path.posix.basename` explicitly so the scrub is
    // deterministic regardless of where the daemon or maestro runs.
    //
    // Also strip a single trailing `.md` — player-type files are
    // shipped as e.g. `tempo-soloist.md` but the name should be just
    // `tempo-soloist` on the wire.
    const normalized = s.replace(/\\/g, '/');
    const base = path.posix.basename(normalized);
    return base.endsWith('.md') ? base.slice(0, -3) : base;
  };
  const scrubList = (list: string[] | undefined): string[] | undefined =>
    list?.map(stripPath);

  // Issue #399 — pass-through fields with no privacy concern.
  // `daemonStartedAt` is a number; `adapterVersions` keys are adapter
  // NAMES and values are version strings. Neither carries paths,
  // env vars, or user-home directories, so the AC5c scrub doesn't
  // need to touch them. We conditionally splice them in only when
  // they're defined on the input, so the scrub output stays
  // shape-equivalent to a clean input that omits them — the
  // already-clean round-trip test (`scrubHostProfile(clean) === clean`)
  // continues to hold.
  const out: HostProfile = {
    hostname: raw.hostname,
    version: raw.version,
    defaultAgent: raw.defaultAgent,
    availableAgentTypes: scrubList(raw.availableAgentTypes),
    availablePlayerTypes: scrubList(raw.availablePlayerTypes),
    claudeBin: raw.claudeBin ? stripPath(raw.claudeBin) : undefined,
    platform: raw.platform,
    capabilities: raw.capabilities,
  };
  if (raw.daemonStartedAt !== undefined) out.daemonStartedAt = raw.daemonStartedAt;
  if (raw.adapterVersions !== undefined) out.adapterVersions = raw.adapterVersions;
  return out;
}

/** Production default: signal the global maestro with the profile. */
async function realSendHostProfileSignal(client: Client, profile: HostProfile): Promise<void> {
  const handle = client.workflow.getHandle(GLOBAL_MAESTRO_WORKFLOW_ID);
  await handle.signal('hostProfile', profile);
}

/**
 * Signal `hostProfile` with bounded retry (AC5b / M11).
 *
 * Default backoff: `[0, 5000, 15000]` ms → 3 attempts, ≤20 s wall-clock,
 * well under the 30 s budget. Tests override to `[0, 0, 0]` for fast
 * execution. On total failure, logs a warning and returns — the daemon
 * stays alive without its profile advertised.
 *
 * Exported for reuse by the Phase 5 `agent-tempo refresh-host-profile`
 * CLI subcommand, which re-signals without needing the full
 * `runDaemonBoot` sequence (the global maestro is already up).
 */
export async function advertiseHostProfile(
  client: Client,
  profile: HostProfile,
  opts: {
    retryBackoffsMs?: number[];
    log?: (...args: unknown[]) => void;
    sendSignal?: (client: Client, profile: HostProfile) => Promise<void>;
  } = {},
): Promise<{ ok: boolean; attempts: number; lastError?: unknown }> {
  const backoffs = opts.retryBackoffsMs ?? [0, 5000, 15000];
  const logFn = opts.log ?? log;
  const send = opts.sendSignal ?? realSendHostProfileSignal;
  let lastError: unknown;
  for (let attempt = 0; attempt < backoffs.length; attempt++) {
    const delay = backoffs[attempt];
    if (delay > 0) await sleep(delay);
    try {
      await send(client, profile);
      logFn(`Advertised host profile for "${profile.hostname}" (attempt ${attempt + 1}/${backoffs.length})`);
      return { ok: true, attempts: attempt + 1 };
    } catch (err) {
      lastError = err;
      logFn(`hostProfile signal attempt ${attempt + 1}/${backoffs.length} failed:`, err instanceof Error ? err.message : err);
    }
  }
  logFn(
    `Failed to advertise host profile after ${backoffs.length} attempts (non-fatal; daemon stays alive):`,
    lastError instanceof Error ? lastError.message : lastError,
  );
  return { ok: false, attempts: backoffs.length, lastError };
}

/**
 * #274 M14 — boot-sequence deps. Injected at `runDaemonBoot` so the
 * ordering + retry + scrub invariants are all unit-testable without
 * subprocess fixtures. Production callers pass the default impls
 * already exported from this module.
 */
export interface DaemonBootDeps {
  /** Ensure the global maestro workflow is running. Awaited before any signal. */
  ensureGlobalMaestro: () => Promise<void>;
  /** Signal the global maestro with the scrubbed host profile. */
  sendHostProfileSignal: (client: Client, profile: HostProfile) => Promise<void>;
  /**
   * Compute the daemon's capability profile. Output is fed into
   * `scrubHostProfile` before signaling — computeHostProfile itself does
   * not need to scrub, the dep-swap pattern makes the pipeline testable.
   */
  computeHostProfile: () => HostProfile;
  /**
   * Probe upstream tool versions for each adapter. Issue #399 Q5.4 —
   * the result is merged into the profile as
   * {@link HostProfile.adapterVersions} before the first signal. Runs
   * in parallel with `ensureGlobalMaestro`, so a slow probe doesn't
   * extend the boot. Probe failures yield an empty / partial map; the
   * caller never throws. Tests stub this to return canned maps.
   *
   * Optional — when omitted (existing tests, embedded callers), the
   * profile is signaled without an `adapterVersions` field. The
   * production daemon entry-point passes the real `probeAdapterVersions`
   * from `daemon-adapter-versions.ts`.
   */
  probeAdapterVersions?: () => Promise<Record<string, string>>;
  /**
   * Retry backoffs for the `hostProfile` signal (ms). Production uses
   * `[0, 5000, 15000]`; tests override to `[0, 0, 0]` for speed.
   */
  retryBackoffsMs?: number[];
  /** Log sink. Tests stub to capture output. Defaults to module-level `log`. */
  log?: (...args: unknown[]) => void;
}

/**
 * #274 M14 — daemon boot sequence: ensure global maestro is running,
 * then advertise the (scrubbed) capability profile with bounded retry.
 *
 * Ordering is load-bearing (AC5a / M11): the `hostProfile` signal MUST
 * NOT fire until `ensureGlobalMaestro` has resolved. Otherwise the
 * signal races the workflow-start and gets silently dropped by Temporal
 * (WorkflowNotFound on an unknown workflow id).
 *
 * Hard-failure behavior (AC5b): if `ensureGlobalMaestro` rejects, the
 * daemon stays alive WITHOUT advertising its profile. Next opportunity
 * is the next daemon restart OR a manual `agent-tempo refresh-host-profile`
 * invocation (Phase 5).
 *
 * Tests in `test/daemon-boot.test.ts` exercise:
 *   - ensure-before-signal ordering via deferred promises
 *   - retry success on 3rd attempt
 *   - all-retries-exhausted stays alive
 *   - ensure-fails-stays-alive
 */
export async function runDaemonBoot(client: Client, deps: DaemonBootDeps): Promise<void> {
  const logFn = deps.log ?? log;
  const raw = deps.computeHostProfile();

  // Issue #399 Q5.4 — probe adapter versions in parallel with the
  // global-maestro ensure. The probe is best-effort and never throws;
  // settled-result handling makes the boot path tolerant of either
  // succeeding without the other. Ordering invariant (AC5a / M11) —
  // the host-profile signal still gates on `ensureGlobalMaestro`
  // resolving — is preserved by awaiting both before signaling.
  const probeFn = deps.probeAdapterVersions ?? (() => Promise.resolve({}));
  const [ensureResult, probeResult] = await Promise.allSettled([
    deps.ensureGlobalMaestro(),
    probeFn(),
  ]);

  if (ensureResult.status === 'rejected') {
    logFn(
      'ensureGlobalMaestro failed (non-fatal); host profile not advertised this boot:',
      ensureResult.reason instanceof Error ? ensureResult.reason.message : ensureResult.reason,
    );
    return;
  }

  const adapterVersions =
    probeResult.status === 'fulfilled' ? probeResult.value : {};
  if (probeResult.status === 'rejected') {
    // probeAdapterVersions is contracted to never throw, but guard the
    // fallthrough for defense-in-depth — a thrown probe shouldn't
    // block profile advertisement.
    logFn(
      'probeAdapterVersions threw (non-fatal); advertising profile without adapter versions:',
      probeResult.reason instanceof Error ? probeResult.reason.message : probeResult.reason,
    );
  }

  // Merge probe result into the profile. We mutate `raw` rather than
  // re-call computeHostProfile because the probe and compute are
  // logically two halves of the same boot snapshot.
  const profile = scrubHostProfile({
    ...raw,
    adapterVersions:
      Object.keys(adapterVersions).length > 0 ? adapterVersions : undefined,
  });

  await advertiseHostProfile(client, profile, {
    retryBackoffsMs: deps.retryBackoffsMs,
    log: logFn,
    sendSignal: deps.sendHostProfileSignal,
  });
}

// ── Reconcile-on-boot (PR-E §10.1) ──

/**
 * PR-E reconcile-on-boot — design §10.1.
 *
 * Called once during daemon startup, after workers are running but before
 * the main run loop blocks. Queries for orphaned sessions owned by this
 * host and applies the effective {@link DaemonConfig.restorePolicy}:
 *
 *  - `auto`: call `restart` on each orphan inside the allowlist + age
 *    window. `AttachmentConflict` is caught silently — another process
 *    may have restored concurrently.
 *  - `prompt`: log the orphan list and leave the restore to the CLI
 *    `agent-tempo restore` command. No automatic action.
 *  - `never`: silent no-op.
 *
 * All three branches exit in bounded time — never blocks worker startup.
 * Non-fatal: any failure is logged and reconcile bails without crashing
 * the daemon (worker loop takes over and the user can re-run the query
 * via the CLI).
 */
export async function reconcileOnBoot(
  client: Client,
  daemonConfig: DaemonConfig,
  hostname: string = os.hostname(),
  // Injectable clock — default to wall-clock at call time. Exposed so tests can pass a
  // pinned reference time alongside fixtures that use ISO strings derived from that time
  // (otherwise the 24h age filter below vs. a hardcoded test NOW drifts out of sync as
  // calendar days roll over; matches the pattern used by the cleanup path below).
  now: number = Date.now(),
): Promise<void> {
  if (daemonConfig.restorePolicy === 'never') {
    log(`reconcile: restorePolicy="never" — skipping orphan scan`);
    return;
  }

  log(`reconcile: scanning for orphans on host="${hostname}" (policy=${daemonConfig.restorePolicy})`);

  // #93 / #285: the decision loop (cross-host filter, age window, allowlist,
  // restart via outbox) was extracted to `restoreOrphansOnce` so the CLI
  // resume flow (`up` option 2, `conduct --resume`) shares the same
  // behavior. Pass `invokerPlayerId: 'daemon'` to preserve the previous
  // operator identity, and inject `now` as a closure over the pinned ref
  // time so the existing rebuild-reboot tests keep their fixture semantics.
  const summary = await restoreOrphansOnce(
    client,
    {
      hostname,
      invokerPlayerId: 'daemon',
      policy: daemonConfig.restorePolicy,
      autoRestoreMaxAgeHours: daemonConfig.autoRestoreMaxAgeHours,
      autoRestoreEnsembles: daemonConfig.autoRestoreEnsembles,
      now: () => now,
    },
    log,
  );

  const total = summary.reattached + summary.skipped + summary.failed;
  if (total === 0) {
    log('reconcile: no orphans found');
    return;
  }
  log(
    `reconcile: ${summary.reattached} reattached, ` +
    `${summary.skipped} skipped, ${summary.failed} failed ` +
    `(scanned ${total})`,
  );
  if (daemonConfig.restorePolicy === 'prompt' && summary.skipped > 0) {
    log('reconcile: [prompt] run `agent-tempo restore` to restore interactively');
  }
}

// ── Memory reporter (#336) ──

/** Default cadence for the periodic memory log. */
const MEMORY_REPORT_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Pure formatter — turns a `process.memoryUsage()` snapshot into a single
 * space-separated `key=NNNmb` string suitable for grepping out of the log.
 *
 * Exported for unit testing without a live process.
 */
export function formatMemoryUsage(usage: NodeJS.MemoryUsage): string {
  const mb = (n: number) => Math.round(n / (1024 * 1024));
  return (
    `rss=${mb(usage.rss)}mb ` +
    `heapUsed=${mb(usage.heapUsed)}mb ` +
    `heapTotal=${mb(usage.heapTotal)}mb ` +
    `external=${mb(usage.external)}mb ` +
    `arrayBuffers=${mb(usage.arrayBuffers)}mb`
  );
}

/**
 * #336 — schedule a periodic `[agent-tempo:daemon ...] memory: ...` log
 * line so the next memory-leak investigation has a baseline + growth curve
 * directly in the daemon log instead of needing a debugger attach.
 *
 * Returns a stop function the daemon's shutdown handler invokes.
 *
 * `unref()` on the timer handle so memory reporting alone never keeps the
 * daemon alive — workers + the HTTP listener are the only legitimate
 * long-lived references.
 */
export function startMemoryReporter(
  intervalMs: number = MEMORY_REPORT_INTERVAL_MS,
  logFn: (...args: unknown[]) => void = log,
  sample: () => NodeJS.MemoryUsage = () => process.memoryUsage(),
): () => void {
  const tick = () => {
    try {
      logFn(`memory: ${formatMemoryUsage(sample())}`);
    } catch (err) {
      // `process.memoryUsage()` can't realistically throw, but if a custom
      // sampler does we don't want to take the daemon down.
      logFn('memory: sample failed (non-fatal):', err instanceof Error ? err.message : err);
    }
  };
  // Emit immediately so the first log line is the baseline (otherwise an
  // operator polling early sees nothing for `intervalMs`).
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

// ── Cleanup loop (PR-E §13.4) ──

/** Hardcoded cleanup loop period per PR-E §8 answer 2. */
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Filter a set of orphan candidates to those that exceed the
 * `detachedMaxAgeDays` retention threshold. Exported for unit testing the
 * retention math without a live Temporal connection.
 */
export function selectStaleDetachedOrphans(
  orphans: OrphanCandidate[],
  detachedMaxAgeDays: number,
  now: number = Date.now(),
): OrphanCandidate[] {
  const thresholdMs = detachedMaxAgeDays * 24 * 60 * 60 * 1000;
  return orphans.filter((o) => {
    if (o.info.phase !== 'detached') return false;
    if (!o.summary.detachedSince) return false;
    const detachedAt = Date.parse(o.summary.detachedSince);
    if (!Number.isFinite(detachedAt)) return false;
    return now - detachedAt > thresholdMs;
  });
}

/**
 * PR-E cleanup loop — design §13.4 regression row 1.
 *
 * Runs on a 6-hour timer (hardcoded per §8 answer 2). Destroys detached
 * orphans older than `detachedMaxAgeDays` via `TempoClient.destroy` so the
 * workflow completes and eventually falls out of the namespace.
 *
 * Never touches `Running` workflows that still hold a live attachment
 * (filter is explicit on `phase === 'detached'`).
 *
 * **Note (#144)**: an earlier revision included a "pass 2" that tried to
 * `terminate()` already-Completed workflows as belt-and-suspenders retention.
 * `terminate()` throws on Completed workflows in every Temporal namespace
 * setting, so the pass was dead code masked by a swallowing catch. It was
 * removed: namespace retention (Temporal Cloud default 30d, self-hosted
 * configurable) is the authoritative reaper for Completed workflows.
 */
export async function cleanupLoop(
  client: Client,
  daemonConfig: DaemonConfig,
  hostname: string = os.hostname(),
): Promise<void> {
  const tempo = createTempoClient(client);
  const now = Date.now();

  try {
    const orphans = await queryOrphanedSessions(client, { hostname }, log);
    const stale = selectStaleDetachedOrphans(
      orphans,
      daemonConfig.cleanupPolicy.detachedMaxAgeDays,
      now,
    );
    for (const o of stale) {
      const { ensemble, playerId } = o.summary;
      try {
        await tempo.destroy(ensemble, playerId, `detached >${daemonConfig.cleanupPolicy.detachedMaxAgeDays}d`);
        log(`cleanup: [detached] destroyed ${o.workflowId} (detachedSince=${o.summary.detachedSince})`);
      } catch (err) {
        log(`cleanup: [detached] destroy failed for ${o.workflowId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    log('cleanup: failed (non-fatal):', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Schedule {@link cleanupLoop} to run every 6 hours. Returns a clearer
 * function that cancels the timer — called during shutdown.
 */
export function startCleanupLoop(
  client: Client,
  daemonConfig: DaemonConfig,
  hostname: string = os.hostname(),
): () => void {
  let timer: NodeJS.Timeout | null = null;

  const tick = () => {
    cleanupLoop(client, daemonConfig, hostname).catch((err) => {
      log('cleanup: tick failed:', err instanceof Error ? err.message : String(err));
    });
    timer = setTimeout(tick, CLEANUP_INTERVAL_MS);
    timer.unref();
  };

  // Run first tick after the initial interval (not immediately — startup is
  // busy enough). The retention math is idempotent so a delayed first run is
  // always safe.
  timer = setTimeout(tick, CLEANUP_INTERVAL_MS);
  timer.unref();

  return () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

async function main() {
  // Neutralize the Temporal/grpc-js "Channel has been shut down" retry-after-
  // close race so a stray retry timer can't kill the long-lived daemon. See
  // src/utils/grpc-shutdown-guard.ts.
  installGrpcShutdownGuard();

  // ADR 0014 §5.4 / gate 4 — dev daemon log self-identifies. Banner fires
  // first so it lands at the top of `~/.agent-tempo-dev/daemon.log` for
  // grep-friendly identification regardless of subsequent log volume.
  emitDevBannerIfActive();

  // Ensure daemon directory exists. AGENT_TEMPO_HOME already resolves to
  // `~/.agent-tempo-dev/` in dev mode (ADR 0014 §5.3), so this lands in
  // the right place without a per-callsite branch.
  fs.mkdirSync(AGENT_TEMPO_HOME, { recursive: true });

  // Write PID file — the parent polls for this to confirm startup.
  // Atomic write: tmp + rename so a racing reader never sees a half-written
  // file. Retries on Windows EPERM/EBUSY/EACCES (see #182).
  await writePidFileAtomic(DAEMON_PID_PATH, process.pid);
  log(`Daemon started (pid ${process.pid})`);
  log(`PID file: ${DAEMON_PID_PATH}`);
  log(`Log file: ${DAEMON_LOG_PATH}`);

  // Create the heartbeat file synchronously so the first `daemon status`
  // invocation after startup never races the first interval tick. The
  // subsequent interval only has to refresh the mtime — no branching on
  // file-existence each tick (#157 PR B).
  try {
    fs.writeFileSync(DAEMON_HEARTBEAT_PATH, '');
  } catch (err) {
    // Non-fatal — the daemon still runs, `daemon status` just reports
    // `heartbeatAge: null`. Log loudly so operators notice.
    log('Failed to create heartbeat file (non-fatal):', (err as Error)?.message ?? err);
  }
  const heartbeatInterval = setInterval(() => {
    try {
      const now = Date.now() / 1000; // `fs.utimes` takes seconds since epoch
      fs.utimesSync(DAEMON_HEARTBEAT_PATH, now, now);
    } catch {
      // Swallow — transient fs errors shouldn't take down the daemon.
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatInterval.unref();

  // Get config from env vars (passed by startDaemon via spawn env)
  const config = getConfig({});

  // #423 PR-A Fix 3 — load-bearing drift detector. The `[DEV MODE]` banner
  // (gate 4) and the daemon's actual Temporal connection MUST agree on the
  // namespace. Fix 1's env-var carve-out plus Fix 2's source-annotated
  // banner make a silent disagreement impossible at the resolution layer,
  // but a future regression — or an operator who hand-edits
  // `~/.agent-tempo-dev/config.json` to a non-dev namespace by mistake —
  // would still slip through. The warning fires once at boot and lands at
  // the top of `daemon.log` so an operator chasing weird coordination bugs
  // sees the override on first inspection.
  warnIfDevNamespaceDrift(config);

  // ADR 0014 §6.2 — dev daemon auto-creates its Temporal namespace before
  // the worker bootstrap. Production daemons skip this; namespaces are
  // operator-managed there.
  //
  // Idempotent on `ALREADY_EXISTS` (every boot after the first), non-fatal
  // on `PERMISSION_DENIED`. If creation fails for an unexpected reason the
  // worker bootstrap below fails loudly with `Namespace not found`, which
  // is the clearer error from the operator's perspective.
  if (isDevMode() && config.temporalNamespace === DEV_TEMPORAL_NAMESPACE) {
    try {
      const provisionConn = await createTemporalConnection(config);
      try {
        await ensureDevNamespace(provisionConn, config.temporalNamespace);
      } finally {
        await provisionConn.close();
      }
    } catch (err) {
      // Connection itself failed — log + fall through. createWorkers() will
      // surface the same error with its own context.
      log(
        '[dev-mode] namespace pre-create skipped — Temporal connection failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // PR-3 of the v1.0 rebrand — fail fast if the `AgentTempo*` search
  // attributes aren't registered on the target namespace. The actionable
  // error message includes the exact `temporal operator search-attribute
  // create` commands operators need to paste. Probe failure (Temporal CLI
  // missing, namespace unreachable) is downgraded to a warning — the
  // createWorkers() call below will surface the connection error with
  // better context. The hard-stop is only "namespace reached, but SAs
  // missing".
  {
    const { verifySearchAttributes } = await import('./cli/sa-preflight');
    const result = await verifySearchAttributes({
      temporalAddress: config.temporalAddress,
      temporalNamespace: config.temporalNamespace,
      temporalApiKey: config.temporalApiKey,
    });
    if (!result.ok && !result.probeError) {
      process.stderr.write('ERROR: ' + result.message + '\n');
      log('Daemon refused to boot — search attributes missing on namespace ' + config.temporalNamespace);
      try { fs.unlinkSync(DAEMON_PID_PATH); } catch { /* ignore */ }
      try { fs.unlinkSync(DAEMON_HEARTBEAT_PATH); } catch { /* ignore */ }
      process.exit(1);
    } else if (result.probeError) {
      log(
        'search-attribute preflight probe failed (non-fatal — createWorkers will surface the real error):',
        result.probeError,
      );
    }
  }

  // Use mutable refs so signal handlers can be registered before workers
  // are created — closes the narrow window where a SIGTERM during
  // createWorkers() would be missed.
  let sharedWorker: Awaited<ReturnType<typeof createWorkers>>['sharedWorker'] | null = null;
  let hostWorker: Awaited<ReturnType<typeof createWorkers>>['hostWorker'] | null = null;

  // Register signal handlers first — idempotent, drain-only (no process.exit).
  let shuttingDown = false;
  const hardExit = () => {
    log('Shutdown timeout — forcing exit');
    try { fs.unlinkSync(DAEMON_PID_PATH); } catch { /* ignore */ }
    try { fs.unlinkSync(DAEMON_HEARTBEAT_PATH); } catch { /* ignore */ }
    process.exit(1);
  };
  // Mutable ref so the reconcile/cleanup init below can register its
  // cancellation with shutdown (declared after signal handlers to preserve
  // the existing signal-handler-first safety ordering).
  let stopCleanupLoopRef: (() => void) | null = null;
  // #336 — memory reporter. Started unconditionally below; shutdown
  // clears the interval so the daemon can drain cleanly.
  let stopMemoryReporterRef: (() => void) | null = null;
  // #94/#95 PR-1 — HTTP server handle. Started after workers are up
  // (so handlers calling into TempoClient hit a live worker), drained
  // here on shutdown. Mutable ref because `startHttpServer` is awaited
  // below the `shutdown` declaration.
  let httpServerHandle: import('./http').HttpServerHandle | null = null;
  // #94/#95 PR-2 — aggregate poll loop + per-ensemble buses. Owned by
  // the daemon process; `close()` drains every per-ensemble bus.
  let aggregateRunner: import('./http/aggregate').AggregateRunner | null = null;
  // 3c Tier-2 — daemon-owned singletons shared between the Temporal worker
  // (outbox pi-spawn mints / destroy revokes) and the HTTP server (/inner SSE
  // + /inner/ingest validation). Both the worker and startHttpServer run in
  // THIS process, so one instance each suffices. Constructed eagerly (no I/O)
  // so the shutdown handler — declared just below — can drain them.
  const innerLoop = new InnerLoopRegistry();
  const ingestTokens = new IngestTokenRegistry();
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('Shutting down (draining in-flight activities)...');
    // Safety net: force exit if workers don't stop within 15s
    const timer = setTimeout(hardExit, 15_000);
    timer.unref();
    stopCleanupLoopRef?.();
    stopMemoryReporterRef?.();
    clearInterval(heartbeatInterval);
    try { fs.unlinkSync(DAEMON_HEARTBEAT_PATH); } catch { /* ignore */ }
    // HTTP server closes ahead of workers. The HTTP `close()` itself
    // returns a Promise that resolves only after live SSE sockets
    // drain (5 s) — by which point the listener is already refusing
    // new connections AND the port file has been unlinked. The fire-
    // and-forget `.catch()` here means we don't await drain, so the
    // worker shutdown below races the HTTP drain. That's intentional:
    // the worker drain budget is 15 s (`hardExit`), which exceeds
    // HTTP's 5 s drain window — so a polling CLI sees ECONNREFUSED
    // either at the listener level (if it polled after `close()`
    // returned) OR is force-disconnected (if it was inside the drain
    // window and the worker drain pulled the rug). Both signals mean
    // "daemon is going away," which is the contract.
    //
    // The aggregate runner is closed first so per-ensemble buses stop
    // pushing events while the SSE handler is still draining its
    // sockets — preventing wasted work in the drain window.
    aggregateRunner?.close();
    httpServerHandle?.close().catch((err) =>
      log('http close error (non-fatal):', err instanceof Error ? err.message : err),
    );
    // 3c Tier-2 — clear-all on shutdown: drop every minted ingest token (no
    // dead token outlives the daemon) and close every open /inner subscriber
    // (streams end cleanly rather than dangling).
    ingestTokens.revokeAll();
    innerLoop.close();
    sharedWorker?.shutdown();
    hostWorker?.shutdown();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Create workers (signal handlers already active via mutable refs)
  log(`Connecting to Temporal at ${config.temporalAddress} (namespace: ${config.temporalNamespace})`);
  const workers = await createWorkers(config, ingestTokens);
  sharedWorker = workers.sharedWorker;
  hostWorker = workers.hostWorker;
  log('Workers created — processing tasks');

  // #336 — start the periodic memory reporter alongside the workers. The
  // first sample lands in the log immediately as a baseline; subsequent
  // samples fire every MEMORY_REPORT_INTERVAL_MS and let operators spot
  // unbounded growth without attaching a debugger.
  stopMemoryReporterRef = startMemoryReporter();

  // #274 — daemon boot sequence: ensure the global maestro is running,
  // then advertise this host's capability profile with bounded retry.
  // Fire-and-forget from main's perspective (the workers above are
  // already polling tasks; we don't block the run loop on maestro
  // ensure + profile signaling). Ordering INSIDE runDaemonBoot is
  // load-bearing — see M11 / AC5a — so the outer `.catch` only
  // handles unexpected throws (both ensure and signal paths log +
  // return gracefully on their own).
  (async () => {
    try {
      const bootConnection = await createTemporalConnection(config);
      const bootClient = new Client({ connection: bootConnection, namespace: config.temporalNamespace });
      await runDaemonBoot(bootClient, {
        ensureGlobalMaestro: () => ensureGlobalMaestro(config),
        sendHostProfileSignal: realSendHostProfileSignal,
        computeHostProfile: () => computeHostProfile(config),
        // Issue #399 Q5.4 — probe upstream tool versions in parallel
        // with the global-maestro ensure. Production uses real spawns
        // / package.json reads; tests inject canned maps via
        // `DaemonBootDeps.probeAdapterVersions`.
        probeAdapterVersions: () => probeAdapterVersions(),
      });
    } catch (err) {
      log('runDaemonBoot background error:', err);
    }
  })();

  // PR-E reconcile-on-boot + cleanup loop (design §10, §13.4). Both run
  // against their own Temporal Client, not the worker connection — they
  // call `workflow.list` + `workflow.getHandle().query(...)` which are
  // client-side operations. Non-fatal: any failure is logged and the
  // daemon continues running.
  let reconcileClient: Client | null = null;
  try {
    const daemonConfig = loadDaemonConfig();
    const reconcileConnection = await createTemporalConnection(config);
    reconcileClient = new Client({ connection: reconcileConnection, namespace: config.temporalNamespace });

    // Fire-and-forget reconcile; the daemon must not block on this.
    reconcileOnBoot(reconcileClient, daemonConfig).catch((err) => {
      log('reconcileOnBoot background error:', err);
    });

    // Schedule the 6-hour cleanup loop (hardcoded per §8 answer 2).
    stopCleanupLoopRef = startCleanupLoop(reconcileClient, daemonConfig);
    log(`cleanup loop scheduled (every ${CLEANUP_INTERVAL_MS / 3_600_000}h)`);
  } catch (err) {
    log('reconcile/cleanup init failed (non-fatal):', err instanceof Error ? err.message : String(err));
  }

  // #94/#95 PR-1 — HTTP snapshot endpoints. Reuses the reconcile client
  // (already long-lived; the snapshot handlers fan out the same
  // visibility queries that reconcile/cleanup do). Non-fatal: any
  // listener error logs and the daemon stays alive — Temporal workers
  // are the durable concern.
  if (reconcileClient) {
    try {
      const { startHttpServer } = await import('./http');
      const { createTempoClient } = await import('./client');
      const { AggregateRunner } = await import('./http/aggregate');
      // #437 — pass the daemon's polling task queue through. `listHosts`
      // (called by `/v1/hosts`, snapshot.hostProfiles, dashboard, TUI,
      // AggregateRunner) defaults to `'agent-tempo'` and silently
      // returns `[]` in dev mode without this. Both `namespace` (already
      // baked into `reconcileClient.options.namespace`) and `taskQueue`
      // must match the daemon for poller discovery to find this host.
      const httpClient = createTempoClient(reconcileClient, { taskQueue: config.taskQueue });
      // Single shared bootEpoch — every bus the daemon constructs uses
      // this same value, frozen for the process lifetime per §5.
      const bootEpoch = Date.now();
      aggregateRunner = new AggregateRunner({ client: httpClient, bootEpoch });
      aggregateRunner.start();
      httpServerHandle = await startHttpServer({
        client: httpClient,
        namespace: config.temporalNamespace,
        taskQueue: config.taskQueue,
        version: daemonVersion(),
        aggregate: aggregateRunner,
        // 3c Tier-2 — same singletons the worker's outbox activities use, so
        // the operator /inner SSE reads the registry the publisher POSTs into
        // and /inner/ingest validates against the tokens the spawn path minted.
        innerLoop,
        ingestTokens,
      });
      log(`HTTP listening on http://${httpServerHandle.bindAddr}:${httpServerHandle.port}`);
      log(`Aggregate poll loop running (bootEpoch=${bootEpoch})`);
    } catch (err) {
      log('http server init failed (non-fatal):', err instanceof Error ? err.message : String(err));
    }
  } else {
    log('http server skipped: no Temporal client available');
  }

  // Run both workers — blocks until shutdown + drain completes
  try {
    await Promise.all([sharedWorker.run(), hostWorker.run()]);
  } catch (err) {
    log('Worker error:', err);
  }

  // Workers have stopped — clean up PID file and exit
  try { fs.unlinkSync(DAEMON_PID_PATH); } catch { /* ignore */ }
  log('Daemon stopped');
  process.exit(0);
}

// Only run `main()` when this file is invoked directly (e.g. via
// `node dist/daemon.js` or `npx ts-node src/daemon.ts`). Tests that
// import `reconcileOnBoot` / `cleanupLoop` / `selectStaleDetachedOrphans`
// must not trigger the worker-bootstrap path as a module side-effect.
if (require.main === module) {
  main().catch((err) => {
    log('Fatal error:', err);
    try { fs.unlinkSync(DAEMON_PID_PATH); } catch { /* ignore */ }
    process.exit(1);
  });
}
