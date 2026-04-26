/**
 * Unit tests for `daemon.port` lifecycle helpers.
 *
 * Targets isolated temp paths so concurrent runs (and a real daemon
 * potentially listening on the production path) never interfere.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  readPortFile,
  removePortFile,
  writePortFileAtomic,
} from '../../src/http/port-file';

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-port-'));
});
afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('writePortFileAtomic', () => {
  it('writes the port as decimal ASCII without trailing newline', async () => {
    const f = path.join(tmpDir, 'daemon.port');
    await writePortFileAtomic(f, 8473);
    expect(fs.readFileSync(f, 'utf8')).toBe('8473');
  });
  it('overwrites a prior value atomically (renames win)', async () => {
    const f = path.join(tmpDir, 'daemon.port');
    fs.writeFileSync(f, '12345');
    await writePortFileAtomic(f, 65535);
    expect(fs.readFileSync(f, 'utf8')).toBe('65535');
  });
  it('creates the parent directory if missing', async () => {
    const f = path.join(tmpDir, 'nested', 'a', 'daemon.port');
    await writePortFileAtomic(f, 1024);
    expect(fs.readFileSync(f, 'utf8')).toBe('1024');
  });
  it('rejects out-of-range ports', async () => {
    const f = path.join(tmpDir, 'daemon.port');
    await expect(writePortFileAtomic(f, -1)).rejects.toThrow(/invalid port/);
    await expect(writePortFileAtomic(f, 70000)).rejects.toThrow(/invalid port/);
    // 0 is allowed at write time — caller may stash an ephemeral fallback.
    await writePortFileAtomic(f, 0);
    expect(fs.readFileSync(f, 'utf8')).toBe('0');
  });
});

describe('removePortFile', () => {
  it('unlinks an existing file', async () => {
    const f = path.join(tmpDir, 'daemon.port');
    await writePortFileAtomic(f, 8473);
    removePortFile(f);
    expect(fs.existsSync(f)).toBe(false);
  });
  it('is silent when the file is missing', () => {
    const f = path.join(tmpDir, 'never-existed.port');
    expect(() => removePortFile(f)).not.toThrow();
  });
});

describe('readPortFile', () => {
  it('returns the port number for a valid file', async () => {
    const f = path.join(tmpDir, 'daemon.port');
    await writePortFileAtomic(f, 8473);
    expect(readPortFile(f)).toBe(8473);
  });
  it('tolerates leading/trailing whitespace', () => {
    const f = path.join(tmpDir, 'daemon.port');
    fs.writeFileSync(f, '  4242\n');
    expect(readPortFile(f)).toBe(4242);
  });
  it('returns null when the file is missing', () => {
    expect(readPortFile(path.join(tmpDir, 'absent'))).toBeNull();
  });
  it('returns null for empty / non-numeric content', () => {
    const f = path.join(tmpDir, 'daemon.port');
    fs.writeFileSync(f, '');
    expect(readPortFile(f)).toBeNull();
    fs.writeFileSync(f, 'not-a-port');
    expect(readPortFile(f)).toBeNull();
  });
  it('returns null for out-of-range values', () => {
    const f = path.join(tmpDir, 'daemon.port');
    fs.writeFileSync(f, '0');     // ephemeral sentinel — not a usable port
    expect(readPortFile(f)).toBeNull();
    fs.writeFileSync(f, '70000');
    expect(readPortFile(f)).toBeNull();
  });
});
