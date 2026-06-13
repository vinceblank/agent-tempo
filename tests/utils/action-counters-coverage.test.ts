/**
 * Drift detector for #753 — every long-lived `new Client(...)` construction
 * must install `actionCountingInterceptors()`, or the process's Temporal
 * calls silently vanish from the action meter.
 *
 * Short-lived CLI / TUI surfaces are intentionally excluded: they're
 * operator-interactive one-shots whose call volume is operator-bounded
 * noise, not part of the idle-burn question the meter exists to answer.
 * Adding a new daemon/adapter-side Client without interceptors fails this
 * test — either wire `actionCountingInterceptors()` or (for a genuinely
 * one-shot surface) extend the exclusion list with a justification.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';

const SRC_ROOT = path.resolve(__dirname, '..', '..', 'src');

/** Intentionally uninstrumented (operator-bounded one-shot processes). */
const EXCLUDED = new Set([
  'cli/commands.ts',
  'cli/ensure-infra.ts',
  'cli/startup.ts',
  'cli/upgrade-command.ts',
  // #785 — `upgrade-to-2` is an operator-invoked one-shot cutover verb; its
  // Client volume is operator-bounded noise, same rationale as upgrade-command.
  'cli/upgrade-to-2-command.ts',
  'tui/index.ts',
]);

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

describe('action-counter coverage of Client constructions (#753)', () => {
  it('every non-excluded `new Client(` site passes interceptors', () => {
    const offenders: string[] = [];
    for (const file of listTsFiles(SRC_ROOT)) {
      const rel = path.relative(SRC_ROOT, file).replace(/\\/g, '/');
      const text = fs.readFileSync(file, 'utf8');
      // Match the code shape (`new Client({`) rather than bare `new Client(`
      // so prose mentions of `new Client(...)` in doc comments don't trip it.
      let idx = text.indexOf('new Client({');
      while (idx !== -1) {
        // The options literal is small at every site — 300 chars of
        // lookahead comfortably covers it.
        const window = text.slice(idx, idx + 300);
        if (!/interceptors\s*:/.test(window) && !EXCLUDED.has(rel)) {
          const line = text.slice(0, idx).split('\n').length;
          offenders.push(`${rel}:${line}`);
        }
        idx = text.indexOf('new Client({', idx + 1);
      }
    }
    expect(offenders, [
      'Found `new Client(` constructions without actionCountingInterceptors().',
      'Wire `interceptors: actionCountingInterceptors()` (src/utils/action-counters.ts)',
      'or add the file to EXCLUDED with a one-shot justification.',
    ].join(' ')).toEqual([]);
  });
});
