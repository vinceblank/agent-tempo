/**
 * Chaos mode — failure-injection helpers for the mock adapter (ADR 0014 §4.2,
 * §4.6). PR-3 of #340-followup.
 *
 * Pure module: no Temporal, fs, or process imports beyond `process.env`. Safe
 * to import from tests and the adapter subprocess alike.
 *
 * Three independent injection axes — each tunable per-daemon via env vars and
 * pinned reproducibly via a seedable PRNG:
 *
 *   - `delayMs`: a fixed pre-reply delay so the dashboard sees a believable
 *     processing window. Deterministic; not driven by the PRNG.
 *   - `failRate`: probability per message of throwing inside the deliver
 *     callback. The SDK base catches the throw and surfaces it as a delivery
 *     failure — exactly the supervisor-recovery surface chaos mode is for.
 *   - `crashRate`: probability per message of `process.exit(1)`. The daemon's
 *     supervisor sees the dead subprocess and transitions the workflow phase
 *     to `gone`. Should NOT crash the daemon itself.
 *
 * Determinism contract: given the same `AGENT_TEMPO_MOCK_CHAOS_SEED`,
 * {@link decideChaosOutcome} returns the same sequence of `'fail' | 'crash' |
 * 'echo'` decisions for the same sequence of input messages — so test
 * expectations and bug repros are reproducible.
 */

/**
 * Seedable PRNG — mulberry32. ~10 lines, 32-bit state, well-distributed for a
 * stress-test fixture. Returns a function that yields a `[0, 1)` float.
 *
 * Why not `Math.random()`: chaos-mode tests need bit-for-bit reproducibility
 * across runs (so a flake reproduces). `Math.random()` has no seed surface in
 * Node, so we ship a tiny PRNG instead of pulling in a dep. mulberry32 is
 * good enough — it's not crypto, just a deterministic random source.
 */
export function mulberry32(seed: number): () => number {
  // The constants are mulberry32 standard; the only state we keep is `s`.
  let s = seed >>> 0;
  return function next(): number {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Resolved chaos config — outcome of {@link chaosFromEnv} with defaults applied. */
export interface ChaosConfig {
  /** Fixed delay (ms) injected before every reply. `0` disables. */
  delayMs: number;
  /** Probability `[0, 1]` of throwing per message. `0` disables. */
  failRate: number;
  /** Probability `[0, 1]` of `process.exit(1)` per message. `0` disables. */
  crashRate: number;
  /** PRNG seed — pin for reproducibility. */
  seed: number;
}

/** Outcome of one chaos roll for a single inbound message. */
export type ChaosDecision =
  | { action: 'echo'; delayMs: number }
  | { action: 'fail'; delayMs: number }
  | { action: 'crash'; delayMs: number };

/** Default chaos rates per architect §4.6 — conservative; meant to be exercised, not painful. */
export const CHAOS_DEFAULTS = {
  delayMs: 0,
  failRate: 0.05,
  crashRate: 0.01,
} as const;

/**
 * Hard caps so an env-var typo can't park a test forever or guarantee a
 * crash on every message. Both limits are loose — they exist to fail loudly
 * on `CHAOS_FAIL_RATE=42` rather than silently saturate, not to constrain
 * legitimate stress runs.
 */
const MAX_DELAY_MS = 60_000;
const MIN_RATE = 0;
const MAX_RATE = 1;

/** Parse one numeric env value. Returns `fallback` on missing / NaN / out-of-range. */
function readNumeric(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
  warn: (msg: string) => void,
): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    warn(`${name}: not a number ("${raw}") — using default ${fallback}`);
    return fallback;
  }
  if (n < min || n > max) {
    warn(`${name}: ${n} out of range [${min}, ${max}] — clamping`);
    return Math.min(max, Math.max(min, n));
  }
  return n;
}

/** Env var names — exported so the spawn layer + tests can refer by constant. */
export const CHAOS_ENV = {
  DELAY_MS: 'AGENT_TEMPO_MOCK_CHAOS_DELAY_MS',
  FAIL_RATE: 'AGENT_TEMPO_MOCK_CHAOS_FAIL_RATE',
  CRASH_RATE: 'AGENT_TEMPO_MOCK_CHAOS_CRASH_RATE',
  SEED: 'AGENT_TEMPO_MOCK_CHAOS_SEED',
} as const;

/**
 * Resolve chaos config from `process.env` (or any compatible record). Missing
 * keys fall back to {@link CHAOS_DEFAULTS}; out-of-range values clamp with a
 * single warning per offender so test runs surface typos loudly without
 * silently bypassing the gate.
 *
 * Seed defaults to `Date.now()` when unset — meaning chaos runs are random by
 * default but pin via `AGENT_TEMPO_MOCK_CHAOS_SEED=<int>` for repro work.
 */
export function chaosFromEnv(
  env: Record<string, string | undefined> = process.env,
  warn: (msg: string) => void = (msg) => console.error(`[agent-tempo:mock:chaos] ${msg}`),
  now: () => number = Date.now,
): ChaosConfig {
  const delayMs = readNumeric(env[CHAOS_ENV.DELAY_MS], CHAOS_DEFAULTS.delayMs, 0, MAX_DELAY_MS, CHAOS_ENV.DELAY_MS, warn);
  const failRate = readNumeric(env[CHAOS_ENV.FAIL_RATE], CHAOS_DEFAULTS.failRate, MIN_RATE, MAX_RATE, CHAOS_ENV.FAIL_RATE, warn);
  const crashRate = readNumeric(env[CHAOS_ENV.CRASH_RATE], CHAOS_DEFAULTS.crashRate, MIN_RATE, MAX_RATE, CHAOS_ENV.CRASH_RATE, warn);
  const seedRaw = env[CHAOS_ENV.SEED];
  const seed = seedRaw === undefined || seedRaw === ''
    ? now()
    : Number.parseInt(seedRaw, 10);
  if (!Number.isFinite(seed)) {
    warn(`${CHAOS_ENV.SEED}: not an integer ("${seedRaw}") — falling back to wall clock`);
    return { delayMs, failRate, crashRate, seed: now() };
  }
  return { delayMs, failRate, crashRate, seed };
}

/**
 * Roll the dice for one inbound message. Crash takes precedence over fail
 * (you can't recover from `process.exit(1)`, so checking it first matches the
 * implicit "more catastrophic wins" expectation of operators reading the
 * decision log).
 *
 * The PRNG is consumed in two draws per message regardless of the outcome —
 * one for the crash check, one for the fail check — so callers running
 * deterministic tests get a stable draw sequence regardless of whether the
 * preceding messages crashed, failed, or echoed.
 */
export function decideChaosOutcome(
  prng: () => number,
  config: Pick<ChaosConfig, 'delayMs' | 'failRate' | 'crashRate'>,
): ChaosDecision {
  const crashRoll = prng();
  const failRoll = prng();
  if (crashRoll < config.crashRate) {
    return { action: 'crash', delayMs: config.delayMs };
  }
  if (failRoll < config.failRate) {
    return { action: 'fail', delayMs: config.delayMs };
  }
  return { action: 'echo', delayMs: config.delayMs };
}
