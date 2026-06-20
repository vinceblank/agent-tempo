/**
 * Serial-withWorker fence (#721, architect-mandated).
 *
 * `TASK_QUEUE` in `test/helpers.ts` is a mutable live binding minted per
 * `withWorker*` invocation. That is safe ONLY while no two `withWorker*`
 * calls run concurrently within one process — a `Promise.all`-wrapped pair
 * would have the second mint overwrite the first mid-flight, making every
 * live-binding read inside the callbacks timing-dependent (a worker on
 * queue-2 while the test thinks it is driving env-1: subtler than a hang).
 *
 * This test converts the doc-comment's point-in-time "no concurrent calls"
 * claim into a standing invariant: no `Promise.all` / `Promise.allSettled`
 * argument span in `test/` may invoke a `withWorker*` helper.
 *
 * Precision (architect's correction): parallel-Mocha with per-FILE worker
 * processes is SAFE as-is — module state is per-process. The forbidden
 * shape is intra-process concurrency only. If you legitimately need two
 * concurrent workers in one test, that is a design conversation (see
 * `useSharedWorker` / #772), not a fence edit.
 *
 * Also asserts the SERIAL-WITHWORKER CONSTRAINT marker comment survives in
 * `helpers.ts`, decision-path-fence style.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';

const TEST_DIR = path.resolve(__dirname, '..', '..', 'test');

/** Recursively list .ts files under test/. */
function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Extract the balanced-paren argument span of each `Promise.all(` /
 * `Promise.allSettled(` call in `text`. Balanced scan (not a fixed window)
 * so a `withWorker` call AFTER the Promise.all closes can never
 * false-positive.
 */
function promiseAllArgSpans(text: string): string[] {
  const spans: string[] = [];
  const re = /Promise\.(?:all|allSettled)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < text.length && depth > 0) {
      const c = text[i];
      if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
      i += 1;
    }
    spans.push(text.slice(start, i - 1));
  }
  return spans;
}

const WITHWORKER_CALL_RE = /\bwithWorker\w*\s*\(/;

describe('serial-withWorker fence (#721)', () => {
  it('no Promise.all/allSettled in test/ wraps a withWorker* invocation', () => {
    const files = listTsFiles(TEST_DIR);
    // #707 — a fence that scans ZERO files would pass while asserting over
    // nothing (silent false-clean). If the source walk yields no files the
    // enumeration is broken (wrong path / empty checkout / a Windows
    // `dir/**/*.ext` glob silently matching nothing) — fail loud first.
    expect(
      files.length,
      `serial-withWorker fence enumerated 0 .ts files under ${TEST_DIR} — ` +
        'the source walk is broken; refusing to pass on an empty scan (#707).',
    ).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const span of promiseAllArgSpans(text)) {
        if (WITHWORKER_CALL_RE.test(span)) {
          offenders.push(path.relative(TEST_DIR, file));
        }
      }
    }
    expect(
      offenders,
      `Concurrent withWorker* under Promise.all detected in: ${offenders.join(', ')} — ` +
        'this breaks the #721 live-binding TASK_QUEUE design (second mint overwrites the ' +
        'first mid-flight). See the SERIAL-WITHWORKER CONSTRAINT doc-comment in test/helpers.ts.',
    ).toEqual([]);
  });

  it('helpers.ts keeps the SERIAL-WITHWORKER CONSTRAINT marker comment', () => {
    const helpers = fs.readFileSync(path.join(TEST_DIR, 'helpers.ts'), 'utf8');
    expect(
      helpers.includes('SERIAL-WITHWORKER CONSTRAINT (#721)'),
      'the SERIAL-WITHWORKER CONSTRAINT marker comment was removed from test/helpers.ts',
    ).toBe(true);
  });
});
