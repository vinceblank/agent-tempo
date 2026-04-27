/**
 * `claude-tempo dashboard` — open the packaged web dashboard,
 * optionally minting a single-use pairing token + QR code for
 * cross-device access. PR-8 of #340.
 *
 * **Critical constraint**: like {@link daemon-command}, this module
 * must NOT import from `@temporalio/*`, `../workflows/*`, or any
 * module that pulls in the Temporal SDK. The dashboard verb must
 * remain operable when Temporal itself is broken (same #157
 * reasoning: a stranded operator with a running daemon should still
 * be able to run `claude-tempo dashboard` to see what's going on).
 *
 * Flow:
 *   1. Resolve the daemon's port (port-file or `--port` override)
 *   2. Probe `GET /v1/health` — if the daemon isn't running, exit 1
 *      with a hint to run `claude-tempo daemon start`
 *   3. Print the dashboard URL
 *   4. If `--pair`: POST `/dashboard/api/pair` (with the operator's
 *      bearer if any) → render a terminal QR + the URL with the
 *      `?pair=<token>` fragment. The user scans from their phone.
 *   5. Unless `--no-open`, spawn the platform browser-opener so the
 *      dashboard shows up immediately.
 *
 * Output modes:
 *   - default: human-readable colored
 *   - `--json`: single JSON object on stdout, no banners — for
 *     scripts and CI
 */
import { request as httpRequest, type IncomingMessage } from 'http';
import { spawn } from 'child_process';
import { CliOverrides } from '../config';
import { readPortFile } from '../http/port-file';
import * as out from './output';

export interface DashboardCommandArgs extends CliOverrides {
  /** Override the daemon port (defaults to the port-file value). */
  port?: number;
  /** Override the daemon bind address (defaults to 127.0.0.1). */
  bind?: string;
  /** When true, print the URL but don't launch the browser. */
  noOpen?: boolean;
  /** Mint a single-use pairing token + show QR for cross-device. */
  pair?: boolean;
  /** Bearer to include on the pair-create POST. */
  bearer?: string;
  /** Machine-parseable output (single-line JSON). */
  json?: boolean;
}

interface DashboardJsonOk {
  ok: true;
  url: string;
  pair?: { url: string; expiresAt: number };
}
interface DashboardJsonErr {
  ok: false;
  error: string;
  hint?: string;
}

const DEFAULT_BIND = '127.0.0.1';

/**
 * Public entry point — invoked by the CLI dispatcher. Returns void;
 * exits the process with code 1 on error, 0 on success.
 */
export async function dashboardCommand(args: DashboardCommandArgs): Promise<void> {
  const port = await resolvePort(args, args.json ?? false);
  if (port === null) return; // resolvePort already exited
  const bind = args.bind ?? DEFAULT_BIND;
  const baseUrl = `http://${bind}:${port}`;

  const healthy = await probeHealth(baseUrl);
  if (!healthy) {
    return emitError(args.json ?? false, {
      error: 'daemon-not-reachable',
      hint: `No response from ${baseUrl}/v1/health. Run \`claude-tempo daemon start\` and retry.`,
    });
  }

  const dashboardUrl = `${baseUrl}/dashboard/`;
  let pairResult: { url: string; expiresAt: number } | null = null;

  if (args.pair) {
    const minted = await mintPairToken(baseUrl, args.bearer);
    if (!minted.ok) {
      return emitError(args.json ?? false, {
        error: 'pair-mint-failed',
        hint: minted.reason,
      });
    }
    pairResult = {
      url: `${dashboardUrl}?pair=${encodeURIComponent(minted.token)}`,
      expiresAt: minted.expiresAt,
    };
  }

  if (args.json) {
    const payload: DashboardJsonOk = {
      ok: true,
      url: dashboardUrl,
      ...(pairResult ? { pair: pairResult } : {}),
    };
    out.log(JSON.stringify(payload));
    return;
  }

  // Human-readable output
  out.heading('claude-tempo dashboard');
  out.log(`  ${out.cyan(dashboardUrl)}`);
  if (pairResult) {
    out.log('');
    out.log(`  ${out.bold('Cross-device pair:')}`);
    out.log(`  ${out.cyan(pairResult.url)}`);
    out.log(`  ${out.dim(`Token expires at ${new Date(pairResult.expiresAt).toLocaleTimeString()} (single-use, 5-min TTL)`)}`);
    await renderQr(pairResult.url);
  }

  if (!args.noOpen) {
    openInBrowser(dashboardUrl);
  } else {
    out.log('');
    out.log(`  ${out.dim('--no-open: not launching browser')}`);
  }
}

async function resolvePort(args: DashboardCommandArgs, json: boolean): Promise<number | null> {
  if (typeof args.port === 'number' && args.port > 0) return args.port;
  const fromFile = readPortFile();
  if (fromFile !== null) return fromFile;
  emitError(json, {
    error: 'no-port',
    hint: 'No daemon port file. Pass --port <N> or run `claude-tempo daemon start` first.',
  });
  return null;
}

async function probeHealth(baseUrl: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const req = httpRequest(`${baseUrl}/v1/health`, { method: 'GET', timeout: 3000 }, (res: IncomingMessage) => {
      // Drain to avoid leaving the socket open.
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

interface MintOk {
  ok: true;
  token: string;
  expiresAt: number;
}
interface MintErr {
  ok: false;
  reason: string;
}

async function mintPairToken(baseUrl: string, bearer: string | undefined): Promise<MintOk | MintErr> {
  return new Promise<MintOk | MintErr>((resolve) => {
    const headers: Record<string, string> = { 'Content-Length': '0' };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    const req = httpRequest(`${baseUrl}/dashboard/api/pair`, { method: 'POST', headers, timeout: 3000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 201) {
          try {
            const parsed = JSON.parse(body) as { token: string; expiresAt: number };
            return resolve({ ok: true, token: parsed.token, expiresAt: parsed.expiresAt });
          } catch (err) {
            return resolve({ ok: false, reason: `malformed pair response: ${err instanceof Error ? err.message : String(err)}` });
          }
        }
        if (res.statusCode === 401) return resolve({ ok: false, reason: 'unauthorized — pass --bearer <token> or run on the host without bearer auth' });
        if (res.statusCode === 400) return resolve({ ok: false, reason: 'pair flow requires bearer auth (loopback skips this)' });
        resolve({ ok: false, reason: `unexpected status ${res.statusCode}: ${body}` });
      });
    });
    req.on('error', (err) => resolve({ ok: false, reason: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, reason: 'request timed out' });
    });
    req.end();
  });
}

/**
 * Render a QR code in the terminal. `qrcode-terminal` is loaded
 * lazily so the require cost only hits operators who pass `--pair`.
 * The package may not be installed in development checkouts that
 * skipped optional deps; surface a graceful fallback.
 */
async function renderQr(url: string): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const qrcode: { generate: (text: string, opts: { small: boolean }, cb: (out: string) => void) => void } = require('qrcode-terminal');
    await new Promise<void>((resolve) => {
      qrcode.generate(url, { small: true }, (rendered: string) => {
        out.log('');
        out.log(rendered);
        resolve();
      });
    });
  } catch {
    out.warn('qrcode-terminal not available — copy the URL above into your phone instead.');
  }
}

/**
 * Open `url` in the operator's default browser via the platform's
 * standard launcher. Best-effort — failures are logged but don't
 * block the command's success path (the URL is already printed).
 */
function openInBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' :
    process.platform === 'win32' ? 'cmd' :
    'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (err) {
    out.warn(`could not launch browser (${err instanceof Error ? err.message : String(err)}); open the URL manually`);
  }
}

function emitError(json: boolean, body: { error: string; hint?: string }): void {
  if (json) {
    const payload: DashboardJsonErr = { ok: false, ...body };
    out.log(JSON.stringify(payload));
  } else {
    out.error(body.error);
    if (body.hint) out.log(`  ${out.dim(body.hint)}`);
  }
  process.exit(1);
}
