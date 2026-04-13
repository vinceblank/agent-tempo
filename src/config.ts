import { existsSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { z } from 'zod';
import { AgentType } from './types';
import { validateEnsembleName } from './utils/validation';

const VALID_AGENTS: AgentType[] = ['claude', 'copilot'];
function validAgent(value: string | undefined): AgentType {
  return VALID_AGENTS.includes(value as AgentType) ? (value as AgentType) : 'claude';
}

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
   * v0.25 attachment lifecycle feature flag. Default is ON — adapters use the
   * new `claimAttachment` / `heartbeat` / `processingStart` wire surface directly.
   * Set `CLAUDE_TEMPO_LIFECYCLE_V2=0` (or `false`) to force adapters back onto
   * the PR-A legacy shim path (`updateMetadata({ status })`, etc.) as an
   * emergency rollback. Removed in v0.25.1 post-GA cleanup.
   */
  LIFECYCLE_V2: 'CLAUDE_TEMPO_LIFECYCLE_V2',
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
} as const;

/**
 * Read the v0.25 lifecycle feature flag. Default ON; explicit `0` / `false` / `off` disables.
 * Accepts a few truthy/falsy spellings so operators don't have to memorize the exact token.
 */
export function lifecycleV2Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[ENV.LIFECYCLE_V2];
  if (raw === undefined || raw === '') return true; // default ON
  const v = raw.trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

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
}

export const CLAUDE_TEMPO_HOME = join(homedir(), '.claude-tempo');
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
 * Build a resolved Config using the priority chain:
 *   CLI flag > env var > claude-tempo config file > temporal CLI config > defaults
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
    return cliVal || process.env[envKey] || fileVal || temporalCliVal || defaultVal;
  };

  const resolveOpt = (
    cliVal: string | undefined,
    envKey: string,
    fileVal: string | undefined,
    temporalCliVal: string | undefined,
  ): string | undefined => {
    return cliVal || process.env[envKey] || fileVal || temporalCliVal || undefined;
  };

  const config: Config = {
    temporalAddress: resolve(
      overrides.temporalAddress, ENV.TEMPORAL_ADDRESS,
      configFile.temporalAddress, temporalCli.temporalAddress,
      'localhost:7233',
    ),
    temporalNamespace: resolve(
      overrides.temporalNamespace, ENV.TEMPORAL_NAMESPACE,
      configFile.temporalNamespace, temporalCli.temporalNamespace,
      'default',
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
    defaultAgent: validAgent(overrides.defaultAgent
      || process.env[ENV.DEFAULT_AGENT]
      || configFile.defaultAgent),
    claudeBin: process.env[ENV.CLAUDE_BIN] || configFile.claudeBin || undefined,
    taskQueue: process.env[ENV.TASK_QUEUE] ?? 'claude-tempo',
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
    if (process.env[envKey]) return { value: process.env[envKey], source: 'env' };
    if (fileVal) return { value: fileVal, source: 'config' };
    if (temporalCliVal) return { value: temporalCliVal, source: 'temporal-cli' };
    if (defaultVal) return { value: defaultVal, source: 'default' };
    return { value: undefined, source: 'none' };
  }

  const address = resolveWithSource('temporalAddress', overrides.temporalAddress, ENV.TEMPORAL_ADDRESS, configFile.temporalAddress, temporalCli.temporalAddress, 'localhost:7233');
  const namespace = resolveWithSource('temporalNamespace', overrides.temporalNamespace, ENV.TEMPORAL_NAMESPACE, configFile.temporalNamespace, temporalCli.temporalNamespace, 'default');
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
      defaultAgent: validAgent(defaultAgent.value),
      claudeBin: claudeBin.value,
      taskQueue: process.env[ENV.TASK_QUEUE] ?? 'claude-tempo',
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
