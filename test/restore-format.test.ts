/**
 * Unit tests for the `restore --all-hosts` cluster-view formatter (#151).
 *
 * Pure renderer — no Temporal, no I/O. Fixtures synthesize the three
 * liveness states the architect's spec calls out:
 *   - `[live]`     remote host is polling now → recovery imminent
 *   - `[stale]`    remote host has a profile but no poller recently
 *   - `[missing]`  remote host has no registered profile at all
 *
 * Plus the local-grouping and `(unknown)` edge cases.
 */
import { expect } from 'chai';
import { formatCrossHostOrphans } from '../src/utils/restore-format';
import type { RestoreOrphanDetail } from '../src/reconcile/orphans';
import type { HostInfo } from '../src/types';

const LOCAL = 'host-A';

function fxOrphan(opts: {
  playerId: string;
  ensemble: string;
  preferredHost: string;
}): RestoreOrphanDetail {
  return {
    playerId: opts.playerId,
    ensemble: opts.ensemble,
    outcome: {
      kind: 'skipped',
      reason: 'crossHost',
      detail: opts.preferredHost,
    },
  };
}

function fxHost(opts: {
  hostname: string;
  freshness: 'live' | 'stale';
}): HostInfo {
  return {
    hostname: opts.hostname,
    instances: [],
    recruitReady: opts.freshness === 'live',
    freshness: opts.freshness,
    profileStaleness: 'fresh',
    profile: {
      hostname: opts.hostname,
      version: '0.28.0',
      platform: 'linux',
      defaultAgent: 'claude',
      capabilities: [],
    },
  };
}

describe('formatCrossHostOrphans (#151)', function () {
  it('zero orphans — emits the empty-result line', function () {
    const out = formatCrossHostOrphans([], [], { localHost: LOCAL });
    expect(out).to.equal('No orphans found (every ensemble across all hosts).');
  });

  it('zero orphans with ensemble narrow — names the ensemble in the empty line', function () {
    const out = formatCrossHostOrphans([], [], { localHost: LOCAL, ensemble: 'band-a' });
    expect(out).to.equal('No orphans found (ensemble "band-a" across all hosts).');
  });

  it("[live] — remote host is polling; action edge prints the TUI /migrate command", function () {
    const orphans = [fxOrphan({ playerId: 'alice', ensemble: 'tempo-impl', preferredHost: 'host-B' })];
    const hosts = [fxHost({ hostname: 'host-B', freshness: 'live' })];
    const out = formatCrossHostOrphans(orphans, hosts, { localHost: LOCAL });

    // Heading reflects total + scope.
    expect(out).to.include('1 cross-host orphan found (every ensemble across all hosts).');
    // Preface — the auto-reattach narrative the architect asked for.
    expect(out).to.include('These sessions are reattached automatically when their preferred host returns.');
    // Liveness label is `[live]`.
    expect(out).to.include('**host-B** [live]');
    // Player line carries the ensemble context.
    expect(out).to.include('alice');
    expect(out).to.include('(ensemble: tempo-impl)');
    // Action edge — TUI form, no `claude-tempo` prefix, local host as target.
    expect(out).to.include(`In TUI: /migrate alice ${LOCAL} --force`);
  });

  it('[stale] — remote host has a profile but no recent poller', function () {
    const orphans = [fxOrphan({ playerId: 'bob', ensemble: 'team-b', preferredHost: 'host-C' })];
    const hosts = [fxHost({ hostname: 'host-C', freshness: 'stale' })];
    const out = formatCrossHostOrphans(orphans, hosts, { localHost: LOCAL });
    expect(out).to.include('**host-C** [stale]');
    expect(out).to.include(`In TUI: /migrate bob ${LOCAL} --force`);
  });

  it('[missing] — remote host has no listHosts entry at all', function () {
    const orphans = [fxOrphan({ playerId: 'ghost', ensemble: 'team-c', preferredHost: 'host-D' })];
    // Note: `host-D` deliberately absent from the hosts array.
    const hosts: HostInfo[] = [fxHost({ hostname: 'host-B', freshness: 'live' })];
    const out = formatCrossHostOrphans(orphans, hosts, { localHost: LOCAL });
    expect(out).to.include('**host-D** [missing]');
    expect(out).to.include(`In TUI: /migrate ghost ${LOCAL} --force`);
  });

  it('groups multiple orphans under the same preferredHost', function () {
    const orphans = [
      fxOrphan({ playerId: 'alice', ensemble: 'tempo-impl', preferredHost: 'host-B' }),
      fxOrphan({ playerId: 'bob', ensemble: 'tempo-impl', preferredHost: 'host-B' }),
      fxOrphan({ playerId: 'carol', ensemble: 'tempo-impl', preferredHost: 'host-C' }),
    ];
    const hosts = [
      fxHost({ hostname: 'host-B', freshness: 'live' }),
      fxHost({ hostname: 'host-C', freshness: 'stale' }),
    ];
    const out = formatCrossHostOrphans(orphans, hosts, { localHost: LOCAL });

    expect(out).to.include('3 cross-host orphans found');
    // Both alice and bob appear under host-B's heading.
    const lines = out.split('\n');
    const idxB = lines.findIndex((l) => l.includes('**host-B**'));
    const idxC = lines.findIndex((l) => l.includes('**host-C**'));
    expect(idxB).to.be.greaterThan(-1);
    expect(idxC).to.be.greaterThan(idxB);
    const sectionB = lines.slice(idxB, idxC).join('\n');
    expect(sectionB).to.include('alice');
    expect(sectionB).to.include('bob');
    const sectionC = lines.slice(idxC).join('\n');
    expect(sectionC).to.include('carol');
  });

  it('local-preferred orphan — local host appears first with (local) tag; action edge is a single-ensemble restore hint', function () {
    const orphans = [
      fxOrphan({ playerId: 'remote', ensemble: 'tempo-impl', preferredHost: 'host-B' }),
      fxOrphan({ playerId: 'me', ensemble: 'tempo-impl', preferredHost: LOCAL }),
    ];
    const hosts = [
      fxHost({ hostname: LOCAL, freshness: 'live' }),
      fxHost({ hostname: 'host-B', freshness: 'stale' }),
    ];
    const out = formatCrossHostOrphans(orphans, hosts, { localHost: LOCAL });

    const lines = out.split('\n');
    const idxLocal = lines.findIndex((l) => l.startsWith(`**${LOCAL}**`));
    const idxRemote = lines.findIndex((l) => l.startsWith('**host-B**'));
    expect(idxLocal, 'local host present').to.be.greaterThan(-1);
    expect(idxRemote, 'remote host present').to.be.greaterThan(-1);
    expect(idxLocal, 'local host listed before remote').to.be.lessThan(idxRemote);
    expect(out).to.include(`**${LOCAL}** [live] (local)`);
    // Local section recommends the single-ensemble restore command.
    expect(out).to.include('Use `claude-tempo restore tempo-impl` (single-ensemble) to reattach.');
    // Local section does NOT print the /migrate steal command for self.
    const localSection = out.slice(out.indexOf(`**${LOCAL}**`), out.indexOf('**host-B**'));
    expect(localSection).to.not.include('/migrate');
  });

  it('preferredHost = "(unknown)" — labeled [missing], grouped last; no /migrate edge printed', function () {
    const orphans = [
      fxOrphan({ playerId: 'mystery', ensemble: 'tempo-impl', preferredHost: '(unknown)' }),
      fxOrphan({ playerId: 'alice', ensemble: 'tempo-impl', preferredHost: 'host-B' }),
    ];
    const hosts = [fxHost({ hostname: 'host-B', freshness: 'live' })];
    const out = formatCrossHostOrphans(orphans, hosts, { localHost: LOCAL });

    expect(out).to.include('**(unknown)** [missing]');
    // `(unknown)` group's section should NOT have a /migrate suggestion —
    // operator can't migrate to/from a hostname they don't know.
    const unknownStart = out.indexOf('**(unknown)**');
    const unknownSection = out.slice(unknownStart);
    expect(unknownSection).to.not.include('/migrate');
    // And it appears AFTER the known host (alphabetical sort with unknown-last).
    const idxKnown = out.indexOf('**host-B**');
    expect(unknownStart).to.be.greaterThan(idxKnown);
  });

  it('filters out non-crossHost details defensively', function () {
    const orphans: RestoreOrphanDetail[] = [
      fxOrphan({ playerId: 'alice', ensemble: 'tempo-impl', preferredHost: 'host-B' }),
      // Local-restore-style outcome — should not appear in cluster-view output.
      {
        playerId: 'restored-already',
        ensemble: 'tempo-impl',
        outcome: { kind: 'queued', entryId: 'entry-1' },
      },
      // Old-style preferredHost skip — also not surfaced in cluster-view.
      {
        playerId: 'old-skip',
        ensemble: 'tempo-impl',
        outcome: { kind: 'skipped', reason: 'preferredHost', detail: 'host-B' },
      },
    ];
    const hosts = [fxHost({ hostname: 'host-B', freshness: 'live' })];
    const out = formatCrossHostOrphans(orphans, hosts, { localHost: LOCAL });

    expect(out).to.include('1 cross-host orphan found');
    expect(out).to.include('alice');
    expect(out).to.not.include('restored-already');
    expect(out).to.not.include('old-skip');
  });

  it('respects the --ensemble narrow in the scope line', function () {
    const orphans = [fxOrphan({ playerId: 'alice', ensemble: 'band-a', preferredHost: 'host-B' })];
    const hosts = [fxHost({ hostname: 'host-B', freshness: 'live' })];
    const out = formatCrossHostOrphans(orphans, hosts, { localHost: LOCAL, ensemble: 'band-a' });
    expect(out).to.include('1 cross-host orphan found (ensemble "band-a" across all hosts).');
  });
});
