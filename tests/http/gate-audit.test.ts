/**
 * Unit tests for the gate-audit JSONL writer (3d / MD-G, R5). Uses a temp root so
 * it never touches the real ~/.agent-tempo tree.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGateAuditSink, gateAuditPath } from '../../src/http/gate-audit';
import type { GateAuditRecord } from '../../src/http/gate-registry';

const WF = 'agent-session-demo-tempo-pi';
const E = 'demo';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-gate-audit-')); });
afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

const decision = (over: Partial<GateAuditRecord> = {}): GateAuditRecord => ({
  kind: 'decision', ts: '2026-06-04T00:00:00.000Z', workflowId: WF, requestId: 'req-1',
  tool: 'bash', argsSummary: '{}', decision: 'allow', source: 'operator', ...over,
} as GateAuditRecord);

describe('gate-audit writer', () => {
  it('appends one JSON line per record to <root>/<ensemble>/<workflowId>.jsonl', () => {
    const sink = createGateAuditSink(root);
    sink(decision(), E);
    sink(decision({ decision: 'deny' }) as GateAuditRecord, E);

    const file = gateAuditPath(E, WF, root);
    expect(fs.existsSync(file)).toBe(true);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ kind: 'decision', workflowId: WF, decision: 'allow' });
    expect(JSON.parse(lines[1])).toMatchObject({ decision: 'deny' });
  });

  it('paths per-ensemble + per-workflowId (separate files)', () => {
    const sink = createGateAuditSink(root);
    sink(decision(), E);
    sink(decision({ workflowId: 'agent-session-demo-other' }), E);
    sink(decision(), 'prod');
    expect(fs.existsSync(gateAuditPath(E, WF, root))).toBe(true);
    expect(fs.existsSync(gateAuditPath(E, 'agent-session-demo-other', root))).toBe(true);
    expect(fs.existsSync(gateAuditPath('prod', WF, root))).toBe(true);
  });

  it('records arm/disarm posture changes too', () => {
    const sink = createGateAuditSink(root);
    sink({ kind: 'arm', ts: '2026-06-04T00:00:00.000Z', workflowId: WF, source: 'operator' }, E);
    const lines = fs.readFileSync(gateAuditPath(E, WF, root), 'utf8').trim().split('\n');
    expect(JSON.parse(lines[0])).toMatchObject({ kind: 'arm', workflowId: WF });
  });

  it('sanitizes path traversal in ensemble / workflowId segments', () => {
    const sink = createGateAuditSink(root);
    sink(decision({ workflowId: '../../etc/passwd' }), '../evil');
    // Nothing escaped the root.
    const escaped = path.join(root, '..', 'etc');
    expect(fs.existsSync(escaped)).toBe(false);
    // The sanitized file lives under the root.
    const file = gateAuditPath('../evil', '../../etc/passwd', root);
    expect(file.startsWith(root)).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('never throws on a bad root (best-effort durable)', () => {
    // A path whose parent is a FILE → mkdir fails; the sink must swallow it.
    const fileAsRoot = path.join(root, 'iam-a-file');
    fs.writeFileSync(fileAsRoot, 'x');
    const sink = createGateAuditSink(path.join(fileAsRoot, 'nested'));
    expect(() => sink(decision(), E)).not.toThrow();
  });
});
