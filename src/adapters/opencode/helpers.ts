/**
 * Small, self-contained helpers for the opencode adapter.
 *
 * Kept out of `adapter.ts` so each can be unit-tested without the full
 * Temporal/SdkAttachment scaffolding. Mirrors the per-adapter helpers
 * pattern used by `src/adapters/claude-api/`.
 */
import * as net from 'net';
import type { ChildProcess } from 'child_process';

/**
 * Probe a free TCP port on `127.0.0.1` by binding port 0 and reading the
 * OS-assigned port. Same approach `src/http/server.ts` uses.
 *
 * The port is briefly bound and released — there is a TOCTOU window where
 * another process could grab it before `opencode serve` starts. Acceptable
 * for the v1 single-machine model: opencode is loopback-only and the
 * single-tenant use case won't hit the race in practice.
 */
export function probeFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr === 'object' && addr && 'port' in addr) {
        const port = addr.port;
        server.close((err) => (err ? reject(err) : resolve(port)));
      } else {
        server.close();
        reject(new Error('probeFreePort: server.address() did not return an AddressInfo'));
      }
    });
  });
}

/**
 * Wait for a `ChildProcess` to exit, with a timeout. Returns the exit code
 * (or signal-as-string) on exit, or `null` on timeout.
 */
export function waitForExit(p: ChildProcess, timeoutMs: number): Promise<number | string | null> {
  return new Promise((resolve) => {
    if (p.killed && p.exitCode !== null) {
      resolve(p.exitCode);
      return;
    }
    let settled = false;
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code ?? signal ?? null);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      p.removeListener('exit', onExit);
      resolve(null);
    }, timeoutMs);
    p.once('exit', onExit);
  });
}

/**
 * Redact API key substrings in a synthesized OpenCode config so the
 * stderr config-log doesn't leak credentials. Any substring that looks
 * like an API key (alphanumeric ≥20 chars, optionally prefixed `sk-` or
 * `Bearer `) is replaced with `***`.
 *
 * Conservative: only known shapes are touched. The `{env:...}` substitution
 * markers in the config (e.g. `"apiKey": "{env:ANTHROPIC_API_KEY}"`) are
 * left intact because they don't contain literal credentials — OpenCode
 * substitutes at read time.
 */
export function redactSecrets(json: string): string {
  // Match: "apiKey": "sk-foo..." or "apiKey": "long-token-here"
  return json.replace(
    /("(?:apiKey|api_key|token|bearer|secret)"\s*:\s*")([^"]{20,})(")/gi,
    (_full, pre: string, value: string, post: string) => {
      // Preserve `{env:...}` markers — they're config-shape, not secrets.
      if (value.startsWith('{env:') && value.endsWith('}')) return pre + value + post;
      return pre + '***' + post;
    },
  );
}

/**
 * Compare a runtime version string to a tilde-pinned spec (e.g. `~1.14.29`).
 * Returns `true` when `version` is on the same `MAJOR.MINOR` line as the
 * spec — i.e. `1.14.29`, `1.14.30`, `1.14.99` all match `~1.14.29`, but
 * `1.15.0` does not. Matches npm tilde-range semantics.
 *
 * Pure string compare — no semver dep. Both `version` and `spec` must be
 * `MAJOR.MINOR.PATCH` (extra suffixes ignored). Returns `true` on
 * unparseable inputs to avoid false-positive WARNING noise on weird
 * builds (e.g. `1.14.29-rc1`).
 */
export function isVersionMatch(version: string, spec: string): boolean {
  const versionMajorMinor = parseMajorMinor(version);
  const specMajorMinor = parseMajorMinor(spec.replace(/^~/, ''));
  if (!versionMajorMinor || !specMajorMinor) return true;
  return versionMajorMinor === specMajorMinor;
}

function parseMajorMinor(s: string): string | null {
  const m = /(\d+)\.(\d+)\.\d+/.exec(s);
  return m ? `${m[1]}.${m[2]}` : null;
}
