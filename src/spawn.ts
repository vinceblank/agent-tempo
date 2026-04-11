import { spawn, execFileSync, execSync } from 'child_process';
import { existsSync, mkdirSync, openSync, closeSync, writeFileSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { ENV } from './config';

const log = (...args: unknown[]) => console.error('[claude-tempo:spawn]', ...args);

/** Stable GUID for the claude-tempo Windows Terminal profile. */
const WT_PROFILE_GUID = '{c1a0d300-0e30-4000-a000-c1a0de00e300}';
const WT_PROFILE_NAME = 'claude-tempo';

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
 * Ensure a "claude-tempo" profile exists in Windows Terminal settings.json
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
      // Update icon path if it changed (e.g. package moved)
      if (existing.icon !== iconPath) {
        existing.icon = iconPath;
        writeFileSync(settingsPath, JSON.stringify(settings, null, 4) + '\n');
        log('Updated claude-tempo profile icon in Windows Terminal');
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
    });

    // Write back with original formatting style (4-space indent to match WT default)
    writeFileSync(settingsPath, JSON.stringify(settings, null, 4) + '\n');
    log('Created claude-tempo profile in Windows Terminal with icon:', iconPath);
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
 *  2. `CLAUDE_TEMPO_CLAUDE_BIN` env var (checked directly for spawned processes that
 *     may not have full config resolution, e.g., activities)
 *  3. `which claude` / `where claude` lookup
 *  4. Bare `claude` fallback
 */
export function resolveClaudePath(configBin?: string): string {
  // Priority 1: explicit config value
  if (configBin) return configBin;

  // Priority 2: env var (may be set by parent process)
  const envBin = process.env.CLAUDE_TEMPO_CLAUDE_BIN;
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
      const osaScript = `
        tell application "Ghostty"
          set cfg to new surface configuration
          set initial working directory of cfg to ${JSON.stringify(workDir)}
          set initial input of cfg to ${JSON.stringify(claudeInvocation + '\n')}
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
      const osaScript = `
        tell application "iTerm2"
          set newWindow to (create window with default profile)
          tell current session of newWindow
            write text "cd ${shellQuote(workDir)} && ${claudeInvocation}"
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
    const scriptPath = join(tmpdir(), `claude-tempo-recruit-${Date.now()}.command`);
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
      `${shellQuote(claudeBin)} ${claudeArgs.map(a => shellQuote(a)).join(' ')}`,
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
        : 'claude-tempo';

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
}

export interface CopilotBridgeResult {
  pid: number | undefined;
  logPath: string;
  pidPath: string;
}

/**
 * Resolve the path to the compiled copilot-bridge.js.
 * In dev (ts-node), returns a ts-node command; in production, returns the dist path.
 */
function resolveBridgePath(): { cmd: string; args: string[] } {
  const isDev = __filename.endsWith('.ts');
  if (isDev) {
    return { cmd: 'npx', args: ['ts-node', resolve(__dirname, 'copilot-bridge.ts')] };
  }
  return { cmd: 'node', args: [resolve(__dirname, 'copilot-bridge.js')] };
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
