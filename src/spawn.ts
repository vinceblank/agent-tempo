import { spawn, execFileSync, execSync } from 'child_process';
import { existsSync, mkdirSync, openSync, closeSync, writeSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { ENV, bridgeLogPaths } from './config';
import { isSecretKey } from './utils/secrets';
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

// ── #689 no-echo spawn: keep secret env values OUT of the echoed command ──────
//
// Terminal launches (claude conductor/recruit via spawnInTerminal, pi conductor
// via buildPiConductorSpawn) INLINE env into the command string that gets typed/
// echoed into the terminal — so `TEMPORAL_API_KEY='<JWT>' … pi …` lands in
// scrollback + shell history. Fix: partition env by name; SECRET values are
// written to a 0600 file in a 0700 owner-only dir and `source`d (then the
// launcher self-`rm`s it) so the value never appears on the command line. Plain
// (non-secret) env keeps the existing inline form. Headless adapters
// (copilot/claude-api/opencode/*-headless) pass env via child_process `env:{}`
// inheritance — no terminal, no inline — so they're unaffected.

/** Owner-only (0700) dir holding short-lived 0600 secret env files. */
const SECRET_ENV_DIR = join(tmpdir(), 'agent-tempo-spawn');

/** Escape a value for `cmd.exe` (wrap-in-quotes callers add the quotes). */
function cmdEscape(s: string): string {
  return s.replace(/([&|<>^"%])/g, '^$1');
}

/**
 * fish single-quote escaping. Inside fish `'...'` only `\` and `'` are special
 * (`\\` and `\'`) — POSIX `shellQuote`'s `'\''` trick is WRONG in fish, so the
 * secret file's `set -gx` lines need this. Plain inline env keeps `shellQuote`
 * (safe there: plain values are regex-validated names with no embedded quotes).
 */
export function fishQuote(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Split env into non-secret (inline-able) and secret (file-only) by key name. */
export function partitionEnv(env: Record<string, string>): {
  plainEnv: Record<string, string>;
  secretEnv: Record<string, string>;
} {
  const plainEnv: Record<string, string> = {};
  const secretEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (isSecretKey(k)) secretEnv[k] = v;
    else plainEnv[k] = v;
  }
  return { plainEnv, secretEnv };
}

export interface SecretEnvFile {
  /** Absolute path to the 0600 env file, or '' when there were no secrets. */
  path: string;
  /** Chain prefix that sources THEN deletes the file before the bin runs (or ''). */
  sourcePrefix: string;
  /** Standalone delete command for the file (or ''). */
  cleanup: string;
}

/**
 * Write secret env to a 0600 file in the 0700 {@link SECRET_ENV_DIR} and return a
 * `sourcePrefix` that sources + deletes it before exec. Empty `secretEnv` → no
 * file, empty strings (no behavior change when there are no secrets, e.g. local
 * dev with no Cloud key).
 *
 * Security: `openSync(path, 'wx', 0o600)` (O_EXCL → fails if the path exists,
 * defeating symlink pre-creation in a shared tmp), a `crypto.randomBytes` name
 * (NOT a predictable `Date.now()`), and the 0700 dir + 0600 file = owner-only
 * twice over. The LAUNCHER self-deletes (sourcePrefix `… && rm -f <f> && …`) — the
 * spawner does NOT, so there's no race: Node writes synchronously before the
 * terminal launches, only the shell reads the file, and after `rm` the value
 * lives only in the process env.
 */
export function writeSecretEnvFile(
  secretEnv: Record<string, string>,
  opts: { syntax: 'posix' | 'fish' | 'cmd' },
): SecretEnvFile {
  const keys = Object.keys(secretEnv);
  if (keys.length === 0) return { path: '', sourcePrefix: '', cleanup: '' };

  mkdirSync(SECRET_ENV_DIR, { recursive: true, mode: 0o700 });
  const ext = opts.syntax === 'cmd' ? 'cmd' : 'sh';
  const path = join(SECRET_ENV_DIR, `env-${randomBytes(9).toString('hex')}.${ext}`);

  let content: string;
  if (opts.syntax === 'fish') {
    content = keys.map((k) => `set -gx ${k} ${fishQuote(secretEnv[k])}`).join('\n') + '\n';
  } else if (opts.syntax === 'cmd') {
    content = keys.map((k) => `set "${k}=${cmdEscape(secretEnv[k])}"`).join('\r\n') + '\r\n';
  } else {
    content = keys.map((k) => `export ${k}=${shellQuote(secretEnv[k])}`).join('\n') + '\n';
  }

  // O_EXCL create with 0600 — fails (no follow) if a symlink/file pre-exists.
  const fd = openSync(path, 'wx', 0o600);
  try { writeSync(fd, content); } finally { closeSync(fd); }

  if (opts.syntax === 'cmd') {
    const q = `"${cmdEscape(path)}"`;
    return { path, sourcePrefix: `call ${q} && del ${q} && `, cleanup: `del ${q}` };
  }
  const q = shellQuote(path);
  return { path, sourcePrefix: `source ${q} && rm -f ${q} && `, cleanup: `rm -f ${q}` };
}

/**
 * Best-effort sweep of secret env files older than `maxAgeMs` (default 5 min) —
 * a backstop for the accepted residual when a shell dies between `source` and
 * `rm`. Owner-only files in our 0700 dir; swallow all errors. Call at `up` start.
 */
export function sweepStaleSecretEnvFiles(maxAgeMs = 5 * 60_000, now = Date.now()): void {
  try {
    for (const name of readdirSync(SECRET_ENV_DIR)) {
      if (!name.startsWith('env-')) continue;
      const p = join(SECRET_ENV_DIR, name);
      try {
        if (now - statSync(p).mtimeMs > maxAgeMs) rmSync(p, { force: true });
      } catch { /* per-file best-effort */ }
    }
  } catch { /* dir absent / unreadable — nothing to sweep */ }
}

/**
 * Build a shell command string that sets env vars and runs `bin` (#689).
 * Plain env keeps the inline `KEY=val` form (works in bash/zsh/fish); SECRET env
 * is routed to a sourced 0600 file via {@link writeSecretEnvFile}, so secret
 * VALUES never appear in the returned command string. `syntax` picks the secret
 * file's dialect (the inline plain form is identical across posix/fish).
 */
export function buildTerminalCommand(
  bin: string,
  binArgs: string[],
  envVars: Record<string, string>,
  syntax: 'posix' | 'fish' = 'posix',
): string {
  const { plainEnv, secretEnv } = partitionEnv(envVars);
  const { sourcePrefix } = writeSecretEnvFile(secretEnv, { syntax });
  const envInline = Object.entries(plainEnv)
    .map(([k, v]) => `${k}=${shellQuote(v)}`)
    .join(' ');
  // Quote the binary path if it contains spaces (e.g., "C:\Program Files\...")
  const quotedBin = bin.includes(' ') ? shellQuote(bin) : bin;
  const args = binArgs.map(a => shellQuote(a)).join(' ');
  const invocation = envInline ? `${envInline} ${quotedBin} ${args}` : `${quotedBin} ${args}`;
  return `${sourcePrefix}${invocation}`;
}

/**
 * Launch ANY binary in a visible terminal window (the cross-platform core
 * extracted from `spawnInTerminal`, #666 C1). Generic over `bin`/`args` so it
 * drives both Claude (via the {@link spawnInTerminal} wrapper) and the
 * interactive Pi conductor (`pi -e <ext>`).
 *
 * Strategy per terminal:
 *  - Ghostty: `initial input` into a normal window (preserves full shell env)
 *  - iTerm2: `write text` via AppleScript (same approach)
 *  - Terminal.app: .command script with shell profile sourcing
 *  - Windows: shell:true with env vars
 *  - Linux: terminal emulator with -e flag
 */
export function launchInTerminal(
  bin: string,
  args: string[],
  workDir: string,
  envVars: Record<string, string>,
): { pid: number | undefined } {
  // Internal aliases keep the platform body below byte-identical to the original
  // spawnInTerminal (behavior-preserving extraction, #666 C1 — minimal blast
  // radius; the existing terminal-spawn tests are the proof). The terminal logic
  // is bin/args-agnostic; the `claude*` names are historical.
  const claudeBin = bin;
  const claudeArgs = args;

  if (process.platform === 'darwin') {
    const detected = detectMacTerminal();
    log(`Terminal detection: TERM_PROGRAM=${JSON.stringify(process.env.TERM_PROGRAM)}, detected=${detected}`);
    // #689 — secret env routes through a sourced 0600 file (buildTerminalCommand /
    // the .command body); pick the file dialect from the user's shell since
    // Ghostty/iTerm2 type the command into it. Computed per-branch below so only
    // the branch that runs writes a secret file (no orphan).
    const macSyntax: 'posix' | 'fish' =
      (process.env.SHELL || '').endsWith('/fish') ? 'fish' : 'posix';

    if (detected === 'ghostty') {
      const claudeInvocation = buildTerminalCommand(claudeBin, claudeArgs, envVars, macSyntax);
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
      const claudeInvocation = buildTerminalCommand(claudeBin, claudeArgs, envVars, macSyntax);
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

    // Terminal.app: .command file with shell profile sourcing.
    const userShell = process.env.SHELL || '/bin/zsh';
    // #689 — the .command file is mode 0700 (was 0755 — it should never have been
    // world/group-readable). The secret env lives in a SEPARATE sourced 0600 file,
    // never inlined into this .command body.
    const scriptPath = join(SECRET_ENV_DIR, `recruit-${randomBytes(9).toString('hex')}.command`);
    mkdirSync(SECRET_ENV_DIR, { recursive: true, mode: 0o700 });

    let lines: string[];
    if (userShell.endsWith('/fish')) {
      // claudeInvocation (fish) already carries the plain inline env + the fish
      // secret-file source+rm — just exec fish with it.
      const claudeInvocation = buildTerminalCommand(claudeBin, claudeArgs, envVars, 'fish');
      lines = ['#!/bin/bash', `exec fish -c "cd ${shellQuote(workDir)} && ${claudeInvocation}"`];
    } else {
      const { plainEnv, secretEnv } = partitionEnv(envVars);
      const secretFile = writeSecretEnvFile(secretEnv, { syntax: 'posix' });
      const plainExports = Object.entries(plainEnv)
        .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
        .join('\n');
      const profileSource = [
        `[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc" 2>/dev/null`,
        `[ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc" 2>/dev/null`,
        `[ -f "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh" 2>/dev/null`,
        `command -v fnm >/dev/null && eval "$(fnm env)" 2>/dev/null`,
      ].join('\n');
      lines = [
        '#!/bin/bash',
        // Secret env from the sourced 0600 file (self-deleted), BEFORE profile
        // sourcing — same ordering rationale as the plain exports (#98).
        ...(secretFile.path ? [`source ${shellQuote(secretFile.path)} && rm -f ${shellQuote(secretFile.path)}`] : []),
        // Plain env vars BEFORE profile sourcing — profiles that call `exec` (e.g.
        // oh-my-zsh) would otherwise lose the exports and the claude command (#98)
        plainExports,
        profileSource,
        `cd ${shellQuote(workDir)}`,
        // `exec` so the shell is replaced by claude — when claude exits (clean or killed),
        // the script process ends and Terminal.app closes the window per its settings.
        // Without `exec`, bash waits for claude and then returns to prompt, leaving the
        // window open. Parity with the WT `closeOnExit: 'always'` fix from #166.
        `exec ${shellQuote(claudeBin)} ${claudeArgs.map(a => shellQuote(a)).join(' ')}`,
      ];
    }
    writeFileSync(scriptPath, lines.join('\n') + '\n', { mode: 0o700 });
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
      // a new process that won't inherit our env. (cmdEscape is module-level.)
      // #689 — SECRET env goes to a sourced 0600 .cmd file (call + del before the
      // bin runs) so JWTs never land in the wt.exe command / cmd history; PLAIN env
      // stays inline as `set "K=v"`.
      const { plainEnv, secretEnv } = partitionEnv(envVars);
      const secretFile = writeSecretEnvFile(secretEnv, { syntax: 'cmd' });
      const setCmds = Object.entries(plainEnv)
        .map(([k, v]) => `set "${k}=${cmdEscape(v)}"`)
        .join(' && ');
      // Quote the binary path if it contains spaces (e.g., "C:\Program Files\...")
      const quotedWinBin = claudeBin.includes(' ') ? `"${cmdEscape(claudeBin)}"` : cmdEscape(claudeBin);
      const claudeCmd = `${quotedWinBin} ${claudeArgs.map(a => `"${cmdEscape(a)}"`).join(' ')}`;
      const inlinePart = setCmds ? `${setCmds} && ${claudeCmd}` : claudeCmd;
      const innerCmd = `${secretFile.sourcePrefix}${inlinePart}`;

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

  // Linux — #689: SECRET env → sourced 0600 file (source+rm before the bin); PLAIN
  // env stays inline `export`. One fullCmd covers both the terminal `-e` path and
  // the headless `bash -c` fallback below (also closes the gnome-terminal-server
  // env-inheritance gap for free).
  const { plainEnv, secretEnv } = partitionEnv(envVars);
  const secretFile = writeSecretEnvFile(secretEnv, { syntax: 'posix' });
  const secretSource = secretFile.path
    ? `source ${shellQuote(secretFile.path)}; rm -f ${shellQuote(secretFile.path)}; `
    : '';
  const plainExports = Object.entries(plainEnv)
    .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
    .join('; ');
  const fullCmd = `${secretSource}${plainExports ? `${plainExports}; ` : ''}cd ${shellQuote(workDir)} && ${shellQuote(claudeBin)} ${claudeArgs.map(a => shellQuote(a)).join(' ')}`;

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
 * Spawn a Claude Code session in a visible terminal window — a thin, unchanged
 * wrapper over {@link launchInTerminal} (resolves the claude binary, forwards
 * the rest). Signature preserved for the existing callers (commands.ts conductor
 * + outbox.ts recruit-spawn) + the spawn-route regression tests (#666 C1).
 */
export function spawnInTerminal(
  claudeArgs: string[],
  workDir: string,
  envVars: Record<string, string>,
  options?: { claudeBin?: string },
): { pid: number | undefined } {
  return launchInTerminal(resolveClaudePath(options?.claudeBin), claudeArgs, workDir, envVars);
}

// --- Interactive Pi conductor (#666) ---

/** Is `bin` resolvable on PATH? (where/which, mirrors resolveClaudePath.) */
function binaryOnPath(bin: string): boolean {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    execFileSync(cmd, [bin], { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

/** Walk up from `__dirname` for the installed Pi package's CLI entry. */
function findPiPackageCli(exists: (p: string) => boolean): string | null {
  let dir = __dirname;
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
    if (exists(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Resolve the INTERACTIVE Pi CLI binary (#666) — the human-TTY `pi`, DISTINCT
 * from {@link resolvePiPath} (the headless adapter entry). Interactive TTY mode
 * is REQUIRED for a conductor: Pi only fires `session_start` / attaches in a real
 * terminal (non-TTY / `--print` → print-mode → tools register but NO attach).
 *
 * `pi` on PATH wins; else fall back to the installed package CLI via `node`.
 * THROWS fail-clean if neither resolves, so the caller never launches a terminal
 * that would immediately die. Collaborators injectable for unit tests.
 */
export function resolvePiInteractiveBinary(deps: {
  onPath?: (bin: string) => boolean;
  exists?: (p: string) => boolean;
} = {}): { cmd: string; args: string[] } {
  const onPath = deps.onPath ?? binaryOnPath;
  const exists = deps.exists ?? existsSync;
  if (onPath('pi')) return { cmd: 'pi', args: [] };
  const cli = findPiPackageCli(exists);
  if (cli) return { cmd: 'node', args: [cli] };
  throw new Error(
    'Pi CLI not found. Install it with `npm install -g pi-ai` and ensure `pi` is on PATH ' +
    '(or add the @earendil-works/pi-coding-agent package). The conductor needs the interactive Pi CLI.',
  );
}

// #825 — `resolvePiExtensionPath` removed: `up --agent pi` no longer passes an
// inline `pi -e <ext>` (it loads the player extension from settings.json, like
// command-center), so nothing resolves a single extension path anymore. The
// canonical extension-path resolver is now `piExtensionPaths()` in
// `src/pi/install.ts` (install-by-reference into settings.json).

/** Inputs for {@link buildPiConductorSpawn} (pure — unit-tested without spawning). */
export interface PiConductorSpawnOpts {
  ensemble: string;
  sessionName: string;
  /** Temporal env (address/namespace/api-key/tls) built by the caller. */
  temporalEnvVars: Record<string, string>;
  /** Temporal task queue — the Pi extension's PiWorkflowClient needs it (confirm #1). */
  taskQueue: string;
  devMode: boolean;
  /** Conductor agent-type name → AGENT_TEMPO_PLAYER_TYPE, when typed. */
  conductorTypeName?: string;
  /** Forwarded if set (warn-not-fail upstream when unset). */
  anthropicApiKey?: string;
  /** Injectable binary resolver (defaults to the real one, which fails-clean on miss). */
  resolveBinary?: () => { cmd: string; args: string[] };
}

/**
 * Build the interactive Pi conductor spawn spec — `{ cmd, args, env }` for
 * {@link launchInTerminal} (#666 C3). PURE + injectable so the env/args mapping is
 * unit-tested. The default binary resolver THROWS fail-clean (binary missing)
 * BEFORE a terminal is launched.
 *
 * #825 — NO inline `-e <ext>`. `up --agent pi` now relies on the player extension
 * being registered in Pi's `settings.json` (by `installPiExtensions`, guarded
 * before launch in the `up` pi branch) + the `resolvePiRole`→`'player'` gate
 * (`PLAYER_NAME` is set in the env below). This collapses the two Pi-launch paths
 * onto ONE registration source, so no divergent on-disk copy (e.g. dev `node
 * dist/cli.js`'s repo `dist/pi/extension.js` vs the global settings.json copy) can
 * escape Pi's realpath-dedup and double-load the player factory. Mirrors
 * {@link buildPiCommandCenterSpawn}. `args` = `[...binArgs]`; conductor
 * INSTRUCTIONS arrive via the lineup-baked workflow messages → cue pump (no
 * `--system-prompt` for the MVP).
 */
export function buildPiConductorSpawn(opts: PiConductorSpawnOpts): {
  cmd: string;
  args: string[];
  env: Record<string, string>;
} {
  const { cmd, args: binArgs } = (opts.resolveBinary ?? resolvePiInteractiveBinary)();
  // #825 — single registration source: no inline `-e` (see the doc-comment above).
  const args = [...binArgs];
  const env: Record<string, string> = {
    ...opts.temporalEnvVars,
    [ENV.TASK_QUEUE]: opts.taskQueue,
    [ENV.ENSEMBLE]: opts.ensemble,
    [ENV.CONDUCTOR]: 'true', // codebase-consistent; the Pi extension accepts '1'|'true'
    // #672 — the Pi conductor is launched detached by the transient `up` CLI:
    // skip the ppid-poll (no current pi process installs the watchdog, but this is
    // propagation-safe + principled if a pi subprocess ever does; stdin-EOF stays).
    [ENV.NO_PPID_WATCHDOG]: '1',
    [ENV.PLAYER_NAME]: opts.sessionName,
    ...(opts.devMode ? { [ENV.DEV_MODE]: '1' } : {}),
    ...(opts.anthropicApiKey ? { ANTHROPIC_API_KEY: opts.anthropicApiKey } : {}),
    ...(opts.conductorTypeName ? { [ENV.PLAYER_TYPE]: opts.conductorTypeName } : {}),
  };
  return { cmd, args, env };
}

/** Inputs for {@link buildPiCommandCenterSpawn} (pure — unit-tested without spawning). */
export interface PiCommandCenterSpawnOpts {
  ensemble: string;
  /** Temporal env (address/namespace/api-key/tls) built by the caller. */
  temporalEnvVars: Record<string, string>;
  /** Temporal task queue (forwarded for config parity; the board drives the daemon via HTTP). */
  taskQueue: string;
  devMode: boolean;
  /** Daemon admin (T3) token → `AGENT_TEMPO_HTTP_ADMIN_TOKEN` (mission-control's write/gate surface). */
  adminToken?: string;
  /** Forwarded if set (Pi's own model auth). */
  anthropicApiKey?: string;
  /** Injectable resolver (defaults to the real one, which fails clean on miss). */
  resolveBinary?: () => { cmd: string; args: string[] };
}

/**
 * Build the interactive Pi COMMAND-CENTER (mission-control) spawn spec —
 * `{ cmd, args, env }` for {@link launchInTerminal} (#729). PURE + injectable.
 *
 * Like {@link buildPiConductorSpawn} (post-#825), this passes NO `-e <ext>`:
 * install-pi registers BOTH Pi extensions in `~/.pi/agent/settings.json`, so a
 * plain `pi` auto-loads them and {@link resolvePiRole} (via the env below) picks
 * exactly one.
 *
 * #825 (comment correction): a SAME-path `-e` would NOT cause a re-registration
 * error — the #825 spike found Pi realpath-dedupes CLI `-e` paths against
 * `settings.json` (`mergePaths` → `canonicalizePath`/`realpathSync`), and even an
 * un-deduped duplicate is first-registration-wins at the tool layer (no throw,
 * Pi 0.79.x). The real reason both spawn specs OMIT `-e` is a SINGLE registration
 * source: it prevents a DIVERGENT on-disk copy (a different physical path that
 * escapes realpath-dedup) from double-loading the extension factory. The env
 * carries the OPERATOR subset only:
 *   - `AGENT_TEMPO_PI_ROLE=command-center` → the DETERMINISTIC role force (top of
 *     {@link resolvePiRole}'s precedence — beats an inherited `PLAYER_NAME`).
 *   - `AGENT_TEMPO_MISSION_CONTROL=1` → the role opt-in (kept for legacy parity /
 *     defense-in-depth; `PI_ROLE` already pins the role).
 *   - `AGENT_TEMPO_ENSEMBLE` → which ensemble the board observes.
 *   - `AGENT_TEMPO_HTTP_ADMIN_TOKEN` → the daemon write/gate surface the board POSTs to.
 *
 * ★ #820 — ROLE DETERMINISM (the destructive fix). The board MUST NEVER resolve to
 * `'player'`: when it did (an inherited `AGENT_TEMPO_PLAYER_NAME` from an ensemble
 * shell — e.g. a conductor terminal sets `PLAYER_NAME=tempo-conductor`), the player
 * extension activated and CLAIMED that player's attachment, HIJACKING the conductor
 * slot and then orphaning it on exit. "Not setting" `PLAYER_NAME`/`CONDUCTOR` is NOT
 * enough — the spawned terminal INHERITS them. So we both (a) force the role via
 * `PI_ROLE=command-center` (highest precedence) AND (b) explicitly CLEAR
 * `PLAYER_NAME`/`CONDUCTOR` to empty strings. {@link launchInTerminal} emits empty
 * values as `set "VAR="` (Windows WT — clears the inherited var), `VAR=''` inline
 * (POSIX), and via `{...process.env, ...envVars}` (Windows cmd fallback) — all make
 * {@link resolvePiRole}'s `if (env[PLAYER_NAME])` falsy. Belt-and-suspenders: even
 * if the clear ever fails to propagate, the `PI_ROLE` force still wins.
 */
export function buildPiCommandCenterSpawn(opts: PiCommandCenterSpawnOpts): {
  cmd: string;
  args: string[];
  env: Record<string, string>;
} {
  const { cmd, args } = (opts.resolveBinary ?? resolvePiInteractiveBinary)();
  const env: Record<string, string> = {
    ...opts.temporalEnvVars,
    [ENV.TASK_QUEUE]: opts.taskQueue,
    [ENV.ENSEMBLE]: opts.ensemble,
    [ENV.PI_ROLE]: 'command-center', // #820 — deterministic role force (top of resolvePiRole precedence)
    [ENV.MISSION_CONTROL]: '1', // #729 A2 role opt-in (defense-in-depth alongside PI_ROLE)
    // #820 — CLEAR (not omit) inherited identity vars. An ensemble shell (e.g. a
    // conductor terminal) exports these; the spawned terminal would inherit them and
    // resolvePiRole would flip to 'player', making the board CLAIM/HIJACK that slot.
    // Empty values emit `set "VAR="` (Windows) / `VAR=''` (POSIX) → falsy in the child.
    [ENV.PLAYER_NAME]: '',
    [ENV.CONDUCTOR]: '',
    [ENV.NO_PPID_WATCHDOG]: '1', // launched detached by the transient CLI (mirrors the conductor)
    ...(opts.devMode ? { [ENV.DEV_MODE]: '1' } : {}),
    ...(opts.adminToken ? { [ENV.HTTP_ADMIN_TOKEN]: opts.adminToken } : {}),
    ...(opts.anthropicApiKey ? { ANTHROPIC_API_KEY: opts.anthropicApiKey } : {}),
  };
  return { cmd, args, env };
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
  /**
   * #672 — set true by a TRANSIENT-CLI spawner that launches this bridge DETACHED
   * to outlive it: BOTH the `up` conductor (commands.ts) AND the `up --lineup`
   * copilot PLAYER loop (commands.ts applyLineupPlayersAndSchedules) — both spawn
   * the bridge directly (no terminal), so its ppid is the short-lived CLI. When
   * set, the bridge skips the ppid-poll that would self-kill it on the CLI's exit
   * (stdin-EOF stays). The DAEMON-recruit path (outbox.ts) OMITS it → the bridge
   * keeps the ppid-poll (#604 anti-leak on daemon death; ppid = persistent daemon).
   */
  transientSpawner?: boolean;
  /**
   * T1.1 PR-1 — per-player ingest token (AGENT_TEMPO_INGEST_TOKEN). Minted by
   * the outbox at spawn; authenticates the adapter's loopback daemon-HTTP
   * calls (doorbell subscribe; Pi also uses it for /inner/ingest). Absent →
   * the adapter never subscribes (pure T0.2 fallback-poll behavior).
   */
  ingestToken?: string;
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
  const logName = opts.name || `copilot-${Date.now()}`;
  // #690 — central ~/.agent-tempo/logs/<ensemble>/ (overrideDir = opts.logDir wins).
  const { dir: logDirPath, logPath, pidPath } = bridgeLogPaths(opts.ensemble, logName, opts.logDir);

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
        [ENV.PID_FILE]: pidPath, // #690 — adapter writes/unlinks THIS exact path (no re-derive → no split-brain)
        [ENV.BRIDGE_NAME]: opts.name,
        [ENV.PLAYER_NAME]: '', // Clear parent's player name so child uses BRIDGE_NAME
        [ENV.BRIDGE_MODE]: '', // Clear parent's bridge mode
        [ENV.TEMPORAL_ADDRESS]: opts.temporalAddress,
        [ENV.CONDUCTOR]: opts.isConductor ? 'true' : '',
        // #672 — transient-CLI spawner: the detached bridge skips the ppid-poll
        // (would self-kill on the short-lived `up` exit). Daemon recruit omits it.
        ...(opts.transientSpawner ? { [ENV.NO_PPID_WATCHDOG]: '1' } : {}),
        // Forward Temporal connection settings so child processes can connect
        ...(opts.temporalNamespace ? { [ENV.TEMPORAL_NAMESPACE]: opts.temporalNamespace } : {}),
        ...(opts.temporalApiKey ? { [ENV.TEMPORAL_API_KEY]: opts.temporalApiKey } : {}),
        ...(opts.temporalTlsCertPath ? { [ENV.TEMPORAL_TLS_CERT_PATH]: opts.temporalTlsCertPath } : {}),
        ...(opts.temporalTlsKeyPath ? { [ENV.TEMPORAL_TLS_KEY_PATH]: opts.temporalTlsKeyPath } : {}),
        ...(opts.sessionId ? { [ENV.BRIDGE_SESSION_ID]: opts.sessionId } : {}),
        // PR-D attachment handoff — renew rather than fresh-claim in startV2Lifecycle.
        ...(opts.attachmentId ? { [ENV.ATTACHMENT_ID]: opts.attachmentId } : {}),
        ...(opts.ingestToken ? { [ENV.INGEST_TOKEN]: opts.ingestToken } : {}),
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
  /**
   * T1.1 PR-1 — per-player ingest token (AGENT_TEMPO_INGEST_TOKEN). Minted by
   * the outbox at spawn; authenticates the adapter's loopback daemon-HTTP
   * calls (doorbell subscribe; Pi also uses it for /inner/ingest). Absent →
   * the adapter never subscribes (pure T0.2 fallback-poll behavior).
   */
  ingestToken?: string;
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
  const logName = opts.name || `mock-${Date.now()}`;
  // #690 — central ~/.agent-tempo/logs/<ensemble>/ (overrideDir = opts.logDir wins).
  const { dir: logDirPath, logPath, pidPath } = bridgeLogPaths(opts.ensemble, logName, opts.logDir);

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
        [ENV.PID_FILE]: pidPath, // #690 — adapter writes/unlinks THIS exact path (no re-derive → no split-brain)
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
        ...(opts.ingestToken ? { [ENV.INGEST_TOKEN]: opts.ingestToken } : {}),
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
  /**
   * T1.1 PR-1 — per-player ingest token (AGENT_TEMPO_INGEST_TOKEN). Minted by
   * the outbox at spawn; authenticates the adapter's loopback daemon-HTTP
   * calls (doorbell subscribe; Pi also uses it for /inner/ingest). Absent →
   * the adapter never subscribes (pure T0.2 fallback-poll behavior).
   */
  ingestToken?: string;
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
  const logName = opts.name || `claude-api-${Date.now()}`;
  // #690 — central ~/.agent-tempo/logs/<ensemble>/ (overrideDir = opts.logDir wins).
  const { dir: logDirPath, logPath, pidPath } = bridgeLogPaths(opts.ensemble, logName, opts.logDir);

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
        [ENV.PID_FILE]: pidPath, // #690 — adapter writes/unlinks THIS exact path (no re-derive → no split-brain)
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
        ...(opts.ingestToken ? { [ENV.INGEST_TOKEN]: opts.ingestToken } : {}),
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
  /**
   * T1.1 PR-1 — per-player ingest token (AGENT_TEMPO_INGEST_TOKEN). Minted by
   * the outbox at spawn; authenticates the adapter's loopback daemon-HTTP
   * calls (doorbell subscribe; Pi also uses it for /inner/ingest). Absent →
   * the adapter never subscribes (pure T0.2 fallback-poll behavior).
   */
  ingestToken?: string;
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
  const logName = opts.name || `opencode-${Date.now()}`;
  // #690 — central ~/.agent-tempo/logs/<ensemble>/ (overrideDir = opts.logDir wins).
  const { dir: logDirPath, logPath, pidPath } = bridgeLogPaths(opts.ensemble, logName, opts.logDir);

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
        [ENV.PID_FILE]: pidPath, // #690 — adapter writes/unlinks THIS exact path (no re-derive → no split-brain)
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
        ...(opts.ingestToken ? { [ENV.INGEST_TOKEN]: opts.ingestToken } : {}),
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

// ── Pi headless adapter (Phase 3a) ─────────────────────────────────────────

/**
 * Options for {@link spawnPiHeadless}. Mirrors {@link OpenCodeAdapterOpts} for
 * identity + Temporal connection + attachment handoff; adds Pi-specific knobs:
 * `model` (provider/model via `AGENT_TEMPO_PI_MODEL`) and `continueSessionId`
 * (restart-resume via `AGENT_TEMPO_PI_CONTINUE_SESSION` → Pi `continueSession`).
 *
 * Unlike the other headless adapters, the Pi entry does NOT drive a
 * `BaseAttachment` loop — it injects the `src/pi` extension into Pi's
 * `createAgentSession`; the module-scope extension singleton owns the lifecycle.
 */
export interface PiHeadlessAdapterOpts {
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
  /** Pi provider/model selector (e.g. `anthropic/claude-opus-4-7`); absent → Pi default. */
  model?: string;
  /** Restart-resume: the Pi conversation id to continue (from `metadata.sessionId`). */
  continueSessionId?: string;
  /**
   * 3c Tier-2 ingest token (minted by the daemon outbox, scoped to this player's
   * workflowId). Threaded into the subprocess env as `AGENT_TEMPO_INGEST_TOKEN`
   * so the inner-loop publisher can authenticate `POST /inner/ingest`. NOTE:
   * spawn.ts only THREADS the token — minting lives in the daemon-only outbox
   * (this module runs outside the daemon and must not import the registry).
   */
  ingestToken?: string;
  /** PR-D attachment-lease handoff (renew rather than fresh-claim on boot). */
  attachmentId?: string;
  attachmentRunId?: string;
  adapterId?: string;
}

export interface PiHeadlessAdapterResult {
  pid: number | undefined;
  logPath: string;
  pidPath: string;
}

/**
 * Resolve the path to the Pi headless adapter entry point. Mirrors
 * {@link resolveOpenCodePath} — dev (ts-node) + prod (compiled .js) both launch
 * the same code through the same `require.main === module` gate.
 */
function resolvePiPath(): { cmd: string; args: string[] } {
  const isDev = __filename.endsWith('.ts');
  if (isDev) {
    return { cmd: 'npx', args: ['ts-node', resolve(__dirname, 'adapters', 'pi', 'adapter.ts')] };
  }
  return { cmd: 'node', args: [resolve(__dirname, 'adapters', 'pi', 'adapter.js')] };
}

/**
 * Spawn the headless Pi runtime as a detached subprocess. Pattern matches
 * {@link spawnOpenCodeAdapter} — no TTY, log + PID files, env carries identity +
 * Temporal settings + attachment handoff + the Pi model / continue-session
 * knobs. The entry constructs `createAgentSession` with the `src/pi`
 * extension injected inline; the singleton claims + heartbeats + registers tools.
 */
export function spawnPiHeadless(opts: PiHeadlessAdapterOpts): PiHeadlessAdapterResult {
  const { cmd, args } = resolvePiPath();
  const logName = opts.name || `pi-${Date.now()}`;
  // #690 — central ~/.agent-tempo/logs/<ensemble>/ (overrideDir = opts.logDir wins).
  const { dir: logDirPath, logPath, pidPath } = bridgeLogPaths(opts.ensemble, logName, opts.logDir);

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
        [ENV.PID_FILE]: pidPath, // #690 — adapter writes/unlinks THIS exact path (no re-derive → no split-brain)
        [ENV.PLAYER_NAME]: opts.name,
        [ENV.CONDUCTOR]: opts.isConductor ? 'true' : '',
        [ENV.TEMPORAL_ADDRESS]: opts.temporalAddress,
        ...(opts.temporalNamespace ? { [ENV.TEMPORAL_NAMESPACE]: opts.temporalNamespace } : {}),
        ...(opts.temporalApiKey ? { [ENV.TEMPORAL_API_KEY]: opts.temporalApiKey } : {}),
        ...(opts.temporalTlsCertPath ? { [ENV.TEMPORAL_TLS_CERT_PATH]: opts.temporalTlsCertPath } : {}),
        ...(opts.temporalTlsKeyPath ? { [ENV.TEMPORAL_TLS_KEY_PATH]: opts.temporalTlsKeyPath } : {}),
        // Model selection: recruit-arg → AGENT_TEMPO_PI_MODEL → Pi default.
        ...(opts.model ? { [ENV.PI_MODEL]: opts.model } : {}),
        // Restart-resume: continue the prior Pi conversation.
        ...(opts.continueSessionId ? { [ENV.PI_CONTINUE_SESSION]: opts.continueSessionId } : {}),
        // 3c Tier-2: per-player ingest token (minted by the daemon outbox).
        // Absent → the inner-loop publisher's HTTP client no-ops (no fine tail).
        ...(opts.ingestToken ? { [ENV.INGEST_TOKEN]: opts.ingestToken } : {}),
        // Attachment handoff — extension renews via claimAttachment(expectedAttachmentId).
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

  log(`Spawned pi headless adapter (pid ${child.pid}) in ${opts.workDir} as "${opts.name}"${opts.model ? ` (model=${opts.model})` : ''}${opts.continueSessionId ? ` (continue=${opts.continueSessionId})` : ''}${opts.attachmentId ? ` (attachmentId=${opts.attachmentId})` : ''}`);
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
  /**
   * T1.1 PR-1 — per-player ingest token (AGENT_TEMPO_INGEST_TOKEN). Minted by
   * the outbox at spawn; authenticates the adapter's loopback daemon-HTTP
   * calls (doorbell subscribe; Pi also uses it for /inner/ingest). Absent →
   * the adapter never subscribes (pure T0.2 fallback-poll behavior).
   */
  ingestToken?: string;
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
  const logName = opts.name || `claude-code-headless-${Date.now()}`;
  // #690 — central ~/.agent-tempo/logs/<ensemble>/ (overrideDir = opts.logDir wins).
  const { dir: logDirPath, logPath, pidPath } = bridgeLogPaths(opts.ensemble, logName, opts.logDir);

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
        [ENV.PID_FILE]: pidPath, // #690 — adapter writes/unlinks THIS exact path (no re-derive → no split-brain)
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
        ...(opts.ingestToken ? { [ENV.INGEST_TOKEN]: opts.ingestToken } : {}),
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
