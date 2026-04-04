import { existsSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { AgentType } from './types';

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
  TEMPORAL_ADDRESS: 'TEMPORAL_ADDRESS',
  TEMPORAL_NAMESPACE: 'TEMPORAL_NAMESPACE',
  TEMPORAL_API_KEY: 'TEMPORAL_API_KEY',
  TEMPORAL_TLS_CERT_PATH: 'TEMPORAL_TLS_CERT_PATH',
  TEMPORAL_TLS_KEY_PATH: 'TEMPORAL_TLS_KEY_PATH',
  DEFAULT_AGENT: 'CLAUDE_TEMPO_DEFAULT_AGENT',
} as const;

export interface Config {
  temporalAddress: string;
  temporalNamespace: string;
  temporalApiKey?: string;
  temporalTlsCertPath?: string;
  temporalTlsKeyPath?: string;
  defaultAgent: AgentType;
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
}

export const CLAUDE_TEMPO_HOME = join(homedir(), '.claude-tempo');
export const CONFIG_FILE_PATH = join(CLAUDE_TEMPO_HOME, 'config.json');

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

  return {
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
    taskQueue: process.env[ENV.TASK_QUEUE] ?? 'claude-tempo',
    ensemble: process.env[ENV.ENSEMBLE] ?? 'default',
  };
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

  return {
    config: {
      temporalAddress: address.value!,
      temporalNamespace: namespace.value!,
      temporalApiKey: apiKey.value,
      temporalTlsCertPath: tlsCert.value,
      temporalTlsKeyPath: tlsKey.value,
      defaultAgent: validAgent(defaultAgent.value),
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
