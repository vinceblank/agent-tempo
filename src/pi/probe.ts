/**
 * Pi dependency preflight — mirrors the opencode / claude-api optional-dep gate.
 *
 * `@earendil-works/pi-coding-agent` (and `@earendil-works/pi-ai`) are OPTIONAL
 * dependencies requiring Node 22.19+. The extension only runs INSIDE Pi, so the
 * runtime guarantees Pi is present — this probe exists for the headless path and
 * for a clear, actionable error if someone wires the extension where Pi isn't
 * installed.
 *
 * Uses `probeSdkInstall` (filesystem walk) rather than `require.resolve` because
 * Pi packages ship ESM-only `exports` maps with no CJS-resolvable entry.
 */
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { probeSdkInstall, readSdkPackageVersion } from '../utils/sdk-probe';

/** Canonical Pi package (the npm `@mariozechner/...` name is an alias). */
export const PI_PACKAGE = '@earendil-works/pi-coding-agent';
/** Pi's model/typing helpers (`StringEnum`, providers). */
export const PI_AI_PACKAGE = '@earendil-works/pi-ai';
/** Tested-pinned Pi version — drift is a maintainer decision (D6). */
export const TESTED_PI_VERSION = '~0.78';
/**
 * Minimum Pi version the integration requires. 0.78.0 covers the Pi fixes the
 * cue-pump + headless paths rely on (#2860 / #5080 / #5115). Bumping this is a
 * D6 maintainer decision; the headless/Copilot pre-flight hard-fails below it.
 */
export const PI_VERSION_FLOOR = '0.78.0';
/** Node floor imposed by the Pi packages (NOT by typebox or agent-tempo core). */
export const PI_NODE_FLOOR = '22.19.0';

export interface PiProbeResult {
  available: boolean;
  /** Human-readable, actionable reason when unavailable. */
  reason?: string;
}

/**
 * Check whether the Pi runtime packages are installed. Returns a structured
 * result so callers choose whether to warn or hard-fail (the extension warns;
 * a headless spawner would hard-fail).
 */
export function probePi(): PiProbeResult {
  if (!probeSdkInstall(PI_PACKAGE)) {
    return {
      available: false,
      reason:
        `${PI_PACKAGE} is not installed.\n` +
        `Install it with: npm install -g ${PI_PACKAGE}\n` +
        `(requires Node >= ${PI_NODE_FLOOR}).`,
    };
  }
  return { available: true };
}

/**
 * Pure semver FLOOR check: is `installed` >= `floor`? Compares major, then
 * minor, then patch (a missing patch defaults to 0). Any pre-release/build
 * suffix (`-beta`, `+sha`) is ignored — a pre-release of a version at/above the
 * floor counts as meeting it. An unparseable `installed` returns `false`
 * (conservative: unknown version is treated as below the floor).
 */
export function meetsVersionFloor(installed: string, floor: string = PI_VERSION_FLOOR): boolean {
  const parse = (v: string): [number, number, number] => {
    const m = v.trim().match(/^v?(\d+)\.(\d+)(?:\.(\d+))?/);
    if (!m) return [-1, -1, -1];
    return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  };
  const [iMaj, iMin, iPat] = parse(installed);
  if (iMaj < 0) return false; // unparseable → below floor
  const [fMaj, fMin, fPat] = parse(floor);
  if (iMaj !== fMaj) return iMaj > fMaj;
  if (iMin !== fMin) return iMin > fMin;
  return iPat >= fPat;
}

/**
 * Node-floor preflight (Decision B, #645). The Pi optional deps require
 * Node >= {@link PI_NODE_FLOOR} (22.19). Enforced ONLY at the Pi recruit/spawn
 * boundary — `package.json#engines` stays `>=20` so non-Pi users are untouched.
 *
 * Pure + injectable (`nodeVersion` defaults to the live runtime) so it is the
 * single source of truth shared by the recruit pre-flight (authoritative,
 * pre-spawn) AND the {@link runHeadlessPi} backstop (direct/manual launches).
 * Reuses {@link meetsVersionFloor}'s major.minor.patch comparison.
 *
 * @returns `{ ok: true }` when the floor is met, else `{ ok: false, reason }`
 *   with an actionable, fail-clean message (mirrors the `probeSdkInstall` /
 *   `resolveModel` style). The `reason` omits any `force: true` hint so each
 *   caller can frame the bypass in its own voice.
 */
export function checkPiNodeFloor(
  nodeVersion: string = process.versions.node,
): { ok: boolean; reason?: string } {
  if (meetsVersionFloor(nodeVersion, PI_NODE_FLOOR)) return { ok: true };
  return {
    ok: false,
    reason:
      `agent: "pi" requires Node >= ${PI_NODE_FLOOR}, but this host runs Node ${nodeVersion}. ` +
      `Upgrade Node (e.g. via nvm/fnm) and retry.`,
  };
}

/**
 * Injectable collaborators for {@link probeCopilotPiPreflight}. All default to
 * real implementations; tests override them to exercise each branch without a
 * live Pi install or real `~/.pi` / env.
 */
export interface CopilotPiPreflightDeps {
  /** Whether a package is installed. Default: filesystem-walk {@link probeSdkInstall}. */
  isInstalled?: (pkg: string) => boolean;
  /** Installed version of a package, or null. Default: {@link readSdkPackageVersion}. */
  installedVersion?: (pkg: string) => string | null;
  /** Environment to read `COPILOT_GITHUB_TOKEN` from. Default: `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Whether the mounted `~/.pi/agent/auth.json` exists. Default: real `existsSync`. */
  authFileExists?: () => boolean;
  /**
   * The parsed recruit selector to validate against Pi's model index (the
   * `{ provider, model }` from {@link parsePiProviderModel}). Omit it — e.g. no
   * `model` recruit arg, the Pi-default path — to SKIP the model-index gate.
   */
  requestedModel?: { provider: string; model: string };
  /**
   * Resolve a `(provider, modelName)` against Pi's build-time model index,
   * returning a truthy Model when indexed and `undefined` when not (the
   * empirically-confirmed contract of pi-ai's `getModel`). The recruit caller
   * (A4) injects pi-ai's `getModel` here — B2 deliberately does NOT import the
   * ESM-only `@earendil-works/pi-ai` from the CJS recruit context. Omit it to
   * SKIP the model-index gate (e.g. unit tests, or callers without pi-ai); the
   * A4 `getModel` backstop then covers an unindexed model.
   */
  resolveModel?: (provider: string, modelName: string) => unknown;
}

/** Default `~/.pi/agent/auth.json` presence check. */
function defaultAuthFileExists(): boolean {
  return existsSync(join(homedir(), '.pi', 'agent', 'auth.json'));
}

/**
 * Hard pre-flight for recruiting a Copilot-backed Pi player (headless). Three
 * gates, each with an actionable, `force: true`-bypassable error:
 *   1. The Pi optional deps (`@earendil-works/pi-coding-agent` + `pi-ai`) are
 *      installed.
 *   2. The Pi SDK version meets {@link PI_VERSION_FLOOR}.
 *   3. Copilot auth is present — either `COPILOT_GITHUB_TOKEN` in the env or a
 *      mounted `~/.pi/agent/auth.json`.
 *
 * Mirrors the opencode / claude-code-headless recruit pre-flights. Returns a
 * {@link PiProbeResult} so the caller (recruit) chooses warn vs hard-fail.
 */
export function probeCopilotPiPreflight(deps: CopilotPiPreflightDeps = {}): PiProbeResult {
  const isInstalled = deps.isInstalled ?? ((pkg: string) => probeSdkInstall(pkg));
  const installedVersion = deps.installedVersion ?? ((pkg: string) => readSdkPackageVersion(pkg));
  const env = deps.env ?? process.env;
  const authFileExists = deps.authFileExists ?? defaultAuthFileExists;

  // 1. Optional Pi deps present.
  const missing = [PI_PACKAGE, PI_AI_PACKAGE].filter((pkg) => !isInstalled(pkg));
  if (missing.length > 0) {
    return {
      available: false,
      reason:
        `Copilot-via-Pi requires the Pi optional dependencies (missing: ${missing.join(', ')}).\n` +
        `Install with: npm install -g ${PI_PACKAGE} ${PI_AI_PACKAGE} (requires Node >= ${PI_NODE_FLOOR}).\n` +
        `Or recruit with force: true to bypass this pre-flight.`,
    };
  }

  // 2. Version floor.
  const version = installedVersion(PI_PACKAGE);
  if (!version) {
    return {
      available: false,
      reason:
        `Could not read ${PI_PACKAGE} version to verify the >= ${PI_VERSION_FLOOR} floor.\n` +
        `Reinstall ${PI_PACKAGE}, or recruit with force: true to bypass.`,
    };
  }
  if (!meetsVersionFloor(version, PI_VERSION_FLOOR)) {
    return {
      available: false,
      reason:
        `${PI_PACKAGE} ${version} is below the required >= ${PI_VERSION_FLOOR} floor ` +
        `(covers Pi #2860/#5080/#5115).\n` +
        `Upgrade with: npm install -g ${PI_PACKAGE}@latest, or recruit with force: true to bypass.`,
    };
  }

  // 3. Copilot auth.
  if (!env.COPILOT_GITHUB_TOKEN && !authFileExists()) {
    return {
      available: false,
      reason:
        `Copilot auth not found. Set COPILOT_GITHUB_TOKEN, or run \`pi /login\` (GitHub Copilot) ` +
        `to write ~/.pi/agent/auth.json.\n` +
        `Or recruit with force: true to bypass this pre-flight.`,
    };
  }

  // 4. Model indexability (catch-early; runs only when BOTH the requested model
  //    and a resolver are supplied — A4 injects pi-ai's getModel). Pi's Copilot
  //    model set is compiled at build time from models.dev, so a model on the
  //    user's subscription but unindexed resolves to `undefined` (NOT a throw,
  //    NOT null — empirically confirmed). Fail the recruit cleanly here rather
  //    than spawning a process getModel kills at the headless entry. A4's
  //    getModel backstop covers the skip cases (no resolver / session-only).
  if (deps.requestedModel && deps.resolveModel) {
    const { provider, model } = deps.requestedModel;
    if (deps.resolveModel(provider, model) === undefined) {
      return {
        available: false,
        reason:
          `model "${provider}/${model}" is not in Pi's model index (getModel returned undefined).\n` +
          `Run \`pi --list-models\` for valid ids; the Copilot set is compiled from models.dev, ` +
          `so a model on your subscription but unindexed is rejected (Pi #4599/#2891).\n` +
          `Or recruit with force: true to bypass this pre-flight.`,
      };
    }
  }

  return { available: true };
}
