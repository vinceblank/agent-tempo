/**
 * `~/.agent-tempo/daemon.port` — atomic write + cleanup helpers.
 *
 * The TUI / CLI / web dashboard read this file to discover the daemon's
 * bound HTTP port without any out-of-band config. SSE-PROTOCOL.md §1
 * makes the file part of the public contract, so its lifecycle MUST be:
 *
 *   1. Atomic write on daemon boot, after the HTTP listener is `listening`
 *      (so a racing reader who polls during startup either sees the prior
 *      file or the new one — never a half-written one).
 *   2. Removal on graceful shutdown. Best-effort on crash (a stale file
 *      points at a dead port; consumers MUST also tolerate ECONNREFUSED).
 *
 * Both behaviours mirror the existing PID-file pattern in
 * `src/daemon.ts`. Extracted as its own module so HTTP-server tests
 * can exercise the contract without booting the daemon.
 */
import * as fs from 'fs';
import * as path from 'path';
import { setTimeout as sleep } from 'timers/promises';
import { AGENT_TEMPO_HOME } from '../config';

/** Default location, anchored to `~/.agent-tempo/`. */
export const DAEMON_PORT_PATH = path.join(AGENT_TEMPO_HOME, 'daemon.port');

/**
 * Atomically write `port` (decimal ASCII, no trailing newline) to
 * `filePath`. Identical retry shape to `writePidFileAtomic` so Windows
 * EPERM/EBUSY/EACCES from antivirus scanners don't crash boot.
 *
 * Exported so tests can target an isolated path.
 */
export async function writePortFileAtomic(filePath: string, port: number): Promise<void> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`writePortFileAtomic: invalid port ${port}`);
  }

  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, String(port));

  const retryCodes = new Set(['EPERM', 'EBUSY', 'EACCES']);
  const backoffs = [50, 100, 200, 400]; // ≤ 750 ms total
  let lastErr: unknown;

  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    try {
      fs.renameSync(tmp, filePath);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (!code || !retryCodes.has(code) || attempt === backoffs.length) {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        throw err;
      }
      await sleep(backoffs[attempt]);
    }
  }
  throw lastErr;
}

/**
 * Best-effort `unlink`. Silent when the file is missing — consumers
 * cleaning up a half-booted daemon should NOT see a "no such file" stack
 * trace just because the port file never made it to disk.
 */
export function removePortFile(filePath: string = DAEMON_PORT_PATH): void {
  try { fs.unlinkSync(filePath); } catch { /* ignore */ }
}

/**
 * Read the current port from disk, or `null` when the file is missing,
 * empty, or not a parseable port. Used by clients (TempoClient HTTP
 * transport, `agent-tempo daemon status`, …) to discover the live port.
 */
export function readPortFile(filePath: string = DAEMON_PORT_PATH): number | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const port = Number(trimmed);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}
