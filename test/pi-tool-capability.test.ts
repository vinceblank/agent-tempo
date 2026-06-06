/**
 * Unit tests for the tool capability classifier (src/security/tool-capability.ts,
 * 3d / MD-C). Tests the MECHANISM — keyed on representative names the conductor
 * named (bash/write/read) + content-agnostic invariants (disjoint sets, each
 * member classifies to its own class) — so tempo-security amending the name-set
 * CONTENT doesn't break these.
 */
import { expect } from 'chai';
import {
  classify,
  UNKNOWN_DEFAULT,
  EXEC_TOOLS,
  HIGH_BLAST_TOOLS,
  LOW_RISK_TOOLS,
  type ToolCapability,
} from '../src/security/tool-capability';

describe('tool-capability classify — by class (representative names)', () => {
  it('classifies shell/exec tools as "exec"', () => {
    for (const t of ['bash', 'shell', 'exec']) {
      expect(classify(t), t).to.equal('exec');
    }
  });

  it('classifies destructive/network tools as "high-blast"', () => {
    for (const t of ['write', 'edit', 'webfetch', 'recruit', 'destroy']) {
      expect(classify(t), t).to.equal('high-blast');
    }
  });

  it('classifies read-only/coordination tools as "low-risk"', () => {
    for (const t of ['read', 'grep', 'cue', 'report']) {
      expect(classify(t), t).to.equal('low-risk');
    }
  });
});

describe('tool-capability classify — security boundary rulings', () => {
  it('web_search is low-risk but web_fetch is high-blast (read vs exfil surface)', () => {
    expect(classify('web_search')).to.equal('low-risk');
    expect(classify('websearch')).to.equal('low-risk');
    expect(classify('web_fetch')).to.equal('high-blast');
    expect(classify('webfetch')).to.equal('high-blast');
    expect(classify('fetch')).to.equal('high-blast');
  });

  it('pause/play/release are high-blast (peer state changes); fetch_state is low-risk', () => {
    expect(classify('pause')).to.equal('high-blast');
    expect(classify('play')).to.equal('high-blast');
    expect(classify('release')).to.equal('high-blast');
    expect(classify('fetch_state')).to.equal('low-risk');
  });

  it('schedule is high-blast but unschedule is low-risk (blast is at schedule-time)', () => {
    expect(classify('schedule')).to.equal('high-blast');
    expect(classify('unschedule')).to.equal('low-risk');
  });

  it('quality_gate/evaluate_gate are high-blast; gates (list) is low-risk', () => {
    expect(classify('quality_gate')).to.equal('high-blast');
    expect(classify('evaluate_gate')).to.equal('high-blast');
    expect(classify('gates')).to.equal('low-risk');
  });

  it('classifies the EXEC superset (incl. powershell/cmd/command/run_command)', () => {
    for (const t of ['powershell', 'pwsh', 'cmd', 'run', 'command', 'run_command']) {
      expect(classify(t), t).to.equal('exec');
    }
  });
});

describe('tool-capability classify — unknown default (fail-safe)', () => {
  it('returns UNKNOWN_DEFAULT for an unrecognized tool', () => {
    expect(classify('some_future_tool_xyz')).to.equal(UNKNOWN_DEFAULT);
  });

  it('NEVER classifies an unknown tool as low-risk (never silently bypass)', () => {
    expect(classify('some_future_tool_xyz')).to.not.equal('low-risk');
  });

  it('treats blank / whitespace names as unknown (fail-safe, not a crash)', () => {
    expect(classify('')).to.equal(UNKNOWN_DEFAULT);
    expect(classify('   ')).to.equal(UNKNOWN_DEFAULT);
  });
});

describe('tool-capability classify — case-insensitive + trimmed', () => {
  it('matches regardless of case', () => {
    expect(classify('BASH')).to.equal('exec');
    expect(classify('Write')).to.equal('high-blast');
    expect(classify('Read')).to.equal('low-risk');
  });

  it('trims surrounding whitespace before matching', () => {
    expect(classify('  bash  ')).to.equal('exec');
    expect(classify('\tWrite\n')).to.equal('high-blast');
  });
});

describe('tool-capability — name-set invariants (content-agnostic)', () => {
  const classOf: Array<[ReadonlySet<string>, ToolCapability]> = [
    [EXEC_TOOLS, 'exec'],
    [HIGH_BLAST_TOOLS, 'high-blast'],
    [LOW_RISK_TOOLS, 'low-risk'],
  ];

  it('every member of each set classifies to that set\'s class', () => {
    for (const [set, cls] of classOf) {
      for (const name of set) {
        expect(classify(name), name).to.equal(cls);
      }
    }
  });

  it('the three sets are pairwise disjoint (a name has exactly one class)', () => {
    const all = [...EXEC_TOOLS, ...HIGH_BLAST_TOOLS, ...LOW_RISK_TOOLS];
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const n of all) {
      if (seen.has(n)) dupes.push(n);
      seen.add(n);
    }
    expect(dupes, `tool(s) in more than one capability set: ${dupes.join(', ')}`).to.deep.equal([]);
  });

  it('all set members are already lowercase (so the case-insensitive lookup works)', () => {
    for (const [set] of classOf) {
      for (const name of set) {
        expect(name, name).to.equal(name.toLowerCase());
      }
    }
  });
});
