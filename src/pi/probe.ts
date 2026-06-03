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
import { probeSdkInstall } from '../utils/sdk-probe';

/** Canonical Pi package (the npm `@mariozechner/...` name is an alias). */
export const PI_PACKAGE = '@earendil-works/pi-coding-agent';
/** Pi's model/typing helpers (`StringEnum`, providers). */
export const PI_AI_PACKAGE = '@earendil-works/pi-ai';
/** Tested-pinned Pi version — drift is a maintainer decision (D6). */
export const TESTED_PI_VERSION = '~0.78';
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
