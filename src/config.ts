import { existsSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { z } from 'zod';
import { AgentType } from './types';
import { validateEnsembleName } from './utils/validation';

// `'mock'` is a valid `AgentType` value but intentionally NOT in the resolved
// `defaultAgent` set — recruit pre-flight rejects it outside dev mode anyway,
// and it's never a sensible *default* (each mock spawn is configured per call
// via the `agent: 'mock'` flag, not via the resolved chain). Listing it here
// would only enable users to set `defaultAgent=mock` in `~/.claude-tempo/config.json`,
// which the recruit gate would then turn around and reject in production.
const VALID_AGENTS: readonly AgentType[] = ['claude', 'copilot'] as const;

/** Environment variable name constants — use these instead of string literals. */
export const ENV = {
  ENSEMBLE: 'CLAUDE_TEMPO_ENSEMBLE',
  CONDUCTOR: 'CLAUDE_TEMPO_CONDUCTOR',
  PLAYER_NAME: 'CLAUDE_TEMPO_PLAYER_NAME',
  TASK_QUEUE: 'CLAUDE_TEMPO_TASK_QUEUE',
  BRIDGE_NAME: 'COPILOT_BRIDGE_NAME',
  BRIDGE_MODE: 'CLAUDE_TEMPO_BRIDGE_MODE',
  BRIDGE_MODEL: 'COPILOT_BRIDGE_MODEL',
  BRIDGE_SESSION_ID: 'COPILOT_BRIDGE_SESSION_ID',
  TEMPORAL_ADDRESS: 'TEMPORAL_ADDRESS',
  TEMPORAL_NAMESPACE: 'TEMPORAL_NAMESPACE',
  TEMPORAL_API_KEY: 'TEMPORAL_API_KEY',
  TEMPORAL_TLS_CERT_PATH: 'TEMPORAL_TLS_CERT_PATH',
  TEMPORAL_TLS_KEY_PATH: 'TEMPORAL_TLS_KEY_PATH',
  DEFAULT_AGENT: 'CLAUDE_TEMPO_DEFAULT_AGENT',
  PLAYER_TYPE: 'CLAUDE_TEMPO_PLAYER_TYPE',
  CLAUDE_BIN: 'CLAUDE_TEMPO_CLAUDE_BIN',
  /**
   * #131 Phase C — claude-api adapter model override. Recruit-arg takes
   * precedence; this env var is the next fallback before the constants-pinned
   * default (`claude-opus-4-7`). Ignored by other adapters.
   */
  API_MODEL: 'CLAUDE_TEMPO_API_MODEL',
  /**
   * #449 Phase C — opencode adapter model override. Distinct from
   * `API_MODEL` to keep namespaces clean: claude-api is Anthropic-only
   * with bare model ids (`claude-opus-4-7`); opencode takes combined
   * `provider/model` strings (`anthropic/claude-opus-4-7`,
   * `openai/gpt-4o`, `ollama/llama3`, …). Recruit-arg precedence:
   * recruit `model` arg → this env var → `DEFAULT_MODEL` constant.
   */
  OPENCODE_MODEL: 'CLAUDE_TEMPO_OPENCODE_MODEL',
  /**
   * v0.25 PR-D attachment resume plumbing. When `restart` / `migrate`
   * enqueues a spawn outbox entry, the workflow passes the pre-claimed
   * `attachmentId` + pinned `runId` + resolved `adapterId` through the spawn
   * activity into the child process env. The child's adapter reads these in
   * `startV2Lifecycle` to renew (rather than freshly claim) the existing lease,
   * so there is no race window between the workflow's claim and the adapter
   * boot. Absent on first-recruit spawn (fresh claim path).
   */
  ATTACHMENT_ID: 'CLAUDE_TEMPO_ATTACHMENT_ID',
  ATTACHMENT_RUN_ID: 'CLAUDE_TEMPO_ATTACHMENT_RUN_ID',
  ADAPTER_ID: 'CLAUDE_TEMPO_ADAPTER_ID',
  /**
   * Daemon HTTP/SSE event source (#94, #95). See SSE-PROTOCOL.md §1, §3.
   * `HTTP_BIND` defaults to `127.0.0.1`. Setting to `0.0.0.0` forces
   * bearer mode. `DAEMON_PORT` defaults to `8473` (the `t-e-m-p-o`
   * mnemonic; not IANA-registered). `CORS_ORIGINS` is a comma-separated
   * explicit allowlist (no wildcards) — only consulted in bearer mode.
   * `SSE_MAX_CONNECTIONS` caps live SSE subscribers (PR-2; defaults 100).
   */
  HTTP_BIND: 'CLAUDE_TEMPO_HTTP_BIND',
  DAEMON_PORT: 'CLAUDE_TEMPO_DAEMON_PORT',
  CORS_ORIGINS: 'CLAUDE_TEMPO_CORS_ORIGINS',
  SSE_MAX_CONNECTIONS: 'CLAUDE_TEMPO_SSE_MAX_CONNECTIONS',
  /**
   * Dev profile gate (ADR 0014 §5.2). One source of truth — every layer
   * (paths, namespace, port, task queue, banner, registry gating) consults
   * `isDevMode()` rather than reading the env var directly. The `--dev`
   * top-level CLI flag in `src/cli.ts` sets this to `'1'` before any other
   * module loads (see `src/cli/dev-mode-bootstrap.ts`).
   */
  DEV_MODE: 'CLAUDE_TEMPO_DEV_MODE',
  /**
   * Escape hatch for triple-isolated environments (ADR 0014 §5.3). When
   * set, `resolveTempoHome()` returns this path verbatim — bypassing both
   * the production default and the dev-mode default. Lets a power user
   * coordinate three or more parallel claude-tempo profiles on one box.
   */
  DEV_HOME_OVERRIDE: 'CLAUDE_TEMPO_HOME_OVERRIDE',
} as const;

// PR-H (#132): `lifecycleV2Enabled()` removed. The V2 attachment-lease path
// is unconditional in v0.25.0-beta.1; the rollback flag was an emergency
// safety net during the lifecycle rebuild and is no longer needed.

export interface Config {
  temporalAddress: string;
  temporalNamespace: string;
  temporalApiKey?: string;
  temporalTlsCertPath?: string;
  temporalTlsKeyPath?: string;
  defaultAgent: AgentType;
  claudeBin?: string;
  taskQueue: string;
  ensemble: string;
}

/** Persisted config file fields (stored in ~/.claude-tempo/config.json). */
export interface PersistedConfig {
  temporalAddress?: string;
  temporalNamespace?: string;
  temporalApiKey?: string;
  temporalTlsCertPath?: string;
  temporalTlsKeyPath?: string;
  defaultAgent?: AgentType;
  claudeBin?: string;
  /**
   * Bearer token for the daemon's HTTP/SSE event source (#94, #95,
   * SSE-PROTOCOL.md §3.1). Auto-generated on first daemon boot when
   * bearer mode is required (`CLAUDE_TEMPO_HTTP_BIND` non-loopback OR
   * a request with a non-loopback `Origin`) and no token is set:
   * `crypto.randomBytes(32).toString('base64url')`, 0600 on POSIX.
   * Rotation = delete this field; next daemon boot regenerates.
   */
  httpToken?: string;
}

// ── Dev profile (ADR 0014 §5) ──

/**
 * Dev profile defaults — one switch (`--dev` top-level flag, or
 * `CLAUDE_TEMPO_DEV_MODE=1` env var) flips four isolation axes at once
 * (ADR 0014 §5.1). Production stays on the existing defaults.
 */
export const DEV_HOME_DIR_NAME = '.claude-tempo-dev';
export const PROD_HOME_DIR_NAME = '.claude-tempo';
export const DEV_TEMPORAL_NAMESPACE = 'claude-tempo-dev';
export const PROD_TEMPORAL_NAMESPACE = 'default';
export const DEV_TASK_QUEUE = 'claude-tempo-dev';
export const PROD_TASK_QUEUE = 'claude-tempo';
export const DEV_DAEMON_PORT = 8474;
export const PROD_DAEMON_PORT = 8473;

/**
 * Single source of truth for the dev profile gate (ADR 0014 §5.2).
 * Every layer that needs to switch behaviour consults this helper; future
 * staging/ci/demo profiles would follow the same `isStagingMode()` pattern.
 *
 * Recognises `'1'` and `'true'` (case-insensitive) so users can write
 * either `CLAUDE_TEMPO_DEV_MODE=1` or `CLAUDE_TEMPO_DEV_MODE=true`. Any
 * other value (including the empty string) is treated as production.
 *
 * **Important**: when the `--dev` CLI flag is used, the env var must be
 * set BEFORE `src/config.ts` is first imported (see
 * `src/cli/dev-mode-bootstrap.ts`) so the module-load-time `CLAUDE_TEMPO_HOME`
 * constant resolves to the dev profile.
 */
export function isDevMode(): boolean {
  const v = process.env[ENV.DEV_MODE];
  if (!v) return false;
  return v === '1' || v.toLowerCase() === 'true';
}

/**
 * Resolve the claude-tempo home directory. Three-tier precedence:
 *   1. `CLAUDE_TEMPO_HOME_OVERRIDE` env — explicit override (multi-isolation
 *      escape hatch; ADR 0014 §5.3).
 *   2. Dev mode (`CLAUDE_TEMPO_DEV_MODE=1`): `~/.claude-tempo-dev/`.
 *   3. Production default: `~/.claude-tempo/`.
 *
 * Evaluated once at module load time; downstream callers consume the
 * exported `CLAUDE_TEMPO_HOME` constant. The bootstrap module guarantees
 * the env var is set before this function first runs.
 *
 * Exported (rather than file-private) so unit tests can exercise the
 * three-tier precedence directly without resorting to `vi.resetModules()`
 * gymnastics. Production code should consume {@link CLAUDE_TEMPO_HOME}
 * — calling this helper per-request would re-read env on every call.
 */
export function resolveTempoHome(): string {
  const override = process.env[ENV.DEV_HOME_OVERRIDE];
  if (override) return override;
  return isDevMode()
    ? join(homedir(), DEV_HOME_DIR_NAME)
    : join(homedir(), PROD_HOME_DIR_NAME);
}

export const CLAUDE_TEMPO_HOME = resolveTempoHome();
export const CONFIG_FILE_PATH = join(CLAUDE_TEMPO_HOME, 'config.json');

// ── Daemon config (PR-E design §10.2) ──

/**
 * Daemon-level configuration persisted in `~/.claude-tempo/config.json`
 * alongside the existing `PersistedConfig` fields.
 *
 * `restorePolicy` is the effective off-switch for daemon reconcile-on-boot
 * auto-restore — there is no feature flag. `"never"` disables all automatic
 * restoration and leaves the CLI `restore` command as the sole revive path.
 */
export const CleanupPolicySchema = z.object({
  detachedMaxAgeDays: z.number().int().positive().default(7),
  destroyedMaxAgeDays: z.number().int().positive().default(30),
}).default({ detachedMaxAgeDays: 7, destroyedMaxAgeDays: 30 });

export const DaemonConfigSchema = z.object({
  restorePolicy: z.enum(['auto', 'prompt', 'never']).default('prompt'),
  autoRestoreMaxAgeHours: z.number().positive().default(24),
  /**
   * Ensemble allowlist for `auto` restore. Empty array means "all ensembles
   * allowed". Each entry is a simple prefix match: trailing `*` is stripped
   * and the remaining string is compared with `String.startsWith()`. Entries
   * without trailing `*` are exact matches. See {@link matchEnsembleGlob}.
   */
  autoRestoreEnsembles: z.array(z.string()).default([]),
  cleanupPolicy: CleanupPolicySchema,
}).default({
  restorePolicy: 'prompt',
  autoRestoreMaxAgeHours: 24,
  autoRestoreEnsembles: [],
  cleanupPolicy: { detachedMaxAgeDays: 7, destroyedMaxAgeDays: 30 },
});

/** Inferred config type matching {@link DaemonConfigSchema}. */
export type DaemonConfig = z.infer<typeof DaemonConfigSchema>;

/**
 * Load `~/.claude-tempo/config.json` and extract the daemon-level fields.
 * Returns fully-defaulted `DaemonConfig` if the file is missing, unreadable,
 * or contains no daemon fields. Partial configs (user sets one field only)
 * merge with defaults via Zod's `.default()` per-field behaviour.
 *
 * Invalid JSON logs a warning and falls back to defaults rather than
 * crashing — the daemon must boot even if the user has a mangled config.
 */
export function loadDaemonConfig(): DaemonConfig {
  try {
    if (!existsSync(CONFIG_FILE_PATH)) {
      return DaemonConfigSchema.parse({});
    }
    const raw = JSON.parse(readFileSync(CONFIG_FILE_PATH, 'utf8'));
    // The file may contain unrelated `PersistedConfig` fields — pick only
    // the daemon-relevant ones. Unknown fields are ignored by Zod's default
    // `.object()` schema (strip mode), which is what we want.
    const result = DaemonConfigSchema.safeParse(raw);
    if (result.success) return result.data;
    console.error('[claude-tempo] Invalid daemon config; using defaults.', result.error.format());
    return DaemonConfigSchema.parse({});
  } catch (err) {
    console.error(
      '[claude-tempo] Could not read daemon config; using defaults:',
      err instanceof Error ? err.message : String(err),
    );
    return DaemonConfigSchema.parse({});
  }
}

/**
 * Simple-prefix ensemble match — PR-E §8 answer 5. No glob library dep.
 *
 *  - Pattern ends with `*` → strip the `*`, match by `ensemble.startsWith(prefix)`.
 *  - Pattern without trailing `*` → exact equality.
 *  - Empty pattern list → allow all (caller decides; this helper returns `false`).
 */
export function matchEnsembleGlob(ensemble: string, pattern: string): boolean {
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return ensemble.startsWith(prefix);
  }
  return ensemble === pattern;
}

/**
 * Check an ensemble name against a list of patterns.
 * Empty list → allow all (returns `true`).
 * Any matching pattern → allow (returns `true`).
 * No matches → deny (returns `false`).
 */
export function isEnsembleAllowed(ensemble: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  return allowlist.some((p) => matchEnsembleGlob(ensemble, p));
}

/** Load ~/.claude-tempo/config.json if it exists. */
export function loadConfigFile(): PersistedConfig {
  try {
    if (existsSync(CONFIG_FILE_PATH)) {
      return JSON.parse(readFileSync(CONFIG_FILE_PATH, 'utf8'));
    }
  } catch {
    // Corrupt file — warn but don't crash
    console.error(`[claude-tempo] Warning: could not parse ${CONFIG_FILE_PATH} — ignoring config file`);
  }
  return {};
}

/** Save config to ~/.claude-tempo/config.json with restrictive permissions. */
export function saveConfigFile(config: PersistedConfig): void {
  const { writeFileSync, chmodSync } = require('fs') as typeof import('fs');
  mkdirSync(CLAUDE_TEMPO_HOME, { recursive: true });
  writeFileSync(CONFIG_FILE_PATH, JSON.stringify(config, null, 2) + '\n');
  // Restrict permissions to owner-only (like aws credentials, gh hosts.yml)
  if (process.platform !== 'win32') {
    try { chmodSync(CONFIG_FILE_PATH, 0o600); } catch { /* best effort */ }
  }
}

/**
 * Load Temporal CLI config from ~/.config/temporalio/temporal.yaml as a fallback.
 * The Temporal CLI stores named environments there. We read the active environment
 * or the first one we find.
 *
 * Format is simple YAML — we parse it with basic string operations.
 */
export function loadTemporalCliConfig(): PersistedConfig {
  const candidates = [
    join(homedir(), '.config', 'temporalio', 'temporal.yaml'),
    join(homedir(), '.config', 'temporalio', 'temporal.yml'),
  ];

  for (const filePath of candidates) {
    try {
      if (!existsSync(filePath)) continue;
      const content = readFileSync(filePath, 'utf8');
      return parseTemporalYaml(content);
    } catch {
      // ignore
    }
  }
  return {};
}

/**
 * Minimal YAML parser for Temporal CLI config files.
 * Handles the subset of YAML used by the Temporal CLI:
 *   active-env: local
 *   env:
 *     local:
 *       address: localhost:7233
 *       namespace: default
 *       api-key: ...
 *       tls-cert-path: ...
 *       tls-key-path: ...
 */
export function parseTemporalYaml(content: string): PersistedConfig {
  // Normalize CRLF to LF and tabs to spaces for consistent parsing
  const lines = content.replace(/\r\n/g, '\n').replace(/\t/g, '  ').split('\n');
  const result: PersistedConfig = {};

  // Find the active environment name
  let activeEnv = '';
  for (const line of lines) {
    const match = line.match(/^active-env:\s*(.+)/);
    if (match) {
      activeEnv = match[1].trim();
      break;
    }
  }

  // Find the env block and the active (or first) environment
  let inEnv = false;
  let targetEnvName = activeEnv;
  let inTargetEnv = false;

  for (const line of lines) {
    const stripped = line.trimEnd();

    // Top-level "env:" key
    if (/^env:\s*$/.test(stripped)) {
      inEnv = true;
      continue;
    }

    if (!inEnv) continue;

    // Back to top-level (non-indented, non-empty line that isn't part of env block)
    if (stripped.length > 0 && !stripped.startsWith(' ')) {
      break;
    }

    // Environment name (2-space indent, may contain dots like "my-ns.abc123")
    const envMatch = stripped.match(/^  ([a-zA-Z0-9_.:-]+):\s*$/);
    if (envMatch) {
      const currentEnvName = envMatch[1];
      // If no active env specified, use the first one
      if (!targetEnvName) targetEnvName = currentEnvName;
      inTargetEnv = currentEnvName === targetEnvName;
      continue;
    }

    if (!inTargetEnv) continue;

    // Key-value pairs (4+ space indent)
    const kvMatch = stripped.match(/^\s{4,}([a-z-]+):\s*(.+)/);
    if (kvMatch) {
      const [, key, value] = kvMatch;
      const val = value.trim().replace(/^['"]|['"]$/g, ''); // strip quotes
      switch (key) {
        case 'address': result.temporalAddress = val; break;
        case 'namespace': result.temporalNamespace = val; break;
        case 'api-key': result.temporalApiKey = val; break;
        case 'tls-cert-path': result.temporalTlsCertPath = val; break;
        case 'tls-key-path': result.temporalTlsKeyPath = val; break;
      }
    }
  }

  return result;
}

/**
 * Human-readable source labels for `defaultAgent` validation errors.
 * Single source of truth shared by {@link parseAgent} callers; keeps the
 * "invalid value" error message and the `config show` source column aligned.
 */
const AGENT_SOURCE_LABELS: Record<ConfigSource, string> = {
  flag: '--agent CLI flag',
  env: `${ENV.DEFAULT_AGENT} env var`,
  config: `defaultAgent in ${CONFIG_FILE_PATH}`,
  'temporal-cli': 'Temporal CLI config',
  default: 'default',
  none: 'none',
};

/**
 * Parse an agent value against the {@link AgentType} union.
 * Throws when `value` is present but not a valid agent; returns `'claude'`
 * for empty/unset values so callers can use it as a source-aware default.
 */
export function parseAgent(value: string | undefined, source: ConfigSource): AgentType {
  if (value == null || value === '') return 'claude';
  if (!VALID_AGENTS.includes(value as AgentType)) {
    throw new Error(
      `Invalid agent "${value}" from ${AGENT_SOURCE_LABELS[source]}. ` +
      `Valid values: ${VALID_AGENTS.join(', ')}.`,
    );
  }
  return value as AgentType;
}

/**
 * Resolve `defaultAgent` through the standard precedence chain and validate
 * against the {@link AgentType} union. Each step passes its own source tag
 * so `parseAgent` error messages point at the offending origin.
 */
function resolveDefaultAgent(
  cliVal: string | undefined,
  configFileVal: string | undefined,
): AgentType {
  if (cliVal) return parseAgent(cliVal, 'flag');
  const envVal = process.env[ENV.DEFAULT_AGENT];
  if (envVal) return parseAgent(envVal, 'env');
  if (configFileVal) return parseAgent(configFileVal, 'config');
  return 'claude';
}

/** CLI flag overrides — passed down from the arg parser. */
export interface CliOverrides {
  temporalAddress?: string;
  temporalNamespace?: string;
  temporalApiKey?: string;
  temporalTlsCertPath?: string;
  temporalTlsKeyPath?: string;
  defaultAgent?: AgentType;
}

/**
 * Env vars that bleed a user's shell-wide Temporal config into the dev
 * profile, defeating its isolation guarantee. In dev mode, reads of these
 * keys via {@link readEnvWithDevCarveOut} return `undefined` — same shape
 * the existing temporal-cli yaml drop already uses for namespace.
 *
 * Carve-out is per architect Q1 in `docs/design/dev-mode-isolation-fix-423.md`:
 * NAMESPACE + ADDRESS are leaks; `TEMPORAL_API_KEY` + `TEMPORAL_TLS_*`
 * are per-credential and stay honored in both modes.
 *
 * Module-level constant so neither `getConfig` nor `getConfigWithSources`
 * allocates a Set on every call.
 */
const DEV_ENV_CARVE_OUT: ReadonlySet<string> = new Set([
  ENV.TEMPORAL_NAMESPACE,
  ENV.TEMPORAL_ADDRESS,
]);

/**
 * Read `process.env[key]` honoring the dev-mode carve-out. Returns
 * `undefined` for carved-out keys when dev mode is active so the
 * resolution chain falls through to the next source.
 */
function readEnvWithDevCarveOut(key: string): string | undefined {
  if (isDevMode() && DEV_ENV_CARVE_OUT.has(key)) return undefined;
  return process.env[key];
}

/**
 * Build a resolved Config using the priority chain:
 *   CLI flag > env var > claude-tempo config file > temporal CLI config > defaults
 *
 * In dev mode, `TEMPORAL_NAMESPACE` and `TEMPORAL_ADDRESS` env vars are
 * dropped from the chain — see {@link DEV_ENV_CARVE_OUT}.
 */
export function getConfig(overrides: CliOverrides = {}): Config {
  const temporalCli = loadTemporalCliConfig();
  const configFile = loadConfigFile();

  const resolve = (
    cliVal: string | undefined,
    envKey: string,
    fileVal: string | undefined,
    temporalCliVal: string | undefined,
    defaultVal: string,
  ): string => {
    return cliVal || readEnvWithDevCarveOut(envKey) || fileVal || temporalCliVal || defaultVal;
  };

  const resolveOpt = (
    cliVal: string | undefined,
    envKey: string,
    fileVal: string | undefined,
    temporalCliVal: string | undefined,
  ): string | undefined => {
    return cliVal || readEnvWithDevCarveOut(envKey) || fileVal || temporalCliVal || undefined;
  };

  const config: Config = {
    temporalAddress: resolve(
      overrides.temporalAddress, ENV.TEMPORAL_ADDRESS,
      configFile.temporalAddress, temporalCli.temporalAddress,
      'localhost:7233',
    ),
    temporalNamespace: resolve(
      overrides.temporalNamespace, ENV.TEMPORAL_NAMESPACE,
      configFile.temporalNamespace,
      // ADR 0014 §5.1: dev profile flips the namespace default. CLI flag and
      // the dev profile's own claude-tempo config file
      // (`~/.claude-tempo-dev/config.json`) still win — but the
      // `TEMPORAL_NAMESPACE` env var (carved out above) and
      // `~/.config/temporalio/temporal.yaml` are intentionally ignored in
      // dev mode. Both capture the user's *default* Temporal environment
      // for ad-hoc CLI work; letting either bleed through would defeat the
      // dev profile's isolation guarantee (a user with `namespace: default`
      // would see the dev daemon connect to prod). Explicit per-invocation
      // overrides (CLI flag, dev config.json) remain available.
      isDevMode() ? undefined : temporalCli.temporalNamespace,
      isDevMode() ? DEV_TEMPORAL_NAMESPACE : PROD_TEMPORAL_NAMESPACE,
    ),
    temporalApiKey: resolveOpt(
      overrides.temporalApiKey, ENV.TEMPORAL_API_KEY,
      configFile.temporalApiKey, temporalCli.temporalApiKey,
    ),
    temporalTlsCertPath: resolveOpt(
      overrides.temporalTlsCertPath, ENV.TEMPORAL_TLS_CERT_PATH,
      configFile.temporalTlsCertPath, temporalCli.temporalTlsCertPath,
    ),
    temporalTlsKeyPath: resolveOpt(
      overrides.temporalTlsKeyPath, ENV.TEMPORAL_TLS_KEY_PATH,
      configFile.temporalTlsKeyPath, temporalCli.temporalTlsKeyPath,
    ),
    defaultAgent: resolveDefaultAgent(overrides.defaultAgent, configFile.defaultAgent),
    claudeBin: process.env[ENV.CLAUDE_BIN] || configFile.claudeBin || undefined,
    // ADR 0014 §5.1: dev profile shifts the default task queue. Explicit
    // env-var override still wins.
    taskQueue: process.env[ENV.TASK_QUEUE] ?? (isDevMode() ? DEV_TASK_QUEUE : PROD_TASK_QUEUE),
    ensemble: process.env[ENV.ENSEMBLE] ?? 'default',
  };

  const ensembleError = validateEnsembleName(config.ensemble);
  if (ensembleError) {
    throw new Error(ensembleError);
  }

  return config;
}

export type ConfigSource = 'flag' | 'env' | 'config' | 'temporal-cli' | 'default' | 'none';

export interface ConfigWithSources {
  config: Config;
  sources: Record<string, ConfigSource>;
}

/**
 * Like getConfig(), but also returns which source each value came from.
 * Used by `claude-tempo config show` to help users debug.
 *
 * Mirrors {@link getConfig}'s dev-mode env-var carve-out — without this
 * parity the user would see `env: TEMPORAL_NAMESPACE=default` in
 * `config show` while the daemon happily ignores it.
 */
export function getConfigWithSources(overrides: CliOverrides = {}): ConfigWithSources {
  const temporalCli = loadTemporalCliConfig();
  const configFile = loadConfigFile();

  function resolveWithSource(
    key: string,
    cliVal: string | undefined,
    envKey: string,
    fileVal: string | undefined,
    temporalCliVal: string | undefined,
    defaultVal?: string,
  ): { value: string | undefined; source: ConfigSource } {
    if (cliVal) return { value: cliVal, source: 'flag' };
    const envVal = readEnvWithDevCarveOut(envKey);
    if (envVal) return { value: envVal, source: 'env' };
    if (fileVal) return { value: fileVal, source: 'config' };
    if (temporalCliVal) return { value: temporalCliVal, source: 'temporal-cli' };
    if (defaultVal) return { value: defaultVal, source: 'default' };
    return { value: undefined, source: 'none' };
  }

  const address = resolveWithSource(
    'temporalAddress',
    overrides.temporalAddress,
    ENV.TEMPORAL_ADDRESS,
    configFile.temporalAddress,
    temporalCli.temporalAddress,
    'localhost:7233',
  );
  const namespace = resolveWithSource(
    'temporalNamespace',
    overrides.temporalNamespace,
    ENV.TEMPORAL_NAMESPACE,
    configFile.temporalNamespace,
    // ADR 0014 §5.1 — temporal-cli fallback is dropped in dev mode for the
    // same isolation reason documented in `getConfig` above.
    isDevMode() ? undefined : temporalCli.temporalNamespace,
    isDevMode() ? DEV_TEMPORAL_NAMESPACE : PROD_TEMPORAL_NAMESPACE,
  );
  const apiKey = resolveWithSource('temporalApiKey', overrides.temporalApiKey, ENV.TEMPORAL_API_KEY, configFile.temporalApiKey, temporalCli.temporalApiKey);
  const tlsCert = resolveWithSource('temporalTlsCertPath', overrides.temporalTlsCertPath, ENV.TEMPORAL_TLS_CERT_PATH, configFile.temporalTlsCertPath, temporalCli.temporalTlsCertPath);
  const tlsKey = resolveWithSource('temporalTlsKeyPath', overrides.temporalTlsKeyPath, ENV.TEMPORAL_TLS_KEY_PATH, configFile.temporalTlsKeyPath, temporalCli.temporalTlsKeyPath);
  const defaultAgent = resolveWithSource('defaultAgent', overrides.defaultAgent, ENV.DEFAULT_AGENT, configFile.defaultAgent, undefined, 'claude');
  const claudeBin = resolveWithSource('claudeBin', undefined, ENV.CLAUDE_BIN, configFile.claudeBin, undefined);

  return {
    config: {
      temporalAddress: address.value!,
      temporalNamespace: namespace.value!,
      temporalApiKey: apiKey.value,
      temporalTlsCertPath: tlsCert.value,
      temporalTlsKeyPath: tlsKey.value,
      defaultAgent: parseAgent(defaultAgent.value, defaultAgent.source),
      claudeBin: claudeBin.value,
      taskQueue: process.env[ENV.TASK_QUEUE] ?? (isDevMode() ? DEV_TASK_QUEUE : PROD_TASK_QUEUE),
      ensemble: process.env[ENV.ENSEMBLE] ?? 'default',
    },
    sources: {
      temporalAddress: address.source,
      temporalNamespace: namespace.source,
      temporalApiKey: apiKey.source,
      temporalTlsCertPath: tlsCert.source,
      temporalTlsKeyPath: tlsKey.source,
      defaultAgent: defaultAgent.source,
      claudeBin: claudeBin.source,
    },
  };
}

/** Build a per-host task queue name for cross-machine activities: {taskQueue}-{hostname} */
export function hostTaskQueue(taskQueue: string, hostname: string): string {
  return `${taskQueue}-${hostname}`;
}

/** Build a workflow ID for a player session: claude-session-{ensemble}-{playerId} */
export function sessionWorkflowId(ensemble: string, playerId: string): string {
  return `claude-session-${ensemble}-${playerId}`;
}

/** Build a workflow ID for a conductor: claude-session-{ensemble}-conductor */
export function conductorWorkflowId(ensemble: string): string {
  return `claude-session-${ensemble}-conductor`;
}

/** Build a workflow ID for the scheduler: claude-scheduler-{ensemble} */
export function schedulerWorkflowId(ensemble: string): string {
  return `claude-scheduler-${ensemble}`;
}

/** Build a workflow ID for the Maestro: claude-maestro-{ensemble} */
export function maestroWorkflowId(ensemble: string): string {
  return `claude-maestro-${ensemble}`;
}

/** Workflow ID for the single global Maestro instance. */
export const GLOBAL_MAESTRO_WORKFLOW_ID = 'claude-maestro-global';
