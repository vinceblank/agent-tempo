/**
 * Probe upstream tool versions for the adapters this daemon ships.
 * Issue #399 Q5.4 — `HostProfile.adapterVersions`.
 *
 * Runs once at daemon boot, in parallel with `ensureGlobalMaestro`, so
 * the host-profile signal can advertise something like:
 *
 *   { "claude-code": "1.2.4", "copilot": "0.5.2" }
 *
 * Adapter probes:
 *   - **claude-code** — shells out to `claude --version` and pulls the
 *     first `MAJOR.MINOR.PATCH` triple via a defensive regex. Claude
 *     Code's `--version` output isn't part of its public API contract
 *     (the format may change between releases); on parse failure or
 *     spawn failure we omit the entry, and the dashboard renders `—`.
 *   - **copilot** — reads `@github/copilot-sdk/package.json#version` via
 *     dynamic import. The SDK is an optional npm dep; when absent
 *     (no copilot bridge available) we omit the entry.
 *   - **mock** — never probed in production. The mock adapter is
 *     dev-mode-only (`isDevMode()` gate in `src/adapters/index.ts`)
 *     and its npm tarball is stripped at prepack; including it here
 *     would just produce a literal `"dev"` that nobody wants in their
 *     Hosts table. Skipped.
 *
 * Latency budget: ~50–100ms total. Each probe runs in parallel; the
 * outer `Promise.all` resolves when the slowest finishes. Each
 * individual probe has its own timeout so a hung `claude --version`
 * (rare but possible — claude CLI sometimes pauses on first launch
 * to register) doesn't keep the daemon's first signal pending.
 *
 * **Failure semantics: never throw.** A probe failure → that key is
 * omitted from the result map. The caller treats the map as a
 * best-effort snapshot; consumers (Hosts table) gracefully degrade.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Per-probe timeout. Generous enough to cover a cold launch but short
 * enough that the daemon-boot pipeline isn't held up. */
const PROBE_TIMEOUT_MS = 5000;

/** Defensive semver-ish capture. Tolerates leading `v`, optional
 * pre-release suffix. Anchored to the FIRST `MAJOR.MINOR.PATCH` triple
 * in the output so headers / banners / multi-line greetings don't break
 * the parse. */
const VERSION_REGEX = /v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/;

/**
 * Test seam — production code passes nothing. Tests inject stubs to
 * avoid spawning real processes / reading real package.json files.
 */
export interface ProbeAdapterVersionsDeps {
  /**
   * Run a CLI and return its stdout. Default: real `execFile` with a
   * timeout. Tests pass a stub that returns canned output.
   */
  runCommand?: (cmd: string, args: string[]) => Promise<string>;
  /**
   * Resolve the Copilot SDK's package version. Default: dynamic
   * `require('@github/copilot-sdk/package.json').version`. Tests stub
   * to control "installed vs. not installed" + version values.
   * Returns `undefined` when the dep isn't installed.
   */
  resolveCopilotSdkVersion?: () => Promise<string | undefined>;
  /** Optional log sink. Tests pass a no-op to silence output. */
  log?: (...args: unknown[]) => void;
}

/**
 * Probe the upstream tool versions for every adapter this daemon ships.
 *
 * @returns A map keyed by adapter name. Adapters whose probe failed or
 * whose output couldn't be parsed are omitted entirely. The map may be
 * empty in environments without any of the supported adapters available.
 */
export async function probeAdapterVersions(
  deps: ProbeAdapterVersionsDeps = {},
): Promise<Record<string, string>> {
  const runCommand = deps.runCommand ?? defaultRunCommand;
  const resolveCopilotSdkVersion =
    deps.resolveCopilotSdkVersion ?? defaultResolveCopilotSdkVersion;
  const log = deps.log ?? defaultLog;

  // Each probe is `Promise<[name, version] | null>`. Resolved-null →
  // omit from the result map. Promise.all won't reject because each
  // catches its own errors.
  const probes: Array<Promise<readonly [string, string] | null>> = [
    probeClaudeCode({ runCommand, log }),
    probeCopilot({ resolveCopilotSdkVersion, log }),
  ];

  const results = await Promise.all(probes);
  const out: Record<string, string> = {};
  for (const r of results) {
    if (r) out[r[0]] = r[1];
  }
  return out;
}

async function probeClaudeCode(deps: {
  runCommand: NonNullable<ProbeAdapterVersionsDeps['runCommand']>;
  log: NonNullable<ProbeAdapterVersionsDeps['log']>;
}): Promise<readonly [string, string] | null> {
  try {
    const stdout = await deps.runCommand('claude', ['--version']);
    const match = VERSION_REGEX.exec(stdout);
    if (!match) {
      deps.log(
        'probeAdapterVersions: claude --version produced no MAJOR.MINOR.PATCH match; omitting',
      );
      return null;
    }
    return ['claude-code', match[1]] as const;
  } catch (err) {
    deps.log(
      'probeAdapterVersions: claude --version failed:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

async function probeCopilot(deps: {
  resolveCopilotSdkVersion: NonNullable<
    ProbeAdapterVersionsDeps['resolveCopilotSdkVersion']
  >;
  log: NonNullable<ProbeAdapterVersionsDeps['log']>;
}): Promise<readonly [string, string] | null> {
  try {
    const version = await deps.resolveCopilotSdkVersion();
    if (!version) return null;
    // Reuse the same defensive regex so a malformed package.json
    // version field doesn't poison the result map.
    const match = VERSION_REGEX.exec(version);
    if (!match) {
      deps.log(
        'probeAdapterVersions: copilot SDK package.json version unparseable; omitting',
      );
      return null;
    }
    return ['copilot', match[1]] as const;
  } catch (err) {
    deps.log(
      'probeAdapterVersions: copilot SDK probe failed:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/** Real `execFile` with a timeout + stderr-friendly options. Used in
 * production; tests stub `runCommand`. */
async function defaultRunCommand(cmd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, {
    timeout: PROBE_TIMEOUT_MS,
    encoding: 'utf8',
    // Don't fail on non-zero stderr; we only care about stdout.
    windowsHide: true,
  });
  return stdout;
}

/**
 * Synchronous companion to {@link defaultResolveCopilotSdkVersion}.
 * Returns the Copilot SDK's `package.json#version` if the optional
 * dependency is installed, or `undefined` when the require fails.
 *
 * Exported for #532 PR-2 — `src/daemon.ts` `computeHostProfile()` is
 * synchronous (matches the existing `claude-code-headless` block at
 * `daemon.ts:278-288`, which uses synchronous probes from
 * `src/adapters/claude-code-headless/pre-flight.ts`). Awaiting an
 * async helper from a sync function isn't possible without cascading
 * the change to all `computeHostProfile` call sites; instead, this
 * sync helper is the single require-source-of-truth, and the async
 * `defaultResolveCopilotSdkVersion` (kept for the
 * `ProbeAdapterVersionsDeps['resolveCopilotSdkVersion']` contract)
 * delegates to it.
 *
 * Tests stub this directly via the `resolveCopilotSdkVersionSync` dep
 * on `computeHostProfile` (see `test/daemon-boot.test.ts`).
 *
 * Never throws — a `try/catch` swallows MODULE_NOT_FOUND and any
 * other failure mode to `undefined`. A throw here would crash the
 * daemon-boot critical path.
 */
export function resolveCopilotSdkVersionSync(): string | undefined {
  try {
    // `require` rather than ESM `import` so we read the package.json
    // synchronously without the await + dynamic-import-of-JSON dance.
    // The wrapper try/catch keeps the require inside a guard so a
    // bundler that statically analyzes imports still treats it as
    // optional.
    const pkg = require('@github/copilot-sdk/package.json') as {
      version?: string;
    };
    return pkg.version;
  } catch {
    return undefined;
  }
}

/** Try to resolve the Copilot SDK's package.json version. Returns
 * `undefined` when the optional dep isn't installed (covers npm
 * installs that opted out, dev environments without the bridge, etc.).
 *
 * Delegates to {@link resolveCopilotSdkVersionSync} so the require
 * call has a single source of truth — see that function's docstring
 * for why the sync sibling exists. */
async function defaultResolveCopilotSdkVersion(): Promise<string | undefined> {
  return resolveCopilotSdkVersionSync();
}

function defaultLog(...args: unknown[]): void {
  console.error('[agent-tempo:adapter-versions]', ...args);
}
