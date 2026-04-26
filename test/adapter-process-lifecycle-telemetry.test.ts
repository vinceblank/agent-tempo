/**
 * Hypothesis A telemetry — process-lifecycle handlers in `BaseAttachment`.
 *
 * Closes the observability gap left by the #258 fix. The structured
 * `terminal fire` log (#258) makes the next adapter-silence incident
 * self-describing — but only when `fireTerminal` actually fires.
 * Hypothesis A (process death — crash, OOM, Windows sleep, terminal
 * close) wouldn't produce that log because the process never reached
 * the code path. These handlers add that missing layer.
 *
 * **Pure-logic tests** (no spawn): exercise the env gate and the
 * structured-frame builder.
 * **Integration tests** (child-process spawn): exercise the real
 * `process.on` registration. We can't simulate `exit` / `SIGTERM` /
 * `uncaughtException` reliably inside the mocha harness — those
 * affect the test process itself. Spawning a child with a tiny stub
 * that imports the compiled adapter, installs handlers, and triggers
 * the signal lets us assert the structured log appears in stderr
 * without disturbing the parent.
 *
 * **Out of scope**: SIGKILL — by definition no handler fires. The
 * absence of any `adapter-process-terminating` log on a future #258
 * recurrence narrows the hypothesis to that branch.
 */
import { expect } from 'chai';
import { spawn } from 'child_process';
import * as path from 'path';
import {
  buildProcessTerminatingFrame,
  installProcessLifecycleTelemetry,
  _resetProcessLifecycleTelemetryForTest,
} from '../src/adapters/base';

const COMPILED_BASE_PATH = path.join(__dirname, '..', 'src', 'adapters', 'base.js');

/**
 * Shape used by callers that just want to grep — kept inline so the
 * test asserts on the same string the operator would `grep` for.
 */
const TERMINATING_TAG = 'adapter-process-terminating';

describe('buildProcessTerminatingFrame', () => {
  it('produces parseable JSON with the canonical event field', () => {
    const frame = buildProcessTerminatingFrame('SIGTERM', undefined, []);
    const parsed = JSON.parse(frame);
    expect(parsed).to.deep.equal({
      event: 'adapter-process-terminating',
      signal: 'SIGTERM',
      adapterCount: 0,
      adapters: [],
    });
  });

  it('includes errorMessage when supplied (uncaughtException path)', () => {
    const frame = buildProcessTerminatingFrame('uncaughtException', 'kapow!', []);
    const parsed = JSON.parse(frame);
    expect(parsed.errorMessage).to.equal('kapow!');
    expect(parsed.signal).to.equal('uncaughtException');
  });

  it('serializes adapter snapshots verbatim', () => {
    const snapshot = [
      {
        attachmentId: 'a1', workflowId: 'wf-1', runId: 'r-1',
        heartbeatsSent: 42, phaseTicksDone: 17,
      },
    ];
    const frame = buildProcessTerminatingFrame('exit', undefined, snapshot);
    const parsed = JSON.parse(frame);
    expect(parsed.adapterCount).to.equal(1);
    expect(parsed.adapters[0]).to.deep.equal(snapshot[0]);
  });

  it('omits errorMessage when not supplied', () => {
    const parsed = JSON.parse(buildProcessTerminatingFrame('SIGINT', undefined, []));
    expect(parsed).to.not.have.property('errorMessage');
  });
});

describe('installProcessLifecycleTelemetry — env gating', () => {
  /**
   * Mocha exposes `it`/`describe` on the global object. The default
   * gate inside `installProcessLifecycleTelemetry` consults that
   * signal AND checks `NODE_ENV === 'test'`, so the function should
   * no-op here. Force-install is the only way to exercise the
   * registration path inside this suite.
   */
  it('no-ops under mocha by default (globalThis.it gate)', () => {
    _resetProcessLifecycleTelemetryForTest();
    const before = process.listenerCount('SIGTERM');
    installProcessLifecycleTelemetry();
    const after = process.listenerCount('SIGTERM');
    expect(after).to.equal(before, 'mocha gate failed — handler registered when it should not have');
  });

  it('installs when force=true is set', () => {
    _resetProcessLifecycleTelemetryForTest();
    const before = process.listenerCount('SIGTERM');
    installProcessLifecycleTelemetry({ force: true });
    const after = process.listenerCount('SIGTERM');
    expect(after).to.equal(before + 1);
    _resetProcessLifecycleTelemetryForTest();
  });

  it('is idempotent — repeat calls do not double-register', () => {
    _resetProcessLifecycleTelemetryForTest();
    const before = process.listenerCount('SIGTERM');
    installProcessLifecycleTelemetry({ force: true });
    installProcessLifecycleTelemetry({ force: true });
    installProcessLifecycleTelemetry({ force: true });
    const after = process.listenerCount('SIGTERM');
    expect(after - before).to.equal(1, 'multiple installs added more than one handler');
    _resetProcessLifecycleTelemetryForTest();
  });

  it('honors the CLAUDE_TEMPO_LIFECYCLE_TELEMETRY=0 opt-out env var', () => {
    _resetProcessLifecycleTelemetryForTest();
    const prev = process.env.CLAUDE_TEMPO_LIFECYCLE_TELEMETRY;
    process.env.CLAUDE_TEMPO_LIFECYCLE_TELEMETRY = '0';
    try {
      const before = process.listenerCount('SIGTERM');
      installProcessLifecycleTelemetry();
      expect(process.listenerCount('SIGTERM')).to.equal(before);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_TEMPO_LIFECYCLE_TELEMETRY;
      else process.env.CLAUDE_TEMPO_LIFECYCLE_TELEMETRY = prev;
      _resetProcessLifecycleTelemetryForTest();
    }
  });
});

// ── Child-process integration tests ─────────────────────────────────────

interface SpawnResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
}

/**
 * Run a stub Node script that loads the compiled adapter, installs
 * lifecycle telemetry, then triggers the requested termination path.
 * The stub is passed via `node -e` so we don't need a fixture file.
 */
function spawnStub(stubBody: string, opts: { signal?: NodeJS.Signals; killAfterMs?: number } = {}): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve, reject) => {
    const stub = `
      const { installProcessLifecycleTelemetry } = require(${JSON.stringify(COMPILED_BASE_PATH)});
      installProcessLifecycleTelemetry({ force: true });
      ${stubBody}
    `;
    const child = spawn(process.execPath, ['-e', stub], {
      env: {
        ...process.env,
        // Belt-and-suspenders: even if NODE_ENV is set in this test run's
        // env, the child gets a clean install path.
        CLAUDE_TEMPO_LIFECYCLE_TELEMETRY: '1',
        NODE_ENV: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf8'); });
    child.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });

    if (opts.signal) {
      const t = setTimeout(() => {
        try { child.kill(opts.signal!); } catch { /* ignore */ }
      }, opts.killAfterMs ?? 100);
      t.unref();
    }

    const watchdog = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('child stub exceeded 5 s timeout'));
    }, 5_000);
    watchdog.unref();

    child.on('close', (exitCode, signal) => {
      clearTimeout(watchdog);
      resolve({ exitCode, signal, stderr, stdout });
    });
    child.on('error', (err) => { clearTimeout(watchdog); reject(err); });
  });
}

describe('process-lifecycle handlers — end-to-end via child process', function() {
  // Each spawn allocates a fresh Node process; cap the suite generously.
  this.timeout(30_000);

  it('emits the structured log on clean process.exit(0)', async () => {
    const result = await spawnStub(`process.exit(0);`);
    expect(result.exitCode).to.equal(0);
    expect(result.stderr).to.include(TERMINATING_TAG);
    expect(result.stderr).to.include('"signal":"exit"');
    expect(result.stderr).to.include('"adapterCount":0');
  });

  it('emits the structured log on SIGTERM', async function() {
    // Windows `child.kill('SIGTERM')` doesn't deliver a signal in the
    // POSIX sense — it terminates the process via TerminateProcess
    // before any handler runs. Skip on Windows; the production
    // registration path is the same, and POSIX coverage is enough
    // for the contract.
    if (process.platform === 'win32') {
      // SKIP-REASON: Windows TerminateProcess doesn't deliver POSIX signals — production registration path is unaffected.
      this.skip();
      return;
    }
    const result = await spawnStub(
      // Keep the event loop alive long enough for SIGTERM to land.
      `setTimeout(() => process.exit(0), 1000);`,
      { signal: 'SIGTERM', killAfterMs: 100 },
    );
    expect(result.stderr).to.include(TERMINATING_TAG);
    expect(result.stderr).to.include('"signal":"SIGTERM"');
  });

  it('emits the structured log on SIGINT', async function() {
    // Some Windows hosts deliver SIGINT differently from POSIX. Skip if
    // the platform doesn't support it cleanly — the production handler
    // is purely additive (it just logs), so platform parity isn't load-
    // bearing for the telemetry contract.
    if (process.platform === 'win32') {
      // SKIP-REASON: Windows SIGINT delivery diverges from POSIX in cmd.exe-hosted children — telemetry contract is platform-agnostic, POSIX coverage suffices.
      this.skip();
      return;
    }
    const result = await spawnStub(
      `setTimeout(() => process.exit(0), 1000);`,
      { signal: 'SIGINT', killAfterMs: 100 },
    );
    expect(result.stderr).to.include(TERMINATING_TAG);
    expect(result.stderr).to.include('"signal":"SIGINT"');
  });

  it('emits the structured log on uncaughtException AND preserves Node default crash', async () => {
    const result = await spawnStub(
      `setTimeout(() => { throw new Error('kapow'); }, 50);`,
    );
    expect(result.stderr).to.include(TERMINATING_TAG);
    expect(result.stderr).to.include('"signal":"uncaughtException"');
    expect(result.stderr).to.include('"errorMessage":"kapow"');
    // Node's default action on uncaughtException is to print the stack
    // trace and exit non-zero. We register `uncaughtExceptionMonitor`,
    // which preserves that — the child should NOT exit with code 0.
    expect(result.exitCode === 0 ? null : 'non-zero').to.equal('non-zero');
  });

  it('emits the structured log on unhandledRejection AND does not crash', async () => {
    // With our handler registered, Node's default crash on unhandled
    // rejection is suppressed (intentional per the brief).
    const result = await spawnStub(`
      Promise.reject(new Error('orphan-promise'));
      setTimeout(() => process.exit(0), 200);
    `);
    expect(result.stderr).to.include(TERMINATING_TAG);
    expect(result.stderr).to.include('"signal":"unhandledRejection"');
    expect(result.stderr).to.include('"errorMessage":"orphan-promise"');
    expect(result.exitCode).to.equal(0);
  });

  it('survives back-to-back process.exit calls without re-registering handlers (idempotency under spawn)', async () => {
    // Spawn calls install twice in a row; the second call must be a
    // no-op or the `exit` handler would fire twice (extra log line).
    const result = await spawnStub(`
      installProcessLifecycleTelemetry({ force: true });
      installProcessLifecycleTelemetry({ force: true });
      process.exit(0);
    `);
    expect(result.exitCode).to.equal(0);
    // Count by `"event":"adapter-process-terminating"` — that exact
    // substring appears once per JSON frame, while the bare
    // `adapter-process-terminating` tag would also match the log-line
    // prefix and double-count.
    const matches = result.stderr.match(/"event":"adapter-process-terminating"/g)?.length ?? 0;
    expect(matches).to.equal(1, 'idempotency broken — handler registered more than once');
  });
});
