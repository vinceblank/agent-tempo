/**
 * Decision-path fence (#748, operator-mandated Invariant 1).
 *
 * T0.1 moved the OBSERVATION path (maestro refresh, daemon aggregate) onto
 * eventually-consistent SA/memo reads. Every DECISION path must stay on
 * direct workflow queries — a stale read there could misroute an action
 * instead of merely mis-rendering a board. The four fenced sites carry a
 * `DECISION-PATH FENCE (#748)` marker comment next to their direct-query
 * call; this test asserts both the marker AND the direct-query call still
 * exist in each file.
 *
 * If this test fails because you migrated one of these reads: stop — that
 * is a design decision requiring architect sign-off (see the read-path
 * split table in docs/design/temporal-cost-rearchitecture.md, addendum
 * §B(a)), not a refactor.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';

const SRC = path.resolve(__dirname, '..', '..', 'src');

const FENCED_SITES: ReadonlyArray<{
  file: string;
  /** The direct-query call shape that must still be present. */
  directCall: RegExp;
  what: string;
}> = [
  {
    file: 'tools/cue.ts',
    directCall: /queryHandleWithTimeout<AttachmentInfo>\(\s*resolved,\s*attachmentInfoQuery/,
    what: 'cue phase preflight (direct attachmentInfo query)',
  },
  {
    file: 'utils/suspension.ts',
    directCall: /queryHandleWithTimeout\(handle, queryDef/,
    what: 'suspension preflight (direct paused/outboxLocked/maestroPaused queries)',
  },
  {
    file: 'activities/resolve.ts',
    directCall: /queryHandleWithTimeout<SessionMetadata>\(handle, 'getMetadata'\)/,
    what: 'resolveSession (direct getMetadata per candidate)',
  },
  {
    file: 'utils/hosts.ts',
    directCall: /handle\.query\('hostProfilesWithExistence'\)/,
    what: 'recruit host preflight (direct global-maestro query)',
  },
];

describe('decision-path fence (#748)', () => {
  for (const site of FENCED_SITES) {
    it(`${site.file} keeps its fence + direct query — ${site.what}`, () => {
      const text = fs.readFileSync(path.join(SRC, site.file), 'utf8');
      expect(
        text.includes('DECISION-PATH FENCE (#748)'),
        `${site.file}: the DECISION-PATH FENCE marker comment was removed`,
      ).toBe(true);
      expect(
        site.directCall.test(text),
        `${site.file}: the fenced direct-query call shape changed or was migrated — ` +
        'decision paths must NOT move to SA/memo reads without architect sign-off',
      ).toBe(true);
    });
  }
});
