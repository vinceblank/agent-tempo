import { spawn, execFileSync, execSync } from 'child_process';
import { existsSync, mkdirSync, openSync, closeSync, writeFileSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { ENV } from './config';
import type { MockMode } from './types';
import type { ClaudeCodeHeadlessPermissionMode } from './adapters/claude-code-headless/types';

const log = (...args: unknown[]) => console.error('[agent-tempo:spawn]', ...args);

/** Stable GUID for the agent-tempo Windows Terminal profile. */
const WT_PROFILE_GUID = '{c1a0d300-0e30-4000-a000-c1a0de00e300}';
const WT_PROFILE_NAME = 'agent-tempo';

/** Resolve the absolute path to the package's icon file (PNG for Windows Terminal). */
export function resolveIconPath(): string {
  // __dirname is src/ in dev or dist/ in production; assets/ is at the package root
  const packageRoot = resolve(__dirname, '..');
  return join(packageRoot, 'assets', 'icon-dark-32.png');
}

/**
 * Strip // and /* comments from JSON-with-comments (JSONC), leaving strings intact.
 * Handles escaped quotes inside strings correctly.
 */
function stripJsonComments(text: string): string {
  let result = '';
  let i = 0;
  while (i < text.length) {
    // String literal — copy verbatim until closing quote
    if (text[i] === '"') {
      result += '"';
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') { result += text[i++]; } // skip escaped char
        if (i < text.length) { result += text[i++]; }
      }
      if (i < text.length) { result += text[i++]; } // closing quote
    // Line comment
    } else if (text[i] === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    // Block comment
    } else if (text[i] === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2; // skip closing */
    } else {
      result += text[i++];
    }
  }
  return result;
}

/**
 * Ensure a "agent-tempo" profile exists in Windows Terminal settings.json
 * with our icon. Returns true if the profile is ready for use.
 *
 * Windows Terminal settings path:
 *   %LOCALAPPDATA%/Packages/Microsoft.WindowsTerminal_8wekyb3d8bbwe/LocalState/settings.json
 */
export function ensureWindowsTerminalProfile(): boolean {
  if (process.platform !== 'win32') return false;

  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return false;

  const settingsPath = join(
    localAppData,
    'Packages',
    'Microsoft.WindowsTerminal_8wekyb3d8bbwe',
    'LocalState',
    'settings.json',
  );

  if (!existsSync(settingsPath)) {
    log('Windows Terminal settings.json not found at', settingsPath);
    return false;
  }

  try {
    const raw = readFileSync(settingsPath, 'utf8');
    // Windows Terminal settings.json may contain comments — strip them for JSON.parse.
    // Naive regex would eat "//" inside strings (e.g., URLs). Walk char-by-char instead.
    const settings = JSON.parse(stripJsonComments(raw));

    if (!settings.profiles?.list) return false;

    const iconPath = resolveIconPath().replace(/\\/g, '/');
    if (!existsSync(iconPath.replace(/\//g, '\\'))) {
      log('Icon file not found at', iconPath);
      return false;
    }
    const profiles: unknown[] = settings.profiles.list;

    // Check if our profile already exists (by GUID or name)
    const existing = profiles.find(
      (p: any) => p.guid === WT_PROFILE_GUID || p.name === WT_PROFILE_NAME,
    ) as Record<string, unknown> | undefined;

    if (existing) {
      // Update icon + closeOnExit if they changed (e.g. package moved, or pre-#165 profile)
      let dirty = false;
      if (existing.icon !== iconPath) { existing.icon = iconPath; dirty = true; }
      // Force-killed sessions exit with code 1; "always" ensures WT closes the tab
      // instead of showing "process exited" with a stale prompt.
      if (existing.closeOnExit !== 'always') { existing.closeOnExit = 'always'; dirty = true; }
      if (dirty) {
        writeFileSync(settingsPath, JSON.stringify(settings, null, 4) + '\n');
        log('Updated agent-tempo profile in Windows Terminal');
      }
      return true;
    }

    // Add new profile
    profiles.push({
      guid: WT_PROFILE_GUID,
      name: WT_PROFILE_NAME,
      commandline: 'cmd.exe',
      icon: iconPath,
      hidden: true, // Hide from dropdown — only used programmatically
      closeOnExit: 'always', // Force-killed sessions exit non-zero; auto-close the tab
    });

    // Write back with original formatting style (4-space indent to match WT default)
    writeFileSync(settingsPath, JSON.stringify(settings, null, 4) + '\n');
    log('Created agent-tempo profile in Windows Terminal with icon:', iconPath);
    return true;
  } catch (e) {
    log('Failed to update Windows Terminal settings:', e);
    return false;
  }
}

/** POSIX shell-safe single-quoting (works in bash, zsh, and fish) */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Resolve the path to the `claude` binary.
 *
 * Resolution order:
 *  1. `configBin` parameter (from Config.claudeBin — env var or config file)
 *  2. `AGENT_TEMPO_CLAUDE_BIN` env var (checked directly for spawned processes that
 *     may not have full config resolution, e.g., activities)
 *  3. `which claude` / `where claude` lookup
 *  4. Bare `claude` fallback
 */
export function resolveClaudePath(configBin?: string): string {
  // Priority 1: explicit config value
  if (configBin) return configBin;

  // Priority 2: env var (may be set by parent process)
  const envBin = process.env.AGENT_TEMPO_CLAUDE_BIN;
  if (envBin) return envBin;

  // Priority 3: which/where lookup
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    return execFileSync(cmd, ['claude'], { encoding: 'utf8' }).trim().split('\n')[0];
  } catch {
    return 'claude';
  }
}

/**
 * Detect the macOS terminal the user is actually running in.
 *
 * Priority:
 *  1. TERM_PROGRAM env var (most reliable when available — set by the terminal itself)
 *  2. Check frontmost app via AppleScript (detects what the user is actively using)
 *  3. Fall back to Terminal.app
 */
export function detectMacTerminal(): 'ghostty' | 'iterm2' | 'terminal' {
  const termProgram = (process.env.TERM_PROGRAM || '').toLowerCase();
  if (termProgram === 'ghostty') return 'ghostty';
  if (termProgram === 'iterm.app' || termProgram === 'iterm2') return 'iterm2';
  if (termProgram === 'apple_terminal') return 'terminal';

  // MCP servers may not inherit TERM_PROGRAM — check which terminal app is running
  // Prefer frontmost app detection over pgrep to avoid false positives
  try {
    const frontApp = execFileSync('osascript', ['-e',
      'tell application "System Events" to get name of first application process whose frontmost is true',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().toLowerCase();
    if (frontApp === 'ghostty') return 'ghostty';
    if (frontApp === 'iterm2') return 'iterm2';
    if (frontApp === 'terminal') return 'terminal';
  } catch { /* ignore */ }

  // Last resort: check running processes
  try {
    execFileSync('pgrep', ['-x', 'ghostty'], { stdio: 'ignore' });
    return 'ghostty';
  } catch { /* not running */ }
  try {
    execFileSync('pgrep', ['-x', 'iTerm2'], { stdio: 'ignore' });
    return 'iterm2';
  } catch { /* not running */ }

  return 'terminal';
}

/** Find the first available terminal emulator on Linux */
export function findLinuxTerminal(): string | null {
  const candidates = ['gnome-terminal', 'konsole', 'x-terminal-emulator', 'xfce4-terminal', 'xterm'];
  for (const term of candidates) {
    try {
      execFileSync('which', [term], { stdio: 'ignore' });
      return term;
    } catch {
      // not found, try next
    }
  }
  return null;
}

/**
 * Build a shell command string that sets env vars and runs claude.
 * Uses inline `KEY=val` syntax which works in bash, zsh, AND fish.
 */
export function buildClaudeCommand(
  claudeBin: string,
  claudeArgs: string[],
  envVars: Record<string, string>,
): string {
  const envInline = Object.entries(envVars)
    .map(([k, v]) => `${k}=${shellQuote(v)}`)
    .join(' ');
  // Quote the binary path if it contains spaces (e.g., "C:\Program Files\...")
  const quotedBin = claudeBin.includes(' ') ? shellQuote(claudeBin) : claudeBin;
  const args = claudeArgs.map(a => shellQuote(a)).join(' ');
  return envInline ? `${envInline} ${quotedBin} ${args}` : `${quotedBin} ${args}`;
}

/**
 * Spawn a Claude Code session in a visible terminal window.
 *
 * Strategy per terminal:
 *  - Ghostty: `initial input` into a normal window (preserves full shell env)
 *  - iTerm2: `write text` via AppleScript (same approach)
 *  - Terminal.app: .command script with shell profile sourcing
 *  - Windows: shell:true with env vars
 *  - Linux: terminal emulator with -e flag
 */
export function spawnInTerminal(
  claudeArgs: string[],
  workDir: string,
  envVars: Record<string, string>,
  options?: { claudeBin?: string },
): { pid: number | undefined } {
  const claudeBin = resolveClaudePath(options?.claudeBin);
  const claudeInvocation = buildClaudeCommand(claudeBin, claudeArgs, envVars);

  if (process.platform === 'darwin') {
    const detected = detectMacTerminal();
    log(`Terminal detection: TERM_PROGRAM=${JSON.stringify(process.env.TERM_PROGRAM)}, detected=${detected}`);

    if (detected === 'ghostty') {
      // Append `; exit` so the wrapping shell exits when claude does (clean or killed).
      // Without it, claude exit returns control to the shell prompt and the tab lingers —
      // parity with the Windows WT `closeOnExit: 'always'` + parent-walk fix from #166.
      const osaScript = `
        tell application "Ghostty"
          set cfg to new surface configuration
          set initial working directory of cfg to ${JSON.stringify(workDir)}
          set initial input of cfg to ${JSON.stringify(claudeInvocation + '; exit\n')}
          set win to new window with configuration cfg
        end tell`;
      log('Using Ghostty initial-input path');
      const child = spawn('osascript', ['-e', osaScript], {
        detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stderr?.on('data', (d: Buffer) => log('osascript stderr:', d.toString()));
      child.stdout?.on('data', (d: Buffer) => log('osascript stdout:', d.toString()));
      child.unref();
      return { pid: child.pid };
    }

    if (detected === 'iterm2') {
      // Append `; exit` so the wrapping shell exits when claude does. `;` rather than
      // `&&` so exit runs regardless of claude's exit code (force-kill returns non-zero).
      // JSON.stringify embeds the full shell command as a properly-escaped string literal
      // so any `"` or `\` in paths/args doesn't break the AppleScript parser. Parity with
      // the Ghostty path above.
      const shellCmd = `cd ${shellQuote(workDir)} && ${claudeInvocation} ; exit`;
      const osaScript = `
        tell application "iTerm2"
          set newWindow to (create window with default profile)
          tell current session of newWindow
            write text ${JSON.stringify(shellCmd)}
          end tell
        end tell`;
      log('Using iTerm2 write-text path');
      const child = spawn('osascript', ['-e', osaScript], {
        detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stderr?.on('data', (d: Buffer) => log('osascript stderr:', d.toString()));
      child.unref();
      return { pid: child.pid };
    }

    // Terminal.app: .command file with shell profile sourcing
    const userShell = process.env.SHELL || '/bin/zsh';
    const scriptPath = join(tmpdir(), `agent-tempo-recruit-${Date.now()}.command`);
    let profileSource: string;
    if (userShell.endsWith('/fish')) {
      profileSource = `exec fish -c "cd ${shellQuote(workDir)} && ${claudeInvocation}"`;
    } else {
      profileSource = [
        `[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc" 2>/dev/null`,
        `[ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc" 2>/dev/null`,
        `[ -f "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh" 2>/dev/null`,
        `command -v fnm >/dev/null && eval "$(fnm env)" 2>/dev/null`,
      ].join('\n');
    }
    const envExports = Object.entries(envVars)
      .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
      .join('\n');
    const lines = [
      '#!/bin/bash',
      // Env vars BEFORE profile sourcing — profiles that call `exec` (e.g. oh-my-zsh)
      // would otherwise lose the exports and the claude command (#98)
      envExports,
      profileSource,
      `cd ${shellQuote(workDir)}`,
      // `exec` so the shell is replaced by claude — when claude exits (clean or killed),
      // the script process ends and Terminal.app closes the window per its settings.
      // Without `exec`, bash waits for claude and then returns to prompt, leaving the
      // window open. Parity with the WT `closeOnExit: 'always'` fix from #166.
      `exec ${shellQuote(claudeBin)} ${claudeArgs.map(a => shellQuote(a)).join(' ')}`,
    ];
    writeFileSync(scriptPath, lines.join('\n') + '\n', { mode: 0o755 });
    log('Using Terminal.app .command path:', scriptPath);
    const child = spawn('open', [scriptPath], { detached: true, stdio: 'ignore' });
    child.unref();
    return { pid: child.pid };
  }

  if (process.platform === 'win32') {
    // Detect Windows Terminal: WT_SESSION env var is set when running inside it.
    // wt.exe is a UWP app execution alias that Node.js can't resolve directly,
    // but `cmd.exe /c start "" wt.exe ...` works through the Windows shell.
    const hasWt = Boolean(process.env.WT_SESSION);

    if (hasWt) {
      // Extract player name from claudeArgs (-n <name>) for tab title
      const nameIdx = claudeArgs.indexOf('-n');
      const tabTitle = nameIdx !== -1 && nameIdx + 1 < claudeArgs.length
        ? claudeArgs[nameIdx + 1]
        : 'agent-tempo';

      // Ensure our profile with icon exists in Windows Terminal settings
      const hasProfile = ensureWindowsTerminalProfile();

      // Build inline env var assignments for cmd /c since wt.exe spawns
      // a new process that won't inherit our env.
      // Escape values for cmd.exe: wrap in quotes and escape inner special chars.
      const cmdEscape = (s: string) => s.replace(/([&|<>^"%])/g, '^$1');
      const setCmds = Object.entries(envVars)
        .map(([k, v]) => `set "${k}=${cmdEscape(v)}"`)
        .join(' && ');
      // Quote the binary path if it contains spaces (e.g., "C:\Program Files\...")
      const quotedWinBin = claudeBin.includes(' ') ? `"${cmdEscape(claudeBin)}"` : cmdEscape(claudeBin);
      const claudeCmd = `${quotedWinBin} ${claudeArgs.map(a => `"${cmdEscape(a)}"`).join(' ')}`;
      const innerCmd = setCmds
        ? `${setCmds} && ${claudeCmd}`
        : claudeCmd;

      // Use `cmd.exe /c start "" wt.exe ...` to resolve the UWP app alias
      // When our profile exists, use --profile to get the tab icon
      const wtArgs = [
        '/c', 'start', '',
        'wt.exe', '-w', '0',
        'new-tab',
        ...(hasProfile ? ['--profile', WT_PROFILE_NAME] : []),
        '--title', tabTitle,
        '-d', workDir,
        'cmd', '/k', innerCmd,
      ];
      const child = spawn('cmd.exe', wtArgs, {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return { pid: child.pid };
    }

    // Fallback: open a new cmd.exe window
    const child = spawn('cmd.exe', ['/c', 'start', '""', claudeBin, ...claudeArgs], {
      cwd: workDir,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ...envVars },
    });
    child.unref();
    return { pid: child.pid };
  }

  // Linux
  const envExports = Object.entries(envVars)
    .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
    .join('; ');
  const fullCmd = `${envExports}; cd ${shellQuote(workDir)} && ${shellQuote(claudeBin)} ${claudeArgs.map(a => shellQuote(a)).join(' ')}`;

  const terminal = findLinuxTerminal();
  if (!terminal) {
    log('No terminal emulator found on Linux, falling back to headless spawn');
    const child = spawn('bash', ['-c', fullCmd], { detached: true, stdio: 'ignore' });
    child.unref();
    return { pid: child.pid };
  }

  let child;
  if (terminal === 'gnome-terminal') {
    child = spawn(terminal, ['--', 'bash', '-c', fullCmd], { detached: true, stdio: 'ignore' });
  } else {
    child = spawn(terminal, ['-e', 'bash', '-c', fullCmd], { detached: true, stdio: 'ignore' });
  }
  child.unref();
  return { pid: child.pid };
}

/**
 * #596 / ADR 0016 — invoke `claude --bg <args>` directly so Anthropic's
 * per-user Claude Code supervisor takes ownership of the new session
 * (visible in `claude agents` / `~/.claude/daemon/roster.json`).
 *
 * Unlike {@link spawnInTerminal}, no terminal window opens — the supervisor
 * owns the pty and the user views/peeks/attaches via Agent View. The session
 * still loads the agent-tempo MCP server (via `--dangerously-load-development-channels`)
 * and still registers itself as a tempo player on MCP boot, so
 * cue/report/recall flow normally via Temporal.
 *
 * **Arg ordering** (matters for Claude Code's arg parser): `--bg` first,
 * then `--session-id <uuid>` so the supervisor adopts the pre-assigned slot,
 * then user args.
 *
 * **Pre-requisite**: the operator must have accepted
 * `--dangerously-skip-permissions` interactively at least once in the
 * target cwd (the supervisor refuses bypass modes that were never
 * accepted). `bgPreflight()` (`src/utils/bg-preflight.ts`) probes for this
 * before the spawn activity calls into here.
 *
 * Returns the PID of the `claude --bg` invocation itself, which exits
 * quickly after handing the new session to the supervisor. The supervised
 * session lives independently in the supervisor's `~/.claude/jobs/<short>/`
 * directory; `claude stop <shortId>` is the supported termination verb.
 */
export function spawnClaudeBg(
  claudeArgs: string[],
  workDir: string,
  envVars: Record<string, string>,
  options: { claudeBin?: string; sessionId: string },
): { pid: number | undefined } {
  const claudeBin = resolveClaudePath(options?.claudeBin);
  const finalArgs = ['--bg', '--session-id', options.sessionId, ...claudeArgs];
  const child = spawn(claudeBin, finalArgs, {
    cwd: workDir,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...envVars },
    shell: process.platform === 'win32',
  });
  child.unref();
  log(`Spawned claude --bg (pid ${child.pid}, sessionId ${options.sessionId}) in ${workDir}`);
  return { pid: child.pid };
}

// --- Copilot bridge spawning ---

export interface CopilotBridgeOpts {
  name: string;
  ensemble: string;
  temporalAddress: string;
  temporalNamespace?: string;
  temporalApiKey?: string;
  temporalTlsCertPath?: string;
  temporalTlsKeyPath?: string;
  isConductor?: boolean;
  workDir: string;
  /** Directory for log and PID files. Defaults to `logs/` inside workDir. */
  logDir?: string;
  /** Copilot SDK session ID for resumable sessions. */
  sessionId?: string;
  /**
   * PR-D attachment-lease handoff. When present, the workflow has already
   * called `claimAttachment`; the bridge adapter reads these from env and
   * renews (rather than fresh-claims) the lease on boot. See design §8.2.
   */
  attachmentId?: string;
  attachmentRunId?: string;
  adapterId?: string;
}

export interface CopilotBridgeResult {
  pid: number | undefined;
  logPath: string;
  pidPath: string;
}

/**
 * Resolve the path to the compiled copilot bridge adapter entry point.
 * In dev (ts-node), returns a ts-node command; in production, returns the dist path.
 *
 * PR-B (v0.25 rebuild step 2/7): the bridge moved from `src/copilot-bridge.ts`
 * to `src/adapters/copilot/adapter.ts`. Behavior unchanged.
 */
function resolveBridgePath(): { cmd: string; args: string[] } {
  const isDev = __filename.endsWith('.ts');
  if (isDev) {
    return { cmd: 'npx', args: ['ts-node', resolve(__dirname, 'adapters', 'copilot', 'adapter.ts')] };
  }
  return { cmd: 'node', args: [resolve(__dirname, 'adapters', 'copilot', 'adapter.js')] };
}

/**
 * Spawn a copilot bridge as a detached headless subprocess.
 * Sets up log file, PID file, and all required env vars.
 */
export function spawnCopilotBridge(opts: CopilotBridgeOpts): CopilotBridgeResult {
  const { cmd, args } = resolveBridgePath();
  const logDirPath = opts.logDir || join(opts.workDir, 'logs');
  const logName = opts.name || `copilot-${Date.now()}`;
  const logPath = join(logDirPath, `${logName}.log`);
  const pidPath = join(logDirPath, `${logName}.pid`);

  mkdirSync(logDirPath, { recursive: true });
  const logFd = openSync(logPath, 'a');

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(cmd, args, {
      cwd: opts.workDir,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        [ENV.ENSEMBLE]: opts.ensemble,
        [ENV.BRIDGE_NAME]: opts.name,
        [ENV.PLAYER_NAME]: '', // Clear parent's player name so child uses BRIDGE_NAME
        [ENV.BRIDGE_MODE]: '', // Clear parent's bridge mode
        [ENV.TEMPORAL_ADDRESS]: opts.temporalAddress,
        [ENV.CONDUCTOR]: opts.isConductor ? 'true' : '',
        // Forward Temporal connection settings so child processes can connect
        ...(opts.temporalNamespace ? { [ENV.TEMPORAL_NAMESPACE]: opts.temporalNamespace } : {}),
        ...(opts.temporalApiKey ? { [ENV.TEMPORAL_API_KEY]: opts.temporalApiKey } : {}),
        ...(opts.temporalTlsCertPath ? { [ENV.TEMPORAL_TLS_CERT_PATH]: opts.temporalTlsCertPath } : {}),
        ...(opts.temporalTlsKeyPath ? { [ENV.TEMPORAL_TLS_KEY_PATH]: opts.temporalTlsKeyPath } : {}),
        ...(opts.sessionId ? { [ENV.BRIDGE_SESSION_ID]: opts.sessionId } : {}),
        // PR-D attachment handoff — renew rather than fresh-claim in startV2Lifecycle.
        ...(opts.attachmentId ? { [ENV.ATTACHMENT_ID]: opts.attachmentId } : {}),
        ...(opts.attachmentRunId ? { [ENV.ATTACHMENT_RUN_ID]: opts.attachmentRunId } : {}),
        ...(opts.adapterId ? { [ENV.ADAPTER_ID]: opts.adapterId } : {}),
      },
    });
    child.unref();
  } finally {
    closeSync(logFd);
  }

  if (child.pid != null) {
    writeFileSync(pidPath, String(child.pid));
  }

  log(`Spawned copilot-bridge (pid ${child.pid}) in ${opts.workDir} as "${opts.name}"`);
  return { pid: child.pid, logPath, pidPath };
}

// ── Mock adapter (ADR 0014 PR-2) ──────────────────────────────────────────

/**
 * Options for {@link spawnMockAdapter}. Mirrors {@link CopilotBridgeOpts} for
 * the cross-machine fields (host queue, attachment handoff) and adds the two
 * mock-specific env knobs (`mockMode`, `mockScenario`).
 *
 * The mock adapter has no notion of a Claude session ID, no auth token, and
 * no MCP server child — it talks to Temporal directly and posts every action
 * through the outbox like any other adapter would. So the option surface is
 * deliberately narrow.
 */
export interface MockAdapterOpts {
  name: string;
  ensemble: string;
  temporalAddress: string;
  temporalNamespace?: string;
  temporalApiKey?: string;
  temporalTlsCertPath?: string;
  temporalTlsKeyPath?: string;
  isConductor?: boolean;
  workDir: string;
  /** Directory for log + PID files. Defaults to `logs/` inside workDir. */
  logDir?: string;
  /** Mock mode (defaults to `echo` when omitted). */
  mockMode?: MockMode;
  /** Scenario reference — bare name, absolute path, or relative path. Required for `scripted` mode. */
  mockScenario?: string;
  /**
   * PR-D attachment-lease handoff. When present, the workflow has already
   * called `claimAttachment`; the mock adapter reads these from env and
   * renews (rather than fresh-claims) the lease on boot.
   */
  attachmentId?: string;
  attachmentRunId?: string;
  adapterId?: string;
}

export interface MockAdapterResult {
  pid: number | undefined;
  logPath: string;
  pidPath: string;
}

/**
 * Resolve the path to the mock adapter entry point. Mirrors
 * {@link resolveBridgePath} so dev (ts-node) and prod (compiled .js) both
 * launch the same code through the same `require.main === module` gate.
 */
function resolveMockAdapterPath(): { cmd: string; args: string[] } {
  const isDev = __filename.endsWith('.ts');
  if (isDev) {
    return { cmd: 'npx', args: ['ts-node', resolve(__dirname, 'adapters', 'mock', 'adapter.ts')] };
  }
  return { cmd: 'node', args: [resolve(__dirname, 'adapters', 'mock', 'adapter.js')] };
}

/**
 * Spawn a mock adapter subprocess. Headless — no terminal window, no
 * "trust this folder" prompt — which is the whole point of the mock for
 * autonomous validation harnesses (ADR 0014 §4.7).
 */
export function spawnMockAdapter(opts: MockAdapterOpts): MockAdapterResult {
  const { cmd, args } = resolveMockAdapterPath();
  const logDirPath = opts.logDir || join(opts.workDir, 'logs');
  const logName = opts.name || `mock-${Date.now()}`;
  const logPath = join(logDirPath, `${logName}.log`);
  const pidPath = join(logDirPath, `${logName}.pid`);

  mkdirSync(logDirPath, { recursive: true });
  const logFd = openSync(logPath, 'a');

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(cmd, args, {
      cwd: opts.workDir,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        [ENV.ENSEMBLE]: opts.ensemble,
        [ENV.PLAYER_NAME]: opts.name,
        [ENV.CONDUCTOR]: opts.isConductor ? 'true' : '',
        [ENV.TEMPORAL_ADDRESS]: opts.temporalAddress,
        // Forward Temporal connection settings so the subprocess can connect.
        ...(opts.temporalNamespace ? { [ENV.TEMPORAL_NAMESPACE]: opts.temporalNamespace } : {}),
        ...(opts.temporalApiKey ? { [ENV.TEMPORAL_API_KEY]: opts.temporalApiKey } : {}),
        ...(opts.temporalTlsCertPath ? { [ENV.TEMPORAL_TLS_CERT_PATH]: opts.temporalTlsCertPath } : {}),
        ...(opts.temporalTlsKeyPath ? { [ENV.TEMPORAL_TLS_KEY_PATH]: opts.temporalTlsKeyPath } : {}),
        // Mock-specific knobs.
        AGENT_TEMPO_MOCK_MODE: opts.mockMode ?? 'echo',
        ...(opts.mockScenario ? { AGENT_TEMPO_MOCK_SCENARIO: opts.mockScenario } : {}),
        // Attachment handoff — adapter renews via startV2Lifecycle.
        ...(opts.attachmentId ? { [ENV.ATTACHMENT_ID]: opts.attachmentId } : {}),
        ...(opts.attachmentRunId ? { [ENV.ATTACHMENT_RUN_ID]: opts.attachmentRunId } : {}),
        ...(opts.adapterId ? { [ENV.ADAPTER_ID]: opts.adapterId } : {}),
      },
    });
    child.unref();
  } finally {
    closeSync(logFd);
  }

  if (child.pid != null) {
    writeFileSync(pidPath, String(child.pid));
  }

  log(`Spawned mock adapter (pid ${child.pid}) in ${opts.workDir} as "${opts.name}" (mode=${opts.mockMode ?? 'echo'})`);
  return { pid: child.pid, logPath, pidPath };
}

// ── claude-api adapter (#131 Phase C) ──────────────────────────────────────

/**
 * Options for {@link spawnClaudeApiAdapter}. Mirrors {@link CopilotBridgeOpts}
 * for the cross-machine fields (host queue, attachment handoff) and adds the
 * `model` knob (resolved from recruit-arg → env → constants-pinned default
 * upstream; the spawn helper just forwards whatever is set).
 *
 * The claude-api adapter is headless — no terminal, no Claude binary, no
 * MCP-server child process. It runs an in-process MCP server paired with a
 * client via `InMemoryTransport` and talks to Anthropic via the optional
 * `@anthropic-ai/sdk`. So the option surface is narrow: identity, Temporal
 * connection settings, attachment handoff, and the optional model id.
 */
export interface ClaudeApiAdapterOpts {
  name: string;
  ensemble: string;
  temporalAddress: string;
  temporalNamespace?: string;
  temporalApiKey?: string;
  temporalTlsCertPath?: string;
  temporalTlsKeyPath?: string;
  isConductor?: boolean;
  workDir: string;
  /** Directory for log + PID files. Defaults to `logs/` inside workDir. */
  logDir?: string;
  /** Model id (e.g. `claude-opus-4-7`). Forwarded via `AGENT_TEMPO_API_MODEL`. */
  model?: string;
  /**
   * PR-D attachment-lease handoff. When present, the workflow has already
   * called `claimAttachment`; the adapter reads these from env and renews
   * (rather than fresh-claims) the lease on boot.
   */
  attachmentId?: string;
  attachmentRunId?: string;
  adapterId?: string;
}

export interface ClaudeApiAdapterResult {
  pid: number | undefined;
  logPath: string;
  pidPath: string;
}

/**
 * Resolve the path to the claude-api adapter entry point. Mirrors
 * {@link resolveBridgePath} so dev (ts-node) and prod (compiled .js) both
 * launch the same code through the same `require.main === module` gate.
 */
function resolveClaudeApiPath(): { cmd: string; args: string[] } {
  const isDev = __filename.endsWith('.ts');
  if (isDev) {
    return { cmd: 'npx', args: ['ts-node', resolve(__dirname, 'adapters', 'claude-api', 'adapter.ts')] };
  }
  return { cmd: 'node', args: [resolve(__dirname, 'adapters', 'claude-api', 'adapter.js')] };
}

/**
 * Spawn the claude-api adapter as a detached headless subprocess.
 *
 * Mirrors {@link spawnCopilotBridge} — no TTY, log + PID files in
 * `logs/<name>.log` and `logs/<name>.pid`, env vars carry identity +
 * Temporal connection settings + optional attachment-handoff. The adapter
 * resolves the LLM model from `AGENT_TEMPO_API_MODEL` (set here when
 * `opts.model` is provided) or falls back to the constants-pinned default
 * (`claude-opus-4-7`) inside the adapter's `run()`. `ANTHROPIC_API_KEY`
 * is inherited from the parent's env (recruit pre-flight checks it).
 */
export function spawnClaudeApiAdapter(opts: ClaudeApiAdapterOpts): ClaudeApiAdapterResult {
  const { cmd, args } = resolveClaudeApiPath();
  const logDirPath = opts.logDir || join(opts.workDir, 'logs');
  const logName = opts.name || `claude-api-${Date.now()}`;
  const logPath = join(logDirPath, `${logName}.log`);
  const pidPath = join(logDirPath, `${logName}.pid`);

  mkdirSync(logDirPath, { recursive: true });
  const logFd = openSync(logPath, 'a');

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(cmd, args, {
      cwd: opts.workDir,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        [ENV.ENSEMBLE]: opts.ensemble,
        [ENV.PLAYER_NAME]: opts.name,
        [ENV.CONDUCTOR]: opts.isConductor ? 'true' : '',
        [ENV.TEMPORAL_ADDRESS]: opts.temporalAddress,
        // Forward Temporal connection settings so the subprocess can connect.
        ...(opts.temporalNamespace ? { [ENV.TEMPORAL_NAMESPACE]: opts.temporalNamespace } : {}),
        ...(opts.temporalApiKey ? { [ENV.TEMPORAL_API_KEY]: opts.temporalApiKey } : {}),
        ...(opts.temporalTlsCertPath ? { [ENV.TEMPORAL_TLS_CERT_PATH]: opts.temporalTlsCertPath } : {}),
        ...(opts.temporalTlsKeyPath ? { [ENV.TEMPORAL_TLS_KEY_PATH]: opts.temporalTlsKeyPath } : {}),
        // Model selection: recruit-arg → AGENT_TEMPO_API_MODEL → in-adapter default.
        ...(opts.model ? { [ENV.API_MODEL]: opts.model } : {}),
        // Attachment handoff — adapter renews via startV2Lifecycle.
        ...(opts.attachmentId ? { [ENV.ATTACHMENT_ID]: opts.attachmentId } : {}),
        ...(opts.attachmentRunId ? { [ENV.ATTACHMENT_RUN_ID]: opts.attachmentRunId } : {}),
        ...(opts.adapterId ? { [ENV.ADAPTER_ID]: opts.adapterId } : {}),
      },
    });
    child.unref();
  } finally {
    closeSync(logFd);
  }

  if (child.pid != null) {
    writeFileSync(pidPath, String(child.pid));
  }

  log(`Spawned claude-api adapter (pid ${child.pid}) in ${opts.workDir} as "${opts.name}"${opts.model ? ` (model=${opts.model})` : ''}${opts.attachmentId ? ` (attachmentId=${opts.attachmentId})` : ''}`);
  return { pid: child.pid, logPath, pidPath };
}

// ── opencode adapter (#449 Phase C) ────────────────────────────────────────

/**
 * Options for {@link spawnOpenCodeAdapter}. Mirrors {@link ClaudeApiAdapterOpts}
 * with one shape difference: the model id carries a `provider/...` prefix
 * (`anthropic/claude-opus-4-7`, `openai/gpt-4o`, …) and is forwarded via
 * `AGENT_TEMPO_OPENCODE_MODEL` so it doesn't collide with claude-api's
 * `AGENT_TEMPO_API_MODEL` namespace.
 *
 * The adapter manages its own `opencode serve` subprocess internally — the
 * spawn helper here only launches the headless adapter Node process; the
 * adapter then probes a free port and spawns opencode itself.
 */
export interface OpenCodeAdapterOpts {
  name: string;
  ensemble: string;
  temporalAddress: string;
  temporalNamespace?: string;
  temporalApiKey?: string;
  temporalTlsCertPath?: string;
  temporalTlsKeyPath?: string;
  isConductor?: boolean;
  workDir: string;
  /** Directory for log + PID files. Defaults to `logs/` inside workDir. */
  logDir?: string;
  /** Model id (e.g. `anthropic/claude-opus-4-7`). Forwarded via `AGENT_TEMPO_OPENCODE_MODEL`. */
  model?: string;
  /**
   * PR-D attachment-lease handoff. When present, the workflow has already
   * called `claimAttachment`; the adapter reads these from env and renews
   * (rather than fresh-claims) the lease on boot.
   */
  attachmentId?: string;
  attachmentRunId?: string;
  adapterId?: string;
}

export interface OpenCodeAdapterResult {
  pid: number | undefined;
  logPath: string;
  pidPath: string;
}

/**
 * Resolve the path to the opencode adapter entry point. Mirrors
 * {@link resolveClaudeApiPath} so dev (ts-node) and prod (compiled .js)
 * both launch the same code through the same `require.main === module` gate.
 */
function resolveOpenCodePath(): { cmd: string; args: string[] } {
  const isDev = __filename.endsWith('.ts');
  if (isDev) {
    return { cmd: 'npx', args: ['ts-node', resolve(__dirname, 'adapters', 'opencode', 'adapter.ts')] };
  }
  return { cmd: 'node', args: [resolve(__dirname, 'adapters', 'opencode', 'adapter.js')] };
}

/**
 * Spawn the opencode adapter as a detached headless subprocess.
 *
 * Pattern matches {@link spawnClaudeApiAdapter} — no TTY, log + PID files
 * in `logs/<name>.log` and `logs/<name>.pid`, env vars carry identity +
 * Temporal connection settings + optional attachment-handoff. Provider
 * env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) are inherited
 * from the parent's env unchanged — OpenCode reads whichever ones the
 * `model`'s prefix maps to (recruit pre-flight does NOT validate any
 * specific provider key since the model is opaque pass-through).
 */
export function spawnOpenCodeAdapter(opts: OpenCodeAdapterOpts): OpenCodeAdapterResult {
  const { cmd, args } = resolveOpenCodePath();
  const logDirPath = opts.logDir || join(opts.workDir, 'logs');
  const logName = opts.name || `opencode-${Date.now()}`;
  const logPath = join(logDirPath, `${logName}.log`);
  const pidPath = join(logDirPath, `${logName}.pid`);

  mkdirSync(logDirPath, { recursive: true });
  const logFd = openSync(logPath, 'a');

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(cmd, args, {
      cwd: opts.workDir,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        [ENV.ENSEMBLE]: opts.ensemble,
        [ENV.PLAYER_NAME]: opts.name,
        [ENV.CONDUCTOR]: opts.isConductor ? 'true' : '',
        [ENV.TEMPORAL_ADDRESS]: opts.temporalAddress,
        ...(opts.temporalNamespace ? { [ENV.TEMPORAL_NAMESPACE]: opts.temporalNamespace } : {}),
        ...(opts.temporalApiKey ? { [ENV.TEMPORAL_API_KEY]: opts.temporalApiKey } : {}),
        ...(opts.temporalTlsCertPath ? { [ENV.TEMPORAL_TLS_CERT_PATH]: opts.temporalTlsCertPath } : {}),
        ...(opts.temporalTlsKeyPath ? { [ENV.TEMPORAL_TLS_KEY_PATH]: opts.temporalTlsKeyPath } : {}),
        // Model selection: recruit-arg → AGENT_TEMPO_OPENCODE_MODEL → in-adapter default.
        ...(opts.model ? { [ENV.OPENCODE_MODEL]: opts.model } : {}),
        // Attachment handoff — adapter renews via startV2Lifecycle.
        ...(opts.attachmentId ? { [ENV.ATTACHMENT_ID]: opts.attachmentId } : {}),
        ...(opts.attachmentRunId ? { [ENV.ATTACHMENT_RUN_ID]: opts.attachmentRunId } : {}),
        ...(opts.adapterId ? { [ENV.ADAPTER_ID]: opts.adapterId } : {}),
      },
    });
    child.unref();
  } finally {
    closeSync(logFd);
  }

  if (child.pid != null) {
    writeFileSync(pidPath, String(child.pid));
  }

  log(`Spawned opencode adapter (pid ${child.pid}) in ${opts.workDir} as "${opts.name}"${opts.model ? ` (model=${opts.model})` : ''}${opts.attachmentId ? ` (attachmentId=${opts.attachmentId})` : ''}`);
  return { pid: child.pid, logPath, pidPath };
}

// ── claude-code-headless adapter (#520) ────────────────────────────────────

/**
 * Options for {@link spawnClaudeCodeHeadlessAdapter}. Mirrors
 * {@link ClaudeApiAdapterOpts} for identity + Temporal connection +
 * attachment handoff; adds `permissionMode` / `dangerouslySkipPermissions`
 * for the per-turn `claude -p --permission-mode <mode>` flag.
 *
 * The adapter spawns the host's `claude` CLI as a per-turn subprocess; this
 * spawn helper only launches the headless adapter Node process.
 */
export interface ClaudeCodeHeadlessAdapterOpts {
  name: string;
  ensemble: string;
  temporalAddress: string;
  temporalNamespace?: string;
  temporalApiKey?: string;
  temporalTlsCertPath?: string;
  temporalTlsKeyPath?: string;
  isConductor?: boolean;
  workDir: string;
  /** Directory for log + PID files. Defaults to `logs/` inside workDir. */
  logDir?: string;
  /**
   * `--permission-mode` flag value forwarded to per-turn `claude -p`. Default
   * `'acceptEdits'` (set inside the adapter on construction). Mutually
   * exclusive with `dangerouslySkipPermissions`.
   */
  permissionMode?: ClaudeCodeHeadlessPermissionMode;
  /** Pass `--dangerously-skip-permissions` to per-turn `claude -p`. Mutually exclusive with `permissionMode`. */
  dangerouslySkipPermissions?: boolean;
  /**
   * PR-D attachment-lease handoff. When present, the workflow has already
   * called `claimAttachment`; the adapter reads these from env and renews
   * (rather than fresh-claims) the lease on boot.
   */
  attachmentId?: string;
  attachmentRunId?: string;
  adapterId?: string;
}

export interface ClaudeCodeHeadlessAdapterResult {
  pid: number | undefined;
  logPath: string;
  pidPath: string;
}

/**
 * Resolve the path to the claude-code-headless adapter entry point.
 * Mirrors {@link resolveClaudeApiPath} so dev (ts-node) and prod
 * (compiled .js) both launch the same code through the same
 * `require.main === module` gate.
 */
function resolveClaudeCodeHeadlessPath(): { cmd: string; args: string[] } {
  const isDev = __filename.endsWith('.ts');
  if (isDev) {
    return { cmd: 'npx', args: ['ts-node', resolve(__dirname, 'adapters', 'claude-code-headless', 'adapter.ts')] };
  }
  return { cmd: 'node', args: [resolve(__dirname, 'adapters', 'claude-code-headless', 'adapter.js')] };
}

/**
 * Spawn the claude-code-headless adapter as a detached headless subprocess.
 *
 * Pattern matches {@link spawnClaudeApiAdapter} — no TTY, log + PID files
 * in `logs/<name>.log` and `logs/<name>.pid`, env vars carry identity +
 * Temporal connection settings + optional attachment-handoff.
 *
 * **Env hygiene** (design §3.6): the per-turn `claude -p` child needs to
 * use the host's OAuth keychain — NOT a `ANTHROPIC_API_KEY` env var.
 * The adapter strips `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN`
 * from its child env at spawn time (in `adapter.ts`'s `invokeSdk`); this
 * spawn helper passes the parent's full env through to the adapter
 * itself (which needs other env vars like PATH).
 */
export function spawnClaudeCodeHeadlessAdapter(
  opts: ClaudeCodeHeadlessAdapterOpts,
): ClaudeCodeHeadlessAdapterResult {
  const { cmd, args } = resolveClaudeCodeHeadlessPath();
  const logDirPath = opts.logDir || join(opts.workDir, 'logs');
  const logName = opts.name || `claude-code-headless-${Date.now()}`;
  const logPath = join(logDirPath, `${logName}.log`);
  const pidPath = join(logDirPath, `${logName}.pid`);

  mkdirSync(logDirPath, { recursive: true });
  const logFd = openSync(logPath, 'a');

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(cmd, args, {
      cwd: opts.workDir,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        [ENV.ENSEMBLE]: opts.ensemble,
        [ENV.PLAYER_NAME]: opts.name,
        [ENV.CONDUCTOR]: opts.isConductor ? 'true' : '',
        [ENV.TEMPORAL_ADDRESS]: opts.temporalAddress,
        ...(opts.temporalNamespace ? { [ENV.TEMPORAL_NAMESPACE]: opts.temporalNamespace } : {}),
        ...(opts.temporalApiKey ? { [ENV.TEMPORAL_API_KEY]: opts.temporalApiKey } : {}),
        ...(opts.temporalTlsCertPath ? { [ENV.TEMPORAL_TLS_CERT_PATH]: opts.temporalTlsCertPath } : {}),
        ...(opts.temporalTlsKeyPath ? { [ENV.TEMPORAL_TLS_KEY_PATH]: opts.temporalTlsKeyPath } : {}),
        // Permission mode: recruit-arg → AGENT_TEMPO_PERMISSION_MODE → in-adapter default.
        ...(opts.permissionMode ? { [ENV.PERMISSION_MODE]: opts.permissionMode } : {}),
        ...(opts.dangerouslySkipPermissions ? { [ENV.DANGEROUSLY_SKIP_PERMISSIONS]: '1' } : {}),
        // Attachment handoff — adapter renews via startV2Lifecycle.
        ...(opts.attachmentId ? { [ENV.ATTACHMENT_ID]: opts.attachmentId } : {}),
        ...(opts.attachmentRunId ? { [ENV.ATTACHMENT_RUN_ID]: opts.attachmentRunId } : {}),
        ...(opts.adapterId ? { [ENV.ADAPTER_ID]: opts.adapterId } : {}),
      },
    });
    child.unref();
  } finally {
    closeSync(logFd);
  }

  if (child.pid != null) {
    writeFileSync(pidPath, String(child.pid));
  }

  log(
    `Spawned claude-code-headless adapter (pid ${child.pid}) in ${opts.workDir} ` +
    `as "${opts.name}"${opts.permissionMode ? ` (permissionMode=${opts.permissionMode})` : ''}` +
    `${opts.dangerouslySkipPermissions ? ' (dangerouslySkipPermissions=true)' : ''}` +
    `${opts.attachmentId ? ` (attachmentId=${opts.attachmentId})` : ''}`,
  );
  return { pid: child.pid, logPath, pidPath };
}
