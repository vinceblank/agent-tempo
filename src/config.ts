import { existsSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { z } from 'zod';
import { AgentType, AGENT_TYPES } from './types';
import { validateEnsembleName } from './utils/validation';

/** Environment variable name constants — use these instead of string literals. */
export const ENV = {
  ENSEMBLE: 'AGENT_TEMPO_ENSEMBLE',
  CONDUCTOR: 'AGENT_TEMPO_CONDUCTOR',
  PLAYER_NAME: 'AGENT_TEMPO_PLAYER_NAME',
  TASK_QUEUE: 'AGENT_TEMPO_TASK_QUEUE',
  BRIDGE_NAME: 'COPILOT_BRIDGE_NAME',
  BRIDGE_MODE: 'AGENT_TEMPO_BRIDGE_MODE',
  BRIDGE_MODEL: 'COPILOT_BRIDGE_MODEL',
  BRIDGE_SESSION_ID: 'COPILOT_BRIDGE_SESSION_ID',
  TEMPORAL_ADDRESS: 'TEMPORAL_ADDRESS',
  TEMPORAL_NAMESPACE: 'TEMPORAL_NAMESPACE',
  TEMPORAL_API_KEY: 'TEMPORAL_API_KEY',
  TEMPORAL_TLS_CERT_PATH: 'TEMPORAL_TLS_CERT_PATH',
  TEMPORAL_TLS_KEY_PATH: 'TEMPORAL_TLS_KEY_PATH',
  DEFAULT_AGENT: 'AGENT_TEMPO_DEFAULT_AGENT',
  PLAYER_TYPE: 'AGENT_TEMPO_PLAYER_TYPE',
  CLAUDE_BIN: 'AGENT_TEMPO_CLAUDE_BIN',
  /**
   * #131 Phase C — claude-api adapter model override. Recruit-arg takes
   * precedence; this env var is the next fallback before the constants-pinned
   * default (`claude-opus-4-7`). Ignored by other adapters.
   */
  API_MODEL: 'AGENT_TEMPO_API_MODEL',
  /**
   * #449 Phase C — opencode adapter model override. Distinct from
   * `API_MODEL` to keep namespaces clean: claude-api is Anthropic-only
   * with bare model ids (`claude-opus-4-7`); opencode takes combined
   * `provider/model` strings (`anthropic/claude-opus-4-7`,
   * `openai/gpt-4o`, `ollama/llama3`, …). Recruit-arg precedence:
   * recruit `model` arg → this env var → `DEFAULT_MODEL` constant.
   */
  OPENCODE_MODEL: 'AGENT_TEMPO_OPENCODE_MODEL',
  /**
   * #520 — claude-code-headless permission mode. Forwarded to `claude -p
   * --permission-mode <mode>`. Recruit-arg `permissionMode` takes precedence;
   * this env var is the fallback before the constants-pinned default
   * (`'acceptEdits'`). Mutually exclusive with
   * {@link DANGEROUSLY_SKIP_PERMISSIONS}.
   */
  PERMISSION_MODE: 'AGENT_TEMPO_PERMISSION_MODE',
  /**
   * #520 — claude-code-headless dangerous-skip-permissions opt-in. When set
   * to `'1'`, the adapter passes `--dangerously-skip-permissions` to
   * `claude -p` instead of `--permission-mode`. Use only in trusted /
   * sandboxed contexts. Mutually exclusive with {@link PERMISSION_MODE}.
   */
  DANGEROUSLY_SKIP_PERMISSIONS: 'AGENT_TEMPO_DANGEROUSLY_SKIP_PERMISSIONS',
  /**
   * Phase 3a — headless Pi runtime model selector. Pi takes a `provider/model`
   * string (e.g. `anthropic/claude-opus-4-7`); absent → Pi's own default
   * provider/model (the 3a anthropic-default path). Recruit `model` arg →
   * this env → Pi default.
   */
  PI_MODEL: 'AGENT_TEMPO_PI_MODEL',
  /**
   * Phase 3a — headless Pi restart-resume. The daemon reads `metadata.sessionId`
   * (the Pi conversation id the player was in when it died) and passes it here;
   * the headless entry resumes via Pi `continueSession(<id>)`. Absent on a fresh
   * recruit → a new Pi session.
   */
  PI_CONTINUE_SESSION: 'AGENT_TEMPO_PI_CONTINUE_SESSION',
  /**
   * Phase 3a / MD-C — headless Pi tool-access policy. One of
   * `restricted` (default; Bash/shell/exec HARD-BLOCKED) | `standard` (scoped
   * Bash) | `full` (unsandboxed; admin-gated at recruit). Read by the Pi
   * extension's `tool_call` gate (mode='headless' only). Mirrors
   * {@link PERMISSION_MODE}'s threading.
   */
  TOOL_ACCESS: 'AGENT_TEMPO_TOOL_ACCESS',
  /**
   * #700 (P2 / G) — headless Pi guardrail posture. One of `autonomous`
   * (default; no gate) | `monitored` (operator-armed, fail-OPEN) | `supervised`
   * (fail-CLOSED, self-arming) | `observe-only` (no-act). Read by the Pi
   * extension's `tool_call` gate (mode='headless'). The DURABLE source of truth
   * is {@link SessionMetadata.guardrailPolicy}; this env var is just the per-boot
   * transport — the (re)spawn always re-derives it from metadata, so a restart
   * can never silently downgrade a supervised player (mirrors how `model` is
   * re-threaded from durable metadata across restart, NOT the ephemeral
   * `TOOL_ACCESS` env-only path).
   */
  GUARDRAIL_POLICY: 'AGENT_TEMPO_GUARDRAIL_POLICY',
  /**
   * 3c Tier-2 ingest auth. The daemon mints a per-player ingest token (scoped to
   * the session workflowId) BEFORE spawning a headless Pi player and threads it
   * into the subprocess env here. The player's inner-loop publisher presents it
   * on `POST /inner/ingest` + `GET /inner/presence` (loopback), where the daemon
   * validates it against the URL-derived workflowId (cross-player-spoof guard).
   * Absent → the publisher's HTTP client is a no-op (no fine-tail forwarding).
   */
  INGEST_TOKEN: 'AGENT_TEMPO_INGEST_TOKEN',
  /**
   * v0.25 PR-D attachment resume plumbing. When `restart` / `migrate`
   * enqueues a spawn outbox entry, the workflow passes the pre-claimed
   * `attachmentId` + pinned `runId` + resolved `adapterId` through the spawn
   * activity into the child process env. The child's adapter reads these in
   * `startV2Lifecycle` to renew (rather than freshly claim) the existing lease,
   * so there is no race window between the workflow's claim and the adapter
   * boot. Absent on first-recruit spawn (fresh claim path).
   */
  ATTACHMENT_ID: 'AGENT_TEMPO_ATTACHMENT_ID',
  ATTACHMENT_RUN_ID: 'AGENT_TEMPO_ATTACHMENT_RUN_ID',
  ADAPTER_ID: 'AGENT_TEMPO_ADAPTER_ID',
  /**
   * Daemon HTTP/SSE event source (#94, #95). See SSE-PROTOCOL.md §1, §3.
   * `HTTP_BIND` defaults to `127.0.0.1`. Setting to `0.0.0.0` forces
   * bearer mode. `DAEMON_PORT` defaults to `8473` (the `t-e-m-p-o`
   * mnemonic; not IANA-registered). `CORS_ORIGINS` is a comma-separated
   * explicit allowlist (no wildcards) — only consulted in bearer mode.
   * `SSE_MAX_CONNECTIONS` caps live SSE subscribers (PR-2; defaults 100).
   */
  HTTP_BIND: 'AGENT_TEMPO_HTTP_BIND',
  DAEMON_PORT: 'AGENT_TEMPO_DAEMON_PORT',
  CORS_ORIGINS: 'AGENT_TEMPO_CORS_ORIGINS',
  SSE_MAX_CONNECTIONS: 'AGENT_TEMPO_SSE_MAX_CONNECTIONS',
  /**
   * 3e RBAC (MD-E). Two-token model: the READ token (T1 — observe) may live in
   * env or config.json and auto-generates; the ADMIN token (T1+T2+T3 — mutate +
   * supervisory gate/inner) is ENV-VAR-ONLY (never config.json/disk, never
   * auto-generated). `TLS_ACKNOWLEDGED=1` suppresses the non-loopback-bind
   * plaintext-HTTP startup warning.
   */
  HTTP_READ_TOKEN: 'AGENT_TEMPO_HTTP_READ_TOKEN',
  HTTP_ADMIN_TOKEN: 'AGENT_TEMPO_HTTP_ADMIN_TOKEN',
  TLS_ACKNOWLEDGED: 'AGENT_TEMPO_TLS_ACKNOWLEDGED',
  /**
   * Dev profile gate (ADR 0014 §5.2). One source of truth — every layer
   * (paths, namespace, port, task queue, banner, registry gating) consults
   * `isDevMode()` rather than reading the env var directly. The `--dev`
   * top-level CLI flag in `src/cli.ts` sets this to `'1'` before any other
   * module loads (see `src/cli/dev-mode-bootstrap.ts`).
   */
  DEV_MODE: 'AGENT_TEMPO_DEV_MODE',
  /**
   * #672 — set to `'1'` by a TRANSIENT-CLI spawner (e.g. the short-lived `up`
   * conductor) on a process it intentionally DETACHES to outlive that spawner.
   * Tells the parent-death watchdog to skip ONLY the ppid-poll signal (which
   * would otherwise self-kill the detached process when the transient spawner
   * exits); the universally-correct stdin-EOF signal stays. Daemon-recruit
   * spawns do NOT set it, so recruited adapters keep the #604 anti-leak ppid-poll.
   */
  NO_PPID_WATCHDOG: 'AGENT_TEMPO_NO_PPID_WATCHDOG',
  /**
   * #690 — absolute path to the bridge pid file, computed ONCE by the spawn
   * helper (`bridgeLogPaths(ensemble, name).pidPath`) and passed to the adapter
   * child. The adapter writes/unlinks THIS path rather than re-deriving its own
   * (which diverged from the spawner's when PLAYER_NAME was empty — the
   * split-brain orphan). PLAIN (non-secret): it's a file location, not a
   * credential — must stay inline under #689's `partitionEnv`.
   */
  PID_FILE: 'AGENT_TEMPO_PID_FILE',
  /**
   * Escape hatch for triple-isolated environments (ADR 0014 §5.3). When
   * set, `resolveTempoHome()` returns this path verbatim — bypassing both
   * the production default and the dev-mode default. Lets a power user
   * coordinate three or more parallel agent-tempo profiles on one box.
   */
  DEV_HOME_OVERRIDE: 'AGENT_TEMPO_HOME_OVERRIDE',
  /**
   * #729 — explicit Pi session-role override for {@link resolvePiRole}. Accepts
   * `'player'` | `'command-center'`. A future escape hatch: the heuristic
   * (PLAYER_NAME presence) already classifies every current launch correctly, so
   * this is intentionally NOT wired into any spawn site — it exists so an operator
   * can force a role if a new launch path ever defeats the heuristic.
   */
  PI_ROLE: 'AGENT_TEMPO_PI_ROLE',
  /**
   * #729 (A2) — affirmative opt-in for the mission-control command-center board.
   * Set by the `agent-tempo command-center` launcher (NOT by bare `pi`), so a
   * plain coding `pi` stays pristine (both extensions dormant). Lower precedence
   * than {@link PLAYER_NAME} in {@link resolvePiRole} — a session that must CLAIM
   * never silently degrades to a passive board.
   */
  MISSION_CONTROL: 'AGENT_TEMPO_MISSION_CONTROL',
} as const;

/**
 * The role of a Pi session (#729). A session is at most ONE of these — the two
 * auto-loaded Pi extensions gate on it so they're mutually exclusive:
 * - `player` — the player extension's full MCP surface (cue/recruit/report/…).
 * - `command-center` — mission-control's operator board + planner tools.
 * - `none` — neither (a bare `pi` used for plain coding); both stay dormant.
 *
 * `player` and `command-center` both register `cue`/`recruit` by name, so loading
 * both in one session collides and the command-center never starts (#729).
 */
export type PiRole = 'player' | 'command-center' | 'none';

/**
 * Resolve the role of a Pi session (#729) — the single discriminator both
 * auto-loaded Pi extensions gate on.
 *
 * Precedence (deterministic, #729 A2):
 * 1. Explicit {@link ENV.PI_ROLE} (`'player'` | `'command-center'`) wins — a future
 *    escape hatch, intentionally NOT wired into any spawn site.
 * 2. {@link ENV.PLAYER_NAME} present (every `up`/`recruit` player spawn) → `'player'`.
 *    Checked BEFORE the board opt-in ON PURPOSE: a session that must CLAIM must
 *    never silently degrade to a passive board.
 * 3. {@link ENV.MISSION_CONTROL} opt-in (set by `agent-tempo command-center`) →
 *    `'command-center'`.
 * 4. Otherwise `'none'` — a bare `pi` for plain coding: BOTH extensions stay
 *    dormant (the A2 clean-pi guarantee).
 *
 * Pure (env injectable) so the dormancy matrix is unit-testable without spawning.
 * NOTE: headless Pi is definitionally a recruited player and must NOT rely on this
 * heuristic — its caller forces `'player'` directly (env-weirdness immune).
 */
export function resolvePiRole(env: NodeJS.ProcessEnv = process.env): PiRole {
  const explicit = env[ENV.PI_ROLE];
  if (explicit === 'player' || explicit === 'command-center') return explicit;
  if (env[ENV.PLAYER_NAME]) return 'player';
  if (env[ENV.MISSION_CONTROL]) return 'command-center';
  return 'none';
}

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

/** Persisted config file fields (stored in ~/.agent-tempo/config.json). */
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
   * bearer mode is required (`AGENT_TEMPO_HTTP_BIND` non-loopback OR
   * a request with a non-loopback `Origin`) and no token is set:
   * `crypto.randomBytes(32).toString('base64url')`, 0600 on POSIX.
   * Rotation = delete this field; next daemon boot regenerates.
   *
   * 3e: this LEGACY single token is migrated to the READ tier (T1) — a daemon
   * with only `httpToken` set keeps read access and emits a one-time startup
   * warning to set an admin token for writes/gate/inner. Prefer `readToken`.
   */
  httpToken?: string;
  /**
   * 3e RBAC — the READ-tier (T1) bearer token. Env `AGENT_TEMPO_HTTP_READ_TOKEN`
   * takes precedence over this; auto-generated here on first bearer-mode boot if
   * neither is set. The ADMIN token is deliberately ABSENT from this file (it is
   * env-var-only, never persisted).
   */
  readToken?: string;
}

// ── Dev profile (ADR 0014 §5) ──

/**
 * Dev profile defaults — one switch (`--dev` top-level flag, or
 * `AGENT_TEMPO_DEV_MODE=1` env var) flips four isolation axes at once
 * (ADR 0014 §5.1). Production stays on the existing defaults.
 */
export const DEV_HOME_DIR_NAME = '.agent-tempo-dev';
export const PROD_HOME_DIR_NAME = '.agent-tempo';
export const DEV_TEMPORAL_NAMESPACE = 'agent-tempo-dev';
export const PROD_TEMPORAL_NAMESPACE = 'default';
export const DEV_TASK_QUEUE = 'agent-tempo-dev';
export const PROD_TASK_QUEUE = 'agent-tempo';
export const DEV_DAEMON_PORT = 8474;
export const PROD_DAEMON_PORT = 8473;

/**
 * Single source of truth for the dev profile gate (ADR 0014 §5.2).
 * Every layer that needs to switch behaviour consults this helper; future
 * staging/ci/demo profiles would follow the same `isStagingMode()` pattern.
 *
 * Recognises `'1'` and `'true'` (case-insensitive) so users can write
 * either `AGENT_TEMPO_DEV_MODE=1` or `AGENT_TEMPO_DEV_MODE=true`. Any
 * other value (including the empty string) is treated as production.
 *
 * **Important**: when the `--dev` CLI flag is used, the env var must be
 * set BEFORE `src/config.ts` is first imported (see
 * `src/cli/dev-mode-bootstrap.ts`) so the module-load-time `AGENT_TEMPO_HOME`
 * constant resolves to the dev profile.
 */
export function isDevMode(): boolean {
  const v = process.env[ENV.DEV_MODE];
  if (!v) return false;
  return v === '1' || v.toLowerCase() === 'true';
}

/**
 * Resolve the agent-tempo home directory. Three-tier precedence:
 *   1. `AGENT_TEMPO_HOME_OVERRIDE` env — explicit override (multi-isolation
 *      escape hatch; ADR 0014 §5.3).
 *   2. Dev mode (`AGENT_TEMPO_DEV_MODE=1`): `~/.agent-tempo-dev/`.
 *   3. Production default: `~/.agent-tempo/`.
 *
 * Evaluated once at module load time; downstream callers consume the
 * exported `AGENT_TEMPO_HOME` constant. The bootstrap module guarantees
 * the env var is set before this function first runs.
 *
 * Exported (rather than file-private) so unit tests can exercise the
 * three-tier precedence directly without resorting to `vi.resetModules()`
 * gymnastics. Production code should consume {@link AGENT_TEMPO_HOME}
 * — calling this helper per-request would re-read env on every call.
 */
export function resolveTempoHome(): string {
  const override = process.env[ENV.DEV_HOME_OVERRIDE];
  if (override) return override;
  return isDevMode()
    ? join(homedir(), DEV_HOME_DIR_NAME)
    : join(homedir(), PROD_HOME_DIR_NAME);
}

export const AGENT_TEMPO_HOME = resolveTempoHome();
export const CONFIG_FILE_PATH = join(AGENT_TEMPO_HOME, 'config.json');

/** Resolved log + pid paths for a recruited bridge/adapter player (#690). */
export interface BridgeLogPaths {
  /** The directory holding the player's log + pid files. */
  dir: string;
  /** `<dir>/<player>.log`. */
  logPath: string;
  /** `<dir>/<player>.pid`. */
  pidPath: string;
}

/**
 * SINGLE source of truth for where a recruited bridge/adapter's `.log` + `.pid`
 * live (#690). Default is CENTRAL — `~/.agent-tempo/logs/<ensemble>/<player>.*` —
 * NOT the old per-cwd `<workDir>/logs` (which scattered pid files across every
 * recruit directory and orphaned them on `down`). No call site should construct
 * its own `join(..., 'logs', ...)`; route everything through here so the writer
 * (spawn helper) and the readers (status / down / hard-terminate) compute the
 * SAME path and can't split-brain.
 *
 * `overrideDir` is the existing per-spawn `opts.logDir` escape hatch (rarely set);
 * when present it wins over the central default. `ensemble`/`player` are
 * regex-validated upstream (ENSEMBLE_NAME_REGEX / PLAYER_NAME_REGEX — no slashes),
 * but a defensive guard rejects path-traversal as insurance.
 */
/**
 * Root of the central bridge-log tree: `~/.agent-tempo/logs`. Per-ensemble dirs
 * live under it. Exposed so a cluster-wide reader (e.g. `down`'s
 * killBridgeProcesses) can enumerate every ensemble's dir without re-constructing
 * the `'logs'` segment itself — {@link bridgeLogPaths} is the only other place
 * that names it.
 */
export function bridgeLogsRoot(): string {
  return join(AGENT_TEMPO_HOME, 'logs');
}

export function bridgeLogPaths(ensemble: string, player: string, overrideDir?: string): BridgeLogPaths {
  for (const [label, seg] of [['ensemble', ensemble], ['player', player]] as const) {
    if (/[/\\]|\.\./.test(seg)) {
      throw new Error(`bridgeLogPaths: ${label} "${seg}" must not contain path separators or "..".`);
    }
  }
  const dir = overrideDir ?? join(bridgeLogsRoot(), ensemble);
  return { dir, logPath: join(dir, `${player}.log`), pidPath: join(dir, `${player}.pid`) };
}

/**
 * The pid path an ADAPTER subprocess should write/unlink (#690). The SPAWNER
 * computes the path once via {@link bridgeLogPaths} and passes it as
 * `ENV.PID_FILE`; the adapter consumes THAT — it does NOT re-derive its own from
 * a (possibly divergent) player identifier. The `bridgeLogPaths` fallback is used
 * ONLY when the env is absent (a manual adapter launch outside the spawner). This
 * is the by-construction fix for the copilot split-brain (PLAYER_NAME='' →
 * `copilot-${Date.now()}` ≠ the spawner's logName).
 */
export function resolveAdapterPidFile(ensemble: string, fallbackPlayer: string): string {
  return process.env[ENV.PID_FILE] || bridgeLogPaths(ensemble, fallbackPlayer).pidPath;
}

// ── Daemon config (PR-E design §10.2) ──

/**
 * Daemon-level configuration persisted in `~/.agent-tempo/config.json`
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
 * Load `~/.agent-tempo/config.json` and extract the daemon-level fields.
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
    console.error('[agent-tempo] Invalid daemon config; using defaults.', result.error.format());
    return DaemonConfigSchema.parse({});
  } catch (err) {
    console.error(
      '[agent-tempo] Could not read daemon config; using defaults:',
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

/** Load ~/.agent-tempo/config.json if it exists. */
export function loadConfigFile(): PersistedConfig {
  try {
    if (existsSync(CONFIG_FILE_PATH)) {
      return JSON.parse(readFileSync(CONFIG_FILE_PATH, 'utf8'));
    }
  } catch {
    // Corrupt file — warn but don't crash
    console.error(`[agent-tempo] Warning: could not parse ${CONFIG_FILE_PATH} — ignoring config file`);
  }
  return {};
}

/** Save config to ~/.agent-tempo/config.json with restrictive permissions. */
export function saveConfigFile(config: PersistedConfig): void {
  const { writeFileSync, chmodSync } = require('fs') as typeof import('fs');
  mkdirSync(AGENT_TEMPO_HOME, { recursive: true });
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
 * Parse an agent value against the canonical {@link AGENT_TYPES} union — the
 * SINGLE SOURCE OF TRUTH for agent validity (shared with `cli.ts`'s `--agent`
 * parser). Throws when `value` is present but not a known agent; returns
 * `'claude'` for empty/unset values so callers can use it as a source-aware default.
 *
 * This is a pure type-VALIDITY check — it accepts EVERY `AgentType` (including
 * `mock` and the headless adapters). Narrower CAPABILITY constraints are gated
 * separately downstream: the recruit pre-flight rejects `mock` outside dev mode,
 * and `config`'s `VALID_DEFAULT_AGENTS` restricts the persistent default to the
 * conductor-capable subset. (#683: the former hardcoded `['claude','copilot']`
 * list was stale — it rejected `defaultAgent=pi` at config LOAD, poisoning every
 * command before the `--agent` flag was even read.)
 */
export function parseAgent(value: string | undefined, source: ConfigSource): AgentType {
  if (value == null || value === '') return 'claude';
  if (!(AGENT_TYPES as readonly string[]).includes(value)) {
    throw new Error(
      `Invalid agent "${value}" from ${AGENT_SOURCE_LABELS[source]}. ` +
      `Valid values: ${AGENT_TYPES.join(', ')}.`,
    );
  }
  return value as AgentType;
}

/**
 * Result of {@link parsePiProviderModel}: the parsed parts, OR an `{ error }`
 * describing why the selector is malformed. Non-throwing by design — a pure
 * mapper returning a discriminated union (the recruit wiring branches
 * `if ('error' in r) return fail(r.error)`, no try/catch).
 */
export type ProviderModel = { provider: string; model: string } | { error: string };

/**
 * Parse a Pi provider/model selector (e.g. `"github-copilot/gpt-4o"`) into its
 * `{ provider, model }` parts for Pi's `createAgentSession` model option.
 *
 * Provider-agnostic: the segment before the FIRST `/` is the provider id,
 * passed through VERBATIM (Copilot's pi-ai provider id is literally
 * `github-copilot` — no normalization needed); everything after is the model
 * id, which may itself contain `/` (e.g. `openrouter/anthropic/claude`).
 *
 * Fail-loud (no silent default): returns `{ error }` — never a fallback model —
 * when the selector has no `/`, an empty provider, or an empty model. A bare
 * provider with no model is rejected here; omitting the recruit `model` arg
 * ENTIRELY is a different path (Pi's own default), handled upstream, not here.
 */
export function parsePiProviderModel(model: string): ProviderModel {
  const raw = model.trim();
  const slash = raw.indexOf('/');
  if (slash < 0) {
    return {
      error: `model "${model}" must be a "provider/model" selector (e.g. "github-copilot/gpt-4o") — no "/" found.`,
    };
  }
  const provider = raw.slice(0, slash).trim();
  const modelId = raw.slice(slash + 1).trim();
  if (!provider) {
    return { error: `model "${model}" has an empty provider before "/" — expected e.g. "github-copilot/gpt-4o".` };
  }
  if (!modelId) {
    return { error: `model "${model}" has an empty model after "/" — specify a model, e.g. "github-copilot/gpt-4o".` };
  }
  return { provider, model: modelId };
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
 *   CLI flag > env var > agent-tempo config file > temporal CLI config > defaults
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
      // the dev profile's own agent-tempo config file
      // (`~/.agent-tempo-dev/config.json`) still win — but the
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
 * Used by `agent-tempo config show` to help users debug.
 *
 * Mirrors {@link getConfig}'s dev-mode env-var carve-out — without this
 * parity the user would see `env: TEMPORAL_NAMESPACE=default` in
 * `config show` while the daemon happily ignores it.
 */
export function getConfigWithSources(overrides: CliOverrides = {}): ConfigWithSources {
  const temporalCli = loadTemporalCliConfig();
  const configFile = loadConfigFile();

  function resolveWithSource(
    // Documentation-only label preserved at call sites for readability;
    // not used inside the body. Prefixed `_` to signal intentional non-use.
    _key: string,
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

/** Build a workflow ID for a player session: agent-session-{ensemble}-{playerId} */
export function sessionWorkflowId(ensemble: string, playerId: string): string {
  return `agent-session-${ensemble}-${playerId}`;
}

/** Build a workflow ID for a conductor: agent-session-{ensemble}-conductor */
export function conductorWorkflowId(ensemble: string): string {
  return `agent-session-${ensemble}-conductor`;
}

/** Build a workflow ID for the scheduler: agent-scheduler-{ensemble} */
export function schedulerWorkflowId(ensemble: string): string {
  return `agent-scheduler-${ensemble}`;
}

/** Build a workflow ID for the Maestro: agent-maestro-{ensemble} */
export function maestroWorkflowId(ensemble: string): string {
  return `agent-maestro-${ensemble}`;
}

/** Workflow ID for the single global Maestro instance. */
export const GLOBAL_MAESTRO_WORKFLOW_ID = 'agent-maestro-global';
