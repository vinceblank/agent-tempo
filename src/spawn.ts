import { spawn, execFileSync, execSync } from 'child_process';
import { existsSync, mkdirSync, openSync, closeSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { ENV } from './config';

const log = (...args: unknown[]) => console.error('[claude-tempo:spawn]', ...args);

/** POSIX shell-safe single-quoting (works in bash, zsh, and fish) */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Resolve the absolute path to the `claude` binary */
export function resolveClaudePath(): string {
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
  const args = claudeArgs.map(a => shellQuote(a)).join(' ');
  return envInline ? `${envInline} ${claudeBin} ${args}` : `${claudeBin} ${args}`;
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
): { pid: number | undefined } {
  const claudeBin = resolveClaudePath();
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
      profileSource,
      envExports,
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

      // Build inline env var assignments for cmd /c since wt.exe spawns
      // a new process that won't inherit our env.
      // Escape values for cmd.exe: wrap in quotes and escape inner special chars.
      const cmdEscape = (s: string) => s.replace(/([&|<>^"%])/g, '^$1');
      const setCmds = Object.entries(envVars)
        .map(([k, v]) => `set "${k}=${cmdEscape(v)}"`)
        .join(' && ');
      const claudeCmd = `${cmdEscape(claudeBin)} ${claudeArgs.map(a => `"${cmdEscape(a)}"`).join(' ')}`;
      const innerCmd = setCmds
        ? `${setCmds} && ${claudeCmd}`
        : claudeCmd;

      // Use `cmd.exe /c start "" wt.exe ...` to resolve the UWP app alias
      const child = spawn('cmd.exe', [
        '/c', 'start', '',
        'wt.exe', '-w', '0',
        'new-tab',
        '--title', tabTitle,
        '-d', workDir,
        'cmd', '/k', innerCmd,
      ], {
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
