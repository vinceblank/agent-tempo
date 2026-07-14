/**
 * Unit tests for the last-exit crash-notice rendering added to
 * `src/cli/ensure-infra.ts` (§4 of docs/design/daemon-last-exit-schema.md).
 * Pure formatting + injectable-deps tests — no Temporal, no filesystem.
 */
import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { formatLastExitNotice, printLastExitNoticeIfAny } from '../src/cli/ensure-infra';
import type { DaemonLastExit } from '../src/utils/last-exit';

describe('formatLastExitNotice', function () {
  const base: DaemonLastExit = {
    schemaVersion: 1,
    reason: 'worker-give-up',
    restarts: 5,
    at: '2026-07-14T03:02:11.000Z',
    pid: 34900,
  };

  it('includes the reason, restart count, and timestamp', function () {
    const text = formatLastExitNotice(base);
    expect(text).to.include('worker gave up');
    expect(text).to.include('5 restarts');
    expect(text).to.include('2026-07-14T03:02:11.000Z');
  });

  it('computes downtime from lastHeartbeatAt vs "now"', function () {
    const marker: DaemonLastExit = {
      ...base,
      lastHeartbeatAt: '2026-07-13T12:32:53.000Z',
    };
    const now = Date.parse('2026-07-14T03:02:11.000Z'); // ~14h29m later
    const text = formatLastExitNotice(marker, now);
    expect(text).to.match(/down ~14h/);
  });

  it('omits the downtime clause when lastHeartbeatAt is absent', function () {
    const text = formatLastExitNotice(base);
    expect(text).to.not.include('down ~');
  });

  it('includes the worker label when present', function () {
    const text = formatLastExitNotice({ ...base, worker: 'shared' });
    expect(text).to.include('(shared worker)');
  });

  it('includes only the first line of a multi-line lastFatalMessage', function () {
    const text = formatLastExitNotice({ ...base, lastFatalMessage: 'boom\nstack trace line 2\nline 3' });
    expect(text).to.include('"boom"');
    expect(text).to.not.include('stack trace line 2');
  });

  it('handles restarts: 0 without an awkward "0 restarts" clause', function () {
    const text = formatLastExitNotice({ ...base, reason: 'stale-pid-unexplained', restarts: 0 });
    expect(text).to.not.include('restarts');
  });

  it('falls back to the raw reason string for an unrecognized value (forward-compat)', function () {
    const text = formatLastExitNotice({ ...base, reason: 'some-future-reason' as DaemonLastExit['reason'] });
    expect(text).to.include('some-future-reason');
  });
});

describe('printLastExitNoticeIfAny', function () {
  it('does not print when no marker exists', function () {
    let called = false;
    printLastExitNoticeIfAny({
      readAndClearLastExit: () => null,
      warn: () => { called = true; },
    });
    expect(called).to.be.false;
  });

  it('prints once when a marker exists', function () {
    const messages: string[] = [];
    printLastExitNoticeIfAny({
      readAndClearLastExit: () => ({
        schemaVersion: 1,
        reason: 'drain-timeout',
        restarts: 0,
        at: '2026-07-14T00:00:00.000Z',
        pid: 1,
      }),
      warn: (msg) => messages.push(msg),
    });
    expect(messages).to.have.length(1);
    expect(messages[0]).to.include('drain');
  });
});

describe('ensureInfra() step ordering — crash notice before install hint', function () {
  // Regression pin for the rebase conflict noted in PR-C review (#935): both
  // `printLastExitNoticeIfAny()` (marker PR, #934) and `printInstallHintIfNeeded()`
  // (PR-C) hook the SAME point in `ensureInfra()`'s bootstrap sequence, and a
  // rebase/merge could silently swap their order. The crash notice must run
  // FIRST — it's strictly higher priority than a "you should install
  // supervision" nudge, and if the hint printed first an operator's eye could
  // land on the nudge with the actual crash message reading as buried
  // underneath it. `ensureInfra()`'s two calls aren't behind the injectable
  // `EnsureInfraDeps` seam (they're plain top-level calls, not deps-driven),
  // so a full behavioral test would need a temp AGENT_TEMPO_HOME set before
  // any module import in this process — impractical in a shared mocha run.
  // This source-position assertion is a cheap, real safeguard instead: it
  // fails loudly if a future edit reorders the two calls.
  it('printLastExitNoticeIfAny() call appears before printInstallHintIfNeeded() call in the source', function () {
    // __dirname here is `dist-test/test` (this file compiles into dist-test,
    // mirroring the repo's src/test layout) — go up TWO levels to the repo
    // root, then down into the real TypeScript source (not the compiled JS
    // sitting alongside this test at dist-test/src/...).
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'cli', 'ensure-infra.ts'), 'utf8');
    const noticeCallIdx = src.indexOf('printLastExitNoticeIfAny();');
    const hintCallIdx = src.indexOf('printInstallHintIfNeeded();');
    expect(noticeCallIdx, 'printLastExitNoticeIfAny() call site not found').to.be.greaterThan(-1);
    expect(hintCallIdx, 'printInstallHintIfNeeded() call site not found').to.be.greaterThan(-1);
    expect(noticeCallIdx).to.be.lessThan(hintCallIdx);
  });
});
