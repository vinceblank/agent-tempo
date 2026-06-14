/**
 * Unit tests for the #689 no-echo spawn helpers (src/spawn.ts) — secret env
 * values must never appear in the echoed terminal command; they go to a sourced
 * 0600 file instead. Pure (no process spawning): exercises partitionEnv,
 * fishQuote, writeSecretEnvFile, and buildTerminalCommand's assembled string.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, statSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  partitionEnv,
  fishQuote,
  writeSecretEnvFile,
  buildTerminalCommand,
} from '../../src/spawn';

const SECRET_ENV_DIR = join(tmpdir(), 'agent-tempo-spawn');
const isPosix = process.platform !== 'win32';

// The helpers write real files into SECRET_ENV_DIR — clean up after each test.
afterEach(() => { try { rmSync(SECRET_ENV_DIR, { recursive: true, force: true }); } catch { /* noop */ } });

const SECRET = 'sk-ant-jwt-AbCdEf0123456789-DO-NOT-LEAK';

describe('partitionEnv (#689)', () => {
  it('routes credential-named vars to secret, everything else (incl *Path) to plain', () => {
    const { plainEnv, secretEnv } = partitionEnv({
      TEMPORAL_API_KEY: 'jwt',
      ANTHROPIC_API_KEY: 'k',
      AGENT_TEMPO_INGEST_TOKEN: 't',
      TEMPORAL_TLS_KEY_PATH: '/p/key.pem',     // *Path → plain (file location, not secret)
      TEMPORAL_TLS_CERT_PATH: '/p/cert.pem',
      AGENT_TEMPO_ENSEMBLE: 'pitest',
      AGENT_TEMPO_PLAYER_NAME: 'tempo-eng',
      AGENT_TEMPO_CONDUCTOR: '1',
    });
    expect(Object.keys(secretEnv).sort()).toEqual(
      ['ANTHROPIC_API_KEY', 'AGENT_TEMPO_INGEST_TOKEN', 'TEMPORAL_API_KEY'].sort(),
    );
    expect(Object.keys(plainEnv).sort()).toEqual(
      ['AGENT_TEMPO_CONDUCTOR', 'AGENT_TEMPO_ENSEMBLE', 'AGENT_TEMPO_PLAYER_NAME', 'TEMPORAL_TLS_CERT_PATH', 'TEMPORAL_TLS_KEY_PATH'].sort(),
    );
  });
});

describe('fishQuote (#689)', () => {
  it("escapes embedded single-quote and backslash the fish way (\\' not POSIX '\\'')", () => {
    expect(fishQuote("a'b")).toBe("'a\\'b'");
    expect(fishQuote('a\\b')).toBe("'a\\\\b'");
    expect(fishQuote('plain')).toBe("'plain'");
  });
});

describe('writeSecretEnvFile (#689)', () => {
  it('empty secretEnv → no file, empty prefix (back-compat: no behavior change)', () => {
    const r = writeSecretEnvFile({}, { syntax: 'posix' });
    expect(r).toEqual({ path: '', sourcePrefix: '', cleanup: '' });
  });

  it('posix: 0600 file (0700 dir) with export lines + source/rm prefix, value in FILE not prefix', () => {
    const r = writeSecretEnvFile({ TEMPORAL_API_KEY: SECRET }, { syntax: 'posix' });
    expect(existsSync(r.path)).toBe(true);
    const body = readFileSync(r.path, 'utf8');
    expect(body).toContain('export TEMPORAL_API_KEY=');
    expect(body).toContain(SECRET);                       // the real value lives in the FILE
    expect(r.sourcePrefix).toContain('source ');
    expect(r.sourcePrefix).toContain('rm -f ');
    expect(r.sourcePrefix).toContain(r.path);
    expect(r.sourcePrefix).not.toContain(SECRET);         // …never in the sourced prefix
    if (isPosix) {
      expect(statSync(r.path).mode & 0o777).toBe(0o600);
      expect(statSync(SECRET_ENV_DIR).mode & 0o777).toBe(0o700);
    }
  });

  it('fish: set -gx lines via fishQuote', () => {
    const r = writeSecretEnvFile({ TEMPORAL_API_KEY: SECRET }, { syntax: 'fish' });
    const body = readFileSync(r.path, 'utf8');
    expect(body).toContain('set -gx TEMPORAL_API_KEY ');
    expect(body).toContain(SECRET);
  });

  it('cmd: @set "K=v" lines (#847 — @-prefixed) + call/del prefix', () => {
    const r = writeSecretEnvFile({ TEMPORAL_API_KEY: SECRET }, { syntax: 'cmd' });
    const body = readFileSync(r.path, 'utf8');
    expect(body).toContain('@set "TEMPORAL_API_KEY=');
    expect(r.sourcePrefix).toContain('call ');
    expect(r.sourcePrefix).toContain('del ');
  });

  // #847 — the cmd secret file is `call`'d under cmd's default echo-ON, which
  // echoes each line of a called batch FILE; without `@`, the `set "<secret>=…"`
  // lines printed the secret VALUE to terminal scrollback. Every emitted line
  // must be `@`-prefixed so it cannot echo.
  describe('cmd #847 — no-echo + containment', () => {
    // A secret with cmd-special chars exercises cmdEscape alongside the @-prefix.
    const TRICKY = 'sk-ant-A&B%C-DO-NOT-LEAK';

    it('EVERY non-empty line of the cmd file begins with `@` (cannot echo to scrollback)', () => {
      const r = writeSecretEnvFile(
        { ANTHROPIC_API_KEY: TRICKY, TEMPORAL_API_KEY: SECRET },
        { syntax: 'cmd' },
      );
      const lines = readFileSync(r.path, 'utf8').split(/\r?\n/).filter((l) => l.length > 0);
      expect(lines.length).toBe(2);
      for (const line of lines) {
        expect(line.startsWith('@'), `line must be @-prefixed: ${line}`).toBe(true);
        expect(line).toMatch(/^@set "/); // structural: @ + the set statement
      }
      // The secret values still live in the FILE (just echo-suppressed). cmdEscape
      // `^`-escapes `&`/`%`, so the tricky value is stored escaped under the `@`.
      const full = readFileSync(r.path, 'utf8');
      expect(full).toContain('@set "ANTHROPIC_API_KEY=sk-ant-A^&B^%C-DO-NOT-LEAK"');
      expect(full).toContain(SECRET); // the no-special-char secret survives verbatim
    });

    it('the secret VALUE is ONLY in the file — never in sourcePrefix/cleanup (the echoed /k string)', () => {
      const r = writeSecretEnvFile({ ANTHROPIC_API_KEY: TRICKY }, { syntax: 'cmd' });
      // sourcePrefix + cleanup feed the echoed `cmd /k` string — they carry only
      // the file PATH (+ call/del), never the secret value.
      expect(r.sourcePrefix).not.toContain(TRICKY);
      expect(r.cleanup).not.toContain(TRICKY);
      expect(r.sourcePrefix).toContain(r.path); // the path IS in the /k string (fine — not secret)
    });

    it('cmd file is 0600 in the 0700 dir (owner-only — pre-existing invariant)', function () {
      if (!isPosix) return; // mode bits only meaningful on POSIX
      const r = writeSecretEnvFile({ ANTHROPIC_API_KEY: TRICKY }, { syntax: 'cmd' });
      expect(statSync(r.path).mode & 0o777).toBe(0o600);
      expect(statSync(SECRET_ENV_DIR).mode & 0o777).toBe(0o700);
    });
  });

  // #847 — the cmd `@`-prefix MUST NOT bleed into the posix/fish branches
  // (`source` does not echo a sourced file's lines, so no `@` there). Pin them
  // byte-stable.
  it('#847: posix + fish branches are UNCHANGED (no `@` — source does not echo)', () => {
    const posix = readFileSync(
      writeSecretEnvFile({ TEMPORAL_API_KEY: SECRET }, { syntax: 'posix' }).path,
      'utf8',
    );
    // shellQuote wraps a special-char-free value in single quotes.
    expect(posix).toBe(`export TEMPORAL_API_KEY='${SECRET}'\n`);
    expect(posix).not.toContain('@');

    const fish = readFileSync(
      writeSecretEnvFile({ TEMPORAL_API_KEY: SECRET }, { syntax: 'fish' }).path,
      'utf8',
    );
    expect(fish).toBe(`set -gx TEMPORAL_API_KEY '${SECRET}'\n`);
    expect(fish).not.toContain('@');
  });

  it('O_EXCL random names: two calls produce two distinct files (no predictable reuse)', () => {
    const a = writeSecretEnvFile({ TEMPORAL_API_KEY: SECRET }, { syntax: 'posix' });
    const b = writeSecretEnvFile({ TEMPORAL_API_KEY: SECRET }, { syntax: 'posix' });
    expect(a.path).not.toBe(b.path);
  });
});

describe('buildTerminalCommand — secret never in the command string (#689 regression guard)', () => {
  for (const syntax of ['posix', 'fish'] as const) {
    it(`${syntax}: assembled command excludes the secret VALUE, includes the env-file path; plain env inline`, () => {
      const cmd = buildTerminalCommand(
        'pi',
        ['-e', 'dist/pi/extension.js'],
        { TEMPORAL_API_KEY: SECRET, AGENT_TEMPO_ENSEMBLE: 'pitest' },
        syntax,
      );
      expect(cmd).not.toContain(SECRET);                  // secret value NOT in the echoed command
      expect(cmd).toContain('AGENT_TEMPO_ENSEMBLE=');     // plain env stays inline
      expect(cmd).toMatch(/agent-tempo-spawn[\\/]env-/);  // secret routed to a sourced file
      expect(cmd).toContain('pi');
    });
  }

  it('no secrets → no source prefix, plain inline only (back-compat)', () => {
    const cmd = buildTerminalCommand('pi', ['-e', 'x'], { AGENT_TEMPO_ENSEMBLE: 'pitest' }, 'posix');
    expect(cmd).not.toContain('source ');
    expect(cmd).toContain('AGENT_TEMPO_ENSEMBLE=');
    expect(cmd.startsWith('AGENT_TEMPO_ENSEMBLE=')).toBe(true);
  });
});
