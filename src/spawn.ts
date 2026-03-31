import { spawn, execFileSync } from 'child_process';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

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
    // Use 'start' to open a visible terminal window, and pass the full
    // command as a single string to avoid DEP0190 deprecation warning
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
